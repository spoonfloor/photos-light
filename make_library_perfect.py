"""
Clean library — engine router.

Default: v2 (cheap inventory preflight, hash-only dupes).
Fallback: set PHOTOS_CLEAN_LIBRARY_ENGINE=legacy

Archived implementation: make_library_perfect_legacy.py
"""

from __future__ import annotations

import os
import sys
import types

import clean_library_fast_audit as _audit_module

_ENGINE = os.environ.get("PHOTOS_CLEAN_LIBRARY_ENGINE", "v2").strip().lower()

if _ENGINE in ("legacy", "v1", "old"):
    import make_library_perfect_legacy as _engine_module
    from make_library_perfect_legacy import (  # noqa: F401
        CLEAN_LIBRARY_ENGINE_VERSION,
        CLEAN_LIBRARY_SIGNAL_KEYS,
        CleanLibraryError,
        DBNormalizationEngine,
        LibraryCleaner,
        MediaRecord,
        _ReadOnlyHashCache,
        _compute_photo_audit_identity,
        _compute_photo_duplicate_key,
        bake_orientation,
        can_bake_losslessly,
        canonicalize_photo_file,
        extract_exif_date,
        extract_exif_rating,
        get_orientation_flag,
        make_library_perfect,
        read_dimensions,
        run_db_normalization_engine,
        scan_library_cleanliness,
        strip_exif_rating,
        summarize_clean_library_issues,
        summarize_clean_library_operations,
        verify_library_cleanliness,
        verify_media_file,
        write_photo_date_metadata,
    )

    def find_resumable_clean_library_checkpoint(library_path):  # type: ignore[misc]
        return None

    def abandon_clean_library_checkpoint(checkpoint_path):  # type: ignore[misc]
        return None

    class CleanLibraryCancelled(Exception):
        """Stop requested; checkpoint preserved for resume."""
else:
    import make_library_clean_v2 as _engine_module
    from make_library_clean_v2 import (  # noqa: F401
        CLEAN_LIBRARY_ENGINE_VERSION,
        CLEAN_LIBRARY_SIGNAL_KEYS,
        CleanLibraryCancelled,
        CleanLibraryError,
        DBNormalizationEngine,
        LibraryCleaner,
        MediaRecord,
        _ReadOnlyHashCache,
        _compute_photo_audit_identity,
        _compute_photo_duplicate_key,
        abandon_clean_library_checkpoint,
        bake_orientation,
        can_bake_losslessly,
        canonicalize_photo_file,
        extract_exif_date,
        extract_exif_rating,
        find_resumable_clean_library_checkpoint,
        get_orientation_flag,
        make_library_perfect,
        read_dimensions,
        run_db_normalization_engine,
        scan_library_cleanliness,
        strip_exif_rating,
        summarize_clean_library_issues,
        summarize_clean_library_operations,
        verify_library_cleanliness,
        verify_media_file,
        write_photo_date_metadata,
    )

_PATCHABLE_ENGINE_SYMBOLS = frozenset(
    {
        "_ReadOnlyHashCache",
        "bake_orientation",
        "can_bake_losslessly",
        "canonicalize_photo_file",
        "extract_exif_date",
        "extract_exif_rating",
        "get_orientation_flag",
        "read_dimensions",
        "strip_exif_rating",
        "verify_media_file",
        "write_photo_date_metadata",
    }
)


class _EngineRouterModule(types.ModuleType):
    def __setattr__(self, name, value):
        super().__setattr__(name, value)
        if name in _PATCHABLE_ENGINE_SYMBOLS:
            setattr(_engine_module, name, value)
        if name in {
            "can_bake_losslessly",
            "extract_exif_rating",
            "get_orientation_flag",
            "verify_media_file",
        }:
            setattr(_audit_module, name, value)


sys.modules[__name__].__class__ = _EngineRouterModule

__all__ = [
    "CLEAN_LIBRARY_ENGINE_VERSION",
    "CLEAN_LIBRARY_SIGNAL_KEYS",
    "CleanLibraryCancelled",
    "CleanLibraryError",
    "DBNormalizationEngine",
    "LibraryCleaner",
    "MediaRecord",
    "_ReadOnlyHashCache",
    "_compute_photo_audit_identity",
    "_compute_photo_duplicate_key",
    "abandon_clean_library_checkpoint",
    "bake_orientation",
    "can_bake_losslessly",
    "canonicalize_photo_file",
    "extract_exif_date",
    "extract_exif_rating",
    "find_resumable_clean_library_checkpoint",
    "get_orientation_flag",
    "make_library_perfect",
    "read_dimensions",
    "run_db_normalization_engine",
    "scan_library_cleanliness",
    "strip_exif_rating",
    "verify_library_cleanliness",
    "summarize_clean_library_issues",
    "summarize_clean_library_operations",
    "verify_media_file",
    "write_photo_date_metadata",
]
