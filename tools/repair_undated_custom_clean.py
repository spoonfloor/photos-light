#!/usr/bin/env python3
"""
Custom undated-library cleanup: outcome ownership, not turnkey Clean.

Uses Clean repair primitives (canonicalize_photo_file, normalize_repair_file)
with pre-fixes Clean does not do (mislabeled .heic, ghost DB rows, forced
unknown date). 15s heartbeat throughout.
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from types import SimpleNamespace

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import app as photo_app
from file_operations import extract_exif_date, extract_exif_rating, strip_exif_rating
from hash_cache import HashCache
from library_cleanliness import (
    build_canonical_photo_path,
    is_supported_media_extension,
    media_kind_for_extension,
)
from library_filesystem import finalize_library_layout
from make_library_clean_v2 import read_dimensions, verify_media_file
from normalization_core import duplicate_row_for_hash
from normalization_repair import RepairDependencies, RepairFileError, normalize_repair_file
from photo_canonicalization import (
    UNKNOWN_PHOTO_DATE_OBJ,
    UNKNOWN_PHOTO_DATE_TAKEN,
    CanonicalizedPhoto,
    canonicalize_photo_file,
)

COHORT_SQL = "date_taken IS NULL OR date_taken LIKE '1900:01:01%'"
HEARTBEAT_SEC = 15
PER_FILE_TIMEOUT_SEC = 180
GHOST_DELETE_IDS = {65095}


class PerFileTimeout(Exception):
    pass


class StallAbort(Exception):
    pass


class ProgressReporter:
    def __init__(self, heartbeat_sec: int = HEARTBEAT_SEC):
        self.heartbeat_sec = heartbeat_sec
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.stall_abort = threading.Event()
        self.phase = "init"
        self.current_id: int | None = None
        self.current_path = ""
        self.index = 0
        self.total = 0
        self.ok = 0
        self.fail = 0
        self.skipped = 0
        self.file_started_at: float | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop_threads(self) -> None:
        self.stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _loop(self) -> None:
        while not self.stop.wait(self.heartbeat_sec):
            with self.lock:
                elapsed = (
                    time.monotonic() - self.file_started_at
                    if self.file_started_at is not None
                    else 0.0
                )
                print(
                    f"HEARTBEAT phase={self.phase} "
                    f"progress={self.index}/{self.total} "
                    f"current_id={self.current_id} "
                    f"file_elapsed={elapsed:.0f}s "
                    f"ok={self.ok} fail={self.fail} skipped={self.skipped} "
                    f"path={self.current_path}",
                    flush=True,
                )
                if self.file_started_at is not None and elapsed >= PER_FILE_TIMEOUT_SEC:
                    print(
                        f"STALL detected on id={self.current_id} after {elapsed:.0f}s — aborting",
                        flush=True,
                    )
                    self.stall_abort.set()

    def begin_file(self, phase: str, index: int, total: int, photo_id: int, path: str) -> None:
        with self.lock:
            self.phase = phase
            self.index = index
            self.total = total
            self.current_id = photo_id
            self.current_path = path
            self.file_started_at = time.monotonic()

    def end_file(self, *, success: bool = False, skipped: bool = False) -> None:
        with self.lock:
            if skipped:
                self.skipped += 1
            elif success:
                self.ok += 1
            else:
                self.fail += 1
            self.file_started_at = None
            self.current_id = None
            self.current_path = ""


def _timeout_handler(_signum, _frame):
    raise PerFileTimeout(f"exceeded {PER_FILE_TIMEOUT_SEC}s")


def run_with_timeout(fn, *args, **kwargs):
    previous = signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(PER_FILE_TIMEOUT_SEC)
    try:
        return fn(*args, **kwargs)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def is_jpeg_bytes_mislabeled_as_heic(file_path: str) -> bool:
    result = subprocess.run(
        ["file", "-b", file_path],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    return result.stdout.strip().lower().startswith("jpeg")


def backup_db(library_path: str, db_path: str) -> str:
    backup_dir = os.path.join(library_path, ".db_backups")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(backup_dir, f"photo_library_custom_clean_{stamp}.db")
    shutil.copy2(db_path, backup_path)
    return backup_path


def load_cohort_ids(conn) -> list[int]:
    rows = conn.execute(
        f"SELECT id FROM photos WHERE {COHORT_SQL} ORDER BY id"
    ).fetchall()
    return [int(row[0]) for row in rows]


def delete_ghost_rows(conn, library_path: str) -> list[tuple[int, str]]:
    removed: list[tuple[int, str]] = []
    cursor = conn.cursor()
    for row in conn.execute(
        f"SELECT id, current_path FROM photos WHERE {COHORT_SQL} ORDER BY id"
    ):
        photo_id = int(row[0])
        rel_path = row[1]
        if photo_id in GHOST_DELETE_IDS or not os.path.exists(
            os.path.join(library_path, rel_path)
        ):
            cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
            cursor.execute("DELETE FROM hash_cache WHERE file_path LIKE ?", (f"%{rel_path}",))
            removed.append((photo_id, rel_path))
    return removed


def fix_mislabeled_extension_on_disk(
    full_path: str,
    library_path: str,
    *,
    date_taken: str,
    content_hash: str,
) -> tuple[str, str]:
    """Rename JPEG-in-HEIC to .jpg before canonicalization."""
    new_rel, _ = build_canonical_photo_path(date_taken, content_hash, ".jpg")
    new_full = os.path.join(library_path, new_rel)
    if os.path.abspath(new_full) == os.path.abspath(full_path):
        return os.path.relpath(full_path, library_path), full_path

    os.makedirs(os.path.dirname(new_full), exist_ok=True)
    if os.path.exists(new_full):
        raise RepairFileError(f"collision renaming mislabeled HEIC to {new_rel}")
    shutil.move(full_path, new_full)
    photo_app.cleanup_empty_date_folders(full_path)
    return new_rel, new_full


def trash_duplicate_file(full_path: str, library_path: str) -> str:
    trash_dir = os.path.join(library_path, ".trash", "duplicates")
    os.makedirs(trash_dir, exist_ok=True)
    base = os.path.basename(full_path)
    candidate = os.path.join(trash_dir, base)
    counter = 1
    while os.path.exists(candidate):
        stem, ext = os.path.splitext(base)
        candidate = os.path.join(trash_dir, f"{stem}_{counter}{ext}")
        counter += 1
    shutil.move(full_path, candidate)
    return candidate


@dataclass
class CanonicalOutcome:
    status: str
    detail: str
    date_taken: str | None = None
    date_obj: datetime | None = None
    content_hash: str | None = None
    rel_path: str | None = None
    full_path: str | None = None
    ext: str | None = None
    file_type: str | None = None
    width: int | None = None
    height: int | None = None
    rating: int | None = None
    metadata_cleaned: bool = False


def canonicalize_photo_resilient(
    file_path: str,
    *,
    hash_cache: HashCache,
    forced_date_taken: str,
) -> CanonicalizedPhoto:
    """Canonicalize a photo; if EXIF write fails, still hash/move with forced date."""
    try:
        return canonicalize_photo_file(
            file_path,
            extract_exif_date=extract_exif_date,
            bake_orientation=photo_app.bake_orientation,
            get_dimensions=photo_app.get_image_dimensions,
            compute_hash=lambda path: hash_cache.get_hash(path)[0],
            write_photo_exif=photo_app.write_photo_exif,
            extract_exif_rating=extract_exif_rating,
            strip_exif_rating=strip_exif_rating,
            forced_date_taken=forced_date_taken,
        )
    except RuntimeError as exc:
        message = str(exc).lower()
        if "exif" not in message and "exiftool" not in message:
            raise

        date_taken, date_obj = UNKNOWN_PHOTO_DATE_TAKEN, UNKNOWN_PHOTO_DATE_OBJ
        baked, _, _ = photo_app.bake_orientation(file_path)
        rating = extract_exif_rating(file_path)
        if rating == 0:
            try:
                strip_exif_rating(file_path)
                rating = None
            except Exception:
                rating = None

        dimensions = photo_app.get_image_dimensions(file_path)
        width, height = dimensions if dimensions else (None, None)
        content_hash = hash_cache.get_hash(file_path)[0]
        if not content_hash:
            raise RuntimeError(f"Failed to compute hash after EXIF fallback: {file_path}") from exc

        relative_path, canonical_name = build_canonical_photo_path(
            date_taken,
            content_hash,
            os.path.splitext(file_path)[1],
        )
        return CanonicalizedPhoto(
            date_taken=date_taken,
            date_obj=date_obj,
            content_hash=content_hash,
            relative_path=relative_path,
            canonical_name=canonical_name,
            file_size=os.path.getsize(file_path),
            width=width,
            height=height,
            rating=rating if rating != 0 else None,
            metadata_changed=bool(baked),
            orientation_baked=bool(baked),
            rating_stripped=False,
        )


def canonicalize_one(
    photo_id: int,
    conn,
    *,
    library_path: str,
    hash_cache: HashCache,
) -> CanonicalOutcome:
    row = conn.execute(
        """
        SELECT id, current_path, date_taken, content_hash, file_type, rating
        FROM photos WHERE id = ?
        """,
        (photo_id,),
    ).fetchone()
    if not row:
        return CanonicalOutcome("missing_row", "photo not found")

    rel_path = row["current_path"]
    full_path = os.path.join(library_path, rel_path)
    if not os.path.exists(full_path):
        conn.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
        return CanonicalOutcome("ghost_deleted", f"deleted ghost row {photo_id}")

    date_taken = row["date_taken"] or UNKNOWN_PHOTO_DATE_TAKEN
    old_hash = row["content_hash"]
    ext = os.path.splitext(full_path)[1].lower()

    if ext == ".heic" and is_jpeg_bytes_mislabeled_as_heic(full_path):
        rel_path, full_path = fix_mislabeled_extension_on_disk(
            full_path,
            library_path,
            date_taken=date_taken,
            content_hash=old_hash,
        )
        ext = ".jpg"

    if not is_supported_media_extension(ext):
        return CanonicalOutcome("unsupported", f"unsupported extension {ext}")

    valid, reason = verify_media_file(full_path)
    if not valid:
        return CanonicalOutcome("corrupt", f"media validation failed: {reason}")

    file_type = media_kind_for_extension(ext) or "photo"
    metadata_cleaned = False
    width: int | None = None
    height: int | None = None
    rating = None if row["rating"] in (None, 0) else int(row["rating"])
    content_hash = old_hash

    if file_type == "photo":
        canonical_photo = canonicalize_photo_resilient(
            full_path,
            hash_cache=hash_cache,
            forced_date_taken=UNKNOWN_PHOTO_DATE_TAKEN,
        )
        date_taken = canonical_photo.date_taken
        date_obj = canonical_photo.date_obj
        content_hash = canonical_photo.content_hash
        width = canonical_photo.width
        height = canonical_photo.height
        rating = canonical_photo.rating
        metadata_cleaned = canonical_photo.metadata_changed
    else:
        photo_app.write_video_metadata(full_path, UNKNOWN_PHOTO_DATE_TAKEN)
        content_hash, _ = hash_cache.get_hash(full_path)
        if not content_hash:
            return CanonicalOutcome("hash_failed", "could not hash video")
        dims = read_dimensions(full_path)
        width, height = dims if dims else (None, None)
        date_taken = UNKNOWN_PHOTO_DATE_TAKEN
        date_obj = UNKNOWN_PHOTO_DATE_OBJ
        metadata_cleaned = True

    duplicate = duplicate_row_for_hash(conn, content_hash)
    if duplicate and int(duplicate["id"]) != photo_id:
        trash_duplicate_file(full_path, library_path)
        conn.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
        if old_hash and old_hash != content_hash:
            photo_app.delete_thumbnail_for_hash(old_hash)
        return CanonicalOutcome(
            "duplicate_removed",
            f"trashed duplicate of id={duplicate['id']} ({duplicate['current_path']})",
        )

    record = SimpleNamespace(
        date_taken=date_taken,
        content_hash=content_hash,
        ext=ext,
        full_path=full_path,
        rel_path=rel_path,
        source_rel_path=rel_path,
        has_metadata_cleanup_signal=metadata_cleaned,
    )

    try:
        repair_result = normalize_repair_file(
            record,
            RepairDependencies(library_path=library_path),
        )
    except RepairFileError as exc:
        return CanonicalOutcome("repair_failed", str(exc))

    target_rel = repair_result.target_rel_path
    target_full = repair_result.target_full_path
    if repair_result.moved:
        photo_app.cleanup_empty_date_folders(full_path)

    file_size = os.path.getsize(target_full)
    conn.execute(
        """
        UPDATE photos
        SET date_taken = ?,
            current_path = ?,
            original_filename = ?,
            content_hash = ?,
            file_size = ?,
            file_type = ?,
            width = ?,
            height = ?,
            rating = ?
        WHERE id = ?
        """,
        (
            date_taken,
            target_rel,
            os.path.basename(target_rel),
            content_hash,
            file_size,
            file_type,
            width,
            height,
            rating,
            photo_id,
        ),
    )

    return CanonicalOutcome(
        status=repair_result.status,
        detail=target_rel,
        date_taken=date_taken,
        date_obj=date_obj,
        content_hash=content_hash,
        rel_path=target_rel,
        full_path=target_full,
        ext=ext,
        file_type=file_type,
        width=width,
        height=height,
        rating=rating,
        metadata_cleaned=metadata_cleaned,
    )


def verify_cohort_clean(conn, library_path: str) -> tuple[bool, list[tuple]]:
    problems: list[tuple] = []
    for row in conn.execute(
        f"""
        SELECT id, current_path, date_taken, content_hash, file_type
        FROM photos WHERE {COHORT_SQL}
        ORDER BY id
        """
    ):
        rel_path = row["current_path"]
        date_taken = row["date_taken"]
        issues: list[str] = []

        if date_taken != UNKNOWN_PHOTO_DATE_TAKEN:
            issues.append(f"bad_date:{date_taken}")
        if not rel_path.startswith("1900/1900-01-01/"):
            issues.append("wrong_folder")
        if os.path.basename(rel_path).startswith("mov_"):
            issues.append("legacy_mov_name")

        full_path = os.path.join(library_path, rel_path)
        if not os.path.exists(full_path):
            issues.append("missing_on_disk")
        else:
            ext = os.path.splitext(rel_path)[1]
            expected_rel, expected_name = build_canonical_photo_path(
                UNKNOWN_PHOTO_DATE_TAKEN,
                row["content_hash"],
                ext,
            )
            if rel_path != expected_rel:
                issues.append(f"path_not_canonical:{expected_rel}")
            if os.path.basename(rel_path) != expected_name:
                issues.append(f"name_not_canonical:{expected_name}")
            if rel_path.lower().endswith(".heic") and is_jpeg_bytes_mislabeled_as_heic(
                full_path
            ):
                issues.append("jpeg_mislabeled_as_heic")

        if issues:
            problems.append((row["id"], rel_path, issues))

    return len(problems) == 0, problems


def run(library_path: str, db_path: str) -> int:
    photo_app.update_app_paths(library_path, db_path)
    backup_path = backup_db(library_path, db_path)
    print(f"DB backup: {backup_path}", flush=True)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    print("=== PHASE 0: ghost row cleanup ===", flush=True)
    work_conn = photo_app.get_db_connection()
    try:
        removed = delete_ghost_rows(work_conn, library_path)
        work_conn.commit()
        for photo_id, path in removed:
            print(f"GHOST deleted id={photo_id} path={path}", flush=True)
        print(f"PHASE 0 removed={len(removed)}", flush=True)
    finally:
        work_conn.close()

    cohort_ids = load_cohort_ids(conn)
    print(f"PLAN canonicalize={len(cohort_ids)} files", flush=True)

    reporter = ProgressReporter()
    reporter.start()
    failures: list[tuple[int, str]] = []

    try:
        print("\n=== PHASE 1: canonicalize cohort ===", flush=True)
        total = len(cohort_ids)
        for index, photo_id in enumerate(cohort_ids, start=1):
            if reporter.stall_abort.is_set():
                raise StallAbort("stall during canonicalize")

            row = conn.execute(
                "SELECT current_path FROM photos WHERE id = ?", (photo_id,)
            ).fetchone()
            path = row["current_path"] if row else "(deleted)"
            reporter.begin_file("canonicalize", index, total, photo_id, path)

            work_conn = photo_app.get_db_connection()
            hash_cache = HashCache(work_conn)
            try:
                outcome = run_with_timeout(
                    canonicalize_one,
                    photo_id,
                    work_conn,
                    library_path=library_path,
                    hash_cache=hash_cache,
                )
                if outcome.status in {
                    "ghost_deleted",
                    "duplicate_removed",
                    "unchanged",
                    "already_moved",
                    "moved",
                }:
                    work_conn.commit()
                    print(
                        f"DONE [{index}/{total}] id={photo_id} "
                        f"status={outcome.status} -> {outcome.detail}",
                        flush=True,
                    )
                    reporter.end_file(
                        success=True,
                        skipped=outcome.status in {"ghost_deleted", "duplicate_removed"},
                    )
                else:
                    work_conn.rollback()
                    failures.append((photo_id, f"{outcome.status}: {outcome.detail}"))
                    print(
                        f"FAIL [{index}/{total}] id={photo_id} "
                        f"status={outcome.status} -> {outcome.detail}",
                        flush=True,
                    )
                    reporter.end_file(success=False)
            except PerFileTimeout as exc:
                work_conn.rollback()
                failures.append((photo_id, str(exc)))
                print(f"TIMEOUT [{index}/{total}] id={photo_id} -> {exc}", flush=True)
                reporter.stall_abort.set()
                reporter.end_file(success=False)
                raise StallAbort(str(exc)) from exc
            except Exception as exc:
                work_conn.rollback()
                failures.append((photo_id, str(exc)))
                print(f"ERROR [{index}/{total}] id={photo_id} -> {exc}", flush=True)
                reporter.end_file(success=False)
            finally:
                work_conn.close()

        print("\n=== PHASE 2: empty folder cleanup ===", flush=True)
        removed_dirs, stragglers = finalize_library_layout(library_path)
        print(f"PHASE 2 removed_dirs={removed_dirs} stragglers={len(stragglers)}", flush=True)

        print("\n=== PHASE 3: verify cohort ===", flush=True)
        clean, problems = verify_cohort_clean(conn, library_path)
        print(
            f"VERIFY clean={clean} problems={len(problems)} "
            f"ok={reporter.ok} fail={reporter.fail} skipped={reporter.skipped}",
            flush=True,
        )
        if problems:
            for photo_id, path, issues in problems[:30]:
                print(f"  id={photo_id} {path} {issues}", flush=True)
        if failures:
            print(f"FAILURES during run: {len(failures)}", flush=True)
            for photo_id, detail in failures[:20]:
                print(f"  id={photo_id}: {detail}", flush=True)

        if failures or not clean:
            return 1
        return 0
    finally:
        reporter.stop_threads()
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--library-path", default="/Volumes/eric_files/photo_library")
    parser.add_argument("--db-path", default="")
    args = parser.parse_args()
    db_path = args.db_path or os.path.join(args.library_path, ".library", "photo_library.db")
    return run(args.library_path, db_path)


if __name__ == "__main__":
    raise SystemExit(main())
