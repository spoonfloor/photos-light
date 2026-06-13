#!/usr/bin/env python3
"""
Phased undated-library repair with heartbeat logging and stall detection.

Phase 1: fix broken cohort (full pipeline where needed)
Phase 2: fix untouched cohort (fast move+DB) — only if phase 1 verifies clean
"""

from __future__ import annotations

import argparse
import os
import signal
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import app as photo_app
from library_cleanliness import build_canonical_photo_path
from media_finalization import finalize_mutated_media
from photo_canonicalization import UNKNOWN_PHOTO_DATE_TAKEN, write_photo_date_metadata

COHORT_SQL = "current_path LIKE '%19000101_%'"
HEARTBEAT_SEC = 15
PER_FILE_TIMEOUT_SEC = 180


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
                    f"ok={self.ok} fail={self.fail} "
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

    def end_file(self, success: bool) -> None:
        with self.lock:
            if success:
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


def classify_row(row, library_path: str) -> tuple[int, list[str]]:
    rel_path = row["current_path"]
    date_taken = row["date_taken"]
    full_path = os.path.join(library_path, rel_path)
    problems: list[str] = []

    if date_taken is None:
        if not os.path.exists(full_path):
            problems.append("missing_on_disk")
        return 1, problems

    if date_taken != UNKNOWN_PHOTO_DATE_TAKEN:
        problems.append(f"unexpected_date:{date_taken}")
    if not rel_path.startswith("1900/1900-01-01/"):
        problems.append("wrong_folder")
    if os.path.basename(rel_path).startswith("mov_"):
        problems.append("legacy_mov_name")
    if not os.path.exists(full_path):
        problems.append("missing_on_disk")
    else:
        ext = os.path.splitext(rel_path)[1]
        expected_rel, expected_name = build_canonical_photo_path(
            UNKNOWN_PHOTO_DATE_TAKEN,
            row["content_hash"],
            ext,
        )
        if rel_path != expected_rel:
            problems.append(f"path_not_canonical:expected={expected_rel}")
        if basename := os.path.basename(rel_path):
            if basename != expected_name:
                problems.append(f"name_not_canonical:expected={expected_name}")
        if rel_path.lower().endswith(".heic") and is_jpeg_bytes_mislabeled_as_heic(full_path):
            problems.append("jpeg_mislabeled_as_heic")

    if problems:
        return 3, problems
    return 2, problems


def load_cohort(conn) -> list[sqlite3.Row]:
    return conn.execute(
        f"""
        SELECT id, current_path, date_taken, content_hash, file_type
        FROM photos
        WHERE {COHORT_SQL}
        ORDER BY id
        """
    ).fetchall()


def split_work_items(rows, library_path: str) -> tuple[list[tuple], list[tuple]]:
    broken: list[tuple] = []
    untouched: list[tuple] = []
    for row in rows:
        status, problems = classify_row(row, library_path)
        item = (row["id"], row["current_path"], problems)
        if status == 1:
            untouched.append(item)
        elif status == 3:
            broken.append(item)
    return broken, untouched


def fix_mislabeled_jpeg_heic(photo_id: int, conn) -> tuple[bool, str]:
    cursor = conn.cursor()
    row = cursor.execute(
        "SELECT current_path, date_taken, content_hash FROM photos WHERE id = ?",
        (photo_id,),
    ).fetchone()
    if not row:
        return False, "photo not found"

    rel_path = row["current_path"]
    full_path = os.path.join(photo_app.LIBRARY_PATH, rel_path)
    if not os.path.exists(full_path):
        return False, "file missing on disk"
    if not is_jpeg_bytes_mislabeled_as_heic(full_path):
        return False, "not JPEG bytes"

    date_taken = row["date_taken"] or UNKNOWN_PHOTO_DATE_TAKEN
    old_hash = row["content_hash"]

    new_rel_path, _ = build_canonical_photo_path(date_taken, old_hash, ".jpg")
    new_full_path = os.path.join(photo_app.LIBRARY_PATH, new_rel_path)
    os.makedirs(os.path.dirname(new_full_path), exist_ok=True)

    if os.path.abspath(new_full_path) != os.path.abspath(full_path):
        if os.path.exists(new_full_path):
            return False, f"collision: {new_rel_path}"
        shutil.move(full_path, new_full_path)
        full_path = new_full_path
        rel_path = new_rel_path

    write_photo_date_metadata(full_path, date_taken)

    finalize_result = finalize_mutated_media(
        conn=conn,
        photo_id=photo_id,
        library_path=photo_app.LIBRARY_PATH,
        current_rel_path=rel_path,
        date_taken=date_taken,
        old_hash=old_hash,
        build_canonical_path=build_canonical_photo_path,
        compute_hash=photo_app.compute_full_hash,
        get_dimensions=photo_app.get_image_dimensions,
        delete_thumbnail_for_hash=photo_app.delete_thumbnail_for_hash,
        duplicate_policy="trash",
        duplicate_trash_dir=os.path.join(photo_app.TRASH_DIR, "duplicates"),
    )
    if finalize_result.status == "duplicate_removed":
        return False, "duplicate_removed"

    cursor.execute(
        """
        UPDATE photos
        SET date_taken = ?, original_filename = ?, current_path = ?
        WHERE id = ?
        """,
        (
            date_taken,
            os.path.basename(finalize_result.current_path or rel_path),
            finalize_result.current_path or rel_path,
            photo_id,
        ),
    )
    return True, finalize_result.current_path or rel_path


