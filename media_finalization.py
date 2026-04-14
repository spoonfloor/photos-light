"""
Shared post-mutation media finalization helpers.

These helpers reconcile one on-disk media file back to canonical path, hash,
dimensions, and database state after a mutation like rotation or metadata
rewrite.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from typing import Callable, Literal, Optional


DuplicatePolicy = Literal["raise", "delete", "trash"]


@dataclass
class DuplicateMediaMatch:
    photo_id: int
    current_path: str


@dataclass
class FinalizeMediaResult:
    status: Literal["finalized", "duplicate_removed"]
    current_path: Optional[str]
    full_path: Optional[str]
    content_hash: Optional[str]
    file_size: Optional[int]
    width: Optional[int]
    height: Optional[int]
    duplicate: Optional[DuplicateMediaMatch] = None
    duplicate_destination: Optional[str] = None


def _reserve_destination(target_path: str) -> str:
    candidate = target_path
    counter = 1
    base, ext = os.path.splitext(target_path)
    while os.path.exists(candidate):
        candidate = f"{base}_{counter}{ext}"
        counter += 1
    return candidate


def finalize_mutated_media(
    *,
    conn,
    photo_id: int,
    library_path: str,
    current_rel_path: str,
    date_taken: str,
    old_hash: Optional[str],
    build_canonical_path: Callable[[str, str, str], tuple[str, str]],
    compute_hash: Callable[[str], Optional[str]],
    get_dimensions: Callable[[str], Optional[tuple[Optional[int], Optional[int]]]],
    delete_thumbnail_for_hash: Callable[[str], None],
    duplicate_policy: DuplicatePolicy = "raise",
    duplicate_trash_dir: Optional[str] = None,
) -> FinalizeMediaResult:
    full_path = os.path.join(library_path, current_rel_path)
    if not os.path.exists(full_path):
        raise FileNotFoundError(f"Cannot finalize missing file: {current_rel_path}")

    dimensions = get_dimensions(full_path)
    width, height = dimensions if dimensions else (None, None)

    new_hash = compute_hash(full_path)
    if not new_hash:
        raise RuntimeError(f"Failed to compute hash for {current_rel_path}")

    cursor = conn.cursor()
    duplicate = None
    if old_hash != new_hash:
        cursor.execute(
            "SELECT id, current_path FROM photos WHERE content_hash = ? AND id != ?",
            (new_hash, photo_id),
        )
        row = cursor.fetchone()
        if row:
            duplicate = DuplicateMediaMatch(
                photo_id=row["id"],
                current_path=row["current_path"],
            )

    if duplicate:
        duplicate_destination = None
        print(
            f"🔎 finalize_mutated_media duplicate: photo_id={photo_id} "
            f"old_hash={old_hash} new_hash={new_hash} "
            f"matched_id={duplicate.photo_id} matched_path={duplicate.current_path} "
            f"policy={duplicate_policy}"
        )
        if duplicate_policy == "raise":
            raise RuntimeError(
                f"Duplicate detected after mutation: {duplicate.photo_id} ({duplicate.current_path})"
            )
        if duplicate_policy == "trash":
            if not duplicate_trash_dir:
                raise RuntimeError("duplicate_trash_dir is required for trash duplicate policy")
            os.makedirs(duplicate_trash_dir, exist_ok=True)
            duplicate_destination = _reserve_destination(
                os.path.join(duplicate_trash_dir, os.path.basename(full_path))
            )
            shutil.move(full_path, duplicate_destination)
        elif duplicate_policy == "delete":
            os.remove(full_path)

        if old_hash and old_hash != new_hash:
            delete_thumbnail_for_hash(old_hash)
        cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
        return FinalizeMediaResult(
            status="duplicate_removed",
            current_path=None,
            full_path=None,
            content_hash=None,
            file_size=None,
            width=width,
            height=height,
            duplicate=duplicate,
            duplicate_destination=duplicate_destination,
        )

    ext = os.path.splitext(full_path)[1]
    new_rel_path, _ = build_canonical_path(date_taken, new_hash, ext)
    new_full_path = os.path.join(library_path, new_rel_path)

    if os.path.abspath(new_full_path) != os.path.abspath(full_path):
        os.makedirs(os.path.dirname(new_full_path), exist_ok=True)
        if os.path.exists(new_full_path):
            raise RuntimeError(f"Canonical path collision after mutation: {new_rel_path}")
        shutil.move(full_path, new_full_path)
        full_path = new_full_path
        current_rel_path = new_rel_path

    if old_hash and old_hash != new_hash:
        delete_thumbnail_for_hash(old_hash)

    file_size = os.path.getsize(full_path)
    cursor.execute(
        """
        UPDATE photos
        SET current_path = ?, content_hash = ?, file_size = ?, width = ?, height = ?
        WHERE id = ?
        """,
        (current_rel_path, new_hash, file_size, width, height, photo_id),
    )
    return FinalizeMediaResult(
        status="finalized",
        current_path=current_rel_path,
        full_path=full_path,
        content_hash=new_hash,
        file_size=file_size,
        width=width,
        height=height,
    )
