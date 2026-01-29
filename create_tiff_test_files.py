#!/usr/bin/env python3
"""
Create TIFF test files with orientation flags for testing orientation baking.
"""
from PIL import Image, ImageOps
import subprocess
import os

source_path = "/Users/erichenry/Desktop/baking-files/png/L_90CCW.png"
output_dir = "/Users/erichenry/Desktop/baking-files/will-bake"

print(f"📂 Source: {source_path}")
print(f"📂 Output directory: {output_dir}")
print()

# Create output directory if it doesn't exist
os.makedirs(output_dir, exist_ok=True)

# Check if source exists
if not os.path.exists(source_path):
    print(f"❌ Source file not found: {source_path}")
    exit(1)

# Open the source image
with Image.open(source_path) as img:
    print(f"✅ Loaded: {img.format} {img.mode} {img.size}")
    source_orientation = img.getexif().get(0x0112, 'None')
    print(f"   Source EXIF orientation: {source_orientation}")
    print()
    
    # Get ICC profile if present
    icc = img.info.get('icc_profile')
    save_kwargs = {}
    if icc:
        save_kwargs['icc_profile'] = icc
        print(f"   ICC profile found: {len(icc)} bytes")
    
    # Test 1: TIFF with Orientation=6 (90° CW rotation needed)
    # Source is 1200×1600, we want it to appear as needing 90° CW rotation
    tiff_orient6_path = os.path.join(output_dir, "test_L_90CCW_orient6.tiff")
    img.save(tiff_orient6_path, "TIFF", **save_kwargs)
    subprocess.run(['exiftool', '-Orientation#=6', '-overwrite_original', tiff_orient6_path], 
                   capture_output=True, check=True)
    print(f"✅ TIFF Orientation=6: {tiff_orient6_path}")
    print(f"   Expected: 1200×1600 with flag 6 → should bake to 1600×1200")
    
    # Test 2: TIFF with Orientation=8 (270° CW / 90° CCW rotation needed)
    tiff_orient8_path = os.path.join(output_dir, "test_L_90CCW_orient8.tiff")
    img.save(tiff_orient8_path, "TIFF", **save_kwargs)
    subprocess.run(['exiftool', '-Orientation#=8', '-overwrite_original', tiff_orient8_path],
                   capture_output=True, check=True)
    print(f"✅ TIFF Orientation=8: {tiff_orient8_path}")
    print(f"   Expected: 1200×1600 with flag 8 → should bake to 1600×1200")
    
    # Test 3: TIFF with Orientation=3 (180° rotation needed)
    tiff_orient3_path = os.path.join(output_dir, "test_L_90CCW_orient3.tiff")
    img.save(tiff_orient3_path, "TIFF", **save_kwargs)
    subprocess.run(['exiftool', '-Orientation#=3', '-overwrite_original', tiff_orient3_path],
                   capture_output=True, check=True)
    print(f"✅ TIFF Orientation=3: {tiff_orient3_path}")
    print(f"   Expected: 1200×1600 with flag 3 → should bake to 1200×1600 (same dims, rotated 180°)")
    
    # Test 4: TIFF with Orientation=1 (no rotation needed, but has tag)
    tiff_orient1_path = os.path.join(output_dir, "test_L_90CCW_orient1.tiff")
    img.save(tiff_orient1_path, "TIFF", **save_kwargs)
    subprocess.run(['exiftool', '-Orientation#=1', '-overwrite_original', tiff_orient1_path],
                   capture_output=True, check=True)
    print(f"✅ TIFF Orientation=1: {tiff_orient1_path}")
    print(f"   Expected: 1200×1600 with flag 1 → should strip tag only (no rotation)")
    
    # Test 5: TIFF with no orientation flag
    tiff_no_orient_path = os.path.join(output_dir, "test_L_90CCW_no_orient.tiff")
    img.save(tiff_no_orient_path, "TIFF", **save_kwargs)
    print(f"✅ TIFF no orientation: {tiff_no_orient_path}")
    print(f"   Expected: 1200×1600 with no flag → should skip (no rotation needed)")

print()
print("🎉 TIFF test files created!")
print()
print("📋 Test Checklist:")
print("   1. Import these TIFFs into the app")
print("   2. Verify orientation=6,8,3 are baked (pixels rotated)")
print("   3. Verify orientation=1 has tag stripped only")
print("   4. Verify no-orientation is skipped")
print("   5. Verify dimensions in DB are correct after baking")
print("   6. Verify ICC profile preserved")
print("   7. Verify files display correctly in grid and lightbox")
