"""Shared import path scanning and browser drop staging."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from clean_library_inventory import (
    estimate_clean_duration_seconds,
    format_about_duration,
)
from library_cleanliness import PHOTO_MEDIA_EXTENSIONS, VIDEO_MEDIA_EXTENSIONS

PHOTO_EXTENSIONS = PHOTO_MEDIA_EXTENSIONS
VIDEO_EXTENSIONS = VIDEO_MEDIA_EXTENSIONS

DROP_BATCH_PREFIX = "photos-light-drop-"
_DROP_BATCH_DIR = os.path.join(tempfile.gettempdir(), "photos-light-drops")
_BATCH_ID_PATTERN = re.compile(r"^[a-f0-9-]{36}$")


@dataclass
class ImportScanResult:
    files: List[str]
    total_count: int
    photo_count: int
    video_count: int
    photo_bytes: int
    video_bytes: int
    estimated_seconds: float
    estimated_display: str
    files_selected: int
    folders_scanned: int

    def to_payload(self) -> Dict[str, Any]:
        total_bytes = self.photo_bytes + self.video_bytes
        return {
            "status": "success",
            "files": self.files,
            "total_count": self.total_count,
            "photo_count": self.photo_count,
            "video_count": self.video_count,
            "photo_bytes": self.photo_bytes,
            "video_bytes": self.video_bytes,
            "total_bytes": total_bytes,
            "estimated_seconds": round(self.estimated_seconds, 1),
            "estimated_display": self.estimated_display,
            "files_selected": self.files_selected,
            "folders_scanned": self.folders_scanned,
        }


def path_is_hidden(location: str) -> bool:
    for component in os.path.normpath(location).split(os.sep):
        if component and component not in (".", "..") and component.startswith("."):
            return True
    return False


def scan_media_paths(paths: Sequence[str]) -> ImportScanResult:
    """Scan filesystem paths (files and/or folders) for importable media."""
    media_files: List[str] = []
    files_count = 0
    folders_count = 0
    photo_count = 0
    video_count = 0
    photo_bytes = 0
    video_bytes = 0

    def add_media_file(full_path: str) -> bool:
        nonlocal photo_count, video_count, photo_bytes, video_bytes

        if path_is_hidden(full_path):
            return False

        _, ext = os.path.splitext(full_path)
        ext_lower = ext.lower()
        if ext_lower not in PHOTO_EXTENSIONS and ext_lower not in VIDEO_EXTENSIONS:
            return False

        media_files.append(full_path)
        try:
            size_bytes = os.path.getsize(full_path)
        except OSError:
            size_bytes = 0

        if ext_lower in VIDEO_EXTENSIONS:
            video_count += 1
            video_bytes += size_bytes
        else:
            photo_count += 1
            photo_bytes += size_bytes
        return True

    for path in paths:
        if not os.path.exists(path):
            continue

        if os.path.isfile(path):
            if add_media_file(path):
                files_count += 1
        elif os.path.isdir(path):
            if path_is_hidden(path):
                continue

            folders_count += 1
            for root, dirs, files in os.walk(path, followlinks=False):
                dirs[:] = [entry for entry in dirs if not entry.startswith(".")]
                for filename in files:
                    if filename.startswith(".") or filename == "manifest.json":
                        continue
                    full_path = os.path.join(root, filename)
                    add_media_file(full_path)

    estimated_seconds = estimate_clean_duration_seconds(
        photo_count=photo_count,
        video_count=video_count,
        photo_bytes=photo_bytes,
        video_bytes=video_bytes,
    )
    _seconds, estimated_display = format_about_duration(estimated_seconds)

    return ImportScanResult(
        files=media_files,
        total_count=len(media_files),
        photo_count=photo_count,
        video_count=video_count,
        photo_bytes=photo_bytes,
        video_bytes=video_bytes,
        estimated_seconds=estimated_seconds,
        estimated_display=estimated_display,
        files_selected=files_count,
        folders_scanned=folders_count,
    )


def _drop_batch_root(batch_id: str) -> str:
    if not _BATCH_ID_PATTERN.fullmatch(batch_id):
        raise ValueError("Invalid drop batch id")
    return os.path.join(_DROP_BATCH_DIR, f"{DROP_BATCH_PREFIX}{batch_id}")


def _sanitize_relative_path(relative_path: str) -> Optional[str]:
    if not relative_path:
        return None
    normalized = os.path.normpath(relative_path.replace("\\", "/"))
    if normalized in (".", ""):
        return None
    if normalized.startswith("..") or os.path.isabs(normalized):
        return None
    return normalized


def _ensure_drop_parent() -> None:
    os.makedirs(_DROP_BATCH_DIR, exist_ok=True)


def stage_drop_uploads(
    uploads: Iterable[Tuple[Any, str]],
) -> Tuple[str, ImportScanResult]:
    """
    Save browser-uploaded files to a temp batch directory and scan them.

    Each upload item is (file_storage, relative_path_or_filename).
    """
    _ensure_drop_parent()
    batch_id = str(uuid.uuid4())
    batch_root = _drop_batch_root(batch_id)
    os.makedirs(batch_root, exist_ok=True)

    manifest: List[Dict[str, str]] = []

    try:
        for file_storage, relative_path in uploads:
            safe_relative = _sanitize_relative_path(relative_path)
            if not safe_relative:
                safe_relative = os.path.basename(getattr(file_storage, "filename", "") or "upload")

            destination = os.path.join(batch_root, safe_relative)
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            file_storage.save(destination)
            manifest.append({"relative_path": safe_relative, "saved_path": destination})

        manifest_path = os.path.join(batch_root, "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as handle:
            json.dump({"batch_id": batch_id, "files": manifest}, handle)

        scan_result = scan_media_paths([batch_root])
        return batch_id, scan_result
    except Exception:
        delete_drop_batch(batch_id)
        raise


def delete_drop_batch(batch_id: str) -> bool:
    """Remove a staged drop batch directory. Returns True when deleted."""
    try:
        batch_root = _drop_batch_root(batch_id)
    except ValueError:
        return False

    if not os.path.isdir(batch_root):
        return False

    shutil.rmtree(batch_root, ignore_errors=True)
    return True
