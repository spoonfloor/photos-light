#!/usr/bin/env python3
"""
Run Clean library on a single inclusive date range (YYYY-MM-DD).

Scans only canonical day folders in the range (+ in-range DB paths), repairs
media there, and rebuilds the photos table while preserving rows outside the
range unchanged.

Does not resume partial checkpoints. Skips library-wide empty-folder cleanup.

Examples:
  python3 tools/clean_library_date_range.py /Volumes/eric_files/photo_library \\
    --from 2026-05-01 --to 2026-06-30

  python3 tools/clean_library_date_range.py /path/to/library \\
    --from 2026-06-01 --to 2026-06-17 --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from make_library_perfect import run_db_normalization_engine, scan_library_cleanliness


def _progress_printer(event: dict) -> None:
    event_type = event.get("type")
    if event_type == "phase":
        print(f"phase {event.get('phase')}: {event.get('status')}", flush=True)
    elif event_type == "progress":
        print(
            f"  {event.get('phase')} {event.get('processed')}/{event.get('total')}",
            flush=True,
        )
    elif event_type == "scope":
        print(
            f"scope {event.get('date_from')} .. {event.get('date_to')}",
            flush=True,
        )
    elif event_type == "log":
        entry = event.get("entry") or {}
        action = entry.get("action")
        if action in {
            "photos_table_rebuilt_date_scoped",
            "scan_complete",
            "folders_skipped_date_range",
        }:
            print(f"  log {action}: {json.dumps(entry)}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Clean library for one inclusive date range only.",
    )
    parser.add_argument("library_path", help="Root of the photo library")
    parser.add_argument(
        "--from",
        dest="date_from",
        required=True,
        metavar="YYYY-MM-DD",
        help="Inclusive start date",
    )
    parser.add_argument(
        "--to",
        dest="date_to",
        required=True,
        metavar="YYYY-MM-DD",
        help="Inclusive end date",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Inventory scan only (no repairs)",
    )
    args = parser.parse_args()

    library_path = os.path.abspath(args.library_path)
    if not os.path.isdir(library_path):
        print(f"Library not found: {library_path}", file=sys.stderr)
        return 1

    if args.dry_run:
        print(f"Dry-run inventory for {args.date_from} .. {args.date_to}")
        result = scan_library_cleanliness(library_path, verify=False)
        print(json.dumps(result.get("summary") or result, indent=2))
        print(
            "\nDry-run uses full-library inventory today; "
            "run without --dry-run to clean the date range.",
            file=sys.stderr,
        )
        return 0

    print(f"Clean library {library_path}")
    print(f"Date range {args.date_from} .. {args.date_to} (inclusive)")
    result = run_db_normalization_engine(
        library_path,
        progress_callback=_progress_printer,
        resume=False,
        date_from=args.date_from,
        date_to=args.date_to,
    )
    print(json.dumps(result, indent=2))
    return 0 if result.get("status") == "SUCCESS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
