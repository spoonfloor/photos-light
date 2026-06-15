# -*- mode: python ; coding: utf-8 -*-
"""Headless Python server bundle for the Electron shell."""

from __future__ import annotations

import os

PROJECT_ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))

HIDDEN_IMPORTS = [
    "runtime_paths",
    "app",
    "hash_cache",
    "db_health",
    "db_schema",
    "db_schema_v3",
    "file_operations",
    "library_cleanliness",
    "library_sync",
    "clean_library_inventory",
    "library_layout",
    "media_finalization",
    "library_filesystem",
    "normalization_convert",
    "normalization_ingest",
    "normalization_repair",
    "library_metadata_compliance",
    "normalization_core",
    "normalization_contract",
    "photo_canonicalization",
    "make_library_perfect",
    "make_library_clean_v2",
    "clean_library_media_utils",
    "clean_library_fast_audit",
    "picker_sort",
    "image_pixels",
    "rotation_utils",
    "media_dates",
    "quicktime_date_atoms",
    "migrate_db",
    "init_db",
]

a = Analysis(
    [os.path.join(PROJECT_ROOT, "launcher.py")],
    pathex=[PROJECT_ROOT],
    binaries=[],
    datas=[(os.path.join(PROJECT_ROOT, "static"), "static")],
    hiddenimports=HIDDEN_IMPORTS,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="photos-light-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="photos-light-server",
)
