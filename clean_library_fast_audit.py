"""
Fast read-only library audit for Clean library preflight (v2).

Checks deal-breaker cleanliness rules without dry-run canonicalization or
pixel-level duplicate detection. Duplicate media === identical file hash.
"""

from __future__ import annotations

import os
import re
import sqlite3
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from db_health import DBStatus, check_database_health
from file_operations import extract_exif_rating
from hash_cache import compute_hash_legacy
from library_cleanliness import (
    IGNORED_LIBRARY_FILES,
    in_infrastructure,
    is_day_folder_name,
    is_supported_media_extension,
    is_year_folder_name,
    media_kind_for_extension,
    path_parts,
    root_entry_allowed,
)
from library_layout import (
    LIBRARY_METADATA_DIR,
    canonical_db_path,
    db_is_valid,
    is_library_metadata_file,
    resolve_db_path,
)
from normalization_contract import (
    canonical_path_issue_message,
    compute_content_hash,
    expected_canonical_rel_path_from_db_date,
)

from clean_library_media_utils import (
    can_bake_losslessly,
    format_issue,
    get_birth_time,
    get_orientation_flag,
    verify_media_file,
    visible_directory_entries,
)

CANONICAL_BASENAME_RE = re.compile(
    r"^img_\d{8}_[0-9a-f]{8}\.[a-z0-9]+$",
    re.IGNORECASE,
)

ProgressCallback = Optional[Callable[[Dict[str, Any]], None]]
CancelCheck = Optional[Callable[[], bool]]


class FastAuditCancelled(Exception):
    """Cooperative stop during final verification."""


def _emit(callback: ProgressCallback, payload: Dict[str, Any]) -> None:
    if callback:
        callback(dict(payload))


def _audit_library_metadata_dir(library_path: str) -> List[Dict[str, str]]:
    issues: List[Dict[str, str]] = []
    metadata_dir = os.path.join(library_path, LIBRARY_METADATA_DIR)

    if not os.path.isdir(metadata_dir):
        issues.append(format_issue("missing_library_metadata_dir", LIBRARY_METADATA_DIR))
        return issues

    canonical_path = canonical_db_path(library_path)
    if not os.path.exists(canonical_path):
        issues.append(
            format_issue("missing_library_db", os.path.relpath(canonical_path, library_path))
        )
    elif not db_is_valid(canonical_path):
        issues.append(
            format_issue("invalid_library_db", os.path.relpath(canonical_path, library_path))
        )

    for item in os.listdir(metadata_dir):
        if item in IGNORED_LIBRARY_FILES:
            continue
        item_path = os.path.join(metadata_dir, item)
        rel_path = os.path.relpath(item_path, library_path)
        if os.path.isdir(item_path):
            issues.append(format_issue("unexpected_library_metadata_dir", rel_path))
            continue
        if not is_library_metadata_file(item):
            issues.append(format_issue("unexpected_library_metadata_file", rel_path))

    return issues


def _path_structure_issues(library_path: str) -> List[Dict[str, str]]:
    issues: List[Dict[str, str]] = []

    for item in os.listdir(library_path):
        if item in IGNORED_LIBRARY_FILES:
            continue
        full_path = os.path.join(library_path, item)
        if not root_entry_allowed(item, os.path.isdir(full_path)):
            issue_kind = (
                "noncanonical_root_folder" if os.path.isdir(full_path) else "noncanonical_root_file"
            )
            issues.append(format_issue(issue_kind, item))

    for root, dirs, files in os.walk(library_path, topdown=True):
        rel_root = os.path.relpath(root, library_path)
        if rel_root != "." and in_infrastructure(rel_root):
            dirs[:] = []
            continue

        parts = path_parts(rel_root)
        if rel_root != ".":
            if len(parts) == 1:
                if not is_year_folder_name(parts[0]):
                    issues.append(format_issue("noncanonical_folder", rel_root))
            elif len(parts) == 2:
                if not (
                    is_year_folder_name(parts[0])
                    and is_day_folder_name(parts[0], parts[1])
                ):
                    issues.append(format_issue("noncanonical_folder", rel_root))
            else:
                issues.append(format_issue("noncanonical_folder", rel_root))

            if not visible_directory_entries(root):
                issues.append(format_issue("empty_folder", rel_root))

        for dirname in list(dirs):
            dir_rel = os.path.relpath(os.path.join(root, dirname), library_path)
            if in_infrastructure(dir_rel):
                continue
            dir_parts = path_parts(dir_rel)
            if len(dir_parts) > 2:
                issues.append(format_issue("noncanonical_folder", dir_rel))

    return issues


