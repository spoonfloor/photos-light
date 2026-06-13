#!/usr/bin/env python3
"""
Create JPEG test image with orientation flag that can't be baked (not divisible by 16).
"""

from PIL import Image
import piexif

# Open the base image
input_path = '/Users/erichenry/Desktop/photos-light/test_rotation_normal.png'
output_path = '/Users/erichenry/Desktop/orientation-baking-v2/landscape_300x400_flagged.jpg'

print(f"📖 Loading {input_path}")
img = Image.open(input_path)
print(f"   Original size: {img.size} (width × height)")

# Rotate pixels 90° CCW (makes 400×300 → 300×400)
print(f"🔄 Rotating pixels 90° CCW...")
img_rotated = img.rotate(90, expand=True)
print(f"   Rotated size: {img_rotated.size}")

# Create EXIF data with Orientation=6 (Rotate 90° CW)
exif_dict = {
    "0th": {
        piexif.ImageIFD.Orientation: 6,
    }
}
exif_bytes = piexif.dump(exif_dict)

# Save as JPEG with EXIF
print(f"💾 Saving as JPEG with Orientation=6 flag...")
img_rotated.save(output_path, 'JPEG', quality=95, exif=exif_bytes)

print(f"✅ Created {output_path}")
print(f"   Physical pixels: 300×400 (portrait)")
print(f"   EXIF Orientation: 6 (Rotate 90° CW)")
print(f"   Should display as: 400×300 (landscape)")
print(f"\n🔍 Divisibility check:")
print(f"   300 ÷ 16 = {300/16:.2f} ❌ (not divisible)")
print(f"   400 ÷ 16 = {400/16:.2f} ✅ (divisible)")
print(f"\n⚠️  This JPEG will NOT be baked by terraform (lossless rotation not possible)")
