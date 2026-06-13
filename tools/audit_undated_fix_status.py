#!/usr/bin/env python3
"""Audit status of undated-library repair cohort."""

from __future__ import annotations

import os
import subprocess
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import sqlite3

from library_cleanliness import build_canonical_photo_path
from photo_canonicalization import UNKNOWN_PHOTO_DATE_TAKEN

LIBRARY_PATH = "/Volumes/eric_files/photo_library"
DB_PATH = os.path.join(LIBRARY_PATH, ".library", "photo_library.db")
PING_INTERVAL_SEC = 10


def is_jpeg_mislabeled_as_heic(file_path: str) -> bool:
    result = subprocess.run(
        ["file", "-b", file_path],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    return result.stdout.strip().lower().startswith("jpeg")


def classify_row(row, library_path: str) -> tuple[int, list[str]]:
    """
    1 = untouched
    2 = finished, integrity OK
    3 = finished or partial, problems detected
    """
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

    basename = os.path.basename(rel_path)
    if basename.startswith("mov_"):
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
        if basename != expected_name:
            problems.append(f"name_not_canonical:expected={expected_name}")
        if rel_path.lower().endswith(".heic") and is_jpeg_mislabeled_as_heic(full_path):
            problems.append("jpeg_mislabeled_as_heic")

    if problems:
        return 3, problems
    return 2, problems


def main() -> int:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT id, current_path, date_taken, content_hash, file_type
        FROM photos
        WHERE current_path LIKE '%19000101_%'
        ORDER BY id
        """
    ).fetchall()
    conn.close()

    total = len(rows)
    counts = {1: 0, 2: 0, 3: 0}
    problem_rows: list[tuple] = []
    last_ping = time.monotonic()

    print(f"Auditing {total} undated-cohort files...", flush=True)

    for index, row in enumerate(rows, start=1):
        status, problems = classify_row(row, LIBRARY_PATH)
        counts[status] += 1
        if status == 3:
            problem_rows.append((row["id"], row["current_path"], problems))

        print(
            f"PING [{index}/{total}] "
            f"untouched={counts[1]} ok={counts[2]} problems={counts[3]} "
            f"id={row['id']} status={status}",
            flush=True,
        )
        now = time.monotonic()
        if (now - last_ping) >= PING_INTERVAL_SEC:
            print(
                f"PING -- heartbeat at {index}/{total} "
                f"untouched={counts[1]} ok={counts[2]} problems={counts[3]}",
                flush=True,
            )
            last_ping = now

    print("\n=== FINAL ===", flush=True)
    print(f"Total: {total}", flush=True)
    print(f"1 untouched: {counts[1]}", flush=True)
    print(f"2 finished OK: {counts[2]}", flush=True)
    print(f"3 problems: {counts[3]}", flush=True)

    if problem_rows:
        print("\nProblem files:", flush=True)
        for photo_id, path, problems in problem_rows[:50]:
            print(f"  id={photo_id} {path}", flush=True)
            for problem in problems:
                print(f"    - {problem}", flush=True)
        if len(problem_rows) > 50:
            print(f"  ... and {len(problem_rows) - 50} more", flush=True)

    if counts[1]:
        print("\nStill untouched (first 20):", flush=True)
        shown = 0
        for row in rows:
            if row["date_taken"] is not None:
                continue
            print(f"  id={row['id']} {row['current_path']}", flush=True)
            shown += 1
            if shown >= 20:
                break

    return 0 if counts[1] == 0 and counts[3] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
