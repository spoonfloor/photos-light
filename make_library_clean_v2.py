"""
Clean library operation (v2).

Cheap inventory preflight by default; optional verify audit (?verify=1). Hash-only dupes.
Blocking final audit at end of every run — SUCCESS only when yardstick is CLEAN.
Full clean repairs in place; duplicate media === identical file hash only.

Set PHOTOS_CLEAN_LIBRARY_ENGINE=legacy to use make_library_perfect_legacy instead.
"""

from __future__ import annotations

CLEAN_LIBRARY_ENGINE_VERSION = "v2"

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
    CANONICAL_DB_DATE_FORMAT,
    PHOTO_MEDIA_EXTENSIONS,
    VIDEO_MEDIA_EXTENSIONS,
    IGNORED_LIBRARY_FILES,
    INFRASTRUCTURE_DIRS,
    canonical_relative_path,
    in_infrastructure,
    is_supported_media_extension,
    is_day_folder_name,
    is_year_folder_name,
    is_zip_artifact_name,
    media_kind_for_extension,
    parse_metadata_datetime,
    path_parts,
    root_entry_allowed,
    ZIP_ARTIFACT_DIR_NAMES,
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
from clean_library_fast_audit import (
    FastAuditCancelled,
    _basename_layout_issue,
    count_supported_media_leaf_files as fast_count_supported_media_leaf_files,
    run_fast_library_audit,
)
from clean_library_inventory import (
    estimate_remaining_duration_seconds,
    format_about_duration,
    inventory_media_library,
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

CHECKPOINT_VERSION = 1
CHECKPOINT_WRITE_INTERVAL = 25
CHECKPOINT_PHASE_ORDER = {
    "setup": 0,
    "scan": 1,
    "scan_complete": 2,
    "dedupe": 3,
    "dedupe_complete": 4,
    "canonicalize": 5,
    "canonicalize_complete": 6,
    "folders": 7,
    "folders_complete": 8,
    "rebuild_db": 9,
    "rebuild_db_complete": 10,
    "audit": 11,
    "audit_complete": 12,
    "complete": 13,
    "abandoned": 14,
}


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


class CleanLibraryCancelled(Exception):
    """Stop requested; checkpoint preserved for resume."""


def _serialize_media_record(record: MediaRecord) -> Dict[str, Any]:
    return {
        "original_filename": record.original_filename,
        "source_rel_path": record.source_rel_path,
        "full_path": record.full_path,
        "rel_path": record.rel_path,
        "ext": record.ext,
        "file_type": record.file_type,
        "content_hash": record.content_hash,
        "duplicate_key": record.duplicate_key,
        "date_taken": record.date_taken,
        "date_obj": record.date_obj.isoformat(),
        "width": record.width,
        "height": record.height,
        "rating": record.rating,
        "metadata_cleaned": record.metadata_cleaned,
        "has_metadata_cleanup_signal": record.has_metadata_cleanup_signal,
        "birth_time": record.birth_time,
        "modified_time": record.modified_time,
    }


def _deserialize_media_record(payload: Dict[str, Any]) -> MediaRecord:
    return MediaRecord(
        original_filename=str(payload["original_filename"]),
        source_rel_path=str(payload["source_rel_path"]),
        full_path=str(payload["full_path"]),
        rel_path=str(payload["rel_path"]),
        ext=str(payload["ext"]),
        file_type=str(payload["file_type"]),
        content_hash=str(payload["content_hash"]),
        duplicate_key=str(payload["duplicate_key"]),
        date_taken=str(payload["date_taken"]),
        date_obj=datetime.fromisoformat(str(payload["date_obj"])),
        width=payload.get("width"),
        height=payload.get("height"),
        rating=payload.get("rating"),
        metadata_cleaned=bool(payload.get("metadata_cleaned")),
        has_metadata_cleanup_signal=bool(payload.get("has_metadata_cleanup_signal")),
        birth_time=float(payload["birth_time"]),
        modified_time=float(payload["modified_time"]),
    )


def _checkpoint_paths_from_manifest(manifest_path: str) -> Dict[str, str]:
    base = manifest_path[: -len(".jsonl")] if manifest_path.endswith(".jsonl") else manifest_path
    return {
        "checkpoint": f"{base}.checkpoint.json",
        "records": f"{base}.records.jsonl",
        "scan_completed": f"{base}.scan_completed.txt",
    }


def _load_scan_completed_sources(path: str) -> set[str]:
    completed: set[str] = set()
    if not os.path.exists(path):
        return completed
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            rel_path = line.strip()
            if rel_path:
                completed.add(rel_path)
    return completed


def _load_records_jsonl(path: str) -> List[MediaRecord]:
    records: List[MediaRecord] = []
    if not os.path.exists(path):
        return records
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            records.append(_deserialize_media_record(json.loads(line)))
    return records


def _write_records_jsonl(path: str, records: Iterable[MediaRecord]) -> None:
    temp_path = f"{path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(_serialize_media_record(record)) + "\n")
    os.replace(temp_path, path)


def find_resumable_clean_library_checkpoint(library_path: str) -> Optional[Dict[str, Any]]:
    logs_dir = os.path.join(os.path.abspath(library_path), ".logs")
    if not os.path.isdir(logs_dir):
        return None

    candidates: List[Tuple[str, str, Dict[str, Any]]] = []
    for name in os.listdir(logs_dir):
        if not name.endswith(".checkpoint.json"):
            continue
        checkpoint_path = os.path.join(logs_dir, name)
        try:
            with open(checkpoint_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
        status = str(payload.get("status") or "")
        if status in {"complete", "abandoned"}:
            continue
        if payload.get("engine") != CLEAN_LIBRARY_ENGINE_VERSION:
            continue
        if os.path.abspath(str(payload.get("library_path") or "")) != os.path.abspath(library_path):
            continue
        candidates.append((str(payload.get("updated_at") or ""), checkpoint_path, payload))

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    _updated_at, checkpoint_path, payload = candidates[0]
    payload["_checkpoint_path"] = checkpoint_path
    return payload


def abandon_clean_library_checkpoint(checkpoint_path: str) -> None:
    try:
        with open(checkpoint_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return
    payload["status"] = "abandoned"
    payload["phase"] = "abandoned"
    payload["updated_at"] = datetime.now().isoformat()
    temp_path = f"{checkpoint_path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temp_path, checkpoint_path)


def _compute_photo_duplicate_key(full_path: str, fallback_hash: Optional[str] = None) -> str:
    """Duplicate key === file content hash (pixel-level dedupe excluded from spec)."""
    if fallback_hash:
        return fallback_hash
    file_hash, _ = compute_hash_legacy(full_path)
    if not file_hash:
        raise CleanLibraryError(f"Failed to compute duplicate key for {full_path}")
    return file_hash

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
            "scan_unchanged_skipped": 0,
        }
        self._remaining_operation_paths: Dict[str, set[str]] = {
            key: set() for key in CLEAN_LIBRARY_SIGNAL_KEYS
        }
        self._progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
        self._resume_checkpoint: Optional[Dict[str, Any]] = None
        self._checkpoint_path: Optional[str] = None
        self._manifest_path: Optional[str] = None
        self._records_jsonl_path: Optional[str] = None
        self._scan_completed_path: Optional[str] = None
        self._current_phase = "setup"
        self._scan_completed_sources: set[str] = set()
        self._canonicalize_index = 0
        self._checkpoint_dirty = False
        self._files_since_checkpoint = 0
        self._checkpoint_records_snapshot: Optional[List[MediaRecord]] = None
        self._cancel_check: Optional[Callable[[], bool]] = None

    def _cancel_requested(self) -> bool:
        return bool(self._cancel_check and self._cancel_check())

    def _raise_if_cancelled(self) -> None:
        if self._cancel_requested():
            raise CleanLibraryCancelled()

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
        entry = {
            "timestamp": datetime.now().isoformat(),
            "action": action,
            **payload,
        }
        if self.manifest:
            self.manifest.write(json.dumps(entry) + "\n")
            self.manifest.flush()
        self._emit({"type": "log", "entry": entry})

    def _phase_rank(self, phase: str) -> int:
        return CHECKPOINT_PHASE_ORDER.get(phase, -1)

    def _phase_is_before(self, phase: str, target: str) -> bool:
        return self._phase_rank(phase) < self._phase_rank(target)

    def _bind_run_artifact_paths(self, manifest_path: str) -> None:
        self._manifest_path = manifest_path
        artifact_paths = _checkpoint_paths_from_manifest(manifest_path)
        self._checkpoint_path = artifact_paths["checkpoint"]
        self._records_jsonl_path = artifact_paths["records"]
        self._scan_completed_path = artifact_paths["scan_completed"]

    def _append_scan_record(self, record: MediaRecord) -> None:
        if not self._records_jsonl_path:
            return
        with open(self._records_jsonl_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(_serialize_media_record(record)) + "\n")

    def _mark_scan_source_complete(self, source_rel_path: str) -> None:
        self._scan_completed_sources.add(source_rel_path)
        if not self._scan_completed_path:
            return
        with open(self._scan_completed_path, "a", encoding="utf-8") as handle:
            handle.write(source_rel_path + "\n")

    def _write_checkpoint(
        self,
        *,
        phase: Optional[str] = None,
        status: str = "in_progress",
        force: bool = False,
        records: Optional[List[MediaRecord]] = None,
    ) -> None:
        if not self._checkpoint_path:
            return
        if phase is not None:
            self._current_phase = phase
        if records is not None:
            self._checkpoint_records_snapshot = list(records)
        if not force and self._files_since_checkpoint < CHECKPOINT_WRITE_INTERVAL:
            self._checkpoint_dirty = True
            return

        if self._checkpoint_records_snapshot is not None and self._records_jsonl_path:
            _write_records_jsonl(self._records_jsonl_path, self._checkpoint_records_snapshot)

        payload: Dict[str, Any] = {
            "version": CHECKPOINT_VERSION,
            "engine": CLEAN_LIBRARY_ENGINE_VERSION,
            "status": status,
            "phase": self._current_phase,
            "library_path": self.library_path,
            "db_path": self.db_path,
            "manifest_path": self._manifest_path,
            "records_path": self._records_jsonl_path,
            "scan_completed_path": self._scan_completed_path,
            "stats": dict(self.stats),
            "scan_completed_count": len(self._scan_completed_sources),
            "canonicalize_index": self._canonicalize_index,
            "updated_at": datetime.now().isoformat(),
        }
        if self._resume_checkpoint and self._resume_checkpoint.get("started_at"):
            payload["started_at"] = self._resume_checkpoint["started_at"]
        else:
            payload["started_at"] = payload["updated_at"]

        temp_path = f"{self._checkpoint_path}.tmp"
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temp_path, self._checkpoint_path)
        self._files_since_checkpoint = 0
        self._checkpoint_dirty = False

    def _flush_checkpoint(self, *, records: Optional[List[MediaRecord]] = None) -> None:
        self._write_checkpoint(force=True, records=records)

    def _emit_stats_feedback(self) -> None:
        if not self._progress_callback:
            return
        stats = dict(self.stats)
        summary = {
            "misfiled_media": int(stats.get("media_moved") or 0),
            "duplicates": int(stats.get("duplicates_trashed") or 0),
            "unsupported_files": int(stats.get("moved_to_trash") or 0),
            "metadata_cleanup": int(stats.get("metadata_fixed") or 0),
            "folder_cleanup": int(stats.get("folders_removed") or 0),
            "database_repairs": 0,
            "operation_count": sum(
                int(stats.get(key) or 0)
                for key in (
                    "media_moved",
                    "duplicates_trashed",
                    "moved_to_trash",
                    "metadata_fixed",
                    "folders_removed",
                )
            ),
        }
        self._emit({"type": "stats", "stats": stats, "summary": summary})

    def run(
        self,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        *,
        resume: Optional[bool] = None,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        self._progress_callback = progress_callback
        self._cancel_check = cancel_check
        resumed_from: Optional[Dict[str, Any]] = None
        try:
            if resume is False:
                existing = find_resumable_clean_library_checkpoint(self.library_path)
                if existing:
                    abandon_clean_library_checkpoint(existing["_checkpoint_path"])
                self._resume_checkpoint = None
            elif resume is True:
                self._resume_checkpoint = find_resumable_clean_library_checkpoint(self.library_path)
                if not self._resume_checkpoint:
                    raise CleanLibraryError("No resumable clean library operation found")
            else:
                self._resume_checkpoint = find_resumable_clean_library_checkpoint(self.library_path)

            if self._progress_callback:
                self._remaining_operation_paths = {
                    key: set() for key in CLEAN_LIBRARY_SIGNAL_KEYS
                }
                self._emit(
                    {
                        "type": "signal_plan",
                        "feedback_only": True,
                        "summary": {
                            "misfiled_media": 0,
                            "unsupported_files": 0,
                            "duplicates": 0,
                            "metadata_cleanup": 0,
                            "folder_cleanup": 0,
                            "database_repairs": 0,
                            "operation_count": 0,
                        },
                        "details": {key: [] for key in CLEAN_LIBRARY_SIGNAL_KEYS},
                    }
                )

            if self._resume_checkpoint:
                resumed_from = {
                    "phase": self._resume_checkpoint.get("phase"),
                    "scan_completed_count": self._resume_checkpoint.get("scan_completed_count", 0),
                    "canonicalize_index": self._resume_checkpoint.get("canonicalize_index", 0),
                    "manifest_path": self._resume_checkpoint.get("manifest_path"),
                }
                self._emit({"type": "resume", "resumed_from": resumed_from})

            self._emit({"type": "phase", "phase": "setup", "status": "starting"})
            self.setup()
            self._emit({"type": "phase", "phase": "setup", "status": "complete"})
            self._raise_if_cancelled()

            resume_phase = str(self._resume_checkpoint.get("phase") or "setup") if self._resume_checkpoint else "setup"
            records = _load_records_jsonl(self._records_jsonl_path or "")

            if self._phase_is_before(resume_phase, "scan_complete"):
                self._raise_if_cancelled()
                candidate_total = self._count_walk_files()
                self._current_phase = "scan"
                self._flush_checkpoint()
                self._emit(
                    {
                        "type": "phase",
                        "phase": "scan",
                        "status": "starting",
                        "total_candidates": candidate_total,
                        "resumed_files": len(self._scan_completed_sources),
                    }
                )
                records = self.scan_and_normalize(
                    candidate_total,
                    initial_records=records,
                    skip_sources=set(self._scan_completed_sources),
                )
                self._current_phase = "scan_complete"
                self._flush_checkpoint(records=records)
                self._emit(
                    {
                        "type": "phase",
                        "phase": "scan",
                        "status": "complete",
                        "records": len(records),
                    }
                )
                self._emit_stats_feedback()
                self._raise_if_cancelled()

            if self._phase_is_before(resume_phase, "dedupe_complete"):
                self._raise_if_cancelled()
                self._current_phase = "dedupe"
                self._flush_checkpoint(records=records)
                self._emit({"type": "phase", "phase": "dedupe", "status": "starting"})
                deduped = self.trash_duplicates(records)
                records = deduped
                self._current_phase = "dedupe_complete"
                self._flush_checkpoint(records=records)
                self._emit(
                    {
                        "type": "phase",
                        "phase": "dedupe",
                        "status": "complete",
                        "remaining": len(deduped),
                    }
                )
                self._emit_stats_feedback()
                self._raise_if_cancelled()
            else:
                deduped = records

            if self._phase_is_before(resume_phase, "canonicalize_complete"):
                self._raise_if_cancelled()
                self._current_phase = "canonicalize"
                self._flush_checkpoint(records=deduped)
                self._emit(
                    {
                        "type": "phase",
                        "phase": "canonicalize",
                        "status": "starting",
                        "total": len(deduped),
                        "resumed_index": self._canonicalize_index,
                    }
                )
                canonicalized = self.move_to_canonical_locations(
                    deduped,
                    start_index=self._canonicalize_index,
                )
                records = canonicalized
                self._current_phase = "canonicalize_complete"
                self._flush_checkpoint(records=records)
                self._emit({"type": "phase", "phase": "canonicalize", "status": "complete"})
                self._emit_stats_feedback()
                self._raise_if_cancelled()
            else:
                canonicalized = records

            if self._phase_is_before(resume_phase, "folders_complete"):
                self._raise_if_cancelled()
                self.stats["metadata_fixed"] = sum(
                    1 for record in canonicalized if record.metadata_cleaned
                )
                self._current_phase = "folders"
                self._flush_checkpoint(records=canonicalized)
                self._emit({"type": "phase", "phase": "folders", "status": "starting"})
                self.remove_empty_noncanonical_folders()
                self._current_phase = "folders_complete"
                self._flush_checkpoint(records=canonicalized)
                self._emit({"type": "phase", "phase": "folders", "status": "complete"})
                self._emit_stats_feedback()
                self._raise_if_cancelled()

            if self._phase_is_before(resume_phase, "rebuild_db_complete"):
                self._raise_if_cancelled()
                self._current_phase = "rebuild_db"
                self._flush_checkpoint(records=canonicalized)
                self._emit(
                    {
                        "type": "phase",
                        "phase": "rebuild_db",
                        "status": "starting",
                        "total": len(canonicalized),
                    }
                )
                self.rebuild_photos_table(canonicalized)
                self._current_phase = "rebuild_db_complete"
                self._flush_checkpoint(records=canonicalized)
                self._emit({"type": "phase", "phase": "rebuild_db", "status": "complete"})
                self._emit_stats_feedback()
                self._raise_if_cancelled()

            if self._phase_is_before(resume_phase, "audit_complete"):
                self._raise_if_cancelled()
                self._current_phase = "audit"
                self._flush_checkpoint(records=canonicalized)
                try:
                    issues = self.final_audit(audit_progress_total=len(canonicalized))
                except FastAuditCancelled:
                    raise CleanLibraryCancelled()
                self._raise_if_cancelled()
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
                self._current_phase = "audit_complete"
                self._flush_checkpoint(records=canonicalized)
                self._raise_if_cancelled()

            self._raise_if_cancelled()
            self._current_phase = "complete"
            self._write_checkpoint(phase="complete", status="complete", force=True, records=canonicalized)
            self.log("operation_complete", stats=self.stats, resumed_from=resumed_from)
            result: Dict[str, Any] = {"status": "SUCCESS", "stats": self.stats}
            if resumed_from:
                result["resumed"] = True
                result["resumed_from"] = resumed_from
            return result
        except CleanLibraryCancelled:
            try:
                self._flush_checkpoint()
            except Exception:
                pass
            self.log(
                "operation_cancelled",
                stats=self.stats,
                phase=self._current_phase,
            )
            return {
                "status": "CANCELLED",
                "stats": dict(self.stats),
                "phase": self._current_phase,
            }
        except Exception as exc:
            try:
                self._flush_checkpoint()
            except Exception:
                pass
            self.log(
                "operation_failed",
                error=str(exc),
                traceback=traceback.format_exc(),
                stats=self.stats,
                phase=self._current_phase,
            )
            raise
        finally:
            self._progress_callback = None
            self._cancel_check = None
            if self.hash_cache is not None:
                try:
                    self.hash_cache.cleanup_stale_entries(self.library_path)
                except Exception:
                    pass
            if self.manifest is not None:
                self.manifest.close()
            if self.db_conn is not None:
                self.db_conn.close()

    def scan(
        self,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        *,
        verify: bool = False,
    ) -> Dict[str, Any]:
        self._progress_callback = progress_callback
        try:
            if not verify:
                inventory = inventory_media_library(self.library_path)
                checkpoint = find_resumable_clean_library_checkpoint(self.library_path)
                payload: Dict[str, Any] = {
                    "preflight": True,
                    "engine": CLEAN_LIBRARY_ENGINE_VERSION,
                    "supported_media_files": inventory["media_count"],
                    "inventory": inventory,
                    "summary": {
                        "misfiled_media": 0,
                        "duplicates": 0,
                        "unsupported_files": 0,
                        "metadata_cleanup": 0,
                        "database_repairs": 0,
                        "issue_count": 0,
                        "photo_count": inventory["photo_count"],
                        "video_count": inventory["video_count"],
                    },
                    "details": {
                        "misfiled_media": [],
                        "duplicates": [],
                        "unsupported_files": [],
                        "metadata_cleanup": [],
                        "database_repairs": [],
                    },
                }
                if checkpoint:
                    remaining_sec = estimate_remaining_duration_seconds(
                        inventory,
                        phase=str(checkpoint.get("phase") or "scan"),
                        scan_completed_count=int(checkpoint.get("scan_completed_count") or 0),
                        canonicalize_index=int(checkpoint.get("canonicalize_index") or 0),
                    )
                    _rem_sec, remaining_display = format_about_duration(remaining_sec)
                    payload["status"] = "RESUME"
                    payload["resumable"] = True
                    payload["resume"] = {
                        "phase": checkpoint.get("phase"),
                        "scan_completed_count": checkpoint.get("scan_completed_count", 0),
                        "canonicalize_index": checkpoint.get("canonicalize_index", 0),
                        "manifest_path": checkpoint.get("manifest_path"),
                    }
                    payload["estimated_remaining_seconds"] = round(remaining_sec, 1)
                    payload["estimated_remaining_display"] = remaining_display
                    payload["message"] = (
                        f"Resumable clean in progress. About {remaining_display} remaining."
                    )
                else:
                    payload["status"] = "INVENTORY"
                    payload["resumable"] = False
                    payload["estimated_seconds"] = inventory["estimated_seconds"]
                    payload["estimated_display"] = inventory["estimated_display"]
                    payload["message"] = (
                        f"{inventory['photo_count']:,} photos and {inventory['video_count']:,} "
                        f"videos — {inventory['estimated_display']}."
                    )
                return payload

            if os.path.exists(self.db_path) and db_is_valid(self.db_path):
                self.db_conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
                self.db_conn.row_factory = sqlite3.Row
            issues = run_fast_library_audit(
                self.library_path,
                db_path=self.db_path,
                progress_callback=progress_callback,
            )
            supported_media_files = self._count_supported_media_leaf_files()
            payload = summarize_clean_library_issues(issues)
            payload["operations"] = summarize_clean_library_operations(
                self.library_path,
                issues,
            )
            payload["supported_media_files"] = supported_media_files
            payload["status"] = "DIRTY" if issues else "CLEAN"
            payload["preflight"] = False
            payload["verify"] = True
            payload["engine"] = CLEAN_LIBRARY_ENGINE_VERSION
            return payload
        finally:
            self._progress_callback = None
            self.hash_cache = None
            if self.db_conn is not None:
                self.db_conn.close()
                self.db_conn = None

    def purge_zip_artifacts(self) -> None:
        for root, dirs, _files in os.walk(self.library_path, topdown=False):
            for filename in os.listdir(root):
                full_path = os.path.join(root, filename)
                if os.path.isfile(full_path) and is_zip_artifact_name(filename, False):
                    try:
                        os.remove(full_path)
                    except OSError:
                        pass
            for dirname in list(dirs):
                if dirname not in ZIP_ARTIFACT_DIR_NAMES:
                    continue
                artifact_path = os.path.join(root, dirname)
                shutil.rmtree(artifact_path, ignore_errors=True)
                self.log(
                    "zip_artifact_removed",
                    path=os.path.relpath(artifact_path, self.library_path),
                )

    def setup(self) -> None:
        self.purge_zip_artifacts()
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

        resuming = self._resume_checkpoint is not None
        if resuming:
            manifest_path = str(self._resume_checkpoint.get("manifest_path") or "")
            if not manifest_path:
                raise CleanLibraryError("Resumable checkpoint is missing manifest_path")
            self._bind_run_artifact_paths(manifest_path)
            self.stats = dict(self._resume_checkpoint.get("stats") or self.stats)
            self._current_phase = str(self._resume_checkpoint.get("phase") or "setup")
            self._canonicalize_index = int(self._resume_checkpoint.get("canonicalize_index") or 0)
            scan_completed_path = str(
                self._resume_checkpoint.get("scan_completed_path") or self._scan_completed_path or ""
            )
            self._scan_completed_sources = _load_scan_completed_sources(scan_completed_path)
            self.manifest = open(manifest_path, "a", encoding="utf-8")
            self.log(
                "operation_resumed",
                library_path=self.library_path,
                db_path=self.db_path,
                phase=self._current_phase,
                scan_completed_count=len(self._scan_completed_sources),
                canonicalize_index=self._canonicalize_index,
            )
        else:
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
            self._bind_run_artifact_paths(manifest_path)
            for artifact_path in (
                self._records_jsonl_path,
                self._scan_completed_path,
            ):
                if artifact_path and not os.path.exists(artifact_path):
                    with open(artifact_path, "a", encoding="utf-8"):
                        pass
            self.manifest = open(manifest_path, "a", encoding="utf-8")
            self.log("operation_started", library_path=self.library_path, db_path=self.db_path)
            self._write_checkpoint(phase="setup", force=True)
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

    def _parse_db_date_taken(self, date_taken: str) -> datetime:
        if date_taken == UNKNOWN_PHOTO_DATE_TAKEN:
            return datetime(1900, 1, 1, 0, 0, 0)
        return datetime.strptime(date_taken, CANONICAL_DB_DATE_FORMAT)

    def _needs_metadata_work(self, full_path: str, ext: str) -> bool:
        orientation = get_orientation_flag(full_path)
        if orientation not in (None, 1):
            if ext in LOSSLESS_ROTATION_EXTENSIONS:
                return True
            if ext in PHOTO_EXTENSIONS and can_bake_losslessly(full_path):
                return True
        return extract_exif_rating(full_path) == 0

    def _try_skip_unchanged_media_record(self, full_path: str) -> Optional[MediaRecord]:
        rel_path = os.path.relpath(full_path, self.library_path)
        ext = os.path.splitext(full_path)[1].lower()
        if not is_supported_media_extension(ext):
            return None
        if _basename_layout_issue(rel_path) is not None:
            return None
        if self.db_conn is None:
            return None

        row = self.db_conn.execute(
            """
            SELECT original_filename, current_path, date_taken, content_hash,
                   file_size, file_type, width, height, rating
            FROM photos
            WHERE current_path = ?
            """,
            (rel_path,),
        ).fetchone()
        if row is None:
            return None

        expected_type = media_kind_for_extension(ext)
        if not expected_type or row["file_type"] != expected_type:
            return None

        try:
            date_obj = self._parse_db_date_taken(str(row["date_taken"] or UNKNOWN_PHOTO_DATE_TAKEN))
        except ValueError:
            return None

        content_hash = str(row["content_hash"] or "")
        if len(content_hash) != 64:
            return None
        if canonical_relative_path(date_obj, content_hash, ext) != rel_path:
            return None

        stat_result = os.stat(full_path)
        if int(row["file_size"]) != int(stat_result.st_size):
            return None
        if self._needs_metadata_work(full_path, ext):
            return None

        valid, _ = verify_media_file(full_path)
        if not valid:
            return None

        rating = row["rating"]
        self.stats["scan_unchanged_skipped"] += 1
        return MediaRecord(
            original_filename=str(row["original_filename"] or os.path.basename(full_path)),
            source_rel_path=rel_path,
            full_path=full_path,
            rel_path=rel_path,
            ext=ext,
            file_type=str(row["file_type"]),
            content_hash=content_hash,
            duplicate_key=content_hash,
            date_taken=str(row["date_taken"] or UNKNOWN_PHOTO_DATE_TAKEN),
            date_obj=date_obj,
            width=int(row["width"] or 0),
            height=int(row["height"] or 0),
            rating=None if rating in (None, 0) else int(rating),
            metadata_cleaned=False,
            has_metadata_cleanup_signal=False,
            birth_time=get_birth_time(stat_result),
            modified_time=float(stat_result.st_mtime),
        )

    def normalize_media_file(self, full_path: str) -> Optional[MediaRecord]:
        unchanged = self._try_skip_unchanged_media_record(full_path)
        if unchanged is not None:
            return unchanged

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
            duplicate_key = canonical_photo.content_hash
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

    def scan_and_normalize(
        self,
        candidate_total: int,
        *,
        initial_records: Optional[List[MediaRecord]] = None,
        skip_sources: Optional[set[str]] = None,
    ) -> List[MediaRecord]:
        records: List[MediaRecord] = list(initial_records or [])
        skip_sources = set(skip_sources or ())
        processed = len(skip_sources)

        for root, _, files in self.active_walk():
            for filename in files:
                self._raise_if_cancelled()
                if filename in IGNORED_LIBRARY_FILES:
                    continue
                full_path = os.path.join(root, filename)
                source_rel_path = os.path.relpath(full_path, self.library_path)
                ext = os.path.splitext(filename)[1].lower()
                if not is_supported_media_extension(ext):
                    if source_rel_path in skip_sources:
                        continue
                    self.normalize_media_file(full_path)
                    self._mark_scan_source_complete(source_rel_path)
                    self._files_since_checkpoint += 1
                    self._write_checkpoint(phase="scan")
                    continue
                if source_rel_path in skip_sources:
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
                self._mark_scan_source_complete(source_rel_path)
                if record is not None:
                    records.append(record)
                    self._append_scan_record(record)
                self._files_since_checkpoint += 1
                self._write_checkpoint(phase="scan")

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
        live_records = [record for record in records if os.path.exists(record.full_path)]
        grouped: Dict[str, List[MediaRecord]] = {}
        for record in live_records:
            grouped.setdefault(record.duplicate_key, []).append(record)

        survivors: List[MediaRecord] = []
        total_groups = len(grouped)
        for gi, (duplicate_key, group) in enumerate(grouped.items(), start=1):
            self._raise_if_cancelled()
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

    def move_to_canonical_locations(
        self,
        records: List[MediaRecord],
        *,
        start_index: int = 0,
    ) -> List[MediaRecord]:
        occupied: set[str] = set()
        canonicalized: List[MediaRecord] = []
        sorted_records = sorted(
            records, key=lambda item: (item.date_taken, item.content_hash, item.rel_path.lower())
        )
        total = len(sorted_records)

        if start_index > 0:
            for record in sorted_records[:start_index]:
                target_rel = canonical_relative_path(record.date_obj, record.content_hash, record.ext)
                occupied.add(target_rel)
                canonicalized.append(record)

        for idx in range(start_index, len(sorted_records)):
            self._raise_if_cancelled()
            record = sorted_records[idx]
            display_idx = idx + 1
            self._emit(
                {
                    "type": "progress",
                    "phase": "canonicalize",
                    "processed": display_idx,
                    "total": max(total, 1),
                }
            )
            target_rel = canonical_relative_path(record.date_obj, record.content_hash, record.ext)
            if target_rel in occupied:
                raise CleanLibraryError(f"Canonical path collision for {target_rel}")

            target_full = os.path.join(self.library_path, target_rel)
            source_rel_path = record.rel_path
            if not os.path.exists(record.full_path):
                if os.path.exists(target_full):
                    record.full_path = target_full
                    record.rel_path = target_rel
                else:
                    raise CleanLibraryError(
                        f"Missing media file during canonicalize resume: {record.source_rel_path}"
                    )
            elif os.path.abspath(record.full_path) != os.path.abspath(target_full):
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
            self._canonicalize_index = display_idx
            self._files_since_checkpoint += 1
            self._write_checkpoint(
                phase="canonicalize",
                records=canonicalized + sorted_records[idx + 1 :],
            )

        return canonicalized

    def remove_empty_noncanonical_folders(self) -> None:
        for root, _, _ in os.walk(self.library_path, topdown=False):
            self._raise_if_cancelled()
            rel_root = os.path.relpath(root, self.library_path)
            if rel_root == ".":
                continue
            if in_infrastructure(rel_root):
                continue
            if os.path.isdir(root) and not visible_directory_entries(root):
                remove_ignored_directory_files(root)
                try:
                    os.rmdir(root)
                except OSError as exc:
                    self.log("folder_remove_skipped", path=rel_root, error=str(exc))
                    continue
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
            self._raise_if_cancelled()
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
        cancel_check = self._cancel_requested if self._cancel_check else None
        return run_fast_library_audit(
            self.library_path,
            db_path=self.db_path,
            progress_callback=self._progress_callback,
            audit_progress_total=audit_progress_total,
            cancel_check=cancel_check,
        )


class DBNormalizationEngine(LibraryCleaner):
    """Authoritative DB normalization engine for library cleanup and repair."""


def scan_library_cleanliness(
    library_path: str,
    db_path: Optional[str] = None,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    *,
    verify: bool = False,
) -> Dict[str, Any]:
    engine = DBNormalizationEngine(library_path, db_path=db_path)
    return engine.scan(progress_callback=progress_callback, verify=verify)


def verify_library_cleanliness(
    library_path: str,
    db_path: Optional[str] = None,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """Post-run yardstick audit (read-only). Not used as preflight."""
    return scan_library_cleanliness(
        library_path,
        db_path=db_path,
        progress_callback=progress_callback,
        verify=True,
    )


def run_db_normalization_engine(
    library_path: str,
    db_path: Optional[str] = None,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    *,
    resume: Optional[bool] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    engine = DBNormalizationEngine(library_path, db_path=db_path)
    return engine.run(
        progress_callback=progress_callback,
        resume=resume,
        cancel_check=cancel_check,
    )


def make_library_perfect(library_path: str, db_path: Optional[str] = None) -> Dict[str, Any]:
    """Backward-compatible wrapper for the DB normalization engine."""
    return run_db_normalization_engine(library_path, db_path=db_path)
