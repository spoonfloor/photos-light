"""
Clean library — engine router.

Default: v2 (cheap inventory preflight, hash-only dupes).
Fallback: set PHOTOS_CLEAN_LIBRARY_ENGINE=legacy

Archived implementation: make_library_perfect_legacy.py
"""

from __future__ import annotations

import os

_ENGINE = os.environ.get("PHOTOS_CLEAN_LIBRARY_ENGINE", "v2").strip().lower()

if _ENGINE in ("legacy", "v1", "old"):
    from make_library_perfect_legacy import (  # noqa: F401
        CLEAN_LIBRARY_ENGINE_VERSION,
        CLEAN_LIBRARY_SIGNAL_KEYS,
        CleanLibraryError,
        DBNormalizationEngine,
        LibraryCleaner,
        MediaRecord,
        _compute_photo_audit_identity,
        _compute_photo_duplicate_key,
        make_library_perfect,
        run_db_normalization_engine,
        scan_library_cleanliness,
        summarize_clean_library_issues,
        summarize_clean_library_operations,
        verify_library_cleanliness,
        verify_media_file,
    )

    def find_resumable_clean_library_checkpoint(library_path):  # type: ignore[misc]
        return None

    def abandon_clean_library_checkpoint(checkpoint_path):  # type: ignore[misc]
        return None

    class CleanLibraryCancelled(Exception):
        """Stop requested; checkpoint preserved for resume."""
else:
    from make_library_clean_v2 import (  # noqa: F401
        CLEAN_LIBRARY_ENGINE_VERSION,
        CLEAN_LIBRARY_SIGNAL_KEYS,
        CleanLibraryCancelled,
        CleanLibraryError,
        DBNormalizationEngine,
        LibraryCleaner,
        MediaRecord,
        _compute_photo_audit_identity,
        _compute_photo_duplicate_key,
        abandon_clean_library_checkpoint,
        find_resumable_clean_library_checkpoint,
        make_library_perfect,
        run_db_normalization_engine,
        scan_library_cleanliness,
        summarize_clean_library_issues,
        summarize_clean_library_operations,
        verify_library_cleanliness,
        verify_media_file,
    )

__all__ = [
    "CLEAN_LIBRARY_ENGINE_VERSION",
    "CLEAN_LIBRARY_SIGNAL_KEYS",
    "CleanLibraryCancelled",
    "CleanLibraryError",
    "DBNormalizationEngine",
    "LibraryCleaner",
    "MediaRecord",
    "_compute_photo_audit_identity",
    "_compute_photo_duplicate_key",
    "abandon_clean_library_checkpoint",
    "find_resumable_clean_library_checkpoint",
    "make_library_perfect",
    "run_db_normalization_engine",
    "scan_library_cleanliness",
    "verify_library_cleanliness",
    "summarize_clean_library_issues",
    "summarize_clean_library_operations",
    "verify_media_file",
]
