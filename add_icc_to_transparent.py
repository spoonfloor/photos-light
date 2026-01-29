#!/usr/bin/env python3
"""
Add ICC profile to transparent PNG for orientation baking testing.
"""
from PIL import Image

# Paths
transparent_png = "/Users/erichenry/Desktop/baking-files copy/transparent-90cw.png"
icc_profile_path = "/tmp/icc_profile.icc"

# Read ICC profile
with open(icc_profile_path, 'rb') as f:
    icc_profile = f.read()

print(f"✅ Loaded ICC profile: {len(icc_profile)} bytes")

# Open transparent PNG
with Image.open(transparent_png) as img:
    print(f"📂 Original: {img.format} {img.mode} {img.size}")
    print(f"   Has alpha: {img.mode in ('RGBA', 'LA', 'PA')}")
    
    # Get existing EXIF if present
    exif_data = img.info.get('exif')
    
    # Save with ICC profile
    save_kwargs = {
        'icc_profile': icc_profile
    }
    
    if exif_data:
        save_kwargs['exif'] = exif_data
    
    img.save(transparent_png, "PNG", **save_kwargs)
    print(f"✅ Saved with ICC profile: {transparent_png}")

# Verify
with Image.open(transparent_png) as img:
    icc = img.info.get('icc_profile')
    if icc:
        print(f"✅ Verified ICC profile: {len(icc)} bytes")
    else:
        print("❌ ICC profile not found!")

print()
print("🎉 ICC profile added to transparent PNG!")
