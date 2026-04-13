"""
Clean library operation.

This module powers More -> Clean library -> Start cleaning.

The operation treats the filesystem as the source of truth, repairs active
library contents outside infrastructure folders, reconciles the live photos
table to the repaired library, and then runs a read-only final audit.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import traceback
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

from PIL import Image

from db_schema import create_database_schema
from file_operations import extract_exif_date, extract_exif_rating, strip_exif_rating
from hash_cache import HashCache
from rotation_utils import (
    bake_orientation as shared_bake_orientation,
    can_bake_losslessly as shared_can_bake_losslessly,
    get_orientation_flag as shared_get_orientation_flag,
)
from library_layout import (
    LIBRARY_METADATA_DIR,
    ROOT_INFRASTRUCTURE_DIRS,
    canonical_db_path,
    db_is_valid,
    db_sidecar_paths,
    is_library_metadata_file,
    resolve_db_path,
)


PHOTO_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".heic",
    ".heif",
    ".png",
    ".gif",
    ".tiff",
    ".tif",
    ".webp",
    ".avif",
    ".jp2",
    ".raw",
    ".cr2",
    ".nef",
    ".arw",
    ".dng",
}
VIDEO_EXTENSIONS = {
    ".mov",
    ".mp4",
    ".m4v",
    ".mkv",
    ".wmv",
    ".webm",
    ".flv",
    ".3gp",
    ".mpg",
    ".mpeg",
    ".vob",
    ".ts",
    ".mts",
    ".avi",
}
SUPPORTED_MEDIA_EXTENSIONS = PHOTO_EXTENSIONS | VIDEO_EXTENSIONS
INFRASTRUCTURE_DIRS = set(ROOT_INFRASTRUCTURE_DIRS)
ALLOWED_ROOT_DIRS = INFRASTRUCTURE_DIRS
IGNORED_LIBRARY_FILES = {".DS_Store"}
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
LOSSLESS_ROTATION_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tiff", ".tif"}


@dataclass
class MediaRecord:
    original_filename: str
    full_path: str
    rel_path: str
    ext: str
    file_type: str
    content_hash: str
    date_taken: str
    date_obj: datetime
    width: Optional[int]
    height: Optional[int]
    rating: Optional[int]
    birth_time: float
    modified_time: float


class CleanLibraryError(RuntimeError):
    """Operation failed and the library may still be dirty."""


def parse_metadata_datetime(value: Optional[str], fallback_timestamp: float) -> Tuple[str, datetime]:
    """Normalize metadata dates to the app's canonical DB format."""
    if value:
        candidate = value.strip()
        for fmt in (
            "%Y:%m:%d %H:%M:%S",
            "%Y-%m-%d %H:%M:%S",
            "%Y:%m:%d %H:%M:%S%z",
            "%Y-%m-%dT%H:%M:%S",
        ):
            try:
                parsed = datetime.strptime(candidate, fmt)
                normalized = parsed.strftime("%Y:%m:%d %H:%M:%S")
                return normalized, datetime.strptime(normalized, "%Y:%m:%d %H:%M:%S")
            except ValueError:
                continue

    parsed = datetime.fromtimestamp(fallback_timestamp)
    normalized = parsed.strftime("%Y:%m:%d %H:%M:%S")
    return normalized, parsed


def get_birth_time(stat_result: os.stat_result) -> float:
    """Use birthtime when available, otherwise fall back to mtime."""
    return float(getattr(stat_result, "st_birthtime", stat_result.st_mtime))


def is_year_folder_name(name: str) -> bool:
    return len(name) == 4 and name.isdigit()


