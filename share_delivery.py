"""
Share delivery policy — browser-viewable assets with honest filenames.

Single source of truth for what gets uploaded, how it is named, and which
MIME type is used. Publish, preflight, and contract tests should call this
module instead of duplicating extension lists.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

from image_pixels import needs_browser_video_proxy

# Keep in sync with shareBoot.js + share-resolve (test_share_media_contract).
SHARE_BROWSER_NATIVE_STILL_EXTENSIONS = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
    }
)

ShareDeliveryAction = Literal[
    "still_native",
    "still_jpeg",
    "video_native",
    "video_transcode",
]


@dataclass(frozen=True)
class ShareDeliveryPlan:
    action: ShareDeliveryAction
    delivered_ext: str
    delivered_filename: str
    content_type: str
    storage_name: str


def _photo_content_type(ext: str) -> str:
    mapping = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }
    return mapping.get(ext, "image/jpeg")


def _video_content_type(ext: str) -> str:
    if ext in {".mov", ".qt"}:
        return "video/quicktime"
    if ext == ".webm":
        return "video/webm"
    return "video/mp4"


def delivered_filename_from_library_path(relative_path: str, delivered_ext: str) -> str:
    """Basename with delivery extension (e.g. vacation.dng → vacation.jpg)."""
    base = os.path.basename(relative_path) or relative_path
    stem, _ext = os.path.splitext(base)
    stem = stem or base
    return f"{stem}{delivered_ext}"


def plan_share_delivery(
    relative_path: str,
    file_type: str,
    *,
    full_path: str | None = None,
) -> ShareDeliveryPlan:
    """
    Decide how one library file is delivered in a share snapshot.

    Stills that are not browser-native are converted once to high-quality JPEG.
    Videos that need a browser proxy are delivered as MP4 only.
    """
    ext = os.path.splitext(relative_path)[1].lower() or ".jpg"
    if file_type == "video":
        if full_path and needs_browser_video_proxy(full_path):
            delivered_ext = ".mp4"
            return ShareDeliveryPlan(
                action="video_transcode",
                delivered_ext=delivered_ext,
                delivered_filename=delivered_filename_from_library_path(
                    relative_path, delivered_ext
                ),
                content_type="video/mp4",
                storage_name=f"original{delivered_ext}",
            )
        return ShareDeliveryPlan(
            action="video_native",
            delivered_ext=ext,
            delivered_filename=os.path.basename(relative_path) or relative_path,
            content_type=_video_content_type(ext),
            storage_name=f"original{ext}",
        )

    if ext in SHARE_BROWSER_NATIVE_STILL_EXTENSIONS:
        return ShareDeliveryPlan(
            action="still_native",
            delivered_ext=ext,
            delivered_filename=os.path.basename(relative_path) or relative_path,
            content_type=_photo_content_type(ext),
            storage_name=f"original{ext}",
        )

    delivered_ext = ".jpg"
    return ShareDeliveryPlan(
        action="still_jpeg",
        delivered_ext=delivered_ext,
        delivered_filename=delivered_filename_from_library_path(
            relative_path, delivered_ext
        ),
        content_type="image/jpeg",
        storage_name="original.jpg",
    )


def estimate_share_upload_size_bytes(
    library_path: str,
    relative_path: str,
    file_type: str,
) -> int:
    """
    Preflight size estimate from source file bytes on disk.

    Converted stills/videos may differ after encode; publish re-checks payload
    size before each upload.
    """
    full_path = os.path.join(library_path, relative_path)
    try:
        return os.path.getsize(full_path)
    except OSError:
        return 0
