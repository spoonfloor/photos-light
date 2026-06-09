"""
Convert-mode normalization (terraform / convert-to-library).

Uses shared per-file identity and canonical path helpers from normalization_core.
Convert owns destructive in-library layout rewrite, duplicate trashing, and
non-media deferral. Resume/checkpoints and blocking final audit remain future
Convert orchestration work; ``CONVERT_POLICY`` is the policy source of truth.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional

from library_cleanliness import ALL_MEDIA_EXTENSIONS, VIDEO_MEDIA_EXTENSIONS
from library_layout import ROOT_INFRASTRUCTURE_DIRS
from normalization_contract import CONVERT_POLICY, NormalizationPolicy
from normalization_core import (
    NormalizationCoreDependencies,
    NormalizationFileResult,
    build_video_identity,
    classify_media_kind,
    duplicate_row_for_hash,
    expected_canonical_rel_path,
    normalize_ingest_photo,
)


@dataclass
class ConvertDependencies(NormalizationCoreDependencies):
    """Convert-facing dependency bundle over the shared per-file primitives."""

    policy: NormalizationPolicy = CONVERT_POLICY
    move_duplicate_to_trash: Callable[[str], str] = field(
        default=lambda _path: "",
        repr=False,
    )
    move_unsupported_to_trash: Callable[[str], str] = field(
        default=lambda _path: "",
        repr=False,
    )
    photo_temp_prefix: str = "convert_photo_"


ConvertFileResult = NormalizationFileResult


@dataclass
class ConvertCounters:
    processed: int = 0
    duplicates: int = 0
    errors: int = 0

    def progress_payload(self, *, current: int, total: int, **extra: Any) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "processed": self.processed,
            "duplicates": self.duplicates,
            "errors": self.errors,
            "current": current,
            "total": total,
        }
        payload.update(extra)
        return payload


@dataclass(frozen=True)
class ConvertScanResult:
    media_files: List[str]
    non_media_files: List[str]

    @property
    def total_media(self) -> int:
        return len(self.media_files)


def scan_convert_library(library_path: str) -> ConvertScanResult:
    """Walk an in-library tree and partition supported media from everything else."""
    media_files: List[str] = []
    non_media_files: List[str] = []

    for root, dirs, files in os.walk(library_path):
        dirs[:] = [entry for entry in dirs if not entry.startswith(".")]

        for filename in files:
            if filename.startswith("."):
                continue

            full_path = os.path.join(root, filename)
            _, ext = os.path.splitext(filename)
            ext_lower = ext.lower()

            if ext_lower in ALL_MEDIA_EXTENSIONS:
                media_files.append(full_path)
            else:
                non_media_files.append(full_path)

    return ConvertScanResult(media_files=media_files, non_media_files=non_media_files)


def normalize_convert_photo(
    conn,
    source_path: str,
    *,
    filename: str,
    deps: ConvertDependencies,
) -> ConvertFileResult:
    """Canonicalize one in-library photo and move it into layout."""
    return normalize_ingest_photo(
        conn,
        source_path,
        filename=filename,
        deps=deps,
        temp_prefix=deps.photo_temp_prefix,
    )


def normalize_convert_video(
    conn,
    source_path: str,
    *,
    filename: str,
    ext: str,
    deps: ConvertDependencies,
) -> ConvertFileResult:
    """Canonicalize one in-library video in place and move it into layout."""
    identity = build_video_identity(source_path, ext=ext, deps=deps)
    if identity is None:
        return NormalizationFileResult(status="error", error="Failed to hash file")

    if duplicate_row_for_hash(conn, identity.duplicate_key):
        return NormalizationFileResult(status="duplicate")

    try:
        deps.write_video_metadata(source_path, identity.date_taken)
    except Exception as error:
        category, user_message = deps.categorize_processing_error(error)
        return NormalizationFileResult(
            status="rejected",
            rejection={
                "file": filename,
                "source_path": source_path,
                "reason": user_message,
                "category": category,
                "technical_error": str(error),
            },
        )

    content_hash = deps.compute_hash(source_path)
    if not content_hash:
        return NormalizationFileResult(status="error", error="Failed to hash file after metadata write")

    if duplicate_row_for_hash(conn, content_hash):
        return NormalizationFileResult(status="duplicate")

    relative_path = expected_canonical_rel_path(identity.date_taken, content_hash, ext)
    target_path = os.path.join(deps.library_path, relative_path)
    if os.path.exists(target_path) and os.path.abspath(target_path) != os.path.abspath(source_path):
        return NormalizationFileResult(
            status="error",
            error=f"Refusing to overwrite existing file at canonical path {relative_path}",
            error_file=filename,
        )

    if os.path.abspath(target_path) != os.path.abspath(source_path):
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        shutil.move(source_path, target_path)

    dimensions = deps.get_dimensions(target_path)
    width = dimensions[0] if dimensions else None
    height = dimensions[1] if dimensions else None
    file_size = os.path.getsize(target_path)
    cursor = conn.cursor()
    cursor.execute(
        """
            INSERT INTO photos (current_path, original_filename, content_hash, file_size, file_type, date_taken, width, height)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            relative_path,
            filename,
            content_hash,
            file_size,
            "video",
            identity.date_taken,
            width,
            height,
        ),
    )
    photo_id = cursor.lastrowid
    conn.commit()
    return NormalizationFileResult(status="imported", photo_id=photo_id)