def apply_unknown_date_slow(photo_id: int, conn) -> tuple[bool, str]:
    success, result, _transaction = photo_app.update_photo_date_with_files(
        photo_id,
        UNKNOWN_PHOTO_DATE_TAKEN,
        conn,
    )
    if not success:
        return False, str(result.get("error", result))
    if result.get("status") == "duplicate_removed":
        return False, "duplicate_removed"
    return True, result.get("current_path", "updated")


def apply_unknown_date_fast(photo_id: int, conn) -> tuple[bool, str]:
    cursor = conn.cursor()
    row = cursor.execute(
        "SELECT current_path, content_hash FROM photos WHERE id = ?",
        (photo_id,),
    ).fetchone()
    if not row:
        return False, "photo not found"

    old_rel_path = row["current_path"]
    old_full_path = os.path.join(photo_app.LIBRARY_PATH, old_rel_path)
    if not os.path.exists(old_full_path):
        return False, "file missing on disk"

    ext = os.path.splitext(old_rel_path)[1]
    new_rel_path, new_filename = build_canonical_photo_path(
        UNKNOWN_PHOTO_DATE_TAKEN,
        row["content_hash"],
        ext,
    )
    new_full_path = os.path.join(photo_app.LIBRARY_PATH, new_rel_path)

    if os.path.abspath(new_full_path) != os.path.abspath(old_full_path):
        os.makedirs(os.path.dirname(new_full_path), exist_ok=True)
        if os.path.exists(new_full_path):
            return False, f"collision: {new_rel_path}"
        shutil.move(old_full_path, new_full_path)
        photo_app.cleanup_empty_date_folders(old_full_path)

    cursor.execute(
        """
        UPDATE photos
        SET date_taken = ?, current_path = ?, original_filename = ?
        WHERE id = ?
        """,
        (UNKNOWN_PHOTO_DATE_TAKEN, new_rel_path, new_filename, photo_id),
    )
    return True, new_rel_path


def pick_broken_handler(problems: list[str]):
    if any("jpeg_mislabeled_as_heic" in p for p in problems):
        return "fake_heic", fix_mislabeled_jpeg_heic
    return "full_pipeline", apply_unknown_date_slow


def process_items(
    phase: str,
    items: list[tuple],
    handler,
    reporter: ProgressReporter,
) -> list[tuple[int, str]]:
    failures: list[tuple[int, str]] = []
    total = len(items)
    for index, (photo_id, path, _problems) in enumerate(items, start=1):
        if reporter.stall_abort.is_set():
            raise StallAbort(f"stalled during phase={phase}")

        reporter.begin_file(phase, index, total, photo_id, path)
        work_conn = photo_app.get_db_connection()
        try:
            ok, detail = run_with_timeout(handler, photo_id, work_conn)
            if ok:
                work_conn.commit()
                print(
                    f"DONE [{index}/{total}] phase={phase} id={photo_id} ok -> {detail}",
                    flush=True,
                )
                reporter.end_file(True)
            else:
                work_conn.rollback()
                failures.append((photo_id, detail))
                print(
                    f"FAIL [{index}/{total}] phase={phase} id={photo_id} -> {detail}",
                    flush=True,
                )
                reporter.end_file(False)
        except PerFileTimeout as exc:
            work_conn.rollback()
            failures.append((photo_id, str(exc)))
            print(
                f"TIMEOUT [{index}/{total}] phase={phase} id={photo_id} -> {exc}",
                flush=True,
            )
            reporter.stall_abort.set()
            reporter.end_file(False)
            raise StallAbort(str(exc)) from exc
        except Exception as exc:
            work_conn.rollback()
            failures.append((photo_id, str(exc)))
            print(
                f"ERROR [{index}/{total}] phase={phase} id={photo_id} -> {exc}",
                flush=True,
            )
            reporter.end_file(False)
            if phase == "broken":
                raise
        finally:
            work_conn.close()
    return failures


