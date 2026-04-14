"""
Shared library cleanliness policy helpers.

These helpers are pure rule definitions used by import, cleanup, and audit
flows so canonical naming and folder validation do not drift.
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import List, Literal, Optional, Tuple

from library_layout import ROOT_INFRASTRUCTURE_DIRS

IGNORED_LIBRARY_FILES = {".DS_Store"}
INFRASTRUCTURE_DIRS = set(ROOT_INFRASTRUCTURE_DIRS)
ALLOWED_ROOT_DIRS = INFRASTRUCTURE_DIRS

CANONICAL_DB_DATE_FORMAT = "%Y:%m:%d %H:%M:%S"
SUPPORTED_METADATA_DATE_FORMATS = (
    "%Y:%m:%d %H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%Y:%m:%d %H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S",
)
PHOTO_MEDIA_EXTENSIONS = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".heic",
        ".heif",
        ".png",
        ".gif",
        ".tiff",
        ".tif",
        ".webp",
        ".avif",
        ".jp2",
        ".raw",
        ".cr2",
        ".nef",
        ".arw",
        ".dng",
    }
)
VIDEO_MEDIA_EXTENSIONS = frozenset(
    {
        ".mov",
        ".mp4",
        ".m4v",
        ".mkv",
        ".wmv",
        ".webm",
        ".flv",
        ".3gp",
        ".mpg",
        ".mpeg",
        ".vob",
        ".ts",
        ".mts",
        ".avi",
    }
)
ALL_MEDIA_EXTENSIONS = PHOTO_MEDIA_EXTENSIONS | VIDEO_MEDIA_EXTENSIONS
EXIF_WRITABLE_PHOTO_EXTENSIONS = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".heic",
        ".heif",
        ".png",
        ".gif",
        ".tiff",
        ".tif",
    }
)


def parse_metadata_datetime(value: Optional[str], fallback_timestamp: float) -> Tuple[str, datetime]:
    """Normalize metadata dates to the app's canonical DB format."""
    if value:
        candidate = value.strip()
        for fmt in SUPPORTED_METADATA_DATE_FORMATS:
            try:
                parsed = datetime.strptime(candidate, fmt)
                normalized = parsed.strftime(CANONICAL_DB_DATE_FORMAT)
                return normalized, datetime.strptime(normalized, CANONICAL_DB_DATE_FORMAT)
            except ValueError:
                continue

    parsed = datetime.fromtimestamp(fallback_timestamp)
    normalized = parsed.strftime(CANONICAL_DB_DATE_FORMAT)
    return normalized, parsed


def canonical_relative_path(date_obj: datetime, content_hash: str, ext: str) -> str:
    """Return the canonical library-relative path for a media file."""
    year = date_obj.strftime("%Y")
    day = date_obj.strftime("%Y-%m-%d")
    short_hash = content_hash[:8]
    filename = f"img_{date_obj.strftime('%Y%m%d')}_{short_hash}{ext.lower()}"
    return os.path.join(year, day, filename)


def build_canonical_photo_path(date_taken: str, content_hash: str, ext: str) -> Tuple[str, str]:
    """Return the canonical relative path and basename for a DB date string."""
    date_obj = datetime.strptime(date_taken, CANONICAL_DB_DATE_FORMAT)
    relative_path = canonical_relative_path(date_obj, content_hash, ext)
    return relative_path, os.path.basename(relative_path)


def is_supported_media_extension(ext: str) -> bool:
    return ext.lower() in ALL_MEDIA_EXTENSIONS


def media_kind_for_extension(ext: str) -> Optional[Literal["photo", "video"]]:
    normalized = ext.lower()
    if normalized in PHOTO_MEDIA_EXTENSIONS:
        return "photo"
    if normalized in VIDEO_MEDIA_EXTENSIONS:
        return "video"
    return None


def is_year_folder_name(name: str) -> bool:
    return len(name) == 4 and name.isdigit()


def is_day_folder_name(year: str, name: str) -> bool:
    if len(name) != 10 or name[:4] != year:
        return False
    if name[4] != "-" or name[7] != "-":
        return False
    try:
        datetime.strptime(name, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def path_parts(rel_path: str) -> List[str]:
    if rel_path in ("", "."):
        return []
    return rel_path.split(os.sep)


def root_entry_allowed(name: str, is_dir: bool) -> bool:
    if name in IGNORED_LIBRARY_FILES:
        return True
    if is_dir:
        return name in ALLOWED_ROOT_DIRS or is_year_folder_name(name)
    return False


def in_infrastructure(rel_path: str) -> bool:
    parts = path_parts(rel_path)
    return bool(parts) and parts[0] in INFRASTRUCTURE_DIRS