def normalize_convert_file(
    conn,
    source_path: str,
    *,
    filename: str,
    deps: ConvertDependencies,
) -> ConvertFileResult:
    """Route one in-library file through the shared convert primitives."""
    _base, ext = os.path.splitext(filename)
    kind = classify_media_kind(ext)
    if kind == "photo":
        return normalize_convert_photo(conn, source_path, filename=filename, deps=deps)
    if ext.lower() in VIDEO_MEDIA_EXTENSIONS:
        return normalize_convert_video(
            conn,
            source_path,
            filename=filename,
            ext=ext,
            deps=deps,
        )
    return NormalizationFileResult(
        status="error",
        error=f"Unsupported file type: {ext}",
        error_file=filename,
    )


def rewrite_library_layout(library_path: str) -> int:
    """
    Remove non-canonical folders after convert, preserving stray media files.

    Allowed layout after convert:
    - Root infrastructure folders (``.library``, ``.logs``, …)
    - ``YYYY/YYYY-MM-DD/`` canonical media trees
    """
    removed_count = 0
    ignored_entries = {".DS_Store"}
    infrastructure_folders = set(ROOT_INFRASTRUCTURE_DIRS)

    try:
        root_items = os.listdir(library_path)
    except OSError:
        return 0

    for item in root_items:
        item_path = os.path.join(library_path, item)
        if not os.path.isdir(item_path):
            continue

        if item in infrastructure_folders:
            continue

        if len(item) == 4 and item.isdigit():
            try:
                year_items = os.listdir(item_path)
            except OSError:
                continue

            for year_item in year_items:
                year_item_path = os.path.join(item_path, year_item)
                if not os.path.isdir(year_item_path):
                    continue

                is_valid_date_folder = (
                    len(year_item) == 10
                    and year_item[4] == "-"
                    and year_item[7] == "-"
                    and year_item[:4].isdigit()
                    and year_item[5:7].isdigit()
                    and year_item[8:10].isdigit()
                )
                if is_valid_date_folder:
                    continue

                try:
                    visible_entries = [
                        entry
                        for entry in os.listdir(year_item_path)
                        if entry not in ignored_entries
                    ]
                except OSError:
                    continue

                if visible_entries:
                    continue

                try:
                    for ignored_entry in os.listdir(year_item_path):
                        if ignored_entry in ignored_entries:
                            ignored_path = os.path.join(year_item_path, ignored_entry)
                            if os.path.isfile(ignored_path):
                                os.remove(ignored_path)
                    shutil.rmtree(year_item_path)
                    removed_count += 1
                except OSError:
                    pass
            continue

        try:
            visible_entries = [
                entry for entry in os.listdir(item_path) if entry not in ignored_entries
            ]
        except OSError:
            continue

        if visible_entries:
            continue

        try:
            for ignored_entry in os.listdir(item_path):
                if ignored_entry in ignored_entries:
                    ignored_path = os.path.join(item_path, ignored_entry)
                    if os.path.isfile(ignored_path):
                        os.remove(ignored_path)
            shutil.rmtree(item_path)
            removed_count += 1
        except OSError:
            pass

    return removed_count


