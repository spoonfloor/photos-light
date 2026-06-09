"""
Shared normalization contract and identity helpers.

This module is intentionally small: it defines the cross-action contract that
Clean, Add photos, and Convert should agree on before their orchestration loops
are fully unified.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional

from hash_cache import compute_hash_legacy
from library_cleanliness import CANONICAL_DB_DATE_FORMAT, canonical_relative_path
from datetime import datetime


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
    """Duplicate identity for v2 normalization: exact canonical content hash."""
    return content_hash or None


def compute_duplicate_key(
    full_path: str,
    *,
    fallback_hash: Optional[str] = None,
    compute_hash: Callable[[str], object] = compute_hash_legacy,
) -> Optional[str]:
    return duplicate_key_for_content_hash(
        fallback_hash or compute_content_hash(full_path, compute_hash=compute_hash)
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
