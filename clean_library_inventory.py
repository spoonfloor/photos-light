"""
Cheap library inventory for Clean library preflight (v2).

Walk + stat only — no hash, no EXIF. Used for photo/video counts and duration
estimates so users can bail before a long run.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional, Tuple

from library_cleanliness import (
    IGNORED_LIBRARY_FILES,
    PHOTO_MEDIA_EXTENSIONS,
    VIDEO_MEDIA_EXTENSIONS,
    is_supported_media_extension,
    media_kind_for_extension,
)

INFRASTRUCTURE_DIRS = {
    ".library",
    ".db_backups",
    ".import_temp",
    ".logs",
    ".thumbnails",
    ".trash",
}

# NAS speed-test fixture medians (tools/profile_clean_library_scan.py, Jun 2026).
PHOTO_SEC_PER_FILE = 1.7
VIDEO_SEC_PER_MB = 0.024
POST_SCAN_OVERHEAD_RATIO = 0.05


def format_about_duration(total_seconds: float) -> Tuple[float, str]:
    """Return (seconds, display) as a single approximate duration string."""
    seconds = max(0.0, float(total_seconds))
    if seconds < 45:
        return seconds, "less than a minute"
    if seconds < 90:
        return seconds, "about 1 minute"
    minutes = seconds / 60.0
    if minutes < 60:
        rounded = max(1, int(round(minutes)))
        unit = "minute" if rounded == 1 else "minutes"
        return seconds, f"about {rounded} {unit}"
    hours = seconds / 3600.0
    if hours < 24:
        rounded = max(1, int(round(hours)))
        unit = "hour" if rounded == 1 else "hours"
        return seconds, f"about {rounded} {unit}"
    rounded = max(1, int(round(hours)))
    return seconds, f"about {rounded} hours"


def inventory_media_library(library_path: str) -> Dict[str, Any]:
    """
    Cheap inventory: count photos/videos and sum bytes (no content reads).
    """
    library_path = os.path.abspath(library_path)
    photo_count = 0
    video_count = 0
    photo_bytes = 0
    video_bytes = 0

    for root, dirs, files in os.walk(library_path, topdown=True, followlinks=False):
        rel_root = os.path.relpath(root, library_path)
        if rel_root != ".":
            top = rel_root.split(os.sep)[0]
            if top in INFRASTRUCTURE_DIRS:
                dirs[:] = []
                continue

        for filename in files:
            if filename in IGNORED_LIBRARY_FILES or filename == ".DS_Store":
                continue
            ext = os.path.splitext(filename)[1].lower()
            if not is_supported_media_extension(ext):
                continue
            full_path = os.path.join(root, filename)
            try:
                size_bytes = os.path.getsize(full_path)
            except OSError:
                continue
            kind = media_kind_for_extension(ext)
            if kind == "video":
                video_count += 1
                video_bytes += size_bytes
            else:
                photo_count += 1
                photo_bytes += size_bytes

    media_count = photo_count + video_count
    estimated_seconds = estimate_clean_duration_seconds(
        photo_count=photo_count,
        video_count=video_count,
        photo_bytes=photo_bytes,
        video_bytes=video_bytes,
    )
    _seconds, estimated_display = format_about_duration(estimated_seconds)

    return {
        "photo_count": photo_count,
        "video_count": video_count,
        "media_count": media_count,
        "photo_bytes": photo_bytes,
        "video_bytes": video_bytes,
        "total_bytes": photo_bytes + video_bytes,
        "estimated_seconds": round(estimated_seconds, 1),
        "estimated_display": estimated_display,
    }


def estimate_clean_duration_seconds(
    *,
    photo_count: int,
    video_count: int,
    photo_bytes: int = 0,
    video_bytes: int = 0,
) -> float:
    """Type/size-weighted first-clean scan estimate (seconds)."""
    _ = video_count  # bytes capture video cost; count kept for callers/reporting.
    photo_sec = max(0, photo_count) * PHOTO_SEC_PER_FILE
    video_sec = (max(0, video_bytes) / (1024 * 1024)) * VIDEO_SEC_PER_MB
    subtotal = photo_sec + video_sec
    return subtotal * (1.0 + POST_SCAN_OVERHEAD_RATIO)


def estimate_remaining_duration_seconds(
    inventory: Dict[str, Any],
    *,
    phase: str,
    scan_completed_count: int = 0,
    canonicalize_index: int = 0,
) -> float:
    """Estimate remaining seconds for a resumed run."""
    total = max(int(inventory.get("media_count") or 0), 1)
    full_sec = float(inventory.get("estimated_seconds") or 0)
    completed = max(0, min(scan_completed_count, total))

    if phase in {"setup", "scan"}:
        remaining_media = max(0, total - completed)
        return full_sec * (remaining_media / total)

    if phase in {"scan_complete", "dedupe"}:
        return full_sec * 0.08

    if phase == "canonicalize":
        remaining = max(0, total - max(0, canonicalize_index))
        return full_sec * max(0.05, 0.08 * (remaining / total))

    if phase in {"canonicalize_complete", "folders"}:
        return full_sec * 0.03

    if phase == "rebuild_db":
        return full_sec * 0.01

    return full_sec * 0.05