def iter_convert_events(
    conn,
    file_paths: Iterable[str],
    deps: ConvertDependencies,
    *,
    stop_check: Optional[Callable[[], bool]] = None,
    on_file_start: Optional[Callable[[str, str, int, int], None]] = None,
    on_success: Optional[Callable[[str, ConvertFileResult], None]] = None,
    on_duplicate: Optional[Callable[[str, ConvertFileResult, str], None]] = None,
    on_rejected: Optional[Callable[[str, ConvertFileResult], None]] = None,
    on_error: Optional[Callable[[str, ConvertFileResult], None]] = None,
) -> Iterator[Tuple[str, Dict[str, Any]]]:
    """
    Process in-library media through convert mode and yield SSE-friendly events.

    Optional callbacks let the HTTP layer keep manifest logging and console output
    without duplicating per-file normalization logic.
    """
    paths = list(file_paths)
    total = len(paths)
    counters = ConvertCounters()

    for file_index, source_path in enumerate(paths, 1):
        if stop_check and stop_check():
            return

        filename = os.path.basename(source_path)
        if not os.path.exists(source_path):
            counters.errors += 1
            yield "progress", counters.progress_payload(current=file_index, total=total)
            continue

        if on_file_start:
            on_file_start(source_path, filename, file_index, total)

        try:
            result = normalize_convert_file(conn, source_path, filename=filename, deps=deps)

            if result.status == "imported":
                counters.processed += 1
                if on_success:
                    on_success(source_path, result)
                payload = counters.progress_payload(current=file_index, total=total)
                if result.photo_id:
                    payload["photo_id"] = result.photo_id
                yield "progress", payload
            elif result.status == "duplicate":
                counters.duplicates += 1
                trash_path = ""
                if os.path.exists(source_path):
                    trash_path = deps.move_duplicate_to_trash(source_path)
                if on_duplicate:
                    on_duplicate(source_path, result, trash_path)
                yield "progress", counters.progress_payload(current=file_index, total=total)
            elif result.status == "rejected":
                rejection = dict(result.rejection or {})
                category = rejection.get("category")
                if category == "duplicate":
                    counters.duplicates += 1
                else:
                    counters.errors += 1
                if on_rejected:
                    on_rejected(source_path, result)
                rejection.update(counters.progress_payload(current=file_index, total=total))
                yield "rejected", rejection
            else:
                counters.errors += 1
                if on_error:
                    on_error(source_path, result)
                yield "progress", counters.progress_payload(
                    current=file_index,
                    total=total,
                    error=result.error,
                    error_file=result.error_file or filename,
                )
        except Exception as error:
            counters.errors += 1
            error_result = NormalizationFileResult(
                status="error",
                error=str(error),
                error_file=filename,
            )
            if on_error:
                on_error(source_path, error_result)
            yield "progress", counters.progress_payload(
                current=file_index,
                total=total,
                error=str(error),
                error_file=filename,
            )
            yield "rejected", {
                "file": filename,
                "source_path": source_path,
                "reason": str(error),
                "category": "error",
                "technical_error": str(error),
                **counters.progress_payload(current=file_index, total=total),
            }

    yield "complete", {
        "processed": counters.processed,
        "duplicates": counters.duplicates,
        "errors": counters.errors,
        "total": total,
    }
