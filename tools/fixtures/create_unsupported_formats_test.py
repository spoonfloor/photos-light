#!/usr/bin/env python3
"""
Create additional test files for formats that will remain unchanged.
"""
from PIL import Image
import os

source_path = "/Users/erichenry/Desktop/baking-files/png/L_90CCW.png"
output_dir = "/Users/erichenry/Desktop/baking-files/unchanged"

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
    
    # Save as GIF
    gif_path = os.path.join(output_dir, "test_L_90CCW.gif")
    try:
        # GIF requires RGB or P mode, convert if necessary
        gif_img = img.convert('P', palette=Image.ADAPTIVE, colors=256)
        gif_img.save(gif_path, "GIF")
        print(f"✅ GIF: {gif_path}")
        print(f"   Note: GIF doesn't support EXIF orientation in standard, but testing unsupported format path")
    except Exception as e:
        print(f"⚠️  GIF: {e}")
    
    # Save as BMP
    bmp_path = os.path.join(output_dir, "test_L_90CCW.bmp")
    try:
        img.save(bmp_path, "BMP")
        print(f"✅ BMP: {bmp_path}")
        print(f"   Note: BMP doesn't support EXIF orientation, but testing unsupported format path")
    except Exception as e:
        print(f"⚠️  BMP: {e}")
    
    # Save as TIFF (as proxy for RAW since PIL can't write CR2)
    tiff_path = os.path.join(output_dir, "test_L_90CCW.tiff")
    try:
        # Preserve ICC profile and EXIF
        icc = img.info.get('icc_profile')
        save_kwargs = {}
        if icc:
            save_kwargs['icc_profile'] = icc
        
        img.save(tiff_path, "TIFF", **save_kwargs)
        print(f"✅ TIFF: {tiff_path}")
        print(f"   Note: TIFF created as RAW proxy (PIL can't write CR2/NEF/ARW)")
    except Exception as e:
        print(f"⚠️  TIFF: {e}")

print()
print("📝 Note about RAW formats:")
print("   PIL cannot write CR2, NEF, ARW, DNG, or other RAW formats.")
print("   These formats are read-only in PIL and would need camera-specific tools.")
print("   For testing 'unsupported format' behavior, GIF and BMP are sufficient.")
print()
print("🎉 Conversion complete!")
