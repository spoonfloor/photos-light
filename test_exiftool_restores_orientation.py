#!/usr/bin/env python3
"""
Test if exiftool restores orientation when writing dates
"""

from PIL import Image, ImageOps
import os
import subprocess
import shutil

test_source = "/Users/erichenry/Desktop/orientation-baking-test/3-png-with-orientation/landscape-1920x1080-orient6.png"
test_copy = "/tmp/test_exiftool_orientation.png"

print("="*80)
print("Testing if exiftool restores orientation when writing dates")
print("="*80)

# Step 1: Create a baked PNG
shutil.copy(test_source, test_copy)

print("\n1. ORIGINAL:")
result = subprocess.run(['exiftool', '-Orientation', '-n', '-s3', test_copy],
                       capture_output=True, text=True)
print(f"   Orientation: {result.stdout.strip()}")

# Step 2: Bake orientation
print("\n2. BAKING:")
with Image.open(test_copy) as img:
    img_rotated = ImageOps.exif_transpose(img)
    icc = img.info.get('icc_profile')
    save_kwargs = {}
    if icc:
        save_kwargs['icc_profile'] = icc
    img_rotated.save(test_copy, **save_kwargs)

result = subprocess.run(['exiftool', '-Orientation', '-n', '-s3', test_copy],
                       capture_output=True, text=True)
print(f"   Orientation after baking: '{result.stdout.strip()}'")

# Step 3: Write EXIF date (simulating what terraform does)
print("\n3. WRITING EXIF DATE:")
cmd = [
    'exiftool',
    '-DateTimeOriginal=2026:01:27 12:00:00',
    '-CreateDate=2026:01:27 12:00:00',
    '-ModifyDate=2026:01:27 12:00:00',
    '-overwrite_original',
    '-P',
    test_copy
]
result = subprocess.run(cmd, capture_output=True, text=True)
print(f"   exiftool exit code: {result.returncode}")

# Step 4: Check orientation after exiftool
print("\n4. AFTER WRITING EXIF DATE:")
result = subprocess.run(['exiftool', '-Orientation', '-n', '-s3', test_copy],
                       capture_output=True, text=True)
orientation_after = result.stdout.strip()
print(f"   Orientation: '{orientation_after}'")

print("\n" + "="*80)
print("ANALYSIS:")
print("="*80)

if orientation_after:
    print("❌ BUG FOUND: exiftool RESTORED the orientation tag!")
    print("   Solution: Remove orientation tag AFTER writing EXIF dates.")
else:
    print("✅ Orientation tag remains removed")
    print("   Bug is NOT caused by exiftool restoring orientation.")

# Cleanup
os.remove(test_copy)
