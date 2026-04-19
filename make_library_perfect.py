"""
Clean library operation.

This module powers More -> Clean library -> Start cleaning.

The operation treats the filesystem as the source of truth, repairs active
library contents outside infrastructure folders, reconciles the live photos
table to the repaired library, and then runs a read-only final audit.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import traceback
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from PIL import Image, ImageOps

from db_schema import create_database_schema
from file_operations import extract_exif_date, extract_exif_rating, strip_exif_rating
from hash_cache import HashCache, compute_hash_legacy
from rotation_utils import (
    bake_orientation as shared_bake_orientation,
    can_bake_losslessly as shared_can_bake_losslessly,
    get_orientation_flag as shared_get_orientation_flag,
)
from library_cleanliness import (
    ALL_MEDIA_EXTENSIONS,
    PHOTO_MEDIA_EXTENSIONS,
    VIDEO_MEDIA_EXTENSIONS,
    IGNORED_LIBRARY_FILES,
    INFRASTRUCTURE_DIRS,
    canonical_relative_path,
    in_infrastructure,
    is_supported_media_extension,
    is_day_folder_name,
    is_year_folder_name,
    media_kind_for_extension,
    parse_metadata_datetime,
    path_parts,
    root_entry_allowed,
)
from library_layout import (
    LIBRARY_METADATA_DIR,
    canonical_db_path,
    db_is_valid,
    db_sidecar_paths,
    is_library_metadata_file,
    quarantine_unexpected_metadata_entries,
    resolve_db_path,
)
from photo_canonicalization import (
    UNKNOWN_PHOTO_DATE_TAKEN,
    canonicalize_photo_date,
    canonicalize_photo_file,
    write_photo_date_metadata,
)

PHOTO_EXTENSIONS = PHOTO_MEDIA_EXTENSIONS
VIDEO_EXTENSIONS = VIDEO_MEDIA_EXTENSIONS
SUPPORTED_MEDIA_EXTENSIONS = ALL_MEDIA_EXTENSIONS
PIL_VERIFY_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".tiff",
    ".tif",
    ".webp",
    ".avif",
}
LOSSLESS_ROTATION_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tiff", ".tif"}

CLEAN_LIBRARY_SIGNAL_KEYS = (
    "misfiled_media",
    "unsupported_files",
    "duplicates",
    "metadata_cleanup",
    "folder_cleanup",
    "database_repairs",
)


@dataclass
class MediaRecord:
    original_filename: str
    source_rel_path: str
    full_path: str
    rel_path: str
    ext: str
    file_type: str
    content_hash: str
    duplicate_key: str
    date_taken: str
    date_obj: datetime
    width: Optional[int]
    height: Optional[int]
    rating: Optional[int]
    metadata_cleaned: bool
    has_metadata_cleanup_signal: bool
    birth_time: float
    modified_time: float


class CleanLibraryError(RuntimeError):
    """Operation failed and the library may still be dirty."""


def _compute_photo_duplicate_key(full_path: str, fallback_hash: Optional[str] = None) -> str:
    """
    Return a pixel-level duplicate key for a normalized photo.

    Photos that render to the same bitmap should dedupe together even when
    metadata or container-level encoding differs. When Pillow cannot decode the
    photo, fall back to the canonical file hash so non-raster formats still
    participate in duplicate grouping.
    """
    try:
        with Image.open(full_path) as image:
            rendered = ImageOps.exif_transpose(image).convert("RGBA")
            duplicate_key = hashlib.sha256()
            duplicate_key.update(
                f"pixels:{rendered.width}x{rendered.height}:RGBA".encode("utf-8")
            )
            duplicate_key.update(rendered.tobytes())
            return duplicate_key.hexdigest()
    except Exception:
        duplicate_key = fallback_hash or compute_hash_legacy(full_path)
        if not duplicate_key:
            raise CleanLibraryError(f"Failed to compute duplicate key for {full_path}")
        return duplicate_key

def get_birth_time(stat_result: os.stat_result) -> float:
    """Use birthtime when available, otherwise fall back to mtime."""
    return float(getattr(stat_result, "st_birthtime", stat_result.st_mtime))


def exiftool_json(file_path: str, args: List[str]) -> Dict[str, Any]:
    result = subprocess.run(
        ["exiftool", "-j", *args, file_path],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "exiftool failed")
    payload = json.loads(result.stdout)
    return payload[0] if payload else {}


def get_orientation_flag(file_path: str) -> Optional[int]:
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in PHOTO_EXTENSIONS:
        return None
    return shared_get_orientation_flag(file_path)


def can_bake_losslessly(file_path: str) -> bool:
    return shared_can_bake_losslessly(file_path)


def bake_orientation(file_path: str) -> Tuple[bool, str, Optional[int]]:
    return shared_bake_orientation(file_path)


def verify_media_file(file_path: str) -> Tuple[bool, str]:
    ext = os.path.splitext(file_path)[1].lower()
    try:
        if ext in VIDEO_EXTENSIONS:
            result = subprocess.run(
                ["ffprobe", "-v", "error", file_path],
                capture_output=True,
                text=True,
                timeout=30,
            )
            return (result.returncode == 0, "video validation")

        if ext in PIL_VERIFY_EXTENSIONS:
            with Image.open(file_path) as image:
                image.verify()
            return True, "image validation"

        if ext in PHOTO_EXTENSIONS:
            subprocess.run(
                ["exiftool", "-fast2", file_path],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            )
            return True, "metadata validation"
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False, "validation failed"
    except Exception:
        return False, "validation failed"

    return False, "unsupported"


def read_dimensions(file_path: str) -> Tuple[Optional[int], Optional[int]]:
    ext = os.path.splitext(file_path)[1].lower()
    try:
        if ext in VIDEO_EXTENSIONS:
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
            payload = json.loads(result.stdout)
            for stream in payload.get("streams", []):
                if stream.get("codec_type") == "video":
                    return stream.get("width"), stream.get("height")
            return None, None

        payload = exiftool_json(file_path, ["-ImageWidth", "-ImageHeight"])
        return payload.get("ImageWidth"), payload.get("ImageHeight")
    except Exception:
        return None, None


def format_issue(kind: str, path: str, detail: str = "") -> Dict[str, str]:
    return {"kind": kind, "path": path, "detail": detail}


def visible_directory_entries(dir_path: str) -> List[str]:
    return [entry for entry in os.listdir(dir_path) if entry not in IGNORED_LIBRARY_FILES]


def remove_ignored_directory_files(dir_path: str) -> None:
    for entry in os.listdir(dir_path):
        if entry not in IGNORED_LIBRARY_FILES:
            continue
        entry_path = os.path.join(dir_path, entry)
        if os.path.isfile(entry_path):
            os.remove(entry_path)


class _ReadOnlyHashCache:
    """Hash helper used by scan-only cleaner audits."""

    def get_hash(self, file_path: str) -> Tuple[Optional[str], bool]:
        try:
            return compute_hash_legacy(file_path), False
        except Exception:
            return None, False


@dataclass
class AuditMediaIdentity:
    canonical_hash: str
    duplicate_key: str
    date_taken: str
    date_obj: datetime


def _detail_message_for_issue(issue: Dict[str, str]) -> str:
    kind = issue["kind"]
    path = issue["path"]
    detail = issue.get("detail") or ""

    if kind == "misnamed_or_misfiled":
        expected = detail.removeprefix("expected ").strip() if detail.startswith("expected ") else detail
        return f"{path} should be filed as {expected}" if expected else f"{path} is misfiled"
    if kind == "noncanonical_root_file":
        return f"{path} is outside the YYYY/YYYY-MM-DD library structure"
    if kind == "noncanonical_root_folder":
        return f"{path} is a noncanonical root folder"
    if kind == "noncanonical_folder":
        return f"{path} is a noncanonical YYYY/YYYY-MM-DD folder"
    if kind == "empty_folder":
        return f"{path} is an empty folder"
    if kind == "duplicate_media":
        other = detail.removeprefix("same hash as ").strip() if detail.startswith("same hash as ") else detail
        return f"{path} duplicates {other}" if other else f"{path} is a duplicate"
    if kind == "unsupported_or_nonmedia":
        return f"{path} is not a supported media file"
    if kind == "corrupted_media":
        return f"{path} appears corrupted or unreadable"
    if kind == "unbaked_rotation":
        return f"{path} has unbaked rotation ({detail})" if detail else f"{path} has unbaked rotation"
    if kind == "rating_zero":
        return f"{path} has rating=0 metadata that should be stripped"
    if kind == "ghost_db_reference":
        return f"{path} is missing on disk but still present in the database"
    if kind == "mole_missing_from_db":
        return f"{path} is missing from the database"
    if kind == "db_hash_mismatch":
        return f"{path} hash mismatch ({detail})" if detail else f"{path} hash mismatch"
    if kind == "missing_library_metadata_dir":
        return f"{path} metadata folder is missing"
    if kind == "missing_library_db":
        return f"{path} database file is missing"
    if kind == "invalid_library_db":
        return f"{path} database file is invalid"
    if kind == "unexpected_library_metadata_dir":
        return f"{path} is an unexpected folder inside .library"
    if kind == "unexpected_library_metadata_file":
        return f"{path} is an unexpected file inside .library"
    return f"{path} ({detail})" if detail else path


def _detail_item(issue: Dict[str, str]) -> Dict[str, str]:
    return {
        "kind": issue["kind"],
        "path": issue["path"],
        "message": _detail_message_for_issue(issue),
    }


def _compute_photo_audit_identity(full_path: str) -> AuditMediaIdentity:
    with tempfile.TemporaryDirectory(prefix="clean_scan_photo_") as temp_dir:
        staged_path = os.path.join(temp_dir, os.path.basename(full_path))
        shutil.copy2(full_path, staged_path)
        canonical_photo = canonicalize_photo_file(
            staged_path,
            extract_exif_date=extract_exif_date,
            bake_orientation=bake_orientation,
            get_dimensions=lambda path: read_dimensions(path),
            compute_hash=compute_hash_legacy,
            write_photo_exif=write_photo_date_metadata,
            extract_exif_rating=extract_exif_rating,
            strip_exif_rating=strip_exif_rating,
        )
        duplicate_key = _compute_photo_duplicate_key(
            staged_path,
            fallback_hash=canonical_photo.content_hash,
        )
    return AuditMediaIdentity(
        canonical_hash=canonical_photo.content_hash,
        duplicate_key=duplicate_key,
        date_taken=canonical_photo.date_taken,
        date_obj=canonical_photo.date_obj,
    )


def _compute_audit_media_identity(
    full_path: str,
    file_type: str,
    stat_result: os.stat_result,
    current_hash: Optional[str] = None,
) -> AuditMediaIdentity:
    if file_type == "photo":
        return _compute_photo_audit_identity(full_path)

    if not current_hash:
        raise RuntimeError(f"Missing audit hash for {full_path}")

    date_taken, date_obj = parse_metadata_datetime(
        extract_exif_date(full_path),
        stat_result.st_mtime,
    )
    return AuditMediaIdentity(
        canonical_hash=current_hash,
        duplicate_key=current_hash,
        date_taken=date_taken,
        date_obj=date_obj,
    )


def summarize_clean_library_issues(issues: List[Dict[str, str]]) -> Dict[str, Any]:
    duplicate_paths = {issue["path"] for issue in issues if issue["kind"] == "duplicate_media"}
    unsupported_paths = {
        issue["path"]
        for issue in issues
        if issue["kind"] in {"corrupted_media", "unsupported_or_nonmedia"}
    }
    trash_paths = duplicate_paths | unsupported_paths

    misfiled_by_path: Dict[str, Dict[str, str]] = {}
    details = {
        "misfiled_media": [],
        "duplicates": [],
        "unsupported_files": [],
        "metadata_cleanup": [],
        "database_repairs": [],
    }

    for issue in issues:
        kind = issue["kind"]
        path = issue["path"]

        if kind == "duplicate_media":
            details["duplicates"].append(_detail_item(issue))
        elif kind in {"corrupted_media", "unsupported_or_nonmedia"}:
            details["unsupported_files"].append(_detail_item(issue))
        elif kind in {"unbaked_rotation", "rating_zero"}:
            if path not in trash_paths:
                details["metadata_cleanup"].append(_detail_item(issue))
        elif kind in {
            "misnamed_or_misfiled",
            "empty_folder",
            "noncanonical_folder",
            "noncanonical_root_folder",
            "noncanonical_root_file",
        }:
            if path in trash_paths:
                continue
            candidate = _detail_item(issue)
            existing = misfiled_by_path.get(path)
            if existing is None or kind == "misnamed_or_misfiled":
                misfiled_by_path[path] = candidate
        elif kind in {
            "ghost_db_reference",
            "mole_missing_from_db",
            "db_hash_mismatch",
            "missing_library_metadata_dir",
            "missing_library_db",
            "invalid_library_db",
            "unexpected_library_metadata_dir",
            "unexpected_library_metadata_file",
        }:
            if path not in trash_paths:
                details["database_repairs"].append(_detail_item(issue))

    details["misfiled_media"] = list(misfiled_by_path.values())

    summary = {
        "misfiled_media": len(details["misfiled_media"]),
        "duplicates": len(details["duplicates"]),
        "unsupported_files": len(details["unsupported_files"]),
        "metadata_cleanup": len(details["metadata_cleanup"]),
        "database_repairs": len(details["database_repairs"]),
        "issue_count": (
            len(details["misfiled_media"])
            + len(details["duplicates"])
            + len(details["unsupported_files"])
            + len(details["metadata_cleanup"])
            + len(details["database_repairs"])
        ),
    }
    return {"summary": summary, "details": details}


def _sort_detail_items(items: List[Dict[str, str]]) -> List[Dict[str, str]]:
    return sorted(
        items,
        key=lambda item: (
            item.get("path", "").lower(),
            item.get("kind", "").lower(),
            item.get("message", "").lower(),
        ),
    )


def _expected_rel_path_from_issue(issue: Dict[str, str]) -> Optional[str]:
    if issue.get("kind") != "misnamed_or_misfiled":
        return None
    detail = issue.get("detail") or ""
    expected = detail.removeprefix("expected ").strip()
    return expected or None


def _metadata_cleanup_detail(path: str, issues: List[Dict[str, str]]) -> Dict[str, str]:
    parts: List[str] = []
    for issue in sorted(issues, key=lambda item: item["kind"]):
        if issue["kind"] == "rating_zero":
            parts.append("strip rating=0 metadata")
        elif issue["kind"] == "unbaked_rotation":
            orientation = (issue.get("detail") or "").strip()
            parts.append(
                f"bake rotation ({orientation})" if orientation else "bake rotation"
            )
        else:
            parts.append(_detail_message_for_issue(issue))

    if not parts:
        message = f"{path} needs metadata cleanup"
    elif len(parts) == 1:
        message = f"{path} needs metadata cleanup: {parts[0]}"
    else:
        message = f"{path} needs metadata cleanup: {'; '.join(parts)}"

    return {"kind": "metadata_cleanup", "path": path, "message": message}


def _folder_cleanup_detail(path: str) -> Dict[str, str]:
    return {
        "kind": "folder_cleanup",
        "path": path,
        "message": f"{path} will be removed after file cleanup",
    }


def _build_directory_snapshot(
    library_path: str,
) -> Tuple[set[str], Dict[str, set[str]], Dict[str, set[str]]]:
    known_dirs: set[str] = set()
    child_dirs: Dict[str, set[str]] = {".": set()}
    file_entries: Dict[str, set[str]] = {".": set()}

    for root, dirs, files in os.walk(library_path, topdown=True):
        rel_root = os.path.relpath(root, library_path)
        if rel_root != "." and in_infrastructure(rel_root):
            dirs[:] = []
            continue

        child_dirs.setdefault(rel_root, set())
        file_entries.setdefault(rel_root, set())
        if rel_root != ".":
            known_dirs.add(rel_root)

        filtered_dirs: List[str] = []
        for dirname in dirs:
            child_rel = os.path.relpath(os.path.join(root, dirname), library_path)
            if in_infrastructure(child_rel):
                continue
            filtered_dirs.append(dirname)
            child_dirs[rel_root].add(dirname)
            child_dirs.setdefault(child_rel, set())
            file_entries.setdefault(child_rel, set())
            known_dirs.add(child_rel)
        dirs[:] = filtered_dirs

        for filename in files:
            if filename in IGNORED_LIBRARY_FILES:
                continue
            file_entries[rel_root].add(filename)

    return known_dirs, child_dirs, file_entries


def _ensure_simulated_dir(
    rel_dir: str,
    known_dirs: set[str],
    child_dirs: Dict[str, set[str]],
    file_entries: Dict[str, set[str]],
) -> None:
    if not rel_dir or rel_dir == ".":
        child_dirs.setdefault(".", set())
        file_entries.setdefault(".", set())
        return

    missing: List[str] = []
    current = rel_dir
    while current and current != "." and current not in child_dirs:
        missing.append(current)
        current = os.path.dirname(current) or "."

    while missing:
        dir_rel = missing.pop()
        parent_rel = os.path.dirname(dir_rel) or "."
        child_dirs.setdefault(parent_rel, set()).add(os.path.basename(dir_rel))
        child_dirs.setdefault(dir_rel, set())
        file_entries.setdefault(dir_rel, set())
        known_dirs.add(dir_rel)


def _predict_folder_cleanup_paths(
    library_path: str,
    move_targets: Dict[str, str],
    trashed_paths: set[str],
) -> List[str]:
    known_dirs, child_dirs, file_entries = _build_directory_snapshot(library_path)

    for rel_path in sorted(trashed_paths):
        parent_rel = os.path.dirname(rel_path) or "."
        file_entries.setdefault(parent_rel, set()).discard(os.path.basename(rel_path))

    for source_rel, target_rel in sorted(move_targets.items()):
        source_parent = os.path.dirname(source_rel) or "."
        target_parent = os.path.dirname(target_rel) or "."
        source_name = os.path.basename(source_rel)
        target_name = os.path.basename(target_rel)

        file_entries.setdefault(source_parent, set()).discard(source_name)
        _ensure_simulated_dir(target_parent, known_dirs, child_dirs, file_entries)
        file_entries.setdefault(target_parent, set()).add(target_name)

    removed_dirs: List[str] = []
    for rel_dir in sorted(
        known_dirs,
        key=lambda path: (-len(path_parts(path)), path.lower()),
    ):
        if file_entries.get(rel_dir) or child_dirs.get(rel_dir):
            continue
        removed_dirs.append(rel_dir)
        parent_rel = os.path.dirname(rel_dir) or "."
        child_dirs.setdefault(parent_rel, set()).discard(os.path.basename(rel_dir))

    return removed_dirs


def summarize_clean_library_operations(
    library_path: str,
    issues: List[Dict[str, str]],
) -> Dict[str, Any]:
    duplicate_paths = {issue["path"] for issue in issues if issue["kind"] == "duplicate_media"}
    unsupported_paths = {
        issue["path"]
        for issue in issues
        if issue["kind"] in {"corrupted_media", "unsupported_or_nonmedia"}
    }
    trashed_paths = duplicate_paths | unsupported_paths

    # Align with summarize_clean_library_issues: misfiled_media includes structural
    # issues (folders / root layout), with per-path collapsing rules.
    misfiled_by_path: Dict[str, Dict[str, str]] = {}
    misnamed_issues_by_path: Dict[str, Dict[str, str]] = {}
    metadata_issues_by_path: Dict[str, List[Dict[str, str]]] = {}
    database_repairs: List[Dict[str, str]] = []

    for issue in issues:
        kind = issue["kind"]
        path = issue["path"]

        if kind in {
            "misnamed_or_misfiled",
            "empty_folder",
            "noncanonical_folder",
            "noncanonical_root_folder",
            "noncanonical_root_file",
        }:
            if path in trashed_paths:
                continue
            candidate = _detail_item(issue)
            existing = misfiled_by_path.get(path)
            if existing is None or kind == "misnamed_or_misfiled":
                misfiled_by_path[path] = candidate
            if kind == "misnamed_or_misfiled":
                misnamed_issues_by_path[path] = issue
            continue

        if kind in {"unbaked_rotation", "rating_zero"}:
            if path in trashed_paths:
                continue
            metadata_issues_by_path.setdefault(path, []).append(issue)
            continue

        if kind in {
            "ghost_db_reference",
            "mole_missing_from_db",
            "db_hash_mismatch",
            "missing_library_metadata_dir",
            "missing_library_db",
            "invalid_library_db",
            "unexpected_library_metadata_dir",
            "unexpected_library_metadata_file",
        }:
            if path in trashed_paths:
                continue
            database_repairs.append(_detail_item(issue))

    move_details = _sort_detail_items(list(misfiled_by_path.values()))
    duplicate_details = _sort_detail_items(
        [_detail_item(issue) for issue in issues if issue["kind"] == "duplicate_media"]
    )
    unsupported_details = _sort_detail_items(
        [
            _detail_item(issue)
            for issue in issues
            if issue["kind"] in {"corrupted_media", "unsupported_or_nonmedia"}
        ]
    )
    metadata_details = _sort_detail_items(
        [
            _metadata_cleanup_detail(path, path_issues)
            for path, path_issues in sorted(metadata_issues_by_path.items())
        ]
    )

    move_targets = {
        path: expected_rel
        for path, issue in misnamed_issues_by_path.items()
        if (expected_rel := _expected_rel_path_from_issue(issue))
    }
    folder_cleanup_details = _sort_detail_items(
        [
            _folder_cleanup_detail(path)
            for path in _predict_folder_cleanup_paths(
                library_path,
                move_targets=move_targets,
                trashed_paths=trashed_paths,
            )
        ]
    )
    database_repairs = _sort_detail_items(database_repairs)

    details = {
        "misfiled_media": move_details,
        "unsupported_files": unsupported_details,
        "duplicates": duplicate_details,
        "metadata_cleanup": metadata_details,
        "folder_cleanup": folder_cleanup_details,
        "database_repairs": database_repairs,
    }
    summary = {
        "misfiled_media": len(details["misfiled_media"]),
        "unsupported_files": len(details["unsupported_files"]),
        "duplicates": len(details["duplicates"]),
        "metadata_cleanup": len(details["metadata_cleanup"]),
        "folder_cleanup": len(details["folder_cleanup"]),
        "database_repairs": len(details["database_repairs"]),
        "operation_count": (
            len(details["misfiled_media"])
            + len(details["unsupported_files"])
            + len(details["duplicates"])
            + len(details["metadata_cleanup"])
            + len(details["folder_cleanup"])
            + len(details["database_repairs"])
        ),
    }
    return {"summary": summary, "details": details}


class LibraryCleaner:
    def __init__(self, library_path: str, db_path: Optional[str] = None):
        self.library_path = os.path.abspath(library_path)
        self.db_path = resolve_db_path(self.library_path, db_path)
        self.db_conn: Optional[sqlite3.Connection] = None
        self.hash_cache: Optional[HashCache] = None
        self.manifest = None
        self.stats = {
            "moved_to_trash": 0,
            "duplicates_trashed": 0,
            "metadata_fixed": 0,
            "media_moved": 0,
            "folders_removed": 0,
            "db_rows_rebuilt": 0,
        }
        self._remaining_operation_paths: Dict[str, set[str]] = {
            key: set() for key in CLEAN_LIBRARY_SIGNAL_KEYS
        }
        self._progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None

    def _emit(self, payload: Dict[str, Any]) -> None:
        if self._progress_callback:
            self._progress_callback(dict(payload))

    def _build_operation_plan(self) -> Dict[str, Any]:
        saved_db_conn = self.db_conn
        saved_hash_cache = self.hash_cache
        temp_db_conn: Optional[sqlite3.Connection] = None
        try:
            if os.path.exists(self.db_path) and db_is_valid(self.db_path):
                temp_db_conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
                temp_db_conn.row_factory = sqlite3.Row
            self.db_conn = temp_db_conn
            self.hash_cache = _ReadOnlyHashCache()
            issues = self.final_audit()
            return summarize_clean_library_operations(self.library_path, issues)
        finally:
            self.hash_cache = saved_hash_cache
            if temp_db_conn is not None:
                temp_db_conn.close()
            self.db_conn = saved_db_conn

    def _remaining_signal_summary(self) -> Dict[str, int]:
        summary = {
            key: len(self._remaining_operation_paths.get(key) or ())
            for key in CLEAN_LIBRARY_SIGNAL_KEYS
        }
        summary["operation_count"] = sum(summary.values())
        return summary

    def _seed_operation_plan(self, operations: Dict[str, Any]) -> None:
        details = operations.get("details") or {}
        self._remaining_operation_paths = {
            key: {
                item.get("path", "")
                for item in (details.get(key) or [])
                if item.get("path")
            }
            for key in CLEAN_LIBRARY_SIGNAL_KEYS
        }
        self._emit(
            {
                "type": "signal_plan",
                "summary": operations.get("summary") or self._remaining_signal_summary(),
                "details": details,
            }
        )

    def _resolve_signal_paths(
        self,
        signal_paths: Dict[str, Iterable[str]],
        *,
        action: Optional[str] = None,
    ) -> None:
        deltas: Dict[str, int] = {}
        for signal, paths in signal_paths.items():
            remaining_paths = self._remaining_operation_paths.get(signal)
            if not remaining_paths:
                continue
            for path in paths:
                if path and path in remaining_paths:
                    remaining_paths.remove(path)
                    deltas[signal] = deltas.get(signal, 0) + 1
        if not deltas:
            return
        payload: Dict[str, Any] = {
            "type": "signal_delta",
            "deltas": deltas,
            "remaining": self._remaining_signal_summary(),
        }
        if action:
            payload["action"] = action
        self._emit(payload)

    def log(self, action: str, **payload: Any) -> None:
        if not self.manifest:
            return
        self.manifest.write(
            json.dumps(
                {
                    "timestamp": datetime.now().isoformat(),
                    "action": action,
                    **payload,
                }
            )
            + "\n"
        )
        self.manifest.flush()

    def run(
        self,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        self._progress_callback = progress_callback
        try:
            if self._progress_callback:
                self._seed_operation_plan(self._build_operation_plan())
            self._emit({"type": "phase", "phase": "setup", "status": "starting"})
            self.setup()
            self._emit({"type": "phase", "phase": "setup", "status": "complete"})

            candidate_total = self._count_walk_files()
            self._emit(
                {
                    "type": "phase",
                    "phase": "scan",
                    "status": "starting",
                    "total_candidates": candidate_total,
                }
            )
            records = self.scan_and_normalize(candidate_total)
            self._emit(
                {
                    "type": "phase",
                    "phase": "scan",
                    "status": "complete",
                    "records": len(records),
                }
            )

            self._emit({"type": "phase", "phase": "dedupe", "status": "starting"})
            deduped = self.trash_duplicates(records)
            self._emit(
                {
                    "type": "phase",
                    "phase": "dedupe",
                    "status": "complete",
                    "remaining": len(deduped),
                }
            )

            self._emit(
                {
                    "type": "phase",
                    "phase": "canonicalize",
                    "status": "starting",
                    "total": len(deduped),
                }
            )
            canonicalized = self.move_to_canonical_locations(deduped)
            self._emit({"type": "phase", "phase": "canonicalize", "status": "complete"})

            self.stats["metadata_fixed"] = sum(1 for record in canonicalized if record.metadata_cleaned)
            self._emit({"type": "phase", "phase": "folders", "status": "starting"})
            self.remove_empty_noncanonical_folders()
            self._emit({"type": "phase", "phase": "folders", "status": "complete"})

            self._emit(
                {
                    "type": "phase",
                    "phase": "rebuild_db",
                    "status": "starting",
                    "total": len(canonicalized),
                }
            )
            self.rebuild_photos_table(canonicalized)
            self._emit({"type": "phase", "phase": "rebuild_db", "status": "complete"})

            self._emit({"type": "phase", "phase": "audit", "status": "starting"})
            issues = self.final_audit(audit_progress_total=len(canonicalized))
            if issues:
                preview = issues[:10]
                self.log("final_audit_failed", issue_count=len(issues), issues=preview)
                self._emit(
                    {
                        "type": "phase",
                        "phase": "audit",
                        "status": "failed",
                        "issue_count": len(issues),
                    }
                )
                raise CleanLibraryError(
                    f"Final audit failed with {len(issues)} issue(s): "
                    + "; ".join(f"{item['kind']}:{item['path']}" for item in preview)
                )
            self._emit({"type": "phase", "phase": "audit", "status": "complete"})

            self.log("operation_complete", stats=self.stats)
            return {"status": "SUCCESS", "stats": self.stats}
        except Exception as exc:
            self.log(
                "operation_failed",
                error=str(exc),
                traceback=traceback.format_exc(),
                stats=self.stats,
            )
            raise
        finally:
            self._progress_callback = None
            if self.hash_cache is not None:
                try:
                    self.hash_cache.cleanup_stale_entries(self.library_path)
                except Exception:
                    pass
            if self.manifest is not None:
                self.manifest.close()
            if self.db_conn is not None:
                self.db_conn.close()

    def scan(self) -> Dict[str, Any]:
        try:
            if os.path.exists(self.db_path) and db_is_valid(self.db_path):
                self.db_conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
                self.db_conn.row_factory = sqlite3.Row
            self.hash_cache = _ReadOnlyHashCache()
            issues = self.final_audit()
            payload = summarize_clean_library_issues(issues)
            payload["operations"] = summarize_clean_library_operations(
                self.library_path,
                issues,
            )
            payload["status"] = "DIRTY" if issues else "CLEAN"
            return payload
        finally:
            self.hash_cache = None
            if self.db_conn is not None:
                self.db_conn.close()
                self.db_conn = None

    def setup(self) -> None:
        metadata_dir_path = os.path.join(self.library_path, LIBRARY_METADATA_DIR)
        canonical_db = canonical_db_path(self.library_path)
        metadata_dir_missing = not os.path.isdir(metadata_dir_path)
        canonical_db_missing = not os.path.exists(canonical_db)
        canonical_db_invalid = os.path.exists(canonical_db) and not db_is_valid(canonical_db)

        for folder in [LIBRARY_METADATA_DIR, ".db_backups", ".logs", ".thumbnails", ".trash"]:
            os.makedirs(os.path.join(self.library_path, folder), exist_ok=True)

        self.migrate_db_to_canonical_location()

        quarantined_metadata = quarantine_unexpected_metadata_entries(
            self.library_path,
            reason="make_perfect",
        )

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        if os.path.exists(self.db_path):
            backup_path = os.path.join(
                self.library_path,
                ".db_backups",
                f"photo_library_{timestamp}.db",
            )
            shutil.copy2(self.db_path, backup_path)

        manifest_path = os.path.join(
            self.library_path,
            ".logs",
            f"clean_library_{timestamp}.jsonl",
        )
        self.manifest = open(manifest_path, "a", encoding="utf-8")
        self.log("operation_started", library_path=self.library_path, db_path=self.db_path)
        if quarantined_metadata:
            self.log(
                "metadata_artifacts_quarantined",
                paths=[os.path.relpath(path, self.library_path) for path in quarantined_metadata],
            )

        repaired_paths = {
            os.path.relpath(path, self.library_path) for path in quarantined_metadata
        }
        if metadata_dir_missing:
            repaired_paths.add(LIBRARY_METADATA_DIR)
        if canonical_db_missing or canonical_db_invalid:
            repaired_paths.add(os.path.relpath(canonical_db, self.library_path))
        self._resolve_signal_paths(
            {"database_repairs": repaired_paths},
            action="setup",
        )

        self.db_conn = sqlite3.connect(self.db_path)
        self.db_conn.row_factory = sqlite3.Row
        self.db_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.db_conn.execute("PRAGMA journal_mode=DELETE")
        create_database_schema(self.db_conn.cursor())
        self.db_conn.commit()
        self.hash_cache = HashCache(self.db_conn)

    def migrate_db_to_canonical_location(self) -> None:
        target_db_path = canonical_db_path(self.library_path)
        if os.path.abspath(self.db_path) == os.path.abspath(target_db_path):
            self.db_path = target_db_path
            return

        if not os.path.exists(self.db_path):
            self.db_path = target_db_path
            return

        os.makedirs(os.path.dirname(target_db_path), exist_ok=True)
        if os.path.exists(target_db_path):
            raise CleanLibraryError(
                f"Refusing to migrate legacy database because canonical path already exists: {target_db_path}"
            )

        shutil.move(self.db_path, target_db_path)
        for source_sidecar in db_sidecar_paths(self.db_path):
            if not os.path.exists(source_sidecar):
                continue
            sidecar_name = os.path.basename(source_sidecar)
            target_sidecar = os.path.join(os.path.dirname(target_db_path), sidecar_name)
            if os.path.exists(target_sidecar):
                raise CleanLibraryError(
                    f"Refusing to overwrite canonical DB sidecar during migration: {target_sidecar}"
                )
            shutil.move(source_sidecar, target_sidecar)

        self.log(
            "db_migrated_to_hidden_folder",
            source=os.path.relpath(self.db_path, self.library_path),
            destination=os.path.relpath(target_db_path, self.library_path),
        )
        self.db_path = target_db_path

    def active_walk(self) -> Iterable[Tuple[str, List[str], List[str]]]:
        for root, dirs, files in os.walk(self.library_path, topdown=True):
            rel_root = os.path.relpath(root, self.library_path)
            if rel_root != "." and in_infrastructure(rel_root):
                dirs[:] = []
                continue
            yield root, dirs, files

    def move_to_trash(self, file_path: str, category: str) -> str:
        rel_path = os.path.relpath(file_path, self.library_path)
        target = os.path.join(self.library_path, ".trash", category, rel_path)
        os.makedirs(os.path.dirname(target), exist_ok=True)

        candidate = target
        counter = 1
        base, ext = os.path.splitext(target)
        while os.path.exists(candidate):
            candidate = f"{base}_{counter}{ext}"
            counter += 1

        shutil.move(file_path, candidate)
        self.stats["moved_to_trash"] += 1
        self.log("moved_to_trash", source=rel_path, destination=os.path.relpath(candidate, self.library_path), category=category)
        return candidate

    def normalize_media_file(self, full_path: str) -> Optional[MediaRecord]:
        rel_path = os.path.relpath(full_path, self.library_path)
        ext = os.path.splitext(full_path)[1].lower()
        original_filename = os.path.basename(full_path)

        if not is_supported_media_extension(ext):
            self.move_to_trash(full_path, "non_media")
            self._resolve_signal_paths({"unsupported_files": [rel_path]}, action="trash_unsupported")
            return None

        valid, _ = verify_media_file(full_path)
        if not valid:
            self.move_to_trash(full_path, "corrupted")
            self._resolve_signal_paths({"unsupported_files": [rel_path]}, action="trash_corrupted")
            return None

        stat_result = os.stat(full_path)
        file_type = media_kind_for_extension(ext) or "photo"
        metadata_cleaned = False
        has_metadata_cleanup_signal = False

        if file_type == "photo":
            assert self.hash_cache is not None
            original_orientation = get_orientation_flag(full_path)
            original_rating = extract_exif_rating(full_path)
            has_metadata_cleanup_signal = (
                original_orientation not in (None, 1)
                and can_bake_losslessly(full_path)
            ) or original_rating == 0
            try:
                canonical_photo = canonicalize_photo_file(
                    full_path,
                    extract_exif_date=extract_exif_date,
                    bake_orientation=bake_orientation,
                    get_dimensions=lambda path: read_dimensions(path),
                    compute_hash=lambda path: self.hash_cache.get_hash(path)[0],
                    write_photo_exif=write_photo_date_metadata,
                    extract_exif_rating=extract_exif_rating,
                    strip_exif_rating=strip_exif_rating,
                )
            except Exception as exc:
                raise CleanLibraryError(str(exc)) from exc

            if canonical_photo.orientation_baked:
                self.log("orientation_baked", file=rel_path, message="canonicalized")
            else:
                orientation = get_orientation_flag(full_path)
                if orientation not in (None, 1) and ext in LOSSLESS_ROTATION_EXTENSIONS:
                    self.log("orientation_kept", file=rel_path, message=str(orientation))

            if canonical_photo.rating_stripped:
                self.log("rating_stripped", file=rel_path)

            if canonical_photo.metadata_changed and not (
                canonical_photo.orientation_baked or canonical_photo.rating_stripped
            ):
                self.log("date_metadata_canonicalized", file=rel_path, date=canonical_photo.date_taken)

            valid, _ = verify_media_file(full_path)
            if not valid:
                self.move_to_trash(full_path, "corrupted")
                self._resolve_signal_paths({"unsupported_files": [rel_path]}, action="trash_corrupted")
                return None

            content_hash = canonical_photo.content_hash
            duplicate_key = _compute_photo_duplicate_key(
                full_path,
                fallback_hash=canonical_photo.content_hash,
            )
            date_taken = canonical_photo.date_taken
            date_obj = canonical_photo.date_obj
            width = canonical_photo.width
            height = canonical_photo.height
            rating = canonical_photo.rating
            metadata_cleaned = canonical_photo.metadata_changed
        else:
            orientation = get_orientation_flag(full_path)
            has_metadata_cleanup_signal = (
                orientation not in (None, 1)
                and ext in LOSSLESS_ROTATION_EXTENSIONS
            )
            if orientation not in (None, 1) and ext in LOSSLESS_ROTATION_EXTENSIONS:
                baked, message, baked_orientation = bake_orientation(full_path)
                if baked:
                    metadata_cleaned = True
                    self.log("orientation_baked", file=rel_path, message=message)
                elif baked_orientation is not None:
                    self.log("orientation_kept", file=rel_path, message=message)

            rating = extract_exif_rating(full_path)
            if rating == 0:
                has_metadata_cleanup_signal = True
                if not strip_exif_rating(full_path):
                    raise CleanLibraryError(f"Failed to strip rating=0 from {rel_path}")
                metadata_cleaned = True
                self.log("rating_stripped", file=rel_path)

            valid, _ = verify_media_file(full_path)
            if not valid:
                self.move_to_trash(full_path, "corrupted")
                self._resolve_signal_paths({"unsupported_files": [rel_path]}, action="trash_corrupted")
                return None

            assert self.hash_cache is not None
            content_hash, _ = self.hash_cache.get_hash(full_path)
            if not content_hash:
                self.move_to_trash(full_path, "corrupted")
                self._resolve_signal_paths({"unsupported_files": [rel_path]}, action="trash_corrupted")
                return None
            duplicate_key = content_hash

            date_taken, date_obj = parse_metadata_datetime(
                extract_exif_date(full_path),
                stat_result.st_mtime,
            )
            width, height = read_dimensions(full_path)
            rating = extract_exif_rating(full_path)

        return MediaRecord(
            original_filename=original_filename,
            source_rel_path=rel_path,
            full_path=full_path,
            rel_path=rel_path,
            ext=ext,
            file_type=file_type,
            content_hash=content_hash,
            duplicate_key=duplicate_key,
            date_taken=date_taken,
            date_obj=date_obj,
            width=width,
            height=height,
            rating=rating if rating != 0 else None,
            metadata_cleaned=metadata_cleaned,
            has_metadata_cleanup_signal=has_metadata_cleanup_signal,
            birth_time=get_birth_time(stat_result),
            modified_time=float(stat_result.st_mtime),
        )

    def _count_walk_files(self) -> int:
        """Count supported media files under the library (matches scan progress ticks)."""
        n = 0
        for root, _, files in self.active_walk():
            for filename in files:
                if filename in IGNORED_LIBRARY_FILES:
                    continue
                ext = os.path.splitext(filename)[1].lower()
                if is_supported_media_extension(ext):
                    n += 1
        return n

    def scan_and_normalize(self, candidate_total: int) -> List[MediaRecord]:
        records: List[MediaRecord] = []
        processed = 0

        for root, _, files in self.active_walk():
            for filename in files:
                if filename in IGNORED_LIBRARY_FILES:
                    continue
                full_path = os.path.join(root, filename)
                ext = os.path.splitext(filename)[1].lower()
                if not is_supported_media_extension(ext):
                    self.normalize_media_file(full_path)
                    continue
                processed += 1
                self._emit(
                    {
                        "type": "progress",
                        "phase": "scan",
                        "processed": processed,
                        "total": max(candidate_total, 1),
                    }
                )
                record = self.normalize_media_file(full_path)
                if record is not None:
                    records.append(record)

        self.log("scan_complete", media_count=len(records))
        return records

    def duplicate_sort_key(self, record: MediaRecord) -> Tuple[int, datetime, float, float, str]:
        prefers_unknown_date_last = 1 if record.date_taken == UNKNOWN_PHOTO_DATE_TAKEN else 0
        return (
            prefers_unknown_date_last,
            record.date_obj,
            record.birth_time,
            record.modified_time,
            record.rel_path.lower(),
        )

    def trash_duplicates(self, records: List[MediaRecord]) -> List[MediaRecord]:
        grouped: Dict[str, List[MediaRecord]] = {}
        for record in records:
            grouped.setdefault(record.duplicate_key, []).append(record)

        survivors: List[MediaRecord] = []
        total_groups = len(grouped)
        for gi, (duplicate_key, group) in enumerate(grouped.items(), start=1):
            self._emit(
                {
                    "type": "progress",
                    "phase": "dedupe",
                    "processed": gi,
                    "total": max(total_groups, 1),
                }
            )
            ordered = sorted(group, key=self.duplicate_sort_key)
            winner = ordered[0]
            survivors.append(winner)
            loser_count = max(0, len(ordered) - 1)
            duplicate_group_paths = {record.source_rel_path for record in ordered}
            planned_duplicate_paths = sorted(
                duplicate_group_paths & self._remaining_operation_paths.get("duplicates", set())
            )

            for loser in ordered[1:]:
                self.move_to_trash(loser.full_path, "duplicates")
                self.stats["duplicates_trashed"] += 1
                self._resolve_signal_paths(
                    {
                        "misfiled_media": [loser.source_rel_path],
                        "database_repairs": [loser.source_rel_path],
                    },
                    action="trash_duplicate",
                )
                self.log(
                    "duplicate_trashed",
                    winner=winner.rel_path,
                    loser=loser.rel_path,
                    duplicate_key=duplicate_key,
                )
            if loser_count:
                self._resolve_signal_paths(
                    {"duplicates": planned_duplicate_paths[:loser_count]},
                    action="trash_duplicate",
                )

        return survivors

    def move_to_canonical_locations(self, records: List[MediaRecord]) -> List[MediaRecord]:
        occupied: set[str] = set()
        canonicalized: List[MediaRecord] = []
        sorted_records = sorted(
            records, key=lambda item: (item.date_taken, item.content_hash, item.rel_path.lower())
        )
        total = len(sorted_records)

        for idx, record in enumerate(sorted_records, start=1):
            self._emit(
                {
                    "type": "progress",
                    "phase": "canonicalize",
                    "processed": idx,
                    "total": max(total, 1),
                }
            )
            target_rel = canonical_relative_path(record.date_obj, record.content_hash, record.ext)
            if target_rel in occupied:
                raise CleanLibraryError(f"Canonical path collision for {target_rel}")

            target_full = os.path.join(self.library_path, target_rel)
            source_rel_path = record.rel_path
            if os.path.abspath(record.full_path) != os.path.abspath(target_full):
                os.makedirs(os.path.dirname(target_full), exist_ok=True)
                if os.path.exists(target_full):
                    raise CleanLibraryError(
                        f"Refusing to overwrite existing file at canonical path {target_rel}"
                    )
                shutil.move(record.full_path, target_full)
                self.stats["media_moved"] += 1
                self.log("media_moved", source=record.rel_path, destination=target_rel)
                record.full_path = target_full
                record.rel_path = target_rel

            resolved_paths: Dict[str, List[str]] = {}
            if source_rel_path != target_rel:
                resolved_paths["misfiled_media"] = [source_rel_path]
            if record.has_metadata_cleanup_signal:
                resolved_paths.setdefault("metadata_cleanup", []).append(record.source_rel_path)
            self._resolve_signal_paths(resolved_paths, action="canonicalize")

            occupied.add(target_rel)
            canonicalized.append(record)

        return canonicalized

    def remove_empty_noncanonical_folders(self) -> None:
        for root, _, _ in os.walk(self.library_path, topdown=False):
            rel_root = os.path.relpath(root, self.library_path)
            if rel_root == ".":
                continue
            if in_infrastructure(rel_root):
                continue
            if os.path.isdir(root) and not visible_directory_entries(root):
                remove_ignored_directory_files(root)
                os.rmdir(root)
                self.stats["folders_removed"] += 1
                self.log("folder_removed", path=rel_root)
                self._resolve_signal_paths(
                    {
                        "misfiled_media": [rel_root],
                        "folder_cleanup": [rel_root],
                    },
                    action="remove_folder",
                )

    def rebuild_photos_table(self, records: List[MediaRecord]) -> None:
        assert self.db_conn is not None
        cursor = self.db_conn.cursor()
        existing_rows = cursor.execute(
            "SELECT current_path, content_hash FROM photos"
        ).fetchall()
        existing_hash_by_path = {row["current_path"]: row["content_hash"] for row in existing_rows}
        record_hash_by_source_path = {
            record.source_rel_path: record.content_hash for record in records
        }
        repaired_db_paths = set()
        for current_path, content_hash in existing_hash_by_path.items():
            planned_hash = record_hash_by_source_path.get(current_path)
            if planned_hash is None or planned_hash != content_hash:
                repaired_db_paths.add(current_path)
        for source_rel_path in record_hash_by_source_path:
            if source_rel_path not in existing_hash_by_path:
                repaired_db_paths.add(source_rel_path)
        self._resolve_signal_paths(
            {"database_repairs": repaired_db_paths},
            action="rebuild_db",
        )
        cursor.execute("DELETE FROM photos")

        sorted_rows = sorted(records, key=lambda item: (item.date_taken, item.rel_path.lower()))
        total = len(sorted_rows)

        for idx, record in enumerate(sorted_rows, start=1):
            self._emit(
                {
                    "type": "progress",
                    "phase": "rebuild_db",
                    "processed": idx,
                    "total": max(total, 1),
                }
            )
            file_size = os.path.getsize(record.full_path)
            cursor.execute(
                """
                INSERT INTO photos (
                    original_filename,
                    current_path,
                    date_taken,
                    content_hash,
                    file_size,
                    file_type,
                    width,
                    height,
                    rating
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.original_filename,
                    record.rel_path,
                    record.date_taken,
                    record.content_hash,
                    file_size,
                    record.file_type,
                    record.width,
                    record.height,
                    record.rating,
                ),
            )

        self.db_conn.commit()
        self.stats["db_rows_rebuilt"] = len(records)
        self.log("photos_table_rebuilt", row_count=len(records))

    def audit_library_metadata_dir(self) -> List[Dict[str, str]]:
        issues: List[Dict[str, str]] = []
        metadata_dir = os.path.join(self.library_path, LIBRARY_METADATA_DIR)

        if not os.path.isdir(metadata_dir):
            issues.append(format_issue("missing_library_metadata_dir", LIBRARY_METADATA_DIR))
            return issues

        canonical_path = canonical_db_path(self.library_path)
        if not os.path.exists(canonical_path):
            issues.append(format_issue("missing_library_db", os.path.relpath(canonical_path, self.library_path)))
        elif not db_is_valid(canonical_path):
            issues.append(format_issue("invalid_library_db", os.path.relpath(canonical_path, self.library_path)))

        for item in os.listdir(metadata_dir):
            if item in IGNORED_LIBRARY_FILES:
                continue
            item_path = os.path.join(metadata_dir, item)
            rel_path = os.path.relpath(item_path, self.library_path)
            if os.path.isdir(item_path):
                issues.append(format_issue("unexpected_library_metadata_dir", rel_path))
                continue
            if not is_library_metadata_file(item):
                issues.append(format_issue("unexpected_library_metadata_file", rel_path))

        return issues

    def _count_supported_media_leaf_files(self) -> int:
        """Matches which paths final_audit() counts as supported media (for progress totals)."""
        n = 0
        for root, _dirs, files in self.active_walk():
            for filename in files:
                if filename in IGNORED_LIBRARY_FILES:
                    continue
                ext = os.path.splitext(filename)[1].lower()
                if is_supported_media_extension(ext):
                    n += 1
        return n

    def final_audit(self, audit_progress_total: Optional[int] = None) -> List[Dict[str, str]]:
        issues: List[Dict[str, str]] = []
        active_paths: set[str] = set()
        path_to_canonical_hash: Dict[str, str] = {}
        duplicate_key_groups: Dict[str, List[Tuple[str, str]]] = {}

        if audit_progress_total is not None:
            audit_total = max(audit_progress_total, 1)
        else:
            audit_total = max(self._count_supported_media_leaf_files(), 1)
        audit_idx = 0

        for item in os.listdir(self.library_path):
            if item in IGNORED_LIBRARY_FILES:
                continue
            full_path = os.path.join(self.library_path, item)
            if not root_entry_allowed(item, os.path.isdir(full_path)):
                issue_kind = "noncanonical_root_folder" if os.path.isdir(full_path) else "noncanonical_root_file"
                issues.append(format_issue(issue_kind, item))

        issues.extend(self.audit_library_metadata_dir())

        for root, dirs, files in self.active_walk():
            rel_root = os.path.relpath(root, self.library_path)
            parts = path_parts(rel_root)

            if rel_root != ".":
                if len(parts) == 1:
                    if not is_year_folder_name(parts[0]):
                        issues.append(format_issue("noncanonical_folder", rel_root))
                elif len(parts) == 2:
                    if not (is_year_folder_name(parts[0]) and is_day_folder_name(parts[0], parts[1])):
                        issues.append(format_issue("noncanonical_folder", rel_root))
                else:
                    issues.append(format_issue("noncanonical_folder", rel_root))

                if not visible_directory_entries(root):
                    issues.append(format_issue("empty_folder", rel_root))

            for dirname in dirs:
                dir_rel = os.path.relpath(os.path.join(root, dirname), self.library_path)
                dir_parts = path_parts(dir_rel)
                if dir_parts and dir_parts[0] in INFRASTRUCTURE_DIRS:
                    continue
                if len(dir_parts) > 2:
                    issues.append(format_issue("noncanonical_folder", dir_rel))

            for filename in files:
                if filename in IGNORED_LIBRARY_FILES:
                    continue
                full_path = os.path.join(root, filename)
                rel_path = os.path.relpath(full_path, self.library_path)

                ext = os.path.splitext(filename)[1].lower()
                if not is_supported_media_extension(ext):
                    issues.append(format_issue("unsupported_or_nonmedia", rel_path))
                    continue

                audit_idx += 1
                self._emit(
                    {
                        "type": "progress",
                        "phase": "audit",
                        "processed": audit_idx,
                        "total": max(audit_total, audit_idx, 1),
                    }
                )

                valid, _ = verify_media_file(full_path)
                if not valid:
                    issues.append(format_issue("corrupted_media", rel_path))
                    continue

                stat_result = os.stat(full_path)
                file_type = media_kind_for_extension(ext) or "photo"

                # Photos already compute their canonical hash during staged audit
                # canonicalization, so a pre-hash of the original path is redundant.
                if file_type == "photo":
                    try:
                        identity = _compute_audit_media_identity(
                            full_path=full_path,
                            file_type=file_type,
                            stat_result=stat_result,
                        )
                    except RuntimeError:
                        issues.append(format_issue("corrupted_media", rel_path))
                        continue
                else:
                    assert self.hash_cache is not None
                    current_hash, _ = self.hash_cache.get_hash(full_path)
                    if not current_hash:
                        issues.append(format_issue("corrupted_media", rel_path))
                        continue
                    identity = _compute_audit_media_identity(
                        full_path=full_path,
                        file_type=file_type,
                        stat_result=stat_result,
                        current_hash=current_hash,
                    )
                canonical_hash = identity.canonical_hash
                path_to_canonical_hash[rel_path] = canonical_hash

                date_taken = identity.date_taken
                expected_rel = canonical_relative_path(identity.date_obj, canonical_hash, ext)
                duplicate_key_groups.setdefault(identity.duplicate_key, []).append(
                    (rel_path, expected_rel)
                )
                if rel_path != expected_rel:
                    issues.append(
                        format_issue(
                            "misnamed_or_misfiled",
                            rel_path,
                            f"expected {expected_rel}",
                        )
                    )

                orientation = get_orientation_flag(full_path)
                if orientation not in (None, 1) and can_bake_losslessly(full_path):
                    issues.append(format_issue("unbaked_rotation", rel_path, str(orientation)))

                rating = extract_exif_rating(full_path)
                if rating == 0:
                    issues.append(format_issue("rating_zero", rel_path))

                active_paths.add(rel_path)
                _ = date_taken  # Keep the date normalization in the audit path explicit.

        for _duplicate_key, group in duplicate_key_groups.items():
            if len(group) < 2:
                continue
            ordered = sorted(
                group,
                key=lambda item: (
                    0 if item[0] == item[1] else 1,
                    item[0].lower(),
                ),
            )
            winner_rel = ordered[0][0]
            for loser_rel, _expected_rel in ordered[1:]:
                issues.append(
                    format_issue(
                        "duplicate_media",
                        loser_rel,
                        f"same hash as {winner_rel}",
                    )
                )

        db_rows: List[sqlite3.Row] = []
        db_paths: set[str] = set()
        if self.db_conn is not None:
            cursor = self.db_conn.cursor()
            cursor.execute("SELECT current_path, content_hash FROM photos")
            db_rows = cursor.fetchall()
            db_paths = {row["current_path"] for row in db_rows}

        for ghost_path in sorted(db_paths - active_paths):
            issues.append(format_issue("ghost_db_reference", ghost_path))
        for mole_path in sorted(active_paths - db_paths):
            issues.append(format_issue("mole_missing_from_db", mole_path))

        for row in db_rows:
            disk_hash = path_to_canonical_hash.get(row["current_path"])
            if disk_hash is not None and row["content_hash"] != disk_hash:
                issues.append(
                    format_issue(
                        "db_hash_mismatch",
                        row["current_path"],
                        f"db={row['content_hash']} disk={disk_hash}",
                    )
                )

        return issues


class DBNormalizationEngine(LibraryCleaner):
    """Authoritative DB normalization engine for library cleanup and repair."""


def scan_library_cleanliness(library_path: str, db_path: Optional[str] = None) -> Dict[str, Any]:
    engine = DBNormalizationEngine(library_path, db_path=db_path)
    return engine.scan()


def run_db_normalization_engine(
    library_path: str,
    db_path: Optional[str] = None,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    engine = DBNormalizationEngine(library_path, db_path=db_path)
    return engine.run(progress_callback=progress_callback)


def make_library_perfect(library_path: str, db_path: Optional[str] = None) -> Dict[str, Any]:
    """Backward-compatible wrapper for the DB normalization engine."""
    return run_db_normalization_engine(library_path, db_path=db_path)
