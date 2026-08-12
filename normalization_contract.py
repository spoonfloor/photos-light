"""
Shared normalization contract and identity helpers.

This module is intentionally small: it defines the cross-action contract that
Clean, Add photos, and Convert should agree on before their orchestration loops
are fully unified.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Callable, Optional

from hash_cache import compute_hash_legacy
from library_cleanliness import CANONICAL_DB_DATE_FORMAT, canonical_relative_path


class NormalizationMode(str, Enum):
    INGEST = "ingest"
    REPAIR = "repair"
    CONVERT = "convert"


@dataclass(frozen=True)
class NormalizationPolicy:
    blocking_audit: bool
    resume: bool
    remove_source: bool
    source_scope: str
    duplicate_action: str
    misfiled_action: str
    unsupported_action: str
    destructive: bool = False


INGEST_POLICY = NormalizationPolicy(
    blocking_audit=False,
    resume=False,
    remove_source=False,
    source_scope="external",
    duplicate_action="skip",
    misfiled_action="copy_to_canonical",
    unsupported_action="reject",
)

REPAIR_POLICY = NormalizationPolicy(
    blocking_audit=True,
    resume=True,
    remove_source=False,
    source_scope="library",
    duplicate_action="trash_loser",
    misfiled_action="move_to_canonical",
    unsupported_action="trash",
)

CONVERT_POLICY = NormalizationPolicy(
    blocking_audit=True,
    resume=True,
    remove_source=False,
    source_scope="library",
    duplicate_action="defer",
    misfiled_action="rewrite_layout",
    unsupported_action="defer",
    destructive=True,
)


def normalize_hash_result(hash_result) -> Optional[str]:
    """Accept legacy hash strings and cache-style ``(hash, cache_hit)`` tuples."""
    if isinstance(hash_result, tuple):
        return hash_result[0]
    return hash_result


def compute_content_hash(
    full_path: str,
    *,
    compute_hash: Callable[[str], object] = compute_hash_legacy,
) -> Optional[str]:
    return normalize_hash_result(compute_hash(full_path))


def duplicate_key_for_content_hash(content_hash: Optional[str]) -> Optional[str]:
    """Wrap a hash that is already star-blind / rating-stripped."""
    return content_hash or None


def _logical_rating_stripped_hash(
    full_path: str,
    *,
    compute_hash: Callable[[str], object],
) -> Optional[str]:
    """
    Hash ``full_path`` as if Rating/RatingPercent were absent.

    Copies to a temp file, strips rating tags there, and hashes the copy.
    The original file is never modified.
    """
    # Lazy import keeps the contract module free of file_operations at import time.
    from file_operations import strip_exif_rating

    basename = os.path.basename(full_path) or "media.bin"
    with tempfile.TemporaryDirectory(prefix="dup_key_") as temp_dir:
        stripped_path = os.path.join(temp_dir, basename)
        shutil.copy2(full_path, stripped_path)
        if not strip_exif_rating(stripped_path):
            return None
        return compute_content_hash(stripped_path, compute_hash=compute_hash)


def compute_duplicate_key(
    full_path: str,
    *,
    fallback_hash: Optional[str] = None,
    compute_hash: Callable[[str], object] = compute_hash_legacy,
) -> Optional[str]:
    """
    Star-blind duplicate identity for import, Clean dedupe, and finalize.

    When the file has EXIF Rating / RatingPercent tags, the key is the hash of a
    logically rating-stripped copy (temp only — disk is not mutated). Otherwise
    the key equals the raw content hash. ``fallback_hash`` is used only when the
    file cannot be read, or as the raw hash on the no-rating fast path.
    """
    if not os.path.isfile(full_path):
        return duplicate_key_for_content_hash(fallback_hash)

    try:
        from file_operations import extract_exif_rating

        rating = extract_exif_rating(full_path)
        if rating is None:
            return duplicate_key_for_content_hash(
                fallback_hash or compute_content_hash(full_path, compute_hash=compute_hash)
            )

        stripped_hash = _logical_rating_stripped_hash(full_path, compute_hash=compute_hash)
        if stripped_hash:
            return duplicate_key_for_content_hash(stripped_hash)

        return duplicate_key_for_content_hash(
            fallback_hash or compute_content_hash(full_path, compute_hash=compute_hash)
        )
    except Exception:
        return duplicate_key_for_content_hash(
            fallback_hash
            if fallback_hash is not None
            else compute_content_hash(full_path, compute_hash=compute_hash)
        )


def expected_canonical_rel_path_from_db_date(
    date_taken: str,
    content_hash: str,
    ext: str,
) -> str:
    date_obj = datetime.strptime(date_taken, CANONICAL_DB_DATE_FORMAT)
    return canonical_relative_path(date_obj, content_hash, ext)


def canonical_path_issue_message(expected_rel_path: str) -> str:
    return f"expected {expected_rel_path.replace(os.sep, '/')}"