def _basename_layout_issue(rel_path: str) -> Optional[Dict[str, str]]:
    parts = path_parts(rel_path)
    if len(parts) != 3:
        return format_issue("misnamed_or_misfiled", rel_path, "expected YYYY/YYYY-MM-DD/img_*.ext")
    year, day, basename = parts
    if not is_year_folder_name(year) or not is_day_folder_name(year, day):
        return format_issue("misnamed_or_misfiled", rel_path, f"expected under {year}/{day}")
    if not CANONICAL_BASENAME_RE.match(basename):
        return format_issue(
            "misnamed_or_misfiled",
            rel_path,
            f"expected canonical basename img_YYYYMMDD_<hash8>.ext",
        )
    return None


def _canonical_path_issue(
    rel_path: str,
    *,
    content_hash: Optional[str] = None,
    date_taken: Optional[str] = None,
) -> Optional[Dict[str, str]]:
    if content_hash and date_taken:
        try:
            expected_rel = expected_canonical_rel_path_from_db_date(
                date_taken,
                content_hash,
                os.path.splitext(rel_path)[1].lower(),
            )
        except (TypeError, ValueError):
            expected_rel = None

        if expected_rel and expected_rel != rel_path:
            return format_issue(
                "misnamed_or_misfiled",
                rel_path,
                canonical_path_issue_message(expected_rel),
            )

    return _basename_layout_issue(rel_path)


def _raise_if_cancelled(cancel_check: CancelCheck) -> None:
    if cancel_check and cancel_check():
        raise FastAuditCancelled()


