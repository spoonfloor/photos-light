"""Shared media date read/write rulebook.

Read precedence (``read_media_date``)
-------------------------------------
All callers resolve a file to the canonical DB string ``YYYY:MM:DD HH:MM:SS``.

a) **Trusted embedded metadata** — exiftool for photos; mvhd atoms for QuickTime
   containers (``.mov``, ``.qt``, ``.mp4``, ``.m4v``); ffprobe ``creation_time``
   for other videos — normalized to the canonical format.

b) **Canonical basename** — ``img_YYYYMMDD_<hash8>[...].ext`` when embedded is
   missing or *untrusted*.

c) **Photo unknown placeholder** — ``1900:01:01 00:00:00`` (no mtime for photos).

d) **Video mtime fallback** — only when ``allow_mtime_fallback=True`` (ingest).
   Rebuild and audit pass ``False`` so they never invent a date ingest would not
   have written.

Untrusted embedded
------------------
Embedded metadata is ignored (basename or fallbacks apply) when:

- It cannot be parsed into the canonical format, or
- A canonical basename date is present and its ``YYYYMMDD`` differs from the
  embedded calendar day (covers post-import edits and bad reads such as
  ``img_19001127_….mov`` with embedded 2037).

Write policy (``metadata_write_policy`` / ``write_and_verify_media_date``)
--------------------------------------------------------------------------
- Writable photos: exiftool write + read-back verify.
- Writable QuickTime containers (``.mov``, ``.qt``, ``.mp4``, ``.m4v``): moov atom
  patch via ``quicktime_date_atoms``; verify via mvhd read + ffmpeg decode.
- Other writable videos: ffmpeg metadata copy + ffprobe verify; exiftool fallback.
- Unsupported containers: ``UnsupportedMediaDateWrite`` — callers fail closed.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Optional

from library_cleanliness import (
    CANONICAL_DB_DATE_FORMAT,
    EXIF_WRITABLE_PHOTO_EXTENSIONS,
    PHOTO_MEDIA_EXTENSIONS,
    SUPPORTED_METADATA_DATE_FORMATS,
    VIDEO_MEDIA_EXTENSIONS,
)

UNKNOWN_PHOTO_DATE_TAKEN = "1900:01:01 00:00:00"

UNSUPPORTED_VIDEO_DATE_FORMATS = {
    ".mpg",
    ".mpeg",
    ".vob",
    ".ts",
    ".mts",
    ".avi",
    ".wmv",
}
QUICKTIME_ATOM_EXTENSIONS = {".mov", ".qt", ".mp4", ".m4v"}
EXIFTOOL_VIDEO_FALLBACK_EXTENSIONS = {".mkv", ".webm", ".flv", ".3gp"}


class MediaDateError(Exception):
    """Base class for explicit media date policy failures."""


class UnsupportedMediaDateWrite(MediaDateError):
    """Raised when the current safe writer cannot support the requested date."""


class MediaDateVerificationError(MediaDateError):
    """Raised when a metadata write does not read back exactly."""


MediaKind = Literal["photo", "video", "unknown"]


@dataclass(frozen=True)
class MediaDateWritePolicy:
    readable: bool
    writable: bool
    media_kind: MediaKind
    writer: str
    verifier: str


def parse_canonical_media_date(value: str) -> datetime:
    """Parse the app canonical date string: YYYY:MM:DD HH:MM:SS."""
    return datetime.strptime(value, CANONICAL_DB_DATE_FORMAT)


def canonical_date_to_iso(value: str) -> str:
    """Convert app canonical date string to ISO-like ffmpeg creation_time."""
    parse_canonical_media_date(value)
    return value.replace(":", "-", 2).replace(" ", "T")


def normalize_raw_metadata_date(value: Optional[str]) -> Optional[str]:
    """Normalize a raw metadata string without filesystem fallbacks."""
    if not value:
        return None
    candidate = value.strip()
    for fmt in SUPPORTED_METADATA_DATE_FORMATS:
        try:
            parsed = datetime.strptime(candidate, fmt)
            return parsed.strftime(CANONICAL_DB_DATE_FORMAT)
        except ValueError:
            continue
    return None


def normalize_ffprobe_creation_time(value: str | None) -> str | None:
    """Normalize ffprobe creation_time to app canonical date format."""
    if not value:
        return None
    normalized = value.replace("T", " ").split(".")[0].rstrip("Z")
    return normalized.replace("-", ":", 2)


def parse_canonical_basename_date(filename: str) -> Optional[str]:
    """Parse ``img_YYYYMMDD`` from canonical or collision-suffixed basenames."""
    if not filename.lower().startswith("img_"):
        return None
    parts = filename.split("_")
    if len(parts) < 3:
        return None
    date_token = parts[1]
    if len(date_token) != 8 or not date_token.isdigit():
        return None
    try:
        parsed = datetime.strptime(date_token, "%Y%m%d")
        return parsed.strftime(CANONICAL_DB_DATE_FORMAT)
    except ValueError:
        return None


def media_kind_for_path(file_path: str) -> MediaKind:
    ext = os.path.splitext(file_path)[1].lower()
    if ext in PHOTO_MEDIA_EXTENSIONS:
        return "photo"
    if ext in VIDEO_MEDIA_EXTENSIONS:
        return "video"
    return "unknown"


def metadata_write_policy(ext: str) -> MediaDateWritePolicy:
    """Return read/write policy for a file extension."""
    normalized = ext.lower()
    if normalized in EXIF_WRITABLE_PHOTO_EXTENSIONS:
        return MediaDateWritePolicy(
            readable=True,
            writable=True,
            media_kind="photo",
            writer="exiftool",
            verifier="exiftool",
        )
    if normalized in PHOTO_MEDIA_EXTENSIONS:
        return MediaDateWritePolicy(
            readable=True,
            writable=False,
            media_kind="photo",
            writer="none",
            verifier="exiftool",
        )
    if normalized in VIDEO_MEDIA_EXTENSIONS:
        if normalized in UNSUPPORTED_VIDEO_DATE_FORMATS:
            return MediaDateWritePolicy(
                readable=True,
                writable=False,
                media_kind="video",
                writer="none",
                verifier="ffprobe",
            )
        if normalized in QUICKTIME_ATOM_EXTENSIONS:
            return MediaDateWritePolicy(
                readable=True,
                writable=True,
                media_kind="video",
                writer="quicktime_atoms",
                verifier="mvhd",
            )
        return MediaDateWritePolicy(
            readable=True,
            writable=True,
            media_kind="video",
            writer="ffmpeg+exiftool",
            verifier="ffprobe",
        )
    return MediaDateWritePolicy(
        readable=False,
        writable=False,
        media_kind="unknown",
        writer="none",
        verifier="none",
    )


def read_video_creation_time(file_path: str) -> str | None:
    """Read video creation_time; QuickTime containers use mvhd as authoritative."""
    ext = os.path.splitext(file_path)[1].lower()
    if ext in QUICKTIME_ATOM_EXTENSIONS:
        from quicktime_date_atoms import read_mvhd_canonical_date

        try:
            return read_mvhd_canonical_date(file_path)
        except Exception:
            pass

    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_entries",
            "format_tags=creation_time",
            file_path,
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise MediaDateVerificationError(f"ffprobe failed: {result.stderr}")

    data = json.loads(result.stdout or "{}")
    creation_time = data.get("format", {}).get("tags", {}).get("creation_time")
    return normalize_ffprobe_creation_time(creation_time)


def _read_embedded_photo_date(file_path: str) -> Optional[str]:
    result = subprocess.run(
        [
            "exiftool",
            "-DateTimeOriginal",
            "-CreateDate",
            "-ModifyDate",
            "-j",
            file_path,
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        return None

    payload = json.loads(result.stdout or "[]")
    if not payload:
        return None
    data = payload[0]
    return data.get("DateTimeOriginal") or data.get("CreateDate") or data.get("ModifyDate")


def read_embedded_media_date(file_path: str) -> Optional[str]:
    """Read raw embedded metadata date without basename or mtime fallbacks."""
    ext = os.path.splitext(file_path)[1].lower()
    try:
        if ext in VIDEO_MEDIA_EXTENSIONS:
            return read_video_creation_time(file_path)
        if ext in PHOTO_MEDIA_EXTENSIONS:
            return _read_embedded_photo_date(file_path)
    except (MediaDateVerificationError, json.JSONDecodeError, subprocess.TimeoutExpired):
        return None
    except FileNotFoundError:
        return None
    return None


def is_embedded_date_untrusted(
    ext: str,
    embedded_raw: Optional[str],
    basename_date: Optional[str],
) -> bool:
    """Return True when embedded metadata must not be trusted for resolution."""
    if not embedded_raw:
        return False

    normalized = normalize_raw_metadata_date(embedded_raw)
    if not normalized:
        return True

    if basename_date:
        embedded_ymd = normalized[:10].replace(":", "")
        basename_ymd = basename_date[:10].replace(":", "")
        if embedded_ymd != basename_ymd:
            return True

    return False


def read_media_date(
    file_path: str,
    *,
    allow_mtime_fallback: bool = False,
) -> str:
    """Resolve a media file to the canonical DB date string."""
    ext = os.path.splitext(file_path)[1].lower()
    media_kind = media_kind_for_path(file_path)
    basename_date = parse_canonical_basename_date(os.path.basename(file_path))
    embedded_raw = read_embedded_media_date(file_path)

    if embedded_raw and not is_embedded_date_untrusted(ext, embedded_raw, basename_date):
        normalized = normalize_raw_metadata_date(embedded_raw)
        if normalized:
            return normalized

    if basename_date:
        return basename_date

    if media_kind == "photo":
        return UNKNOWN_PHOTO_DATE_TAKEN

    if media_kind == "video" and allow_mtime_fallback:
        parsed = datetime.fromtimestamp(os.path.getmtime(file_path))
        return parsed.strftime(CANONICAL_DB_DATE_FORMAT)

    return UNKNOWN_PHOTO_DATE_TAKEN


def write_and_verify_video_date(file_path: str, new_date: str) -> None:
    """Write video creation_time and verify via the extension policy."""
    _base, ext = os.path.splitext(file_path)
    ext_lower = ext.lower()
    if ext_lower in UNSUPPORTED_VIDEO_DATE_FORMATS:
        raise UnsupportedMediaDateWrite(
            f"Format {ext.upper()} does not support embedded metadata"
        )

    if ext_lower in QUICKTIME_ATOM_EXTENSIONS:
        from quicktime_date_atoms import (
            QuickTimeDatePatchError,
            read_mvhd_canonical_date,
            write_quicktime_media_date,
        )

        try:
            if read_mvhd_canonical_date(file_path) == new_date:
                return
        except Exception:
            pass
        try:
            write_quicktime_media_date(file_path, new_date)
        except QuickTimeDatePatchError as error:
            raise MediaDateVerificationError(str(error)) from error
        return

    _write_video_date_ffmpeg(file_path, new_date)
    actual = read_video_creation_time(file_path)
    if actual == new_date:
        return

    if ext_lower in EXIFTOOL_VIDEO_FALLBACK_EXTENSIONS:
        _write_video_date_exiftool(file_path, new_date)
        actual = read_video_creation_time(file_path)
        if actual == new_date:
            return

    raise MediaDateVerificationError(
        f"Video date verification failed: expected {new_date}, got {actual or 'none'}"
    )


def _write_video_date_exiftool(file_path: str, new_date: str) -> None:
    result = subprocess.run(
        [
            "exiftool",
            f"-CreateDate={new_date}",
            f"-ModifyDate={new_date}",
            f"-MediaCreateDate={new_date}",
            f"-TrackCreateDate={new_date}",
            "-overwrite_original",
            file_path,
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise MediaDateVerificationError(
            result.stderr.strip() or "exiftool video date write failed"
        )


def _write_video_date_ffmpeg(file_path: str, new_date: str) -> None:
    base, ext = os.path.splitext(file_path)
    iso_date = canonical_date_to_iso(new_date)
    temp_output = f"{base}_temp{ext}"

    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-i",
                file_path,
                "-metadata",
                f"creation_time={iso_date}",
                "-codec",
                "copy",
                "-y",
                temp_output,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired as error:
        if os.path.exists(temp_output):
            os.remove(temp_output)
        raise MediaDateVerificationError("ffmpeg timeout after 60s") from error
    except FileNotFoundError as error:
        raise MediaDateVerificationError("ffmpeg not found") from error

    if result.returncode != 0:
        if os.path.exists(temp_output):
            os.remove(temp_output)
        raise MediaDateVerificationError(f"ffmpeg failed: {result.stderr}")

    os.replace(temp_output, file_path)


def write_and_verify_media_date(file_path: str, new_date: str) -> None:
    """Dispatch a verified metadata write by extension policy."""
    ext = os.path.splitext(file_path)[1].lower()
    policy = metadata_write_policy(ext)
    if not policy.writable:
        raise UnsupportedMediaDateWrite(
            f"Format {ext.upper()} does not support embedded date writes"
        )

    if policy.media_kind == "photo":
        from photo_canonicalization import write_photo_date_metadata

        write_photo_date_metadata(file_path, new_date)
        return

    if policy.media_kind == "video":
        write_and_verify_video_date(file_path, new_date)
        return

    raise UnsupportedMediaDateWrite(f"Unsupported media type for {file_path}")
