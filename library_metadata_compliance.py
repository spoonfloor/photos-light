"""
Shared library metadata compliance pass before ``run_fast_library_audit``.

Clean and Convert both call ``ensure_library_metadata_compliant`` so the same
auto-fixable metadata work runs before the shared audit gate. Audit remains the
single truth test; this module owns only the prep slice.

Compliance spec (mirrors ``run_fast_library_audit`` with ``include_metadata_checks``):

Auto-fix (this module):
  - ``rating_zero`` — strip EXIF rating=0 via ``strip_exif_rating``
  - ``unbaked_rotation`` — bake orientation when losslessly bakeable (photos via
    ``canonicalize_photo_file``; videos via ``bake_orientation``)

Blocking (audit only; not repaired here):
  - ``corrupted_media``, layout/path issues, ``db_hash_mismatch``, mole/ghost DB
    drift, duplicate media, unsupported files, etc.
"""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from file_operations import (
    extract_exif_date,
    extract_exif_rating,
    get_dimensions,
    strip_exif_rating,
)
from hash_cache import HashCache
from library_cleanliness import IGNORED_LIBRARY_FILES, is_supported_media_extension
from library_filesystem import iter_library_walk
from library_layout import resolve_db_path
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
from clean_library_fast_audit import verify_media_file

ProgressCallback = Optional[Callable[[Dict[str, Any]], None]]
CancelCheck = Optional[Callable[[], bool]]


METADATA_COMPLIANCE_SPEC: Dict[str, Any] = {
    "audit_metadata_kinds": ["rating_zero", "unbaked_rotation"],
    "auto_fix_kinds": ["rating_zero", "unbaked_rotation"],
    "blocking_kinds": [
        "corrupted_media",
        "misnamed_or_misfiled",
        "noncanonical_root_file",
        "noncanonical_root_folder",
        "noncanonical_folder",
        "empty_folder",
        "duplicate_media",
        "unsupported_or_nonmedia",
        "ghost_db_reference",
        "mole_missing_from_db",
        "db_hash_mismatch",
        "missing_library_metadata_dir",
        "missing_library_db",
        "invalid_library_db",
        "unexpected_library_metadata_dir",
        "unexpected_library_metadata_file",
    ],
}


class MetadataComplianceCancelled(RuntimeError):
    """Raised when a compliance pass is cancelled mid-run."""


@dataclass
class MetadataComplianceStats:
    files_scanned: int = 0
    files_fixed: int = 0
    rating_stripped: int = 0
    orientation_baked: int = 0
    db_rows_updated: int = 0
    errors: List[str] = field(default_factory=list)


def _default_repair_scan_dependencies(
    library_path: str,
    *,
    hash_cache: Optional[HashCache] = None,
    db_conn: Optional[sqlite3.Connection] = None,
) -> RepairScanDependencies:
    if hash_cache is None:
        if db_conn is None:
            raise ValueError("hash_cache or db_conn is required for metadata compliance")
        hash_cache = HashCache(db_conn)
    return RepairScanDependencies(
        hash_cache=hash_cache,
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


def _emit(callback: ProgressCallback, payload: Dict[str, Any]) -> None:
    if callback:
        callback(payload)


def _raise_if_cancelled(cancel_check: CancelCheck) -> None:
    if cancel_check and cancel_check():
        raise MetadataComplianceCancelled()


def _count_supported_media_leaf_files(library_path: str) -> int:
    count = 0
    for _root, _dirs, files in iter_library_walk(library_path):
        for filename in files:
            if filename in IGNORED_LIBRARY_FILES:
                continue
            ext = os.path.splitext(filename)[1].lower()
            if is_supported_media_extension(ext):
                count += 1
    return count


def ensure_library_metadata_compliant(
    library_path: str,
    *,
    db_path: Optional[str] = None,
    db_conn: Optional[sqlite3.Connection] = None,
    hash_cache: Optional[HashCache] = None,
    deps: Optional[RepairScanDependencies] = None,
    progress_callback: ProgressCallback = None,
    cancel_check: CancelCheck = None,
    progress_total: Optional[int] = None,
) -> MetadataComplianceStats:
    """
    Walk in-library media and apply auto-fixable metadata compliance fixes.

    Returns stats; does not run layout, dedupe, or blocking-issue repair.
    Call ``run_fast_library_audit`` afterward as the sole cleanliness gate.
    """
    library_path = os.path.abspath(library_path)
    stats = MetadataComplianceStats()

    own_conn = False
    conn = db_conn
    if conn is None and db_path is not None:
        resolved_db = resolve_db_path(library_path, db_path)
        if os.path.exists(resolved_db):
            conn = sqlite3.connect(resolved_db)
            conn.row_factory = sqlite3.Row
            own_conn = True

    scan_deps = deps or _default_repair_scan_dependencies(
        library_path,
        hash_cache=hash_cache,
        db_conn=conn,
    )

    total = progress_total
    if total is None:
        total = max(_count_supported_media_leaf_files(library_path), 1)

    _emit(
        progress_callback,
        {
            "type": "phase",
            "phase": "compliance",
            "status": "starting",
            "total": total,
        },
    )

    processed = 0
    try:
        for root, _dirs, files in iter_library_walk(library_path):
            _raise_if_cancelled(cancel_check)
            for filename in files:
                _raise_if_cancelled(cancel_check)
                if filename in IGNORED_LIBRARY_FILES:
                    continue

                full_path = os.path.join(root, filename)
                rel_path = os.path.relpath(full_path, library_path)
                ext = os.path.splitext(filename)[1].lower()
                if not is_supported_media_extension(ext):
                    continue

                valid, _ = verify_media_file(full_path)
                if not valid:
                    continue

                stats.files_scanned += 1
                processed += 1
                _emit(
                    progress_callback,
                    {
                        "type": "progress",
                        "phase": "compliance",
                        "processed": processed,
                        "total": total,
                    },
                )

                try:
                    result = repair_file_metadata_compliance(
                        full_path,
                        ext=ext,
                        deps=scan_deps,
                    )
                except RepairFileError as exc:
                    stats.errors.append(str(exc).replace(full_path, rel_path))
                    continue

                if not result.fixed:
                    continue

                stats.files_fixed += 1
                for event in result.log_events:
                    if event.action == "rating_stripped":
                        stats.rating_stripped += 1
                    elif event.action == "orientation_baked":
                        stats.orientation_baked += 1

                if conn is not None and result.content_hash:
                    file_size = result.file_size
                    if file_size is None:
                        file_size = os.path.getsize(full_path)
                    row = conn.execute(
                        "SELECT id, content_hash FROM photos WHERE current_path = ?",
                        (rel_path,),
                    ).fetchone()
                    if row is not None and row["content_hash"] != result.content_hash:
                        conn.execute(
                            """
                            UPDATE photos
                            SET content_hash = ?, file_size = ?
                            WHERE current_path = ?
                            """,
                            (result.content_hash, file_size, rel_path),
                        )
                        conn.commit()
                        stats.db_rows_updated += 1
    finally:
        if own_conn and conn is not None:
            conn.close()

    _emit(
        progress_callback,
        {
            "type": "phase",
            "phase": "compliance",
            "status": "complete",
            "files_fixed": stats.files_fixed,
        },
    )
    return stats
