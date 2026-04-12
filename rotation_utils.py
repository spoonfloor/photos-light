from __future__ import annotations

import os
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageOps


JPEG_EXTENSIONS = {".jpg", ".jpeg"}
PIL_LOSSLESS_ROTATION_EXTENSIONS = {".png", ".tiff", ".tif"}
LOSSLESS_ROTATION_EXTENSIONS = JPEG_EXTENSIONS | PIL_LOSSLESS_ROTATION_EXTENSIONS
ROTATION_SUPPORTED_EXTENSIONS = LOSSLESS_ROTATION_EXTENSIONS
JPEG_LOSSY_QUALITY = 95
ORIENTATION_TAG = 0x0112


@dataclass
class RotationResult:
    success: bool
    lossless: bool
    message: str


def normalize_rotation_degrees(degrees_ccw: int) -> int:
    normalized = degrees_ccw % 360
    if normalized not in {0, 90, 180, 270}:
        raise ValueError("Rotation must be in 90-degree steps")
    return normalized


def get_orientation_flag(file_path: str) -> Optional[int]:
    try:
        result = subprocess.run(
            ["exiftool", "-Orientation", "-n", "-s3", file_path],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None
        value = result.stdout.strip()
        return int(value) if value else None
    except (ValueError, OSError, subprocess.TimeoutExpired):
        return None


def strip_orientation_tag(target_path: str) -> Tuple[bool, str]:
    result = subprocess.run(
        ["exiftool", "-Orientation=", "-overwrite_original", "-P", target_path],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        return False, result.stderr.strip() or "Failed to remove orientation tag"
    return True, "Removed orientation tag"


def jpegtran_transform_for_degrees(degrees_ccw: int) -> Optional[List[str]]:
    normalized = normalize_rotation_degrees(degrees_ccw)
    return {
        0: [],
        90: ["rotate", "270"],
        180: ["rotate", "180"],
        270: ["rotate", "90"],
    }.get(normalized)


def _run_jpegtran_transform(
    file_path: str, transform: List[str], output_path: str
) -> subprocess.CompletedProcess[str]:
    cmd = ["jpegtran", "-perfect"]
    cmd.extend(
        f"-{part}" if index == 0 else part
        for index, part in enumerate(transform)
    )
    cmd.extend(["-copy", "all", "-outfile", output_path, file_path])
    return subprocess.run(cmd, capture_output=True, text=True, timeout=30)


def _can_run_jpegtran_transform_losslessly(file_path: str, transform: List[str]) -> bool:
    if not transform:
        return True

    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(suffix=".jpg")
        os.close(fd)
        result = _run_jpegtran_transform(file_path, transform, tmp)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)


def can_rotate_losslessly(file_path: str, degrees_ccw: int) -> bool:
    ext = os.path.splitext(file_path)[1].lower()
    normalized = normalize_rotation_degrees(degrees_ccw)
    if normalized == 0:
        return True
    if ext in PIL_LOSSLESS_ROTATION_EXTENSIONS:
        return True
    if ext not in JPEG_EXTENSIONS:
        return False

    orientation = get_orientation_flag(file_path)
    if orientation not in (None, 1):
        return False

    transform = jpegtran_transform_for_degrees(normalized)
    if transform is None:
        return False

    return _can_run_jpegtran_transform_losslessly(file_path, transform)


def _rotate_jpeg_losslessly(file_path: str, degrees_ccw: int) -> RotationResult:
    transform = jpegtran_transform_for_degrees(degrees_ccw)
    if transform is None:
        return RotationResult(False, False, "Unsupported JPEG rotation")
    if not transform:
        return RotationResult(True, True, "No rotation needed")

    temp_output = f"{file_path}.rotated.jpg"
    try:
        result = _run_jpegtran_transform(file_path, transform, temp_output)
        if result.returncode != 0:
            if os.path.exists(temp_output):
                os.remove(temp_output)
            return RotationResult(False, False, "Lossless JPEG rotation not possible")

        stripped, message = strip_orientation_tag(temp_output)
        if not stripped:
            os.remove(temp_output)
            return RotationResult(False, False, message)

        os.replace(temp_output, file_path)
        return RotationResult(True, True, "Rotated JPEG losslessly")
    finally:
        if os.path.exists(temp_output):
            os.remove(temp_output)


def _build_clean_exif_bytes(image: Image.Image) -> Optional[bytes]:
    try:
        exif = image.getexif()
        if exif:
            if ORIENTATION_TAG in exif:
                del exif[ORIENTATION_TAG]
            return exif.tobytes()
    except Exception:
        return None
    return None


def _rotate_with_pillow(
    file_path: str, degrees_ccw: int, *, jpeg_quality: int, save_as_jpeg: bool
) -> RotationResult:
    ext = os.path.splitext(file_path)[1].lower()
    fd, temp_output = tempfile.mkstemp(
        suffix=".jpg" if save_as_jpeg else ext,
        dir=os.path.dirname(file_path),
    )
    os.close(fd)

    try:
        with Image.open(file_path) as image:
            normalized = ImageOps.exif_transpose(image)
            rotated = normalized.rotate(degrees_ccw, expand=True)
            icc_profile = image.info.get("icc_profile") or normalized.info.get("icc_profile")
            exif_bytes = _build_clean_exif_bytes(normalized)

            save_kwargs: Dict[str, Any] = {}
            if icc_profile:
                save_kwargs["icc_profile"] = icc_profile
            if exif_bytes:
                save_kwargs["exif"] = exif_bytes

            if save_as_jpeg:
                if rotated.mode not in {"RGB", "L", "CMYK"}:
                    rotated = rotated.convert("RGB")
                save_kwargs.update(
                    {
                        "format": "JPEG",
                        "quality": jpeg_quality,
                        "optimize": True,
                    }
                )
            elif ext == ".png":
                save_kwargs["format"] = "PNG"
            else:
                save_kwargs["format"] = "TIFF"

            rotated.save(temp_output, **save_kwargs)

        stripped, message = strip_orientation_tag(temp_output)
        if not stripped:
            return RotationResult(False, False, message)

        os.replace(temp_output, file_path)
        return RotationResult(
            True,
            not save_as_jpeg,
            "Rotated with Pillow" if not save_as_jpeg else "Rotated JPEG with high-quality re-save",
        )
    finally:
        if os.path.exists(temp_output):
            os.remove(temp_output)


def rotate_file_in_place(
    file_path: str,
    degrees_ccw: int,
    *,
    allow_lossy_fallback: bool = False,
    jpeg_quality: int = JPEG_LOSSY_QUALITY,
) -> RotationResult:
    ext = os.path.splitext(file_path)[1].lower()
    normalized = normalize_rotation_degrees(degrees_ccw)
    if normalized == 0:
        return RotationResult(True, True, "No rotation needed")

    if ext in PIL_LOSSLESS_ROTATION_EXTENSIONS:
        return _rotate_with_pillow(
            file_path,
            normalized,
            jpeg_quality=jpeg_quality,
            save_as_jpeg=False,
        )

    if ext not in JPEG_EXTENSIONS:
        return RotationResult(False, False, f"Unsupported rotation format {ext}")

    if can_rotate_losslessly(file_path, normalized):
        return _rotate_jpeg_losslessly(file_path, normalized)

    if not allow_lossy_fallback:
        return RotationResult(False, False, "Lossless JPEG rotation not possible")

    return _rotate_with_pillow(
        file_path,
        normalized,
        jpeg_quality=jpeg_quality,
        save_as_jpeg=True,
    )


def can_bake_losslessly(file_path: str) -> bool:
    ext = os.path.splitext(file_path)[1].lower()
    orientation = get_orientation_flag(file_path)
    if orientation in (None, 1):
        return False

    if ext in PIL_LOSSLESS_ROTATION_EXTENSIONS:
        return True
    if ext not in JPEG_EXTENSIONS:
        return False

    transform = {
        2: ["flip", "horizontal"],
        3: ["rotate", "180"],
        4: ["flip", "vertical"],
        5: ["transpose"],
        6: ["rotate", "90"],
        7: ["transverse"],
        8: ["rotate", "270"],
    }.get(orientation)
    if not transform:
        return False

    return _can_run_jpegtran_transform_losslessly(file_path, transform)


def bake_orientation(file_path: str) -> Tuple[bool, str, Optional[int]]:
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in ROTATION_SUPPORTED_EXTENSIONS:
        return False, "Skipped lossy-risk format", None

    try:
        orientation = get_orientation_flag(file_path)
        if orientation is None:
            return False, "No orientation metadata", None
        if orientation == 1:
            success, message = strip_orientation_tag(file_path)
            return success, message, 1

        if ext in JPEG_EXTENSIONS:
            transform = {
                2: ["flip", "horizontal"],
                3: ["rotate", "180"],
                4: ["flip", "vertical"],
                5: ["transpose"],
                6: ["rotate", "90"],
                7: ["transverse"],
                8: ["rotate", "270"],
            }.get(orientation)
            if not transform:
                return False, f"Unknown orientation {orientation}", orientation

            temp_output = f"{file_path}.baked.jpg"
            try:
                result = _run_jpegtran_transform(file_path, transform, temp_output)
                if result.returncode != 0:
                    return False, "Kept orientation (lossless bake not possible)", orientation

                success, message = strip_orientation_tag(temp_output)
                if not success:
                    return False, message, orientation

                os.replace(temp_output, file_path)
                return True, f"Baked orientation {orientation}", orientation
            finally:
                if os.path.exists(temp_output):
                    os.remove(temp_output)

        if ext in PIL_LOSSLESS_ROTATION_EXTENSIONS:
            with Image.open(file_path) as image:
                rotated = ImageOps.exif_transpose(image)
                icc_profile = image.info.get("icc_profile")
                exif_bytes = _build_clean_exif_bytes(image)
                save_kwargs: Dict[str, Any] = {}
                if icc_profile:
                    save_kwargs["icc_profile"] = icc_profile
                if exif_bytes:
                    save_kwargs["exif"] = exif_bytes
                rotated.save(file_path, **save_kwargs)
            return True, f"Baked orientation {orientation}", orientation

        return False, f"Unsupported rotation format {ext}", orientation
    except subprocess.TimeoutExpired:
        return False, "Orientation bake timeout", None
    except FileNotFoundError as exc:
        return False, f"Required tool missing: {exc}", None
    except Exception as exc:
        return False, f"Orientation bake error: {exc}", None
