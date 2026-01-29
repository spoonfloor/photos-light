#!/usr/bin/env python3
"""
Test to verify ImageOps.exif_transpose() behavior on already-baked images.

Theory: After baking (rotating pixels and removing EXIF orientation tag),
calling exif_transpose() again might be re-applying some transformation.
"""

from PIL import Image, ImageOps
import os
import subprocess

def test_file(file_path):
    """Test a file's behavior with exif_transpose"""
    print(f"\n{'='*80}")
    print(f"Testing: {os.path.basename(file_path)}")
    print('='*80)
    
    # Check EXIF orientation with exiftool
    result = subprocess.run(
        ['exiftool', '-Orientation', '-n', '-s3', file_path],
        capture_output=True, text=True, timeout=5
    )
    orientation = result.stdout.strip()
    print(f"EXIF Orientation tag: {orientation if orientation else '(none)'}")
    
    # Open with PIL and check dimensions
    with Image.open(file_path) as img:
        print(f"Dimensions before exif_transpose: {img.size}")
        
        # Check if EXIF data exists in PIL
        exif = img.getexif()
        pil_orientation = exif.get(0x0112, None)
        print(f"PIL EXIF orientation (0x0112): {pil_orientation}")
        
        # Apply exif_transpose
        img_transposed = ImageOps.exif_transpose(img)
        
        print(f"Dimensions after exif_transpose: {img_transposed.size}")
        
        # Check if dimensions changed
        if img.size != img_transposed.size:
            print("⚠️  DIMENSIONS CHANGED - exif_transpose() did something!")
        else:
            print("✅ Dimensions unchanged - exif_transpose() was a no-op")
        
        # Check if it's the same object
        if img is img_transposed:
            print("✅ Same object returned (no transformation)")
        else:
            print("⚠️  New object returned (transformation applied)")

# Test on a baked image from the terraform test library
test_library = "/Users/erichenry/Desktop/test-library-v214"

print("Testing baked images from terraform operation...")

# Test a PNG that was baked
png_files = subprocess.run(
    ['find', test_library, '-name', '*.png', '-type', 'f'],
    capture_output=True, text=True
).stdout.strip().split('\n')

if png_files and png_files[0]:
    test_file(png_files[0])

# Test a JPEG that was baked
jpg_files = subprocess.run(
    ['find', test_library, '-name', '*.jpg', '-type', 'f'],
    capture_output=True, text=True
).stdout.strip().split('\n')

if jpg_files and jpg_files[0]:
    test_file(jpg_files[0])

print("\n" + "="*80)
print("CONCLUSION:")
print("="*80)
print("If dimensions changed after exif_transpose() on a baked image,")
print("then the bug is that PIL is finding some orientation metadata we didn't remove.")
print("If dimensions stayed the same, then the problem is elsewhere in the pipeline.")
