"""
Shared deterministic photo canonicalization helpers.

This module defines the single rulebook for photo date fallback, metadata
normalization, final hash computation, and canonical path derivation.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Optional, Tuple

from library_cleanliness import build_canonical_photo_path, parse_metadata_datetime

UNKNOWN_PHOTO_DATE_TAKEN = "1900:01:01 00:00:00"
UNKNOWN_PHOTO_DATE_OBJ = datetime(1900, 1, 1, 0, 0, 0)


def canonicalize_photo_date(raw_date: Optional[str]) -> Tuple[str, datetime]:
    """Resolve a photo date without using filesystem timestamps."""
    if raw_date:
        return parse_metadata_datetime(raw_date, 0)
    return UNKNOWN_PHOTO_DATE_TAKEN, UNKNOWN_PHOTO_DATE_OBJ


def write_photo_date_metadata(file_path: str, new_date: str) -> None:
    """Write canonical date metadata to a photo file using exiftool."""
    cmd = [
        "exiftool",
        f"-DateTimeOriginal={new_date}",
        f"-CreateDate={new_date}",
        f"-ModifyDate={new_date}",
        "-overwrite_original",
        "-P",
        file_path,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "exiftool failed")

        verify_result = subprocess.run(
            ["exiftool", "-DateTimeOriginal", "-s3", file_path],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if verify_result.returncode != 0:
            raise RuntimeError("EXIF verification failed: could not read back date")

        read_date = verify_result.stdout.strip()
        if read_date != new_date:
            raise RuntimeError(
                f"EXIF verification failed: wrote {new_date}, read back {read_date}"
            )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("exiftool timeout after 30s") from exc
    except FileNotFoundError as exc:
        raise RuntimeError("exiftool not found") from exc


@dataclass
class CanonicalizedPhoto:
    date_taken: str
    date_obj: datetime
    content_hash: str
    relative_path: str
    canonical_name: str
    file_size: int
    width: Optional[int]
    height: Optional[int]
    rating: Optional[int]
    metadata_changed: bool
    orientation_baked: bool
    rating_stripped: bool


def canonicalize_photo_file(
    file_path: str,
    *,
    extract_exif_date: Callable[[str], Optional[str]],
    bake_orientation: Callable[[str], Tuple[bool, str, Optional[int]]],
    get_dimensions: Callable[[str], Optional[Tuple[Optional[int], Optional[int]]]],
    compute_hash: Callable[[str], Optional[str]],
    write_photo_exif: Callable[[str, str], None] = write_photo_date_metadata,
    extract_exif_rating: Optional[Callable[[str], Optional[int]]] = None,
    strip_exif_rating: Optional[Callable[[str], bool]] = None,
    forced_date_taken: Optional[str] = None,
) -> CanonicalizedPhoto:
    """
    Canonicalize a photo file in place and return its final deterministic identity.

    The final identity depends only on the canonicalized file bytes and the shared
    date policy. Filesystem timestamps are intentionally excluded.
    """

    raw_date = extract_exif_date(file_path)
    current_normalized_date = None
    if raw_date:
        current_normalized_date, _ = parse_metadata_datetime(raw_date, 0)

    if forced_date_taken is None:
        date_taken, date_obj = canonicalize_photo_date(raw_date)
    else:
        date_taken, date_obj = parse_metadata_datetime(forced_date_taken, 0)

    baked, _, _ = bake_orientation(file_path)
    orientation_baked = bool(baked)

    rating = extract_exif_rating(file_path) if extract_exif_rating else None
    rating_stripped = False
    if rating == 0 and strip_exif_rating:
        if not strip_exif_rating(file_path):
            raise RuntimeError(f"Failed to strip rating=0 from {file_path}")
        rating = None
        rating_stripped = True

    metadata_changed = orientation_baked or rating_stripped
    if forced_date_taken is not None or current_normalized_date != date_taken or metadata_changed:
        write_photo_exif(file_path, date_taken)
        metadata_changed = True

    dimensions = get_dimensions(file_path)
    width, height = dimensions if dimensions else (None, None)

    content_hash = compute_hash(file_path)
    if not content_hash:
        raise RuntimeError(f"Failed to compute canonical hash for {file_path}")

    relative_path, canonical_name = build_canonical_photo_path(
        date_taken,
        content_hash,
        os.path.splitext(file_path)[1],
    )

    return CanonicalizedPhoto(
        date_taken=date_taken,
        date_obj=date_obj,
        content_hash=content_hash,
        relative_path=relative_path,
        canonical_name=canonical_name,
        file_size=os.path.getsize(file_path),
        width=width,
        height=height,
        rating=rating if rating != 0 else None,
        metadata_changed=metadata_changed,
        orientation_baked=orientation_baked,
        rating_stripped=rating_stripped,
    )
