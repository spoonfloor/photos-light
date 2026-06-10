"""
Canonical still-image pixel operations for Photos Light.

Single source of truth for:
- Decoding still images (HEIC via sips on macOS, PIL elsewhere)
- Baking HEIC orientation into pixels at ingest
- Square thumbnail generation and cache paths
- Lightbox JPEG conversion
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from io import BytesIO
from typing import Callable, Optional, Tuple

from PIL import Image, ImageOps

HEIF_EXTENSIONS = {".heic", ".heif"}
BROWSER_CONVERT_EXTENSIONS = HEIF_EXTENSIONS | {".tif", ".tiff"}
THUMBNAIL_CACHE_VERSION = "v2"
DEFAULT_SQUARE_THUMB_SIZE = 400
DEFAULT_SQUARE_THUMB_QUALITY = 85

RgbConverter = Callable[[Image.Image], Image.Image]
StripOrientationTag = Callable[[str], Tuple[bool, str]]


def is_macos() -> bool:
    return sys.platform == "darwin"


def thumbnail_cache_filename(content_hash: str) -> str:
    return f"{content_hash}.{THUMBNAIL_CACHE_VERSION}.jpg"


def thumbnail_cache_path(cache_dir: str, content_hash: str, *, mkdir: bool = False) -> str:
    shard_dir = os.path.join(cache_dir, content_hash[:2], content_hash[2:4])
    if mkdir:
        os.makedirs(shard_dir, exist_ok=True)
    return os.path.join(shard_dir, thumbnail_cache_filename(content_hash))


def should_decode_with_sips(file_path: str) -> bool:
    ext = os.path.splitext(file_path)[1].lower()
    return is_macos() and ext in HEIF_EXTENSIONS


def _sips_decode_to_pil(file_path: str) -> Image.Image:
    """Decode via sips and apply any surviving EXIF orientation."""
    if not is_macos():
        raise RuntimeError("sips decode is only available on macOS")

    fd, temp_path = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    try:
        result = subprocess.run(
            ["sips", "-s", "format", "jpeg", file_path, "--out", temp_path],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0 or not os.path.exists(temp_path):
            message = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(message or "sips failed to decode image")

        with Image.open(temp_path) as decoded:
            image = decoded.copy()
        try:
            return ImageOps.exif_transpose(image)
        except Exception:
            return image
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def open_still_image(file_path: str) -> Image.Image:
    """
    Decode a still image to a PIL Image copy with display orientation applied.

    Caller owns the returned image and should close it when finished.
    """
    if should_decode_with_sips(file_path):
        return _sips_decode_to_pil(file_path)

    try:
        with Image.open(file_path) as opened:
            image = opened.copy()
        try:
            return ImageOps.exif_transpose(image)
        except Exception:
            return image
    except Exception:
        if is_macos():
            return _sips_decode_to_pil(file_path)
        raise


def still_image_to_jpeg_buffer(file_path: str, *, quality: int = 95) -> BytesIO:
    """Convert a still image to JPEG bytes for in-browser display."""
    image = open_still_image(file_path)
    try:
        if image.mode != "RGB":
            image = image.convert("RGB")
        buffer = BytesIO()
        image.save(buffer, format="JPEG", quality=quality)
        buffer.seek(0)
        return buffer
    finally:
        image.close()


def bake_heic_orientation_in_place(
    file_path: str,
    *,
    orientation: int,
    strip_orientation_tag: StripOrientationTag,
) -> Tuple[bool, str, Optional[int]]:
    """
    Bake EXIF orientation into HEIC pixels via sips re-encode (lossy).

    Intended for ingest/clean canonicalization — display can then decode bytes directly.
    """
    if not is_macos():
        return False, "HEIC orientation bake requires macOS", orientation

    temp_jpg = None
    temp_heic = None
    image = None
    try:
        image = open_still_image(file_path)
        if image.mode != "RGB":
            image = image.convert("RGB")

        fd, temp_jpg = tempfile.mkstemp(suffix=".jpg")
        os.close(fd)
        fd, temp_heic = tempfile.mkstemp(suffix=".heic")
        os.close(fd)

        image.save(temp_jpg, format="JPEG", quality=95)
        result = subprocess.run(
            ["sips", "-s", "format", "heic", temp_jpg, "--out", temp_heic],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0 or not os.path.exists(temp_heic):
            message = (result.stderr or result.stdout or "").strip()
            return False, message or "HEIC re-encode failed", orientation

        os.replace(temp_heic, file_path)
        temp_heic = None

        success, message = strip_orientation_tag(file_path)
        if not success:
            return False, message, orientation
        return True, f"Baked HEIC orientation {orientation}", orientation
    except Exception as exc:
        return False, f"HEIC orientation bake error: {exc}", orientation
    finally:
        if image is not None:
            image.close()
        for path in (temp_jpg, temp_heic):
            if path and os.path.exists(path):
                os.remove(path)


def save_square_jpeg_thumbnail(
    image: Image.Image,
    output_path: str,
    *,
    target_size: int = DEFAULT_SQUARE_THUMB_SIZE,
    quality: int = DEFAULT_SQUARE_THUMB_QUALITY,
    to_rgb: Optional[RgbConverter] = None,
) -> None:
    """Center-crop resize to a square JPEG thumbnail."""
    icc_profile = image.info.get("icc_profile")
    if to_rgb is not None:
        image = to_rgb(image)
    elif image.mode != "RGB":
        image = image.convert("RGB")

    width, height = image.size
    if width < height:
        new_width = target_size
        new_height = int(height * (target_size / width))
    else:
        new_height = target_size
        new_width = int(width * (target_size / height))

    image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
    left = (image.width - target_size) // 2
    top = (image.height - target_size) // 2
    image = image.crop((left, top, left + target_size, top + target_size))

    save_kwargs = {"format": "JPEG", "quality": quality, "optimize": True}
    if icc_profile:
        save_kwargs["icc_profile"] = icc_profile
    image.save(output_path, **save_kwargs)


def generate_still_square_thumbnail(
    file_path: str,
    output_path: str,
    *,
    to_rgb: Optional[RgbConverter] = None,
    target_size: int = DEFAULT_SQUARE_THUMB_SIZE,
    quality: int = DEFAULT_SQUARE_THUMB_QUALITY,
) -> None:
    image = open_still_image(file_path)
    try:
        save_square_jpeg_thumbnail(
            image,
            output_path,
            target_size=target_size,
            quality=quality,
            to_rgb=to_rgb,
        )
    finally:
        image.close()


def generate_video_square_thumbnail(
    video_path: str,
    output_path: str,
    *,
    temp_frame_path: str,
    to_rgb: Optional[RgbConverter] = None,
    target_size: int = DEFAULT_SQUARE_THUMB_SIZE,
    quality: int = DEFAULT_SQUARE_THUMB_QUALITY,
) -> None:
    cmd = [
        "ffmpeg",
        "-i",
        video_path,
        "-vframes",
        "1",
        "-vf",
        "scale=800:-1",
        "-y",
        temp_frame_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.exists(temp_frame_path):
        raise RuntimeError("Failed to extract video frame")

    try:
        with Image.open(temp_frame_path) as frame:
            image = frame.copy()
        save_square_jpeg_thumbnail(
            image,
            output_path,
            target_size=target_size,
            quality=quality,
            to_rgb=to_rgb,
        )
    finally:
        if os.path.exists(temp_frame_path):
            os.remove(temp_frame_path)


def generate_preview_jpeg_buffer(
    file_path: str,
    *,
    max_size: int = 80,
    quality: int = 75,
) -> BytesIO:
    """Small aspect-preserving preview for the photo picker."""
    image = open_still_image(file_path)
    try:
        if image.mode != "RGB":
            image = image.convert("RGB")
        image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        buffer = BytesIO()
        image.save(buffer, format="JPEG", quality=quality)
        buffer.seek(0)
        return buffer
    finally:
        image.close()
