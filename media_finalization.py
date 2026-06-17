"""
Shared post-mutation media finalization helpers.

These helpers reconcile one on-disk media file back to canonical path, hash,
dimensions, and database state after a mutation like rotation or metadata
rewrite.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from typing import Callable, Literal, Optional, Tuple, List


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
    # (from_path, to_path) pairs to restore on failed DB commit
    rollback_moves: List[Tuple[str, str]] = field(default_factory=list)
    pending_thumbnail_hash: Optional[str] = None


def _reserve_destination(target_path: str) -> str:
    candidate = target_path
    counter = 1
    base, ext = os.path.splitext(target_path)
    while os.path.exists(candidate):
        candidate = f"{base}_{counter}{ext}"
        counter += 1
    return candidate


def rollback_finalize_mutated_media(result: FinalizeMediaResult) -> None:
    """Reverse on-disk changes from finalize when the DB transaction did not commit."""
    for from_path, to_path in reversed(result.rollback_moves):
        if os.path.exists(from_path):
            os.makedirs(os.path.dirname(to_path), exist_ok=True)
            shutil.move(from_path, to_path)


def apply_pending_thumbnail_cleanup(
    result: FinalizeMediaResult,
    delete_thumbnail_for_hash: Callable[[str], None],
) -> None:
    if result.pending_thumbnail_hash:
        delete_thumbnail_for_hash(result.pending_thumbnail_hash)


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
    precomputed_hash: Optional[str] = None,
    defer_thumbnail_cleanup: bool = False,
) -> FinalizeMediaResult:
    rollback_moves: List[Tuple[str, str]] = []
    pending_thumbnail_hash: Optional[str] = None
    full_path = os.path.join(library_path, current_rel_path)
    if not os.path.exists(full_path):
        raise FileNotFoundError(f"Cannot finalize missing file: {current_rel_path}")

    dimensions = get_dimensions(full_path)
    width, height = dimensions if dimensions else (None, None)

    new_hash = precomputed_hash or compute_hash(full_path)
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
            rollback_moves.append((duplicate_destination, full_path))
        elif duplicate_policy == "delete":
            os.remove(full_path)

        if old_hash and old_hash != new_hash:
            if defer_thumbnail_cleanup:
                pending_thumbnail_hash = old_hash
            else:
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
            rollback_moves=rollback_moves,
            pending_thumbnail_hash=pending_thumbnail_hash,
        )

    ext = os.path.splitext(full_path)[1]
    new_rel_path, _ = build_canonical_path(date_taken, new_hash, ext)
    new_full_path = os.path.join(library_path, new_rel_path)

    if os.path.abspath(new_full_path) != os.path.abspath(full_path):
        os.makedirs(os.path.dirname(new_full_path), exist_ok=True)
        if os.path.exists(new_full_path):
            raise RuntimeError(f"Canonical path collision after mutation: {new_rel_path}")
        old_full_path_before_move = full_path
        old_dir_before_move = os.path.dirname(old_full_path_before_move)
        shutil.move(full_path, new_full_path)
        rollback_moves.append((new_full_path, old_full_path_before_move))
        from quicktime_date_atoms import (
            cleanup_orphan_patch_artifacts_in_dir,
            remove_quicktime_patch_artifacts,
        )

        remove_quicktime_patch_artifacts(old_full_path_before_move)
        cleanup_orphan_patch_artifacts_in_dir(old_dir_before_move)
        full_path = new_full_path
        current_rel_path = new_rel_path

    if old_hash and old_hash != new_hash:
        if defer_thumbnail_cleanup:
            pending_thumbnail_hash = old_hash
        else:
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
        rollback_moves=rollback_moves,
        pending_thumbnail_hash=pending_thumbnail_hash,
    )
