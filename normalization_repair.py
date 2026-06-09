"""
Repair-mode per-file normalization primitives.

Clean Library keeps the phase machine, checkpoints, duplicate grouping, DB
rebuild, folder cleanup, and final audit. This module owns small per-file
repair actions that can be shared and tested outside that orchestration.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from library_cleanliness import media_kind_for_extension, parse_metadata_datetime
from normalization_contract import REPAIR_POLICY, NormalizationPolicy
from normalization_core import duplicate_key_for_file, expected_canonical_rel_path


class RepairFileError(RuntimeError):
    """A single repair operation could not be completed safely."""


@dataclass
class RepairDependencies:
    library_path: str
    policy: NormalizationPolicy = REPAIR_POLICY
    path_exists: Callable[[str], bool] = os.path.exists
    make_dirs: Callable[..., None] = os.makedirs
    move_file: Callable[[str, str], Any] = shutil.move
    canonical_rel_path: Callable[[str, str, str], str] = expected_canonical_rel_path


@dataclass
class RepairScanDependencies:
    hash_cache: Any
    extract_exif_date: Callable[[str], Optional[str]]
    extract_exif_rating: Callable[[str], Optional[int]]
    strip_exif_rating: Callable[[str], bool]
    get_orientation_flag: Callable[[str], Optional[int]]
    can_bake_losslessly: Callable[[str], bool]
    bake_orientation: Callable[[str], Tuple[bool, str, Optional[int]]]
    canonicalize_photo_file: Callable[..., Any]
    write_photo_date_metadata: Callable[[str, str], None]
    read_dimensions: Callable[[str], Tuple[Optional[int], Optional[int]]]
    lossless_rotation_extensions: frozenset[str]
    policy: NormalizationPolicy = REPAIR_POLICY


@dataclass(frozen=True)
class RepairLogEvent:
    action: str
    payload: Dict[str, Any] = field(default_factory=dict)


@dataclass
class RepairScanIdentity:
    file_type: str
    content_hash: str
    duplicate_key: str
    date_taken: str
    date_obj: datetime
    width: Optional[int]
    height: Optional[int]
    rating: Optional[int]
    metadata_cleaned: bool
    has_metadata_cleanup_signal: bool
    log_events: List[RepairLogEvent] = field(default_factory=list)


@dataclass(frozen=True)
class RepairDuplicateDecision:
    duplicate_key: str
    winner: Any
    losers: List[Any]

    @property
    def records(self) -> List[Any]:
        return [self.winner, *self.losers]


@dataclass
class RepairPhaseState:
    records: List[Any]
    canonicalize_index: int = 0
    deduped: List[Any] = field(default_factory=list)
    canonicalized: List[Any] = field(default_factory=list)


@dataclass
class RepairPhaseDependencies:
    phase_is_before: Callable[[str, str], bool]
    raise_if_cancelled: Callable[[], None]
    set_current_phase: Callable[[str], None]
    flush_checkpoint: Callable[..., None]
    emit_stats_feedback: Callable[[], None]
    set_metadata_fixed: Callable[[int], None]
    trash_duplicates: Callable[[List[Any]], List[Any]]
    move_to_canonical_locations: Callable[..., List[Any]]
    remove_empty_noncanonical_folders: Callable[[], None]
    rebuild_photos_table: Callable[[List[Any]], None]


@dataclass
class RepairFileResult:
    status: str
    record: Any
    source_rel_path: str
    target_rel_path: str
    target_full_path: str
    issue_paths: Dict[str, List[str]] = field(default_factory=dict)

    @property
    def moved(self) -> bool:
        return self.status == "moved"


def _issue_paths_for_record(record: Any, source_rel_path: str, target_rel_path: str) -> Dict[str, List[str]]:
    issue_paths: Dict[str, List[str]] = {}
    if source_rel_path != target_rel_path:
        issue_paths["misfiled_media"] = [source_rel_path]
    if getattr(record, "has_metadata_cleanup_signal", False):
        issue_paths.setdefault("metadata_cleanup", []).append(record.source_rel_path)
    return issue_paths


def plan_repair_duplicate_decisions(
    records: List[Any],
    *,
    sort_key: Callable[[Any], Any],
    path_exists: Callable[[str], bool] = os.path.exists,
) -> List[RepairDuplicateDecision]:
    """Group live records by duplicate key and pick deterministic winners."""
    grouped: Dict[str, List[Any]] = {}
    for record in records:
        if path_exists(record.full_path):
            grouped.setdefault(record.duplicate_key, []).append(record)

    decisions: List[RepairDuplicateDecision] = []
    for duplicate_key, group in grouped.items():
        ordered = sorted(group, key=sort_key)
        decisions.append(
            RepairDuplicateDecision(
                duplicate_key=duplicate_key,
                winner=ordered[0],
                losers=ordered[1:],
            )
        )
    return decisions


def iter_repair_events(
    state: RepairPhaseState,
    *,
    resume_phase: str,
    deps: RepairPhaseDependencies,
) -> Iterator[Dict[str, Any]]:
    """
    Run Clean's post-scan repair phases while yielding the existing phase events.

    Filesystem mutations, checkpoints, and progress callbacks remain delegated to
    the v2 engine through ``deps`` so resume artifacts and SSE progress stay stable.
    """
    records = state.records

    if deps.phase_is_before(resume_phase, "dedupe_complete"):
        deps.raise_if_cancelled()
        deps.set_current_phase("dedupe")
        deps.flush_checkpoint(records=records)
        yield {"type": "phase", "phase": "dedupe", "status": "starting"}
        deduped = deps.trash_duplicates(records)
        records = deduped
        state.records = records
        state.deduped = deduped
        deps.set_current_phase("dedupe_complete")
        deps.flush_checkpoint(records=records)
        yield {
            "type": "phase",
            "phase": "dedupe",
            "status": "complete",
            "remaining": len(deduped),
        }
        deps.emit_stats_feedback()
        deps.raise_if_cancelled()
    else:
        deduped = records
        state.deduped = deduped

    if deps.phase_is_before(resume_phase, "canonicalize_complete"):
        deps.raise_if_cancelled()
        deps.set_current_phase("canonicalize")
        deps.flush_checkpoint(records=deduped)
        yield {
            "type": "phase",
            "phase": "canonicalize",
            "status": "starting",
            "total": len(deduped),
            "resumed_index": state.canonicalize_index,
        }
        canonicalized = deps.move_to_canonical_locations(
            deduped,
            start_index=state.canonicalize_index,
        )
        records = canonicalized
        state.records = records
        state.canonicalized = canonicalized
        deps.set_current_phase("canonicalize_complete")
        deps.flush_checkpoint(records=records)
        yield {"type": "phase", "phase": "canonicalize", "status": "complete"}
        deps.emit_stats_feedback()
        deps.raise_if_cancelled()
    else:
        canonicalized = records
        state.canonicalized = canonicalized

    if deps.phase_is_before(resume_phase, "folders_complete"):
        deps.raise_if_cancelled()
        deps.set_metadata_fixed(
            sum(1 for record in canonicalized if record.metadata_cleaned)
        )
        deps.set_current_phase("folders")
        deps.flush_checkpoint(records=canonicalized)
        yield {"type": "phase", "phase": "folders", "status": "starting"}
        deps.remove_empty_noncanonical_folders()
        deps.set_current_phase("folders_complete")
        deps.flush_checkpoint(records=canonicalized)
        yield {"type": "phase", "phase": "folders", "status": "complete"}
        deps.emit_stats_feedback()
        deps.raise_if_cancelled()

    if deps.phase_is_before(resume_phase, "rebuild_db_complete"):
        deps.raise_if_cancelled()
        deps.set_current_phase("rebuild_db")
        deps.flush_checkpoint(records=canonicalized)
        yield {
            "type": "phase",
            "phase": "rebuild_db",
            "status": "starting",
            "total": len(canonicalized),
        }
        deps.rebuild_photos_table(canonicalized)
        deps.set_current_phase("rebuild_db_complete")
        deps.flush_checkpoint(records=canonicalized)
        yield {"type": "phase", "phase": "rebuild_db", "status": "complete"}
        deps.emit_stats_feedback()
        deps.raise_if_cancelled()


def normalize_repair_scan_identity(
    full_path: str,
    *,
    ext: str,
    stat_result: os.stat_result,
    deps: RepairScanDependencies,
) -> Optional[RepairScanIdentity]:
    """
    Normalize one validated in-library media file and return its canonical identity.

    The caller remains responsible for validation/trash behavior and for converting
    this identity into its orchestration-specific record type.
    """
    file_type = media_kind_for_extension(ext) or "photo"
    log_events: List[RepairLogEvent] = []

    if file_type == "photo":
        original_orientation = deps.get_orientation_flag(full_path)
        original_rating = deps.extract_exif_rating(full_path)
        has_metadata_cleanup_signal = (
            original_orientation not in (None, 1)
            and deps.can_bake_losslessly(full_path)
        ) or original_rating == 0

        canonical_photo = deps.canonicalize_photo_file(
            full_path,
            extract_exif_date=deps.extract_exif_date,
            bake_orientation=deps.bake_orientation,
            get_dimensions=lambda path: deps.read_dimensions(path),
            compute_hash=lambda path: deps.hash_cache.get_hash(path)[0],
            write_photo_exif=deps.write_photo_date_metadata,
            extract_exif_rating=deps.extract_exif_rating,
            strip_exif_rating=deps.strip_exif_rating,
        )

        if canonical_photo.orientation_baked:
            log_events.append(
                RepairLogEvent("orientation_baked", {"message": "canonicalized"})
            )
        else:
            orientation = deps.get_orientation_flag(full_path)
            if orientation not in (None, 1) and ext in deps.lossless_rotation_extensions:
                log_events.append(
                    RepairLogEvent("orientation_kept", {"message": str(orientation)})
                )

        if canonical_photo.rating_stripped:
            log_events.append(RepairLogEvent("rating_stripped"))

        if canonical_photo.metadata_changed and not (
            canonical_photo.orientation_baked or canonical_photo.rating_stripped
        ):
            log_events.append(
                RepairLogEvent(
                    "date_metadata_canonicalized",
                    {"date": canonical_photo.date_taken},
                )
            )

        duplicate_key = duplicate_key_for_file(
            full_path,
            fallback_hash=canonical_photo.content_hash,
        )
        if not duplicate_key:
            return None

        return RepairScanIdentity(
            file_type=file_type,
            content_hash=canonical_photo.content_hash,
            duplicate_key=duplicate_key,
            date_taken=canonical_photo.date_taken,
            date_obj=canonical_photo.date_obj,
            width=canonical_photo.width,
            height=canonical_photo.height,
            rating=canonical_photo.rating,
            metadata_cleaned=canonical_photo.metadata_changed,
            has_metadata_cleanup_signal=has_metadata_cleanup_signal,
            log_events=log_events,
        )

    orientation = deps.get_orientation_flag(full_path)
    has_metadata_cleanup_signal = (
        orientation not in (None, 1)
        and ext in deps.lossless_rotation_extensions
    )
    metadata_cleaned = False
    if orientation not in (None, 1) and ext in deps.lossless_rotation_extensions:
        baked, message, baked_orientation = deps.bake_orientation(full_path)
        if baked:
            metadata_cleaned = True
            log_events.append(RepairLogEvent("orientation_baked", {"message": message}))
        elif baked_orientation is not None:
            log_events.append(RepairLogEvent("orientation_kept", {"message": message}))

    rating = deps.extract_exif_rating(full_path)
    if rating == 0:
        has_metadata_cleanup_signal = True
        if not deps.strip_exif_rating(full_path):
            raise RepairFileError(f"Failed to strip rating=0 from {full_path}")
        metadata_cleaned = True
        log_events.append(RepairLogEvent("rating_stripped"))

    content_hash, _cache_hit = deps.hash_cache.get_hash(full_path)
    if not content_hash:
        return None
    duplicate_key = duplicate_key_for_file(full_path, fallback_hash=content_hash)
    if not duplicate_key:
        return None

    date_taken, date_obj = parse_metadata_datetime(
        deps.extract_exif_date(full_path),
        stat_result.st_mtime,
    )
    width, height = deps.read_dimensions(full_path)
    rating = deps.extract_exif_rating(full_path)

    return RepairScanIdentity(
        file_type=file_type,
        content_hash=content_hash,
        duplicate_key=duplicate_key,
        date_taken=date_taken,
        date_obj=date_obj,
        width=width,
        height=height,
        rating=rating,
        metadata_cleaned=metadata_cleaned,
        has_metadata_cleanup_signal=has_metadata_cleanup_signal,
        log_events=log_events,
    )


def normalize_repair_file(record: Any, deps: RepairDependencies) -> RepairFileResult:
    """
    Move one already-normalized Clean record into its canonical library path.

    Duplicate winner/loser selection intentionally stays outside this primitive:
    Clean's dedupe phase needs the whole duplicate group to preserve "oldest wins".
    """
    target_rel_path = deps.canonical_rel_path(
        record.date_taken,
        record.content_hash,
        record.ext,
    )
    target_full_path = os.path.join(deps.library_path, target_rel_path)
    source_rel_path = record.rel_path

    if not deps.path_exists(record.full_path):
        if deps.path_exists(target_full_path):
            record.full_path = target_full_path
            record.rel_path = target_rel_path
            return RepairFileResult(
                status="already_moved",
                record=record,
                source_rel_path=source_rel_path,
                target_rel_path=target_rel_path,
                target_full_path=target_full_path,
                issue_paths=_issue_paths_for_record(record, source_rel_path, target_rel_path),
            )
        raise RepairFileError(
            f"Missing media file during canonicalize resume: {record.source_rel_path}"
        )

    if os.path.abspath(record.full_path) == os.path.abspath(target_full_path):
        return RepairFileResult(
            status="unchanged",
            record=record,
            source_rel_path=source_rel_path,
            target_rel_path=target_rel_path,
            target_full_path=target_full_path,
            issue_paths=_issue_paths_for_record(record, source_rel_path, target_rel_path),
        )

    deps.make_dirs(os.path.dirname(target_full_path), exist_ok=True)
    if deps.path_exists(target_full_path):
        raise RepairFileError(
            f"Refusing to overwrite existing file at canonical path {target_rel_path}"
        )

    deps.move_file(record.full_path, target_full_path)
    record.full_path = target_full_path
    record.rel_path = target_rel_path
    return RepairFileResult(
        status="moved",
        record=record,
        source_rel_path=source_rel_path,
        target_rel_path=target_rel_path,
        target_full_path=target_full_path,
        issue_paths=_issue_paths_for_record(record, source_rel_path, target_rel_path),
    )
