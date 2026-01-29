#!/usr/bin/env python3
"""
Deep dive: Does PIL's ImageOps.exif_transpose() actually remove the orientation tag?
Or does it just rotate pixels while LEAVING the tag in place?
"""

from PIL import Image, ImageOps
import os
import subprocess
import shutil

# Create a test PNG with orientation
test_source = "/Users/erichenry/Desktop/orientation-baking-test/3-png-with-orientation/landscape-1920x1080-orient6.png"
test_copy = "/tmp/test_orientation_baking.png"

print("="*80)
print("Testing PIL PNG Orientation Baking Behavior")
print("="*80)

# Copy original
shutil.copy(test_source, test_copy)

print(f"\n1. ORIGINAL FILE:")
print(f"   Path: {test_copy}")

# Check with exiftool
result = subprocess.run(['exiftool', '-Orientation', '-n', '-s3', test_copy],
                       capture_output=True, text=True)
print(f"   EXIF Orientation: {result.stdout.strip()}")

# Check with sips
result = subprocess.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', test_copy],
                       capture_output=True, text=True)
print(f"   Dimensions: {result.stdout.strip()}")

# Open with PIL
with Image.open(test_copy) as img:
    print(f"   PIL size: {img.size}")
    exif = img.getexif()
    pil_orient = exif.get(0x0112, None)
    print(f"   PIL EXIF 0x0112: {pil_orient}")

print(f"\n2. APPLYING ImageOps.exif_transpose() AND SAVING:")

# Simulate the baking process from app.py
with Image.open(test_copy) as img:
    exif = img.getexif()
    orientation = exif.get(0x0112, 1)
    print(f"   Detected orientation: {orientation}")
    
    # Apply rotation
    img_rotated = ImageOps.exif_transpose(img)
    print(f"   Rotated size: {img_rotated.size} (was {img.size})")
    
    # Preserve ICC profile
    icc = img.info.get('icc_profile')
    
    # Save (lossless for PNG)
    save_kwargs = {}
    if icc:
        save_kwargs['icc_profile'] = icc
    
    img_rotated.save(test_copy, **save_kwargs)
    print(f"   Saved back to file")

print(f"\n3. AFTER BAKING:")

# Check with exiftool again
result = subprocess.run(['exiftool', '-Orientation', '-n', '-s3', test_copy],
                       capture_output=True, text=True)
exif_after = result.stdout.strip()
print(f"   EXIF Orientation: '{exif_after}' (empty = removed)")

# Check dimensions
result = subprocess.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', test_copy],
                       capture_output=True, text=True)
print(f"   Dimensions: {result.stdout.strip()}")

# Check with PIL
with Image.open(test_copy) as img:
    print(f"   PIL size: {img.size}")
    exif = img.getexif()
    pil_orient = exif.get(0x0112, None)
    print(f"   PIL EXIF 0x0112: {pil_orient}")

print(f"\n4. CALLING exif_transpose() AGAIN (simulating thumbnail generation):")

# This simulates what happens in thumbnail generation
with Image.open(test_copy) as img:
    print(f"   Before: {img.size}")
    img_again = ImageOps.exif_transpose(img)
    print(f"   After: {img_again.size}")
    
    if img.size != img_again.size:
        print("   ⚠️  PROBLEM: Dimensions changed!")
        print("   This means there's still orientation metadata present!")
    else:
        print("   ✅ No change - exif_transpose is a no-op now")

print("\n" + "="*80)
print("ANALYSIS:")
print("="*80)

if exif_after:
    print("❌ BUG FOUND: exif_transpose() does NOT remove the orientation tag!")
    print("   It rotates pixels but leaves EXIF data intact.")
    print("   Solution: Manually remove orientation tag after transposing.")
else:
    print("✅ exif_transpose() correctly removes the orientation tag")
    print("   The bug must be elsewhere.")

# Cleanup
os.remove(test_copy)