def run_fast_library_audit(
    library_path: str,
    db_path: Optional[str] = None,
    progress_callback: ProgressCallback = None,
    *,
    include_metadata_checks: bool = True,
    include_hash_checks: bool = True,
    audit_progress_total: Optional[int] = None,
    cancel_check: CancelCheck = None,
) -> List[Dict[str, str]]:
    """
    Read-only fast audit. Returns issue dicts compatible with summarize_clean_library_issues.
    """
    library_path = os.path.abspath(library_path)
    resolved_db = resolve_db_path(library_path, db_path)
    issues: List[Dict[str, str]] = []

    if audit_progress_total is not None:
        audit_total = max(int(audit_progress_total), 1)
    else:
        audit_total = max(count_supported_media_leaf_files(library_path), 1)

    _emit(
        progress_callback,
        {
            "type": "phase",
            "phase": "audit",
            "status": "starting",
            "total": audit_total,
        },
    )

    _raise_if_cancelled(cancel_check)
    issues.extend(_path_structure_issues(library_path))
    issues.extend(_audit_library_metadata_dir(library_path))
    _raise_if_cancelled(cancel_check)

    db_conn: Optional[sqlite3.Connection] = None
    db_rows: List[sqlite3.Row] = []
    db_by_path: Dict[str, sqlite3.Row] = {}
    if os.path.exists(resolved_db) and db_is_valid(resolved_db):
        db_conn = sqlite3.connect(f"file:{resolved_db}?mode=ro", uri=True)
        db_conn.row_factory = sqlite3.Row
        cursor = db_conn.cursor()
        cursor.execute("SELECT current_path, content_hash, file_type, date_taken FROM photos")
        db_rows = cursor.fetchall()
        db_by_path = {row["current_path"]: row for row in db_rows}

    active_media_paths: Set[str] = set()
    hash_groups: Dict[str, List[Tuple[str, float]]] = {}
    audit_idx = 0

    for root, dirs, files in os.walk(library_path, topdown=True):
        _raise_if_cancelled(cancel_check)
        rel_root = os.path.relpath(root, library_path)
        if rel_root != "." and in_infrastructure(rel_root):
            dirs[:] = []
            continue

        for filename in files:
            _raise_if_cancelled(cancel_check)
            if filename in IGNORED_LIBRARY_FILES:
                continue
            full_path = os.path.join(root, filename)
            rel_path = os.path.relpath(full_path, library_path)
            ext = os.path.splitext(filename)[1].lower()

            if not is_supported_media_extension(ext):
                issues.append(format_issue("unsupported_or_nonmedia", rel_path))
                continue

            audit_idx += 1
            _emit(
                progress_callback,
                {
                    "type": "progress",
                    "phase": "audit",
                    "processed": audit_idx,
                    "total": audit_total,
                },
            )

            valid, _ = verify_media_file(full_path)
            if not valid:
                issues.append(format_issue("corrupted_media", rel_path))
                continue

            active_media_paths.add(rel_path)

            if include_metadata_checks:
                file_type = media_kind_for_extension(ext) or "photo"
                if file_type == "photo":
                    orientation = get_orientation_flag(full_path)
                    if orientation not in (None, 1) and can_bake_losslessly(full_path):
                        issues.append(format_issue("unbaked_rotation", rel_path, str(orientation)))
                rating = extract_exif_rating(full_path)
                if rating == 0:
                    issues.append(format_issue("rating_zero", rel_path))

            file_hash: Optional[str] = None
            row = db_by_path.get(rel_path)
            if include_hash_checks:
                try:
                    file_hash = compute_content_hash(
                        full_path,
                        compute_hash=compute_hash_legacy,
                    )
                except Exception:
                    issues.append(format_issue("corrupted_media", rel_path))
                    continue

                if file_hash:
                    stat_result = os.stat(full_path)
                    hash_groups.setdefault(file_hash, []).append(
                        (rel_path, get_birth_time(stat_result))
                    )

                if row is not None and file_hash and row["content_hash"] != file_hash:
                    issues.append(
                        format_issue(
                            "db_hash_mismatch",
                            rel_path,
                            f"db={row['content_hash']} disk={file_hash}",
                        )
                    )

                expected_type = media_kind_for_extension(ext)
                if row is not None and expected_type and row["file_type"] != expected_type:
                    issues.append(
                        format_issue(
                            "db_hash_mismatch",
                            rel_path,
                            f"db_type={row['file_type']} disk_type={expected_type}",
                        )
                    )

            layout_issue = _canonical_path_issue(
                rel_path,
                content_hash=file_hash,
                date_taken=(row["date_taken"] if row is not None else None),
            )
            if layout_issue is not None:
                issues.append(layout_issue)

    _raise_if_cancelled(cancel_check)
    if include_hash_checks:
        for file_hash, group in hash_groups.items():
            _raise_if_cancelled(cancel_check)
            if len(group) < 2:
                continue
            ordered = sorted(group, key=lambda item: (item[1], item[0].lower()))
            winner_rel = ordered[0][0]
            for loser_rel, _birth in ordered[1:]:
                issues.append(
                    format_issue(
                        "duplicate_media",
                        loser_rel,
                        f"same hash as {winner_rel}",
                    )
                )
            _ = file_hash

    _raise_if_cancelled(cancel_check)
    db_paths = set(db_by_path.keys())
    for ghost_path in sorted(db_paths - active_media_paths):
        issues.append(format_issue("ghost_db_reference", ghost_path))
    for mole_path in sorted(active_media_paths - db_paths):
        issues.append(format_issue("mole_missing_from_db", mole_path))
    _raise_if_cancelled(cancel_check)

    if db_conn is not None:
        db_conn.close()

    _emit(
        progress_callback,
        {
            "type": "phase",
            "phase": "audit",
            "status": "complete",
            "issue_count": len(issues),
        },
    )
    return issues


def count_supported_media_leaf_files(library_path: str) -> int:
    count = 0
    library_path = os.path.abspath(library_path)
    for root, _dirs, files in os.walk(library_path, topdown=True):
        rel_root = os.path.relpath(root, library_path)
        if rel_root != "." and in_infrastructure(rel_root):
            continue
        for filename in files:
            if filename in IGNORED_LIBRARY_FILES:
                continue
            ext = os.path.splitext(filename)[1].lower()
            if is_supported_media_extension(ext):
                count += 1
    return count
