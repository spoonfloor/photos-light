"""
Canonical library layout helpers.

This module centralizes how the app detects, creates, and validates library
database locations. New libraries store their SQLite database in the hidden
`.library/` folder, while legacy root-level databases remain discoverable so
maintenance flows can normalize them.
"""

from __future__ import annotations

import os
from typing import Optional, Set

from db_health import DBStatus, check_database_health

DB_FILENAME = "photo_library.db"
LIBRARY_METADATA_DIR = ".library"
ROOT_INFRASTRUCTURE_DIRS: Set[str] = {
    LIBRARY_METADATA_DIR,
    ".db_backups",
    ".logs",
    ".thumbnails",
    ".trash",
}
ALLOWED_LIBRARY_METADATA_FILES: Set[str] = {
    DB_FILENAME,
    f"{DB_FILENAME}-wal",
    f"{DB_FILENAME}-shm",
}


def canonical_db_dir(library_path: str) -> str:
    return os.path.join(os.path.abspath(library_path), LIBRARY_METADATA_DIR)


def canonical_db_path(library_path: str) -> str:
    return os.path.join(canonical_db_dir(library_path), DB_FILENAME)


def legacy_db_path(library_path: str) -> str:
    return os.path.join(os.path.abspath(library_path), DB_FILENAME)


def is_library_metadata_file(filename: str) -> bool:
    return filename in ALLOWED_LIBRARY_METADATA_FILES


def db_sidecar_paths(db_path: str) -> list[str]:
    return [f"{db_path}-wal", f"{db_path}-shm"]


def detect_existing_db_path(library_path: str) -> Optional[str]:
    canonical_path = canonical_db_path(library_path)
    if os.path.exists(canonical_path):
        return canonical_path

    legacy_path = legacy_db_path(library_path)
    if os.path.exists(legacy_path):
        return legacy_path

    return None


def resolve_db_path(library_path: str, requested_db_path: Optional[str] = None) -> str:
    if requested_db_path:
        requested_abs = os.path.abspath(requested_db_path)
        if requested_abs == canonical_db_path(library_path):
            return requested_abs

    existing_path = detect_existing_db_path(library_path)
    if existing_path:
        return existing_path

    return canonical_db_path(library_path)


def library_has_db(library_path: str) -> bool:
    return detect_existing_db_path(library_path) is not None


def db_is_valid(db_path: str) -> bool:
    report = check_database_health(db_path)
    return report.status not in {DBStatus.MISSING, DBStatus.CORRUPTED}
