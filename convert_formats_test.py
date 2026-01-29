#!/usr/bin/env python3
"""
Convert PNG to WebP, AVIF, JP2, HEIC, and HEIF for orientation baking testing.
"""
from PIL import Image
import os

# Register HEIF support
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    print("✅ HEIF support registered")
except ImportError:
    print("⚠️  pillow-heif not available, HEIC/HEIF conversion will be skipped")

source_path = "/Users/erichenry/Desktop/baking-files/png/L_90CCW.png"
output_dir = "/Users/erichenry/Desktop/baking-files"

print(f"📂 Source: {source_path}")
print(f"📂 Output directory: {output_dir}")
print()

# Check if source exists
if not os.path.exists(source_path):
    print(f"❌ Source file not found: {source_path}")
    exit(1)

# Open the source image
with Image.open(source_path) as img:
    print(f"✅ Loaded: {img.format} {img.mode} {img.size}")
    print(f"   EXIF orientation: {img.getexif().get(0x0112, 'None')}")
    print()
    
    # Save as WebP (lossy)
    webp_path = os.path.join(output_dir, "test_L_90CCW.webp")
    img.save(webp_path, "WEBP", quality=80)
    print(f"✅ WebP (lossy, quality=80): {webp_path}")
    
    # Save as WebP (lossless)
    webp_lossless_path = os.path.join(output_dir, "test_L_90CCW_lossless.webp")
    img.save(webp_lossless_path, "WEBP", lossless=True)
    print(f"✅ WebP (lossless): {webp_lossless_path}")
    
    # Save as AVIF (lossy)
    avif_path = os.path.join(output_dir, "test_L_90CCW.avif")
    try:
        img.save(avif_path, "AVIF", quality=80)
        print(f"✅ AVIF (lossy, quality=80): {avif_path}")
    except Exception as e:
        print(f"⚠️  AVIF: {e}")
    
    # Save as JPEG 2000 (lossy)
    jp2_path = os.path.join(output_dir, "test_L_90CCW.jp2")
    try:
        img.save(jp2_path, "JPEG2000", quality_mode="rates", quality_layers=[20])
        print(f"✅ JP2 (lossy): {jp2_path}")
    except Exception as e:
        print(f"⚠️  JP2 lossy: {e}")
    
    # Save as JPEG 2000 (lossless)
    jp2_lossless_path = os.path.join(output_dir, "test_L_90CCW_lossless.jp2")
    try:
        img.save(jp2_lossless_path, "JPEG2000", irreversible=False)
        print(f"✅ JP2 (lossless): {jp2_lossless_path}")
    except Exception as e:
        print(f"⚠️  JP2 lossless: {e}")
    
    # Save as HEIC
    heic_path = os.path.join(output_dir, "test_L_90CCW.heic")
    try:
        img.save(heic_path, quality=80)
        print(f"✅ HEIC: {heic_path}")
    except Exception as e:
        print(f"⚠️  HEIC: {e}")
    
    # Save as HEIF
    heif_path = os.path.join(output_dir, "test_L_90CCW.heif")
    try:
        img.save(heif_path, quality=80)
        print(f"✅ HEIF: {heif_path}")
    except Exception as e:
        print(f"⚠️  HEIF: {e}")

print()
print("🎉 Conversion complete!")
print()
print("Test these files by importing them and checking if bake_orientation() correctly skips them.")
