# -*- mode: python ; coding: utf-8 -*-

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
    "normalization_core",
    "normalization_contract",
    "photo_canonicalization",
    "make_library_perfect",
    "make_library_clean_v2",
    "clean_library_media_utils",
    "clean_library_fast_audit",
    "picker_sort",
    "rotation_utils",
    "migrate_db",
    "operation_state",
    "db_rebuild",
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
    name="Photos Light",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=[os.path.join(PROJECT_ROOT, "packaging", "AppIcon.icns")],
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Photos Light",
)
app = BUNDLE(
    coll,
    name="Photos Light.app",
    icon=os.path.join(PROJECT_ROOT, "packaging", "AppIcon.icns"),
    bundle_identifier="com.erichenry.photoslight",
    version="1.0.0",
    info_plist={
        "CFBundleName": "Photos Light",
        "CFBundleDisplayName": "Photos Light",
        "CFBundleShortVersionString": "1.0.0",
        "CFBundleVersion": "1.0.0",
        "LSMinimumSystemVersion": "12.0",
        "NSHighResolutionCapable": True,
    },
)
