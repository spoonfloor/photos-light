#!/usr/bin/env python3
"""
Manual script: thumbnail generation from baked orientation PNG.

Run directly: python3 test_thumbnail_from_baked.py
Not collected by unittest discover (no tests at import time).
"""

import os
import shutil

from PIL import Image, ImageOps

test_source = "/tmp/test_orientation_baking.png"
fixture_source = (
    "/Users/erichenry/Desktop/orientation-baking-test/3-png-with-orientation/"
    "landscape-1920x1080-orient6.png"
)


def simulate_thumbnail_generation(source_file, output_file):
    print(f"Generating thumbnail from: {os.path.basename(source_file)}")

    with Image.open(source_file) as img:
        print(f"  Original size: {img.size}")

        img = img.copy()
        img = ImageOps.exif_transpose(img)
        print(f"  After exif_transpose: {img.size}")

        icc_profile = img.info.get("icc_profile")

        if img.mode == "RGBA":
            img = img.convert("RGB")
        elif img.mode != "RGB":
            img = img.convert("RGB")

        print(f"  After RGB conversion: {img.size}")

        target_size = 400
        width, height = img.size
        if width < height:
            new_width = target_size
            new_height = int(height * (target_size / width))
        else:
            new_height = target_size
            new_width = int(width * (target_size / height))

        img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
        print(f"  After resize: {img.size}")

        left = (img.width - target_size) // 2
        top = (img.height - target_size) // 2
        img = img.crop((left, top, left + target_size, top + target_size))
        print(f"  After crop: {img.size}")

        save_kwargs = {"format": "JPEG", "quality": 85, "optimize": True}
        if icc_profile:
            save_kwargs["icc_profile"] = icc_profile
        img.save(output_file, **save_kwargs)

        print(f"  ✅ Saved to: {output_file}")


def main():
    print("=" * 80)
    print("STEP 1: Create a baked PNG")
    print("=" * 80)

    shutil.copy(fixture_source, test_source)

    with Image.open(test_source) as img:
        exif = img.getexif()
        orientation = exif.get(0x0112, 1)
        print(f"Original: {img.size}, orientation={orientation}")

        img_rotated = ImageOps.exif_transpose(img)
        print(f"Baked: {img_rotated.size}")

        icc = img.info.get("icc_profile")
        save_kwargs = {}
        if icc:
            save_kwargs["icc_profile"] = icc

        img_rotated.save(test_source, **save_kwargs)

    print("\n" + "=" * 80)
    print("STEP 2: Generate thumbnail from baked PNG")
    print("=" * 80)

    simulate_thumbnail_generation(test_source, "/tmp/test_thumbnail.jpg")

    print("\n" + "=" * 80)
    print("RESULT")
    print("=" * 80)
    print("Open /tmp/test_thumbnail.jpg in Finder/Preview.")
    print("If it displays correctly (portrait), then our code is fine.")
    print("If it displays sideways (landscape), then there's a bug in our thumbnail generation.")

    os.remove(test_source)


if __name__ == "__main__":
    main()