def is_day_folder_name(year: str, name: str) -> bool:
    if len(name) != 10 or name[:4] != year:
        return False
    if name[4] != "-" or name[7] != "-":
        return False
    try:
        datetime.strptime(name, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def canonical_relative_path(date_obj: datetime, content_hash: str, ext: str) -> str:
    year = date_obj.strftime("%Y")
    day = date_obj.strftime("%Y-%m-%d")
    filename = f"img_{date_obj.strftime('%Y%m%d')}_{content_hash}{ext.lower()}"
    return os.path.join(year, day, filename)


def path_parts(rel_path: str) -> List[str]:
    if rel_path in ("", "."):
        return []
    return rel_path.split(os.sep)


def root_entry_allowed(name: str, is_dir: bool) -> bool:
    if name in IGNORED_LIBRARY_FILES:
        return True
    if is_dir:
        return name in ALLOWED_ROOT_DIRS or is_year_folder_name(name)
    return False


def in_infrastructure(rel_path: str) -> bool:
    parts = path_parts(rel_path)
    return bool(parts) and parts[0] in INFRASTRUCTURE_DIRS


def exiftool_json(file_path: str, args: List[str]) -> Dict[str, Any]:
    result = subprocess.run(
        ["exiftool", "-j", *args, file_path],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "exiftool failed")
    payload = json.loads(result.stdout)
    return payload[0] if payload else {}


def get_orientation_flag(file_path: str) -> Optional[int]:
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in PHOTO_EXTENSIONS:
        return None
    return shared_get_orientation_flag(file_path)


def can_bake_losslessly(file_path: str) -> bool:
    return shared_can_bake_losslessly(file_path)


def bake_orientation(file_path: str) -> Tuple[bool, str, Optional[int]]:
    return shared_bake_orientation(file_path)


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


def read_dimensions(file_path: str) -> Tuple[Optional[int], Optional[int]]:
    ext = os.path.splitext(file_path)[1].lower()
    try:
        if ext in VIDEO_EXTENSIONS:
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "quiet",
                    "-print_format",
                    "json",
                    "-show_streams",
                    file_path,
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode != 0:
                return None, None
            payload = json.loads(result.stdout)
            for stream in payload.get("streams", []):
                if stream.get("codec_type") == "video":
                    return stream.get("width"), stream.get("height")
            return None, None

        payload = exiftool_json(file_path, ["-ImageWidth", "-ImageHeight"])
        return payload.get("ImageWidth"), payload.get("ImageHeight")
    except Exception:
        return None, None


def format_issue(kind: str, path: str, detail: str = "") -> Dict[str, str]:
    return {"kind": kind, "path": path, "detail": detail}


class LibraryCleaner:
    def __init__(self, library_path: str, db_path: Optional[str] = None):
        self.library_path = os.path.abspath(library_path)
        self.db_path = resolve_db_path(self.library_path, db_path)
        self.db_conn: Optional[sqlite3.Connection] = None
        self.hash_cache: Optional[HashCache] = None
        self.manifest = None
        self.stats = {
            "moved_to_trash": 0,
            "duplicates_trashed": 0,
            "metadata_fixed": 0,
            "media_moved": 0,
            "folders_removed": 0,
            "db_rows_rebuilt": 0,
        }

    def log(self, action: str, **payload: Any) -> None:
        if not self.manifest:
            return
        self.manifest.write(
            json.dumps(
                {
                    "timestamp": datetime.now().isoformat(),
                    "action": action,
                    **payload,
                }
            )
            + "\n"
        )
        self.manifest.flush()

    def run(self) -> Dict[str, Any]:
        try:
            self.setup()
            records = self.scan_and_normalize()
            deduped = self.trash_duplicates(records)
            canonicalized = self.move_to_canonical_locations(deduped)
            self.remove_empty_noncanonical_folders()
            self.rebuild_photos_table(canonicalized)
            issues = self.final_audit()
            if issues:
                preview = issues[:10]
                self.log("final_audit_failed", issue_count=len(issues), issues=preview)
                raise CleanLibraryError(
                    f"Final audit failed with {len(issues)} issue(s): "
                    + "; ".join(f"{item['kind']}:{item['path']}" for item in preview)
                )

            self.log("operation_complete", stats=self.stats)
            return {"status": "SUCCESS", "stats": self.stats}
        except Exception as exc:
            self.log(
                "operation_failed",
                error=str(exc),
                traceback=traceback.format_exc(),
                stats=self.stats,
            )
            raise
        finally:
            if self.hash_cache is not None:
                try:
                    self.hash_cache.cleanup_stale_entries(self.library_path)
                except Exception:
                    pass
            if self.manifest is not None:
                self.manifest.close()
            if self.db_conn is not None:
                self.db_conn.close()

    def setup(self) -> None:
        for folder in [LIBRARY_METADATA_DIR, ".db_backups", ".logs", ".thumbnails", ".trash"]:
            os.makedirs(os.path.join(self.library_path, folder), exist_ok=True)

        self.migrate_db_to_canonical_location()

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        if os.path.exists(self.db_path):
            backup_path = os.path.join(
                self.library_path,
                ".db_backups",
                f"photo_library_{timestamp}.db",
            )
            shutil.copy2(self.db_path, backup_path)

        manifest_path = os.path.join(
            self.library_path,
            ".logs",
            f"clean_library_{timestamp}.jsonl",
        )
        self.manifest = open(manifest_path, "a", encoding="utf-8")
        self.log("operation_started", library_path=self.library_path, db_path=self.db_path)

        self.db_conn = sqlite3.connect(self.db_path)
        self.db_conn.row_factory = sqlite3.Row
        self.db_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.db_conn.execute("PRAGMA journal_mode=DELETE")
        create_database_schema(self.db_conn.cursor())
        self.db_conn.commit()
        self.hash_cache = HashCache(self.db_conn)

    def migrate_db_to_canonical_location(self) -> None:
        target_db_path = canonical_db_path(self.library_path)
        if os.path.abspath(self.db_path) == os.path.abspath(target_db_path):
            self.db_path = target_db_path
            return

        if not os.path.exists(self.db_path):
            self.db_path = target_db_path
            return

        os.makedirs(os.path.dirname(target_db_path), exist_ok=True)
        if os.path.exists(target_db_path):
            raise CleanLibraryError(
                f"Refusing to migrate legacy database because canonical path already exists: {target_db_path}"
            )

        shutil.move(self.db_path, target_db_path)
        for source_sidecar in db_sidecar_paths(self.db_path):
            if not os.path.exists(source_sidecar):
                continue
            sidecar_name = os.path.basename(source_sidecar)
            target_sidecar = os.path.join(os.path.dirname(target_db_path), sidecar_name)
            if os.path.exists(target_sidecar):
                raise CleanLibraryError(
                    f"Refusing to overwrite canonical DB sidecar during migration: {target_sidecar}"
                )
            shutil.move(source_sidecar, target_sidecar)

        self.log(
            "db_migrated_to_hidden_folder",
            source=os.path.relpath(self.db_path, self.library_path),
            destination=os.path.relpath(target_db_path, self.library_path),
        )
        self.db_path = target_db_path

    def active_walk(self) -> Iterable[Tuple[str, List[str], List[str]]]:
        for root, dirs, files in os.walk(self.library_path, topdown=True):
            rel_root = os.path.relpath(root, self.library_path)
            if rel_root != "." and in_infrastructure(rel_root):
                dirs[:] = []
                continue
            yield root, dirs, files

    def move_to_trash(self, file_path: str, category: str) -> str:
        rel_path = os.path.relpath(file_path, self.library_path)
        target = os.path.join(self.library_path, ".trash", category, rel_path)
        os.makedirs(os.path.dirname(target), exist_ok=True)

        candidate = target
        counter = 1
        base, ext = os.path.splitext(target)
        while os.path.exists(candidate):
            candidate = f"{base}_{counter}{ext}"
            counter += 1

        shutil.move(file_path, candidate)
        self.stats["moved_to_trash"] += 1
        self.log("moved_to_trash", source=rel_path, destination=os.path.relpath(candidate, self.library_path), category=category)
        return candidate

    def normalize_media_file(self, full_path: str) -> Optional[MediaRecord]:
        rel_path = os.path.relpath(full_path, self.library_path)
        ext = os.path.splitext(full_path)[1].lower()
        original_filename = os.path.basename(full_path)

        if ext not in SUPPORTED_MEDIA_EXTENSIONS:
            self.move_to_trash(full_path, "non_media")
            return None

        valid, _ = verify_media_file(full_path)
        if not valid:
            self.move_to_trash(full_path, "corrupted")
            return None

        orientation = get_orientation_flag(full_path)
        if orientation not in (None, 1) and ext in LOSSLESS_ROTATION_EXTENSIONS:
            baked, message, baked_orientation = bake_orientation(full_path)
            if baked:
                self.stats["metadata_fixed"] += 1
                self.log("orientation_baked", file=rel_path, message=message)
            elif baked_orientation is not None:
                self.log("orientation_kept", file=rel_path, message=message)

        rating = extract_exif_rating(full_path)
        if rating == 0:
            if not strip_exif_rating(full_path):
                raise CleanLibraryError(f"Failed to strip rating=0 from {rel_path}")
            self.stats["metadata_fixed"] += 1
            self.log("rating_stripped", file=rel_path)

        valid, _ = verify_media_file(full_path)
        if not valid:
            self.move_to_trash(full_path, "corrupted")
            return None

        assert self.hash_cache is not None
        content_hash, _ = self.hash_cache.get_hash(full_path)
        if not content_hash:
            self.move_to_trash(full_path, "corrupted")
            return None

        stat_result = os.stat(full_path)
        date_taken, date_obj = parse_metadata_datetime(
            extract_exif_date(full_path),
            stat_result.st_mtime,
        )
        width, height = read_dimensions(full_path)
        rating = extract_exif_rating(full_path)

        return MediaRecord(
            original_filename=original_filename,
            full_path=full_path,
            rel_path=rel_path,
            ext=ext,
            file_type="video" if ext in VIDEO_EXTENSIONS else "photo",
            content_hash=content_hash,
            date_taken=date_taken,
            date_obj=date_obj,
            width=width,
            height=height,
            rating=rating if rating != 0 else None,
            birth_time=get_birth_time(stat_result),
            modified_time=float(stat_result.st_mtime),
        )

    def scan_and_normalize(self) -> List[MediaRecord]:
        records: List[MediaRecord] = []

        for root, _, files in self.active_walk():
            rel_root = os.path.relpath(root, self.library_path)
            for filename in files:
                if filename in IGNORED_LIBRARY_FILES:
                    continue
                full_path = os.path.join(root, filename)
                record = self.normalize_media_file(full_path)
                if record is not None:
                    records.append(record)

        self.log("scan_complete", media_count=len(records))
        return records

    def duplicate_sort_key(self, record: MediaRecord) -> Tuple[datetime, float, float, str]:
        return (record.date_obj, record.birth_time, record.modified_time, record.rel_path.lower())

    def trash_duplicates(self, records: List[MediaRecord]) -> List[MediaRecord]:
        grouped: Dict[str, List[MediaRecord]] = {}
        for record in records:
            grouped.setdefault(record.content_hash, []).append(record)

        survivors: List[MediaRecord] = []
        for content_hash, group in grouped.items():
            ordered = sorted(group, key=self.duplicate_sort_key)
            winner = ordered[0]
            survivors.append(winner)

            for loser in ordered[1:]:
                self.move_to_trash(loser.full_path, "duplicates")
                self.stats["duplicates_trashed"] += 1
                self.log(
                    "duplicate_trashed",
                    winner=winner.rel_path,
                    loser=loser.rel_path,
                    content_hash=content_hash,
                )

        return survivors

    def move_to_canonical_locations(self, records: List[MediaRecord]) -> List[MediaRecord]:
        occupied: set[str] = set()
        canonicalized: List[MediaRecord] = []

        for record in sorted(records, key=lambda item: (item.date_taken, item.content_hash, item.rel_path.lower())):
            target_rel = canonical_relative_path(record.date_obj, record.content_hash, record.ext)
            if target_rel in occupied:
                raise CleanLibraryError(f"Canonical path collision for {target_rel}")

            target_full = os.path.join(self.library_path, target_rel)
            if os.path.abspath(record.full_path) != os.path.abspath(target_full):
                os.makedirs(os.path.dirname(target_full), exist_ok=True)
                if os.path.exists(target_full):
                    raise CleanLibraryError(
                        f"Refusing to overwrite existing file at canonical path {target_rel}"
                    )
                shutil.move(record.full_path, target_full)
                self.stats["media_moved"] += 1
                self.log("media_moved", source=record.rel_path, destination=target_rel)
                record.full_path = target_full
                record.rel_path = target_rel

            occupied.add(target_rel)
            canonicalized.append(record)

        return canonicalized

    def remove_empty_noncanonical_folders(self) -> None:
        for root, _, _ in os.walk(self.library_path, topdown=False):
            rel_root = os.path.relpath(root, self.library_path)
            if rel_root == ".":
                continue
            if in_infrastructure(rel_root):
                continue
            if os.path.isdir(root) and not os.listdir(root):
                os.rmdir(root)
                self.stats["folders_removed"] += 1
                self.log("folder_removed", path=rel_root)

    def rebuild_photos_table(self, records: List[MediaRecord]) -> None:
        assert self.db_conn is not None
        cursor = self.db_conn.cursor()
        cursor.execute("DELETE FROM photos")

        for record in sorted(records, key=lambda item: (item.date_taken, item.rel_path.lower())):
            file_size = os.path.getsize(record.full_path)
            cursor.execute(
                """
                INSERT INTO photos (
                    original_filename,
                    current_path,
                    date_taken,
                    content_hash,
                    file_size,
                    file_type,
                    width,
                    height,
                    rating
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.original_filename,
                    record.rel_path,
                    record.date_taken,
                    record.content_hash,
                    file_size,
                    record.file_type,
                    record.width,
                    record.height,
                    record.rating,
                ),
            )

        self.db_conn.commit()
        self.stats["db_rows_rebuilt"] = len(records)
        self.log("photos_table_rebuilt", row_count=len(records))

    def audit_library_metadata_dir(self) -> List[Dict[str, str]]:
        issues: List[Dict[str, str]] = []
        metadata_dir = os.path.join(self.library_path, LIBRARY_METADATA_DIR)

        if not os.path.isdir(metadata_dir):
            issues.append(format_issue("missing_library_metadata_dir", LIBRARY_METADATA_DIR))
            return issues

        canonical_path = canonical_db_path(self.library_path)
        if not os.path.exists(canonical_path):
            issues.append(format_issue("missing_library_db", os.path.relpath(canonical_path, self.library_path)))
        elif not db_is_valid(canonical_path):
            issues.append(format_issue("invalid_library_db", os.path.relpath(canonical_path, self.library_path)))

        for item in os.listdir(metadata_dir):
            if item in IGNORED_LIBRARY_FILES:
                continue
            item_path = os.path.join(metadata_dir, item)
            rel_path = os.path.relpath(item_path, self.library_path)
            if os.path.isdir(item_path):
                issues.append(format_issue("unexpected_library_metadata_dir", rel_path))
                continue
            if not is_library_metadata_file(item):
                issues.append(format_issue("unexpected_library_metadata_file", rel_path))

        return issues

    def final_audit(self) -> List[Dict[str, str]]:
        issues: List[Dict[str, str]] = []
        active_paths: set[str] = set()
        active_hashes: Dict[str, str] = {}

        for item in os.listdir(self.library_path):
            if item in IGNORED_LIBRARY_FILES:
                continue
            full_path = os.path.join(self.library_path, item)
            if not root_entry_allowed(item, os.path.isdir(full_path)):
                issue_kind = "noncanonical_root_folder" if os.path.isdir(full_path) else "noncanonical_root_file"
                issues.append(format_issue(issue_kind, item))

        issues.extend(self.audit_library_metadata_dir())

        for root, dirs, files in self.active_walk():
            rel_root = os.path.relpath(root, self.library_path)
            parts = path_parts(rel_root)

            if rel_root != ".":
                if len(parts) == 1:
                    if not is_year_folder_name(parts[0]):
                        issues.append(format_issue("noncanonical_folder", rel_root))
                elif len(parts) == 2:
                    if not (is_year_folder_name(parts[0]) and is_day_folder_name(parts[0], parts[1])):
                        issues.append(format_issue("noncanonical_folder", rel_root))
                else:
                    issues.append(format_issue("noncanonical_folder", rel_root))

                if not os.listdir(root):
                    issues.append(format_issue("empty_folder", rel_root))

            for dirname in dirs:
                dir_rel = os.path.relpath(os.path.join(root, dirname), self.library_path)
                dir_parts = path_parts(dir_rel)
                if dir_parts and dir_parts[0] in INFRASTRUCTURE_DIRS:
                    continue
                if len(dir_parts) > 2:
                    issues.append(format_issue("noncanonical_folder", dir_rel))

            for filename in files:
                if filename in IGNORED_LIBRARY_FILES:
                    continue
                full_path = os.path.join(root, filename)
                rel_path = os.path.relpath(full_path, self.library_path)

                ext = os.path.splitext(filename)[1].lower()
                if ext not in SUPPORTED_MEDIA_EXTENSIONS:
                    issues.append(format_issue("unsupported_or_nonmedia", rel_path))
                    continue

                valid, _ = verify_media_file(full_path)
                if not valid:
                    issues.append(format_issue("corrupted_media", rel_path))
                    continue

                assert self.hash_cache is not None
                content_hash, _ = self.hash_cache.get_hash(full_path)
                if not content_hash:
                    issues.append(format_issue("corrupted_media", rel_path))
                    continue

                if content_hash in active_hashes:
                    issues.append(
                        format_issue(
                            "duplicate_media",
                            rel_path,
                            f"same hash as {active_hashes[content_hash]}",
                        )
                    )
                else:
                    active_hashes[content_hash] = rel_path

                stat_result = os.stat(full_path)
                date_taken, date_obj = parse_metadata_datetime(
                    extract_exif_date(full_path),
                    stat_result.st_mtime,
                )
                expected_rel = canonical_relative_path(date_obj, content_hash, ext)
                if rel_path != expected_rel:
                    issues.append(
                        format_issue(
                            "misnamed_or_misfiled",
                            rel_path,
                            f"expected {expected_rel}",
                        )
                    )

                orientation = get_orientation_flag(full_path)
                if orientation not in (None, 1) and can_bake_losslessly(full_path):
                    issues.append(format_issue("unbaked_rotation", rel_path, str(orientation)))

                rating = extract_exif_rating(full_path)
                if rating == 0:
                    issues.append(format_issue("rating_zero", rel_path))

                active_paths.add(rel_path)
                _ = date_taken  # Keep the date normalization in the audit path explicit.

        assert self.db_conn is not None
        cursor = self.db_conn.cursor()
        cursor.execute("SELECT current_path, content_hash FROM photos")
        db_rows = cursor.fetchall()
        db_paths = {row["current_path"] for row in db_rows}

        for ghost_path in sorted(db_paths - active_paths):
            issues.append(format_issue("ghost_db_reference", ghost_path))
        for mole_path in sorted(active_paths - db_paths):
            issues.append(format_issue("mole_missing_from_db", mole_path))

        for row in db_rows:
            disk_hash = None
            if row["current_path"] in active_hashes.values():
                for content_hash, rel_path in active_hashes.items():
                    if rel_path == row["current_path"]:
                        disk_hash = content_hash
                        break
            if disk_hash is not None and row["content_hash"] != disk_hash:
                issues.append(
                    format_issue(
                        "db_hash_mismatch",
                        row["current_path"],
                        f"db={row['content_hash']} disk={disk_hash}",
                    )
                )

        return issues


class DBNormalizationEngine(LibraryCleaner):
    """Authoritative DB normalization engine for library cleanup and repair."""


def run_db_normalization_engine(library_path: str, db_path: Optional[str] = None) -> Dict[str, Any]:
    engine = DBNormalizationEngine(library_path, db_path=db_path)
    return engine.run()


def make_library_perfect(library_path: str, db_path: Optional[str] = None) -> Dict[str, Any]:
    """Backward-compatible wrapper for the DB normalization engine."""
    return run_db_normalization_engine(library_path, db_path=db_path)
