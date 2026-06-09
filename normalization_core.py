"""
Shared per-file normalization primitives.

This module owns mode-neutral file work. Orchestrators such as Add Photos and
Clean Library decide which files to process, how to report progress, and what
policy to apply around resume/final audit.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

from library_cleanliness import (
    VIDEO_MEDIA_EXTENSIONS,
    build_canonical_photo_path,
    media_kind_for_extension,
    parse_metadata_datetime,
)
from normalization_contract import (
    compute_duplicate_key,
    expected_canonical_rel_path_from_db_date,
)


@dataclass
class NormalizationCoreDependencies:
    library_path: str
    hash_cache: Any
    stage_photo_for_canonicalization: Callable[..., Any]
    cleanup_staged_file: Callable[[Optional[str]], None]
    commit_staged_canonical_photo: Callable[..., Tuple[int, str]]
    categorize_processing_error: Callable[[Exception], Tuple[str, str]]
    extract_exif_date: Callable[[str], Optional[str]]
    write_video_metadata: Callable[[str, str], None]
    finalize_mutated_media: Callable[..., Any]
    compute_hash: Callable[[str], str]
    get_dimensions: Callable[[str], Any]
    delete_thumbnail_for_hash: Callable[[str], None]
    remove_source_after_commit: bool = False


@dataclass
class NormalizationFileResult:
    status: str
    photo_id: Optional[int] = None
    error: Optional[str] = None
    error_file: Optional[str] = None
    rejection: Optional[Dict[str, Any]] = None


@dataclass(frozen=True)
class NormalizationIdentity:
    file_type: str
    content_hash: str
    duplicate_key: str
    date_taken: str
    relative_path: str


def classify_media_kind(ext: str) -> Optional[str]:
    """Return the shared media kind for an extension."""
    return media_kind_for_extension(ext.lower())


def duplicate_row_for_hash(conn, content_hash: str):
    return conn.execute(
        "SELECT id, current_path FROM photos WHERE content_hash = ?",
        (content_hash,),
    ).fetchone()


def duplicate_key_for_file(
    full_path: str,
    *,
    fallback_hash: Optional[str] = None,
    compute_hash: Optional[Callable[[str], object]] = None,
) -> Optional[str]:
    if compute_hash is None:
        return compute_duplicate_key(full_path, fallback_hash=fallback_hash)
    return compute_duplicate_key(
        full_path,
        fallback_hash=fallback_hash,
        compute_hash=compute_hash,
    )


def build_video_identity(
    source_path: str,
    *,
    ext: str,
    deps: NormalizationCoreDependencies,
) -> Optional[NormalizationIdentity]:
    content_hash, _cache_hit = deps.hash_cache.get_hash(source_path)
    if content_hash is None:
        return None

    date_taken, _date_obj = parse_metadata_datetime(
        deps.extract_exif_date(source_path),
        os.path.getmtime(source_path),
    )
    relative_path, _canonical_name = build_canonical_photo_path(date_taken, content_hash, ext)
    duplicate_key = duplicate_key_for_file(source_path, fallback_hash=content_hash)
    if not duplicate_key:
        return None

    return NormalizationIdentity(
        file_type="video",
        content_hash=content_hash,
        duplicate_key=duplicate_key,
        date_taken=date_taken,
        relative_path=relative_path,
    )


def expected_canonical_rel_path(date_taken: str, content_hash: str, ext: str) -> str:
    return expected_canonical_rel_path_from_db_date(date_taken, content_hash, ext)


def normalize_ingest_photo(
    conn,
    source_path: str,
    *,
    filename: str,
    deps: NormalizationCoreDependencies,
    temp_prefix: str = "import_photo_",
) -> NormalizationFileResult:
    staged_path = None
    try:
        staged_photo = deps.stage_photo_for_canonicalization(
            source_path,
            temp_prefix=temp_prefix,
        )
        staged_path = staged_photo.staged_path
        canonical_photo = staged_photo.canonical_photo

        existing = duplicate_row_for_hash(conn, canonical_photo.content_hash)
        if existing:
            deps.cleanup_staged_file(staged_path)
            staged_path = None
            return NormalizationFileResult(status="duplicate")

        target_path = os.path.join(deps.library_path, canonical_photo.relative_path)
        if os.path.exists(target_path):
            deps.cleanup_staged_file(staged_path)
            staged_path = None
            return NormalizationFileResult(status="duplicate")

        photo_id, _target_path = deps.commit_staged_canonical_photo(
            conn,
            library_path=deps.library_path,
            source_path=source_path,
            original_filename=filename,
            staged_photo=staged_photo,
            remove_source_after_commit=deps.remove_source_after_commit,
        )
        staged_path = None
        return NormalizationFileResult(status="imported", photo_id=photo_id)
    except Exception as error:
        deps.cleanup_staged_file(staged_path)
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


def normalize_ingest_video(
    conn,
    source_path: str,
    *,
    filename: str,
    ext: str,
    deps: NormalizationCoreDependencies,
) -> NormalizationFileResult:
    identity = build_video_identity(source_path, ext=ext, deps=deps)
    if identity is None:
        return NormalizationFileResult(status="error", error="Failed to hash file")

    if duplicate_row_for_hash(conn, identity.duplicate_key):
        return NormalizationFileResult(status="duplicate")

    relative_path = identity.relative_path
    canonical_name = os.path.basename(relative_path)
    target_path = os.path.join(deps.library_path, relative_path)
    target_dir = os.path.dirname(target_path)
    os.makedirs(target_dir, exist_ok=True)
    base_name, _ = os.path.splitext(canonical_name)

    counter = 1
    while os.path.exists(target_path):
        canonical_name = f"{base_name}_{counter}{ext.lower()}"
        relative_path = os.path.join(os.path.dirname(relative_path), canonical_name)
        target_path = os.path.join(target_dir, canonical_name)
        counter += 1

    cursor = conn.cursor()
    file_size = os.path.getsize(source_path)
    cursor.execute(
        """
            INSERT INTO photos (current_path, original_filename, content_hash, file_size, file_type, date_taken, width, height)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            relative_path,
            filename,
            identity.content_hash,
            file_size,
            identity.file_type,
            identity.date_taken,
            None,
            None,
        ),
    )
    photo_id = cursor.lastrowid
    conn.commit()

    shutil.copy2(source_path, target_path)

    try:
        deps.write_video_metadata(target_path, identity.date_taken)
        finalize_result = deps.finalize_mutated_media(
            conn=conn,
            photo_id=photo_id,
            library_path=deps.library_path,
            current_rel_path=relative_path,
            date_taken=identity.date_taken,
            old_hash=identity.content_hash,
            build_canonical_path=build_canonical_photo_path,
            compute_hash=deps.compute_hash,
            get_dimensions=deps.get_dimensions,
            delete_thumbnail_for_hash=deps.delete_thumbnail_for_hash,
            duplicate_policy="delete",
        )
        conn.commit()
        if finalize_result.status == "duplicate_removed":
            return NormalizationFileResult(status="duplicate")

        if deps.remove_source_after_commit and os.path.exists(source_path):
            os.remove(source_path)

        return NormalizationFileResult(status="imported", photo_id=photo_id)
    except Exception as error:
        try:
            if os.path.exists(target_path):
                os.remove(target_path)
        except Exception:
            pass
        try:
            cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
            conn.commit()
        except Exception:
            pass

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


def normalize_ingest_file(
    conn,
    source_path: str,
    *,
    filename: str,
    deps: NormalizationCoreDependencies,
) -> NormalizationFileResult:
    _base, ext = os.path.splitext(filename)
    kind = classify_media_kind(ext)
    if kind == "photo":
        return normalize_ingest_photo(conn, source_path, filename=filename, deps=deps)
    if ext.lower() in VIDEO_MEDIA_EXTENSIONS:
        return normalize_ingest_video(
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
