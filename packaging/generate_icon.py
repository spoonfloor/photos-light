#!/usr/bin/env python3
"""Build AppIcon.icns for the Photos Light bundle."""

from __future__ import annotations

import os
import shutil
import subprocess

from PIL import Image

SCRIPT_DIR = os.path.dirname(__file__)
SOURCE_PATH = os.path.join(SCRIPT_DIR, "AppIcon.source.png")
ICONSET_DIR = os.path.join(SCRIPT_DIR, "PhotosLight.iconset")
ICNS_PATH = os.path.join(SCRIPT_DIR, "AppIcon.icns")

ICONSET_FILES = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}


def _resize_source(size: int) -> Image.Image:
    with Image.open(SOURCE_PATH) as source:
        rgba = source.convert("RGBA")
        return rgba.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    if not os.path.exists(SOURCE_PATH):
        raise SystemExit(f"Missing source icon: {SOURCE_PATH}")

    if os.path.isdir(ICONSET_DIR):
        shutil.rmtree(ICONSET_DIR)
    os.makedirs(ICONSET_DIR, exist_ok=True)

    for filename, size in ICONSET_FILES.items():
        _resize_source(size).save(os.path.join(ICONSET_DIR, filename))

    subprocess.run(
        ["iconutil", "-c", "icns", ICONSET_DIR, "-o", ICNS_PATH],
        check=True,
    )
    shutil.rmtree(ICONSET_DIR)
    print(f"Created {ICNS_PATH}")


if __name__ == "__main__":
    main()
