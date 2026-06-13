#!/usr/bin/env python3
"""
One-shot repair for undated library photos:
- NULL date_taken -> 1900:01:01 00:00:00 + canonical 1900/1900-01-01/ path
- Legacy mov_* at 1900:01:01 -> canonical img_* via same date-edit pipeline
- JPEG bytes mislabeled as .heic -> .jpg via finalize + EXIF write
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import app as photo_app
from library_cleanliness import build_canonical_photo_path
from media_finalization import finalize_mutated_media
from photo_canonicalization import UNKNOWN_PHOTO_DATE_TAKEN, write_photo_date_metadata


def is_jpeg_bytes_mislabeled_as_heic(file_path: str) -> bool:
    result = subprocess.run(
        ["file", "-b", file_path],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    return result.stdout.strip().lower().startswith("jpeg")


def fix_mislabeled_jpeg_heic(photo_id: int, conn) -> tuple[bool, str]:
    cursor = conn.cursor()
    row = cursor.execute(
        "SELECT current_path, date_taken, content_hash, file_type FROM photos WHERE id = ?",
        (photo_id,),
    ).fetchone()
    if not row:
        return False, "photo not found"

    rel_path = row["current_path"]
    full_path = os.path.join(photo_app.LIBRARY_PATH, rel_path)
    if not os.path.exists(full_path):
        return False, "file missing on disk"
    if not rel_path.lower().endswith(".heic"):
        return False, "not a .heic path"
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

    try:
        write_photo_date_metadata(full_path, date_taken)
    except Exception as exc:
        return False, f"EXIF write on .jpg failed: {exc}"

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
        return False, "became duplicate after .jpg fix"

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


def apply_unknown_date_fast(photo_id: int, conn) -> tuple[bool, str]:
    """Move to canonical 1900/1900-01-01/ path and set DB date without re-encoding."""
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


def fetch_photo_ids(conn, query: str, params=()) -> list[int]:
    return [row[0] for row in conn.execute(query, params).fetchall()]


def verify_library(conn) -> dict:
    stats = {}
    stats["null_date"] = conn.execute(
        "SELECT COUNT(*) FROM photos WHERE date_taken IS NULL"
    ).fetchone()[0]
    stats["unknown_date"] = conn.execute(
        "SELECT COUNT(*) FROM photos WHERE date_taken LIKE '1900:01:01%'"
    ).fetchone()[0]
    stats["null_or_unknown_wrong_folder"] = conn.execute(
        """
        SELECT COUNT(*) FROM photos
        WHERE (date_taken IS NULL OR date_taken LIKE '1900:01:01%')
          AND current_path NOT LIKE '1900/1900-01-01/%'
        """
    ).fetchone()[0]
    stats["null_in_2025"] = conn.execute(
        """
        SELECT COUNT(*) FROM photos
        WHERE date_taken IS NULL AND current_path LIKE '2025/%'
        """
    ).fetchone()[0]
    stats["legacy_mov_unknown"] = conn.execute(
        """
        SELECT COUNT(*) FROM photos
        WHERE date_taken LIKE '1900:01:01%'
          AND current_path LIKE '%/mov_%'
        """
    ).fetchone()[0]
    stats["fake_heic_unknown"] = 0
    rows = conn.execute(
        """
        SELECT id, current_path FROM photos
        WHERE current_path LIKE '%img_19000101_%'
          AND current_path LIKE '%.heic'
          AND (date_taken IS NULL OR date_taken LIKE '1900:01:01%')
        """
    ).fetchall()
    for row in rows:
        full_path = os.path.join(photo_app.LIBRARY_PATH, row["current_path"])
        if os.path.exists(full_path) and is_jpeg_bytes_mislabeled_as_heic(full_path):
            stats["fake_heic_unknown"] += 1
    return stats


def backup_db(library_path: str, db_path: str) -> str:
    backup_dir = os.path.join(library_path, ".db_backups")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(backup_dir, f"photo_library_undated_fix_{stamp}.db")
    shutil.copy2(db_path, backup_path)
    return backup_path


def run_batch(library_path: str, db_path: str, *, use_slow_path: bool = False) -> int:
    photo_app.update_app_paths(library_path, db_path)
    backup_path = backup_db(library_path, db_path)
    print(f"DB backup: {backup_path}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    before = verify_library(conn)
    print("Before:", before)

    null_ids = fetch_photo_ids(
        conn,
        "SELECT id FROM photos WHERE date_taken IS NULL ORDER BY id",
    )
    legacy_mov_ids = fetch_photo_ids(
        conn,
        """
        SELECT id FROM photos
        WHERE date_taken LIKE '1900:01:01%'
          AND current_path LIKE '%/mov_%'
        ORDER BY id
        """,
    )
    fake_heic_ids = []
    for row in conn.execute(
        """
        SELECT id, current_path FROM photos
        WHERE current_path LIKE '%.heic'
          AND (date_taken IS NULL OR date_taken LIKE '1900:01:01%')
        ORDER BY id
        """
    ):
        full_path = os.path.join(library_path, row["current_path"])
        if os.path.exists(full_path) and is_jpeg_bytes_mislabeled_as_heic(full_path):
            fake_heic_ids.append(row["id"])

    apply_unknown_date = apply_unknown_date_slow if use_slow_path else apply_unknown_date_fast
    phases = [
        ("null_date", null_ids, apply_unknown_date),
        ("legacy_mov", legacy_mov_ids, apply_unknown_date),
        ("fake_heic", fake_heic_ids, fix_mislabeled_jpeg_heic),
    ]

    failures: list[tuple[str, int, str]] = []
    totals = {"ok": 0, "fail": 0}

    for phase_name, photo_ids, handler in phases:
        print(f"\n=== {phase_name}: {len(photo_ids)} photos ===")
        for index, photo_id in enumerate(photo_ids, start=1):
            work_conn = photo_app.get_db_connection()
            try:
                ok, detail = handler(photo_id, work_conn)
                if ok:
                    work_conn.commit()
                    totals["ok"] += 1
                    if index <= 5 or index % 25 == 0 or index == len(photo_ids):
                        print(f"  [{index}/{len(photo_ids)}] id={photo_id} ok -> {detail}")
                else:
                    work_conn.rollback()
                    totals["fail"] += 1
                    failures.append((phase_name, photo_id, detail))
                    print(f"  [{index}/{len(photo_ids)}] id={photo_id} FAIL: {detail}")
            except Exception as exc:
                work_conn.rollback()
                totals["fail"] += 1
                failures.append((phase_name, photo_id, str(exc)))
                print(f"  [{index}/{len(photo_ids)}] id={photo_id} EXCEPTION: {exc}")
            finally:
                work_conn.close()

    after = verify_library(conn)
    conn.close()

    print("\n=== Done ===")
    print("Totals:", totals)
    print("After:", after)
    if failures:
        print(f"Failures ({len(failures)}):")
        for phase_name, photo_id, detail in failures[:30]:
            print(f"  {phase_name} id={photo_id}: {detail}")
        if len(failures) > 30:
            print(f"  ... and {len(failures) - 30} more")
        return 1
    if after["null_date"] or after["null_or_unknown_wrong_folder"] or after["fake_heic_unknown"]:
        print("Verification incomplete.")
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--library-path",
        default="/Volumes/eric_files/photo_library",
    )
    parser.add_argument(
        "--db-path",
        default="",
    )
    parser.add_argument(
        "--slow",
        action="store_true",
        help="Use full date-edit pipeline (EXIF write + re-hash) per file",
    )
    args = parser.parse_args()
    db_path = args.db_path or os.path.join(args.library_path, ".library", "photo_library.db")
    return run_batch(args.library_path, db_path, use_slow_path=args.slow)


if __name__ == "__main__":
    raise SystemExit(main())
