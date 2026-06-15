"""
Shared library cleanliness policy helpers.

These helpers are pure rule definitions used by import, cleanup, and audit
flows so canonical naming and folder validation do not drift.

Filesystem walk, classification, quarantine, and tree cleanup live in
``library_filesystem`` and are shared by Convert and Clean.

TBD cleanliness criteria (not enforced yet; audit/repair wiring deferred)
-------------------------------------------------------------------------

1. Usable library date (DB + path consistency)

   Every media row must carry a date sufficient for date edit and for
   canonical layout. A row is clean when:

   - ``date_taken`` is present, parseable in ``CANONICAL_DB_DATE_FORMAT``, and
     resolvable for edit (see ``effective_date_taken_for_edit`` in ``app.py``
     today — to be moved here when implemented).
   - ``date_taken`` agrees with the canonical path and basename: folder
     ``YYYY/YYYY-MM-DD/`` and ``img_YYYYMMDD_<hash8>.ext`` must reflect the
     same calendar date as the DB value.
   - When no real capture date exists in file metadata, the deterministic
     unknown-date placeholder applies: ``1900:01:01 00:00:00`` (Jan 1900),
     stored under ``1900/1900-01-01/`` with matching ``img_19000101_…``
     basename — not NULL, not path-inferred-only, not a mismatched real date
     on an unknown-date path.

   Not audited or repaired by Clean / Convert yet.

2. Declared format matches on-disk container format

   Extension and ``file_type`` must reflect the actual bytes on disk.
   Declared format = path extension (+ DB ``file_type``); detected format =
   container / codec family sniffed from file content.

   A row is clean when declared and detected formats agree within the
   supported media taxonomy (photo vs video, and the honest container for
   that kind). Example failure: JPEG bytes with a ``.heic`` extension — passes
   extension-based validation but breaks canonical rename, hash finalization,
   and HEIC-specific pipelines (sips, rotation).

   Repair direction (TBD): detect mismatch, rename to the canonical extension
   for the true container, update DB path — not transcode (Convert territory).

   Not audited or repaired by Clean / Convert yet.
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import List, Literal, Optional, Tuple

from library_layout import ROOT_INFRASTRUCTURE_DIRS

IGNORED_LIBRARY_FILES = {".DS_Store"}
# Zip / Finder artifacts — not library content; safe to delete during clean/setup.
ZIP_ARTIFACT_DIR_NAMES = frozenset({"__MACOSX"})
ZIP_ARTIFACT_FILE_PREFIXES = ("._",)
INFRASTRUCTURE_DIRS = set(ROOT_INFRASTRUCTURE_DIRS)
ALLOWED_ROOT_DIRS = INFRASTRUCTURE_DIRS

CANONICAL_DB_DATE_FORMAT = "%Y:%m:%d %H:%M:%S"
SUPPORTED_METADATA_DATE_FORMATS = (
    "%Y:%m:%d %H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%Y:%m:%d %H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S",
)
RAW_PHOTO_EXTENSIONS = frozenset(
    {
        ".raw",
        ".cr2",
        ".nef",
        ".arw",
        ".dng",
    }
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
        *RAW_PHOTO_EXTENSIONS,
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


def is_zip_artifact_name(name: str, is_dir: bool) -> bool:
    if is_dir and name in ZIP_ARTIFACT_DIR_NAMES:
        return True
    if not is_dir and name.startswith(ZIP_ARTIFACT_FILE_PREFIXES):
        return True
    return False


def root_entry_allowed(name: str, is_dir: bool) -> bool:
    if name in IGNORED_LIBRARY_FILES:
        return True
    if is_zip_artifact_name(name, is_dir):
        return False
    if is_dir:
        return name in ALLOWED_ROOT_DIRS or is_year_folder_name(name)
    return False


def in_infrastructure(rel_path: str) -> bool:
    """True when any path segment is library infrastructure (root or misplaced)."""
    parts = path_parts(rel_path)
    return any(part in INFRASTRUCTURE_DIRS for part in parts)


def is_misplaced_infrastructure_rel(rel_path: str) -> bool:
    """Infrastructure folder copied inside a year/media tree instead of at library root."""
    parts = path_parts(rel_path)
    if not parts or parts[0] in INFRASTRUCTURE_DIRS:
        return False
    return any(part in INFRASTRUCTURE_DIRS for part in parts)
