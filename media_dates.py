"""Shared media date read/write policy.

This module is the single place for media date write safety rules. It starts
with video metadata because QuickTime/MOV post-2040 dates need binary atom
upgrades; ffmpeg metadata copy alone is not trustworthy for those files.
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime

UNSUPPORTED_VIDEO_DATE_FORMATS = {
    ".mpg",
    ".mpeg",
    ".vob",
    ".ts",
    ".mts",
    ".avi",
    ".wmv",
}
QUICKTIME_POST_2040_EXTENSIONS = {".mov", ".qt"}
QUICKTIME_V0_MAX_DATE = datetime(2040, 2, 6, 6, 28, 15)


class MediaDateError(Exception):
    """Base class for explicit media date policy failures."""


class UnsupportedMediaDateWrite(MediaDateError):
    """Raised when the current safe writer cannot support the requested date."""


class MediaDateVerificationError(MediaDateError):
    """Raised when a metadata write does not read back exactly."""


def parse_canonical_media_date(value: str) -> datetime:
    """Parse the app canonical date string: YYYY:MM:DD HH:MM:SS."""
    return datetime.strptime(value, "%Y:%m:%d %H:%M:%S")


def canonical_date_to_iso(value: str) -> str:
    """Convert app canonical date string to ISO-like ffmpeg creation_time."""
    parse_canonical_media_date(value)
    return value.replace(":", "-", 2).replace(" ", "T")


def normalize_ffprobe_creation_time(value: str | None) -> str | None:
    """Normalize ffprobe creation_time to app canonical date format."""
    if not value:
        return None
    normalized = value.replace("T", " ").split(".")[0].rstrip("Z")
    return normalized.replace("-", ":", 2)


def read_video_creation_time(file_path: str) -> str | None:
    """Read video creation_time via ffprobe, matching Photos Light's read path."""
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


def ensure_video_date_write_supported(file_path: str, new_date: str) -> None:
    """Fail closed for formats/dates the current safe writer cannot handle."""
    _base, ext = os.path.splitext(file_path)
    ext_lower = ext.lower()
    if ext_lower in UNSUPPORTED_VIDEO_DATE_FORMATS:
        raise UnsupportedMediaDateWrite(
            f"Format {ext.upper()} does not support embedded metadata"
        )

    target = parse_canonical_media_date(new_date)
    if ext_lower in QUICKTIME_POST_2040_EXTENSIONS and target > QUICKTIME_V0_MAX_DATE:
        raise UnsupportedMediaDateWrite(
            "MOV/QuickTime dates after 2040 require verified 64-bit atom patching"
        )


def write_and_verify_video_date(file_path: str, new_date: str) -> None:
    """Write video creation_time with ffmpeg and verify via ffprobe.

    This intentionally rejects post-2040 MOV/QuickTime dates until the dedicated
    64-bit atom patching pipeline is available.
    """
    base, ext = os.path.splitext(file_path)
    ext_lower = ext.lower()
    if ext_lower in UNSUPPORTED_VIDEO_DATE_FORMATS:
        raise UnsupportedMediaDateWrite(
            f"Format {ext.upper()} does not support embedded metadata"
        )

    target = parse_canonical_media_date(new_date)
    if ext_lower in QUICKTIME_POST_2040_EXTENSIONS and target > QUICKTIME_V0_MAX_DATE:
        if read_video_creation_time(file_path) == new_date:
            return
        raise UnsupportedMediaDateWrite(
            "MOV/QuickTime dates after 2040 require verified 64-bit atom patching"
        )

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

    actual = read_video_creation_time(file_path)
    if actual != new_date:
        raise MediaDateVerificationError(
            f"Video date verification failed: expected {new_date}, got {actual or 'none'}"
        )
