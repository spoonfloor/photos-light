"""
Shared media validation helpers for Clean library v2 and fast audit.

Leaf module (no imports from make_library_clean_v2 or clean_library_fast_audit)
so audit and engine can share verify/format helpers without circular imports.
"""

from __future__ import annotations

import os
import subprocess
from typing import Dict, List, Optional, Tuple

from PIL import Image

from library_cleanliness import (
    IGNORED_LIBRARY_FILES,
    PHOTO_MEDIA_EXTENSIONS,
    VIDEO_MEDIA_EXTENSIONS,
)
from rotation_utils import (
    can_bake_losslessly as shared_can_bake_losslessly,
    get_orientation_flag as shared_get_orientation_flag,
)

PHOTO_EXTENSIONS = PHOTO_MEDIA_EXTENSIONS
VIDEO_EXTENSIONS = VIDEO_MEDIA_EXTENSIONS
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


def get_birth_time(stat_result: os.stat_result) -> float:
    """Use birthtime when available, otherwise fall back to mtime."""
    return float(getattr(stat_result, "st_birthtime", stat_result.st_mtime))


def get_orientation_flag(file_path: str) -> Optional[int]:
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in PHOTO_EXTENSIONS:
        return None
    return shared_get_orientation_flag(file_path)


def can_bake_losslessly(file_path: str) -> bool:
    return shared_can_bake_losslessly(file_path)


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


def format_issue(kind: str, path: str, detail: str = "") -> Dict[str, str]:
    return {"kind": kind, "path": path, "detail": detail}


def visible_directory_entries(dir_path: str) -> List[str]:
    return [entry for entry in os.listdir(dir_path) if entry not in IGNORED_LIBRARY_FILES]