def verify_broken_clean(conn, library_path: str, broken_ids: set[int]) -> tuple[bool, list]:
    rows = load_cohort(conn)
    remaining = []
    for row in rows:
        if row["id"] not in broken_ids:
            continue
        status, problems = classify_row(row, library_path)
        if status != 2:
            remaining.append((row["id"], row["current_path"], problems))
    return len(remaining) == 0, remaining


def backup_db(library_path: str, db_path: str) -> str:
    backup_dir = os.path.join(library_path, ".db_backups")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(backup_dir, f"photo_library_phased_repair_{stamp}.db")
    shutil.copy2(db_path, backup_path)
    return backup_path


def run(library_path: str, db_path: str) -> int:
    photo_app.update_app_paths(library_path, db_path)
    backup_path = backup_db(library_path, db_path)
    print(f"DB backup: {backup_path}", flush=True)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = load_cohort(conn)
    broken_items, untouched_items = split_work_items(rows, library_path)
    broken_ids = {item[0] for item in broken_items}

    print(
        f"PLAN broken={len(broken_items)} untouched={len(untouched_items)} total={len(rows)}",
        flush=True,
    )

    reporter = ProgressReporter()
    reporter.start()

    try:
        print("\n=== PHASE 1: broken files (full pipeline) ===", flush=True)
        broken_failures: list[tuple[int, str]] = []
        for index, (photo_id, path, problems) in enumerate(broken_items, start=1):
            if reporter.stall_abort.is_set():
                raise StallAbort("stall before broken file")

            handler_name, handler = pick_broken_handler(problems)
            reporter.begin_file(f"broken:{handler_name}", index, len(broken_items), photo_id, path)
            work_conn = photo_app.get_db_connection()
            try:
                ok, detail = run_with_timeout(handler, photo_id, work_conn)
                if ok:
                    work_conn.commit()
                    print(
                        f"DONE [{index}/{len(broken_items)}] broken id={photo_id} "
                        f"handler={handler_name} -> {detail}",
                        flush=True,
                    )
                    reporter.end_file(True)
                else:
                    work_conn.rollback()
                    broken_failures.append((photo_id, detail))
                    print(
                        f"FAIL [{index}/{len(broken_items)}] broken id={photo_id} -> {detail}",
                        flush=True,
                    )
                    reporter.end_file(False)
                    print("Phase 1 failed — stopping before untouched cohort.", flush=True)
                    return 1
            except (PerFileTimeout, StallAbort) as exc:
                work_conn.rollback()
                print(f"SAFE STOP: {exc}", flush=True)
                return 2
            except Exception as exc:
                work_conn.rollback()
                print(f"SAFE STOP on id={photo_id}: {exc}", flush=True)
                return 2
            finally:
                work_conn.close()

        clean, remaining = verify_broken_clean(conn, library_path, broken_ids)
        print(
            f"PHASE 1 VERIFY clean={clean} remaining_problems={len(remaining)}",
            flush=True,
        )
        if not clean:
            for item in remaining:
                print(f"  still broken id={item[0]} {item[1]} {item[2]}", flush=True)
            print("Phase 1 verify failed — stopping.", flush=True)
            return 1

        print("\n=== PHASE 2: untouched files (fast move+DB) ===", flush=True)
        untouched_failures = process_items(
            "untouched",
            untouched_items,
            apply_unknown_date_fast,
            reporter,
        )
        if untouched_failures:
            print(f"Phase 2 failures: {len(untouched_failures)}", flush=True)
            for photo_id, detail in untouched_failures[:20]:
                print(f"  id={photo_id}: {detail}", flush=True)
            return 1

        final_broken, final_untouched = split_work_items(load_cohort(conn), library_path)
        print(
            f"\nFINAL broken={len(final_broken)} untouched={len(final_untouched)} "
            f"ok={reporter.ok} fail={reporter.fail}",
            flush=True,
        )
        if final_broken or final_untouched:
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
