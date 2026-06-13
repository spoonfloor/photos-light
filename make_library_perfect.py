"""
Clean library — public entry (v2 engine).

Re-exports make_library_clean_v2 with test-patch propagation into the engine
and fast-audit modules.
"""

from __future__ import annotations

import sys
import types

import clean_library_fast_audit as _audit_module
import clean_library_media_utils as _media_utils_module
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

_AUDIT_PATCH_SYMBOLS = frozenset(
    {
        "can_bake_losslessly",
        "extract_exif_rating",
        "get_orientation_flag",
        "verify_media_file",
    }
)


class _EngineRouterModule(types.ModuleType):
    def __setattr__(self, name, value):
        super().__setattr__(name, value)
        if name in _PATCHABLE_ENGINE_SYMBOLS:
            setattr(_engine_module, name, value)
        if name in _AUDIT_PATCH_SYMBOLS:
            setattr(_audit_module, name, value)
            setattr(_media_utils_module, name, value)


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
