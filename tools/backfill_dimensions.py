#!/usr/bin/env python3
"""Backfill width/height for existing photos rows without rehashing or renaming."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from file_operations import get_dimensions
from library_cleanliness import VIDEO_MEDIA_EXTENSIONS
from library_layout import resolve_db_path


def get_video_dimensions(file_path: str) -> tuple[int | None, int | None]:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_streams",
                file_path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None, None
        data = json.loads(result.stdout)
        for stream in data.get("streams", []):
            if stream.get("codec_type") == "video":
                width = stream.get("width")
                height = stream.get("height")
                if width and height:
                    return int(width), int(height)
    except Exception as exc:
        print(f"  ⚠️  ffprobe failed for {file_path}: {exc}")
    return None, None


def read_dimensions(file_path: str, file_type: str) -> tuple[int | None, int | None]:
    ext = os.path.splitext(file_path)[1].lower()
    if file_type == "video" or ext in VIDEO_MEDIA_EXTENSIONS:
        return get_video_dimensions(file_path)
    width, height = get_dimensions(file_path)
    if width is None or height is None:
        return None, None
    return int(width), int(height)


def backfill(library_path: str, db_path: str | None = None, *, batch_size: int = 250) -> int:
    library_path = os.path.abspath(library_path)
    resolved_db = resolve_db_path(library_path, db_path)
    if not resolved_db or not os.path.exists(resolved_db):
        raise SystemExit(f"Database not found for library: {library_path}")

    conn = sqlite3.connect(resolved_db, timeout=60)
    conn.execute("PRAGMA busy_timeout = 60000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    rows = cursor.execute(
        """
        SELECT id, current_path, file_type, width, height
        FROM photos
        ORDER BY id
        """
    ).fetchall()

    total = len(rows)
    updated = 0
    skipped = 0
    failed = 0
    started = time.perf_counter()

    print(f"Backfilling dimensions for {total:,} rows")
    print(f"Library: {library_path}")
    print(f"Database: {resolved_db}\n")

    pending = 0
    for idx, row in enumerate(rows, start=1):
        if row["width"] is not None and row["height"] is not None:
            skipped += 1
            continue

        full_path = os.path.join(library_path, row["current_path"])
        if not os.path.exists(full_path):
            failed += 1
            if failed <= 10:
                print(f"  ⚠️  Missing file: {row['current_path']}")
            continue

        width, height = read_dimensions(full_path, str(row["file_type"] or "photo"))
        if width is None or height is None:
            failed += 1
            if failed <= 10:
                print(f"  ⚠️  Could not read dimensions: {row['current_path']}")
            continue

        cursor.execute(
            "UPDATE photos SET width = ?, height = ? WHERE id = ?",
            (width, height, row["id"]),
        )
        updated += 1
        pending += 1

        if pending >= batch_size:
            conn.commit()
            pending = 0

        if idx % 500 == 0 or idx == total:
            elapsed = time.perf_counter() - started
            rate = idx / elapsed if elapsed > 0 else 0.0
            print(
                f"  {idx:,}/{total:,} processed | updated={updated:,} "
                f"skipped={skipped:,} failed={failed:,} | {rate:.1f} rows/s"
            )

    if pending:
        conn.commit()

    conn.close()
    elapsed = time.perf_counter() - started
    print(
        f"\nDone in {elapsed / 60:.1f} min: updated={updated:,}, "
        f"skipped={skipped:,}, failed={failed:,}"
    )
    return 0 if failed == 0 else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill photos width/height columns.")
    parser.add_argument("library_path", help="Path to photo library root")
    parser.add_argument("--db-path", default=None, help="Optional explicit database path")
    parser.add_argument("--batch-size", type=int, default=250)
    args = parser.parse_args()
    raise SystemExit(backfill(args.library_path, args.db_path, batch_size=args.batch_size))


if __name__ == "__main__":
    main()
