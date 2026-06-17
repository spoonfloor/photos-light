#!/usr/bin/env python3
"""
Targeted repair for row-level path/hash drift (e.g. failed star commits).

Does not run Clean library / make-perfect. Backs up the DB before --apply.

Examples:
  python3 tools/repair_row_drift.py /Volumes/eric_files/photo_library --ids 66108,66117
  python3 tools/repair_row_drift.py /path/to/library --ghosts-only --limit 50
  python3 tools/repair_row_drift.py /path/to/library --ghosts-only --apply
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
from datetime import datetime
from typing import Dict, List, Optional, Set, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import app as photo_app
from file_operations import extract_exif_rating
from library_cleanliness import (
    CANONICAL_DB_DATE_FORMAT,
    build_canonical_photo_path,
    is_supported_media_extension,
)
from library_layout import resolve_db_path
from media_finalization import (
    apply_pending_thumbnail_cleanup,
    finalize_mutated_media,
    rollback_finalize_mutated_media,
)


def backup_db(library_path: str, db_path: str) -> str:
    backup_dir = os.path.join(library_path, ".db_backups")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(backup_dir, f"photo_library_row_drift_repair_{stamp}.db")
    shutil.copy2(db_path, backup_path)
    return backup_path


def date_folder_rel(date_taken: str) -> Optional[str]:
    try:
        parsed = datetime.strptime(date_taken, CANONICAL_DB_DATE_FORMAT)
    except ValueError:
        return None
    return os.path.join(parsed.strftime("%Y"), parsed.strftime("%Y-%m-%d"))


def iter_media_files_in_dir(abs_dir: str, library_path: str) -> List[str]:
    if not os.path.isdir(abs_dir):
        return []
    rel_paths: List[str] = []
    for name in os.listdir(abs_dir):
        if name.startswith("."):
            continue
        ext = os.path.splitext(name)[1].lower()
        if not is_supported_media_extension(ext):
            continue
        rel_paths.append(os.path.relpath(os.path.join(abs_dir, name), library_path))
    return rel_paths


def find_file_by_content_hash(
    library_path: str,
    *,
    content_hash: str,
    date_taken: str,
    db_paths: Set[str],
) -> Tuple[Optional[str], str]:
    """Return (relative_path, reason) when a matching file is found on disk."""
    if not content_hash:
        return None, ""

    search_dirs = []
    folder_rel = date_folder_rel(date_taken)
    if folder_rel:
        search_dirs.append(os.path.join(library_path, folder_rel))
    search_dirs.append(os.path.join(library_path, ".trash", "duplicates"))

    hash_prefix = content_hash[:8].lower()
    candidates: List[str] = []
    for abs_dir in search_dirs:
        for rel_path in iter_media_files_in_dir(abs_dir, library_path):
            basename = os.path.basename(rel_path).lower()
            if hash_prefix in basename:
                candidates.append(rel_path)

    seen: Set[str] = set()
    for rel_path in candidates:
        if rel_path in seen:
            continue
        seen.add(rel_path)
        full_path = os.path.join(library_path, rel_path)
        try:
            if photo_app.compute_full_hash(full_path) == content_hash:
                return rel_path, "content_hash_match"
        except OSError:
            continue

    if folder_rel:
        folder_abs = os.path.join(library_path, folder_rel)
        orphans = [
            rel
            for rel in iter_media_files_in_dir(folder_abs, library_path)
            if rel not in db_paths
        ]
        if len(orphans) == 1:
            return orphans[0], "single_orphan_in_date_folder"

    return None, ""


def rating_for_db(full_path: str) -> Optional[int]:
    rating = extract_exif_rating(full_path)
    if rating is None or rating == 0:
        return None
    return int(rating)


def assess_row(
    library_path: str,
    row: sqlite3.Row,
    db_paths: Set[str],
) -> Dict[str, object]:
    rel_path = row["current_path"]
    full_path = os.path.join(library_path, rel_path)
    if os.path.exists(full_path):
        try:
            disk_hash = photo_app.compute_full_hash(full_path)
        except OSError as exc:
            return {
                "photo_id": row["id"],
                "action": "error",
                "reason": f"unreadable file: {exc}",
            }
        db_hash = row["content_hash"]
        db_rating = row["rating"]
        file_rating = rating_for_db(full_path)
        needs_finalize = disk_hash != db_hash
        needs_rating = db_rating != file_rating
        if not needs_finalize and not needs_rating:
            return {
                "photo_id": row["id"],
                "action": "skip",
                "reason": "path and metadata already consistent",
            }
        return {
            "photo_id": row["id"],
            "action": "reconcile_at_path",
            "rel_path": rel_path,
            "reason": (
                "hash mismatch"
                if needs_finalize
                else "rating mismatch"
            ),
        }

    found_rel, find_reason = find_file_by_content_hash(
        library_path,
        content_hash=row["content_hash"],
        date_taken=row["date_taken"],
        db_paths=db_paths,
    )
    if found_rel:
        return {
            "photo_id": row["id"],
            "action": "relocate_from_found",
            "rel_path": found_rel,
            "old_path": rel_path,
            "reason": find_reason,
        }

    return {
        "photo_id": row["id"],
        "action": "unresolved",
        "reason": f"missing at {rel_path}; no matching file found",
    }


def reconcile_row(
    conn: sqlite3.Connection,
    library_path: str,
    row: sqlite3.Row,
    *,
    rel_path: str,
    apply: bool,
) -> Dict[str, object]:
    photo_id = row["id"]
    full_path = os.path.join(library_path, rel_path)
    if not os.path.exists(full_path):
        return {
            "photo_id": photo_id,
            "status": "error",
            "message": f"file missing: {rel_path}",
        }

    db_rating = rating_for_db(full_path)
    if not apply:
        return {
            "photo_id": photo_id,
            "status": "dry_run",
            "rel_path": rel_path,
            "rating": db_rating,
        }

    precomputed_hash = photo_app.compute_full_hash(full_path)
    finalize_result = None
    conn_row = conn.cursor()
    try:
        finalize_result = finalize_mutated_media(
            conn=conn,
            photo_id=photo_id,
            library_path=library_path,
            current_rel_path=rel_path,
            date_taken=row["date_taken"],
            old_hash=row["content_hash"],
            build_canonical_path=build_canonical_photo_path,
            compute_hash=photo_app.compute_full_hash,
            get_dimensions=photo_app.get_image_dimensions,
            delete_thumbnail_for_hash=photo_app.delete_thumbnail_for_hash,
            duplicate_policy="trash",
            duplicate_trash_dir=os.path.join(photo_app.TRASH_DIR, "duplicates"),
            precomputed_hash=precomputed_hash,
            defer_thumbnail_cleanup=True,
        )
        if finalize_result.status == "duplicate_removed":
            photo_app.commit_row_mutation(conn)
            apply_pending_thumbnail_cleanup(
                finalize_result,
                photo_app.delete_thumbnail_for_hash,
            )
            return {
                "photo_id": photo_id,
                "status": "duplicate_removed",
                "matched_id": (
                    finalize_result.duplicate.photo_id
                    if finalize_result.duplicate
                    else None
                ),
            }

        conn_row.execute(
            "UPDATE photos SET rating = ? WHERE id = ?",
            (db_rating, photo_id),
        )
        photo_app.commit_row_mutation(conn)
        apply_pending_thumbnail_cleanup(
            finalize_result,
            photo_app.delete_thumbnail_for_hash,
        )
        return {
            "photo_id": photo_id,
            "status": "repaired",
            "path": finalize_result.current_path,
            "rating": db_rating,
        }
    except Exception as exc:
        conn.rollback()
        if finalize_result is not None:
            rollback_finalize_mutated_media(finalize_result)
        return {
            "photo_id": photo_id,
            "status": "error",
            "message": str(exc),
        }


def load_rows(
    conn: sqlite3.Connection,
    *,
    photo_ids: Optional[List[int]],
    ghosts_only: bool,
    limit: Optional[int],
    library_path: str,
) -> List[sqlite3.Row]:
    if photo_ids:
        placeholders = ",".join("?" for _ in photo_ids)
        rows = conn.execute(
            f"SELECT id, current_path, content_hash, date_taken, rating "
            f"FROM photos WHERE id IN ({placeholders}) ORDER BY id",
            photo_ids,
        ).fetchall()
        return list(rows)

    rows = conn.execute(
        "SELECT id, current_path, content_hash, date_taken, rating "
        "FROM photos ORDER BY id"
    ).fetchall()
    if ghosts_only:
        rows = [
            row
            for row in rows
            if not os.path.exists(os.path.join(library_path, row["current_path"]))
        ]
    if limit is not None:
        rows = rows[:limit]
    return list(rows)


def run(
    library_path: str,
    *,
    db_path: Optional[str],
    photo_ids: Optional[List[int]],
    ghosts_only: bool,
    limit: Optional[int],
    apply: bool,
) -> int:
    library_path = os.path.abspath(library_path)
    resolved_db = resolve_db_path(library_path, db_path)
    if not resolved_db or not os.path.exists(resolved_db):
        raise SystemExit(f"Database not found for library: {library_path}")

    photo_app.update_app_paths(library_path, resolved_db)

    conn = sqlite3.connect(resolved_db, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=60000")
    conn.execute("PRAGMA journal_mode=WAL")

    db_paths = {
        row[0]
        for row in conn.execute("SELECT current_path FROM photos").fetchall()
    }
    rows = load_rows(
        conn,
        photo_ids=photo_ids,
        ghosts_only=ghosts_only,
        limit=limit,
        library_path=library_path,
    )

    if not rows:
        print("No rows selected.", flush=True)
        conn.close()
        return 0

    print(
        f"Selected {len(rows)} row(s) "
        f"({'apply' if apply else 'dry-run'}).",
        flush=True,
    )

    if apply:
        backup_path = backup_db(library_path, resolved_db)
        print(f"DB backup: {backup_path}", flush=True)

    stats = {
        "skip": 0,
        "repaired": 0,
        "duplicate_removed": 0,
        "unresolved": 0,
        "error": 0,
        "dry_run": 0,
    }

    for row in rows:
        assessment = assess_row(library_path, row, db_paths)
        photo_id = row["id"]
        action = assessment["action"]
        print(
            f"photo {photo_id}: {action} — {assessment.get('reason', '')}",
            flush=True,
        )

        if action == "skip":
            stats["skip"] += 1
            continue
        if action == "unresolved":
            stats["unresolved"] += 1
            continue

        rel_path = assessment["rel_path"]
        if action == "relocate_from_found":
            print(
                f"  found at {rel_path} (was {assessment.get('old_path')})",
                flush=True,
            )

        result = reconcile_row(
            conn,
            library_path,
            row,
            rel_path=str(rel_path),
            apply=apply,
        )
        status = result["status"]
        stats[status] = stats.get(status, 0) + 1
        print(f"  -> {status}: {result}", flush=True)

        if apply and status == "repaired" and result.get("path"):
            db_paths.discard(row["current_path"])
            db_paths.add(result["path"])

    if apply and stats.get("repaired", 0) + stats.get("duplicate_removed", 0) > 0:
        photo_app.invalidate_grid_read_caches()

    conn.close()
    print(f"Done: {stats}", flush=True)
    return 1 if stats.get("unresolved") or stats.get("error") else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library_path", help="Absolute path to photo library root")
    parser.add_argument("--db-path", help="Override SQLite path")
    parser.add_argument(
        "--ids",
        help="Comma-separated photo ids to repair (e.g. 66108,66117)",
    )
    parser.add_argument(
        "--ghosts-only",
        action="store_true",
        help="Only rows whose current_path is missing on disk",
    )
    parser.add_argument("--limit", type=int, help="Max rows to process")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write repairs (creates a .db_backups copy first)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    photo_ids = None
    if args.ids:
        photo_ids = [int(value.strip()) for value in args.ids.split(",") if value.strip()]
    if not photo_ids and not args.ghosts_only:
        raise SystemExit("Specify --ids and/or --ghosts-only")

    exit_code = run(
        args.library_path,
        db_path=args.db_path,
        photo_ids=photo_ids,
        ghosts_only=args.ghosts_only,
        limit=args.limit,
        apply=args.apply,
    )
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
