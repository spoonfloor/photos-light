"""Background open reconcile — cheap dirty-delta maintenance on library open.

Applies the **same** auto-fixable metadata rulebook as Clean/Convert
(``repair_file_metadata_compliance``) to files whose on-disk size drifted from
the catalog, and removes ghost DB rows for missing files.

This is **not** a full Clean: no layout repair, no mole ingest, no dedupe walk.
It must never block library open / grid load — callers schedule it on a daemon
thread via ``schedule_open_reconcile_background``.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional, Set

from clean_library_fast_audit import verify_media_file
from file_operations import (
    extract_exif_date,
    extract_exif_rating,
    get_dimensions,
    strip_exif_rating,
)
from hash_cache import HashCache
from library_cleanliness import IGNORED_LIBRARY_FILES, is_supported_media_extension
from library_filesystem import iter_library_walk
from library_layout import LIBRARY_METADATA_DIR, resolve_db_path
from normalization_repair import (
    RepairFileError,
    RepairScanDependencies,
    repair_file_metadata_compliance,
)
from photo_canonicalization import canonicalize_photo_file, write_photo_date_metadata
from rotation_utils import (
    LOSSLESS_ROTATION_EXTENSIONS,
    bake_orientation,
    can_bake_losslessly,
    get_orientation_flag,
)

CancelCheck = Optional[Callable[[], bool]]
OnComplete = Optional[Callable[["OpenReconcileResult"], None]]

OPEN_RECONCILE_STATE_FILENAME = "open_reconcile_state.json"
DEFAULT_MAX_METADATA_REPAIRS = 200

_schedule_lock = threading.Lock()
_active_cancel: Optional[threading.Event] = None
_active_generation: Optional[int] = None
_active_library: Optional[str] = None


@dataclass
class OpenReconcileDelta:
    """Stat-only dirty set: inventory vs catalog."""

    ghosts: List[str] = field(default_factory=list)
    moles: List[str] = field(default_factory=list)
    size_mismatched: List[str] = field(default_factory=list)
    filesystem_count: int = 0
    db_count: int = 0


@dataclass
class OpenReconcileResult:
    library_path: str
    ghosts_removed: int = 0
    moles_detected: int = 0
    size_mismatched: int = 0
    metadata_fixed: int = 0
    hashes_updated: int = 0
    errors: List[str] = field(default_factory=list)
    cancelled: bool = False
    elapsed_ms: float = 0.0

    def to_dict(self) -> Dict[str, object]:
        return {
            "library_path": self.library_path,
            "ghosts_removed": self.ghosts_removed,
            "moles_detected": self.moles_detected,
            "size_mismatched": self.size_mismatched,
            "metadata_fixed": self.metadata_fixed,
            "hashes_updated": self.hashes_updated,
            "error_count": len(self.errors),
            "cancelled": self.cancelled,
            "elapsed_ms": round(self.elapsed_ms, 1),
        }


def open_reconcile_state_path(library_path: str) -> str:
    return os.path.join(
        os.path.abspath(library_path),
        LIBRARY_METADATA_DIR,
        OPEN_RECONCILE_STATE_FILENAME,
    )


def _raise_if_cancelled(cancel_check: CancelCheck) -> None:
    if cancel_check and cancel_check():
        raise OpenReconcileCancelled()


class OpenReconcileCancelled(RuntimeError):
    """Reconcile aborted because the active library generation changed."""


def collect_open_reconcile_delta(
    library_path: str,
    conn: sqlite3.Connection,
) -> OpenReconcileDelta:
    """Compare a stat-only filesystem inventory to ``photos`` rows."""
    library_path = os.path.abspath(library_path)
    filesystem_sizes: Dict[str, int] = {}

    for root, _dirs, files in iter_library_walk(library_path):
        for filename in files:
            if filename in IGNORED_LIBRARY_FILES:
                continue
            ext = os.path.splitext(filename)[1].lower()
            if not is_supported_media_extension(ext):
                continue
            full_path = os.path.join(root, filename)
            try:
                rel_path = os.path.relpath(full_path, library_path)
                filesystem_sizes[rel_path] = os.path.getsize(full_path)
            except OSError:
                continue

    rows = conn.execute(
        "SELECT id, current_path, file_size FROM photos"
    ).fetchall()
    db_paths: Set[str] = set()
    size_mismatched: List[str] = []
    ghosts: List[str] = []

    for row in rows:
        rel_path = str(row["current_path"] or "")
        if not rel_path:
            continue
        db_paths.add(rel_path)
        disk_size = filesystem_sizes.get(rel_path)
        if disk_size is None:
            ghosts.append(rel_path)
            continue
        db_size = row["file_size"]
        if db_size is None:
            continue
        try:
            if int(db_size) != int(disk_size):
                size_mismatched.append(rel_path)
        except (TypeError, ValueError):
            size_mismatched.append(rel_path)

    moles = sorted(path for path in filesystem_sizes if path not in db_paths)
    return OpenReconcileDelta(
        ghosts=sorted(ghosts),
        moles=moles,
        size_mismatched=sorted(size_mismatched),
        filesystem_count=len(filesystem_sizes),
        db_count=len(db_paths),
    )


def _default_repair_deps(
    conn: sqlite3.Connection,
) -> RepairScanDependencies:
    return RepairScanDependencies(
        hash_cache=HashCache(conn),
        extract_exif_date=extract_exif_date,
        extract_exif_rating=extract_exif_rating,
        strip_exif_rating=strip_exif_rating,
        get_orientation_flag=get_orientation_flag,
        can_bake_losslessly=can_bake_losslessly,
        bake_orientation=bake_orientation,
        canonicalize_photo_file=canonicalize_photo_file,
        write_photo_date_metadata=write_photo_date_metadata,
        read_dimensions=get_dimensions,
        lossless_rotation_extensions=frozenset(LOSSLESS_ROTATION_EXTENSIONS),
    )


def _write_reconcile_state(library_path: str, result: OpenReconcileResult) -> None:
    state_path = open_reconcile_state_path(library_path)
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    payload = {
        "finished_at": datetime.now(timezone.utc).isoformat(),
        **result.to_dict(),
    }
    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)


def run_open_reconcile(
    library_path: str,
    *,
    db_path: Optional[str] = None,
    db_conn: Optional[sqlite3.Connection] = None,
    cancel_check: CancelCheck = None,
    max_metadata_repairs: int = DEFAULT_MAX_METADATA_REPAIRS,
    deps: Optional[RepairScanDependencies] = None,
    persist_state: bool = True,
) -> OpenReconcileResult:
    """Run one open-reconcile pass. Safe to call synchronously from tests."""
    started = time.perf_counter()
    library_path = os.path.abspath(library_path)
    result = OpenReconcileResult(library_path=library_path)

    own_conn = False
    conn = db_conn
    if conn is None:
        resolved = resolve_db_path(library_path, db_path)
        if not os.path.exists(resolved):
            result.errors.append(f"database missing: {resolved}")
            result.elapsed_ms = (time.perf_counter() - started) * 1000
            return result
        conn = sqlite3.connect(resolved)
        conn.row_factory = sqlite3.Row
        own_conn = True

    try:
        _raise_if_cancelled(cancel_check)
        delta = collect_open_reconcile_delta(library_path, conn)
        result.moles_detected = len(delta.moles)
        result.size_mismatched = len(delta.size_mismatched)

        if delta.ghosts:
            _raise_if_cancelled(cancel_check)
            conn.executemany(
                "DELETE FROM photos WHERE current_path = ?",
                [(path,) for path in delta.ghosts],
            )
            conn.commit()
            result.ghosts_removed = len(delta.ghosts)

        scan_deps = deps or _default_repair_deps(conn)
        repaired = 0
        for rel_path in delta.size_mismatched:
            if repaired >= max_metadata_repairs:
                break
            _raise_if_cancelled(cancel_check)
            full_path = os.path.join(library_path, rel_path)
            if not os.path.isfile(full_path):
                continue
            valid, _ = verify_media_file(full_path)
            if not valid:
                continue
            ext = os.path.splitext(full_path)[1].lower()
            try:
                compliance = repair_file_metadata_compliance(
                    full_path,
                    ext=ext,
                    deps=scan_deps,
                )
            except RepairFileError as exc:
                result.errors.append(str(exc).replace(full_path, rel_path))
                continue

            content_hash = compliance.content_hash
            file_size = compliance.file_size
            if content_hash is None:
                content_hash, _hit = scan_deps.hash_cache.get_hash(full_path)
            if file_size is None:
                try:
                    file_size = os.path.getsize(full_path)
                except OSError as exc:
                    result.errors.append(f"{rel_path}: {exc}")
                    continue
            if not content_hash:
                result.errors.append(f"{rel_path}: failed to hash after drift")
                continue

            row = conn.execute(
                "SELECT content_hash, file_size FROM photos WHERE current_path = ?",
                (rel_path,),
            ).fetchone()
            if row is None:
                continue
            if (
                row["content_hash"] != content_hash
                or int(row["file_size"] or -1) != int(file_size)
            ):
                conn.execute(
                    """
                    UPDATE photos
                    SET content_hash = ?, file_size = ?
                    WHERE current_path = ?
                    """,
                    (content_hash, file_size, rel_path),
                )
                conn.commit()
                result.hashes_updated += 1

            if compliance.fixed:
                result.metadata_fixed += 1
            repaired += 1

    except OpenReconcileCancelled:
        result.cancelled = True
    finally:
        if own_conn and conn is not None:
            conn.close()

    result.elapsed_ms = (time.perf_counter() - started) * 1000
    if persist_state and not result.cancelled:
        try:
            _write_reconcile_state(library_path, result)
        except OSError as exc:
            result.errors.append(f"state write failed: {exc}")
    return result


def _open_reconcile_scheduling_enabled() -> bool:
    if os.environ.get("PHOTOS_LIGHT_DISABLE_OPEN_RECONCILE"):
        return False
    if os.environ.get("PHOTOS_LIGHT_ENABLE_OPEN_RECONCILE"):
        return True
    # Many unit tests call update_app_paths against temp libraries.
    import sys

    if "unittest" in sys.modules:
        return False
    return True


def schedule_open_reconcile_background(
    library_path: str,
    db_path: str,
    *,
    generation: int,
    on_complete: OnComplete = None,
    invalidate_caches: Optional[Callable[[], None]] = None,
) -> bool:
    """Start a daemon reconcile for ``generation``. Returns True if scheduled.

    Cancels any in-flight reconcile for a previous generation/library. No-op when
    disabled via ``PHOTOS_LIGHT_DISABLE_OPEN_RECONCILE`` or under unittest
    (opt in with ``PHOTOS_LIGHT_ENABLE_OPEN_RECONCILE``).
    """
    if not _open_reconcile_scheduling_enabled():
        return False
    if not library_path or not db_path:
        return False
    if not os.path.isdir(library_path):
        return False

    library_path = os.path.abspath(library_path)
    db_path = os.path.abspath(db_path)
    cancel_event = threading.Event()

    global _active_cancel, _active_generation, _active_library
    with _schedule_lock:
        if _active_cancel is not None:
            _active_cancel.set()
        _active_cancel = cancel_event
        _active_generation = generation
        _active_library = library_path

    def worker() -> None:
        def cancel_check() -> bool:
            return cancel_event.is_set()

        try:
            result = run_open_reconcile(
                library_path,
                db_path=db_path,
                cancel_check=cancel_check,
            )
        except Exception as exc:  # pragma: no cover - defensive
            result = OpenReconcileResult(
                library_path=library_path,
                errors=[str(exc)],
            )

        with _schedule_lock:
            still_active = (
                _active_generation == generation
                and _active_library == library_path
                and not cancel_event.is_set()
            )

        if still_active and not result.cancelled:
            if (
                invalidate_caches
                and (
                    result.ghosts_removed
                    or result.hashes_updated
                    or result.metadata_fixed
                )
            ):
                try:
                    invalidate_caches()
                except Exception:
                    pass
            print(
                "  🔄 Open reconcile complete: "
                f"ghosts={result.ghosts_removed} "
                f"size_drift={result.size_mismatched} "
                f"metadata_fixed={result.metadata_fixed} "
                f"hashes_updated={result.hashes_updated} "
                f"moles={result.moles_detected} "
                f"({result.elapsed_ms:.0f} ms)"
            )
            if on_complete:
                try:
                    on_complete(result)
                except Exception:
                    pass

    thread = threading.Thread(
        target=worker,
        daemon=True,
        name=f"OpenReconcile-{generation}",
    )
    thread.start()
    return True
