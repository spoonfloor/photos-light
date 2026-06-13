#!/usr/bin/env python3
"""
Manual script: test generate_thumbnail_for_file() ICC preservation.

Run directly: python3 test_actual_app_function.py
Not collected by unittest discover (no tests at import time).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import generate_thumbnail_for_file
from PIL import Image


def main():
    test_file = "/Users/erichenry/Desktop/--test-lib/2026/2026-01-26/img_20260126_60558d9.jpg"
    test_hash = "0ef3e73a91ac42bd022b93368a26e73b3a752cb49e25c36317766e29ff4df979"

    print("Original file:")
    with Image.open(test_file) as img:
        icc = img.info.get("icc_profile")
        print(f"  ICC Profile: {len(icc) if icc else 0} bytes")

    print("\nGenerating thumbnail using app.py function...")
    result = generate_thumbnail_for_file(test_file, test_hash, "image")
    print(f"Result: {result}")

    thumbnail_path = f"/Users/erichenry/Desktop/--test-lib/.thumbnails/0e/f3/{test_hash}.jpg"
    if os.path.exists(thumbnail_path):
        print(f"\nGenerated thumbnail at: {thumbnail_path}")
        with Image.open(thumbnail_path) as img:
            icc = img.info.get("icc_profile")
            print(f"  ICC Profile: {len(icc) if icc else 0} bytes")
            print(f"  Size: {img.size}")
            if icc:
                print("✅ SUCCESS: ICC profile preserved!")
            else:
                print("❌ FAILURE: ICC profile was stripped!")
    else:
        print("❌ Thumbnail was not created at expected path")


if __name__ == "__main__":
    main()
