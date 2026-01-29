#!/usr/bin/env python3
"""
Create JPEG with orientation flag from landscape_1200x1600.png
Dimensions are divisible by 16, making it a candidate for lossless baking.
"""

from PIL import Image
import piexif

# Open the base image
input_path = '/Users/erichenry/Desktop/orientation-baking-v2/landscape_1200x1600.png'
output_path = '/Users/erichenry/Desktop/orientation-baking-v2/landscape_1600x1200_flagged.jpg'

print(f"📖 Loading {input_path}")
img = Image.open(input_path)
print(f"   Original size: {img.size} (width × height)")

# Verify divisibility by 16
width, height = img.size
print(f"\n🔍 Divisibility check:")
print(f"   {width} ÷ 16 = {width/16} {'✅' if width % 16 == 0 else '❌'}")
print(f"   {height} ÷ 16 = {height/16} {'✅' if height % 16 == 0 else '❌'}")

# Rotate pixels 90° CCW (makes 1200×1600 → 1600×1200)
print(f"\n🔄 Rotating pixels 90° CCW...")
img_rotated = img.rotate(90, expand=True)
print(f"   Rotated size: {img_rotated.size}")

# Create EXIF data with Orientation=6 (Rotate 90° CW)
exif_dict = {
    "0th": {
        piexif.ImageIFD.Orientation: 6,
    }
}
exif_bytes = piexif.dump(exif_dict)

# Save as JPEG with EXIF (high quality for test)
print(f"\n💾 Saving as JPEG with Orientation=6 flag...")
img_rotated.save(output_path, 'JPEG', quality=95, exif=exif_bytes)

print(f"\n✅ Created {output_path}")
print(f"   Physical pixels: 1600×1200 (portrait)")
print(f"   EXIF Orientation: 6 (Rotate 90° CW)")
print(f"   Should display as: 1200×1600 (landscape)")
print(f"\n🎯 This file IS a candidate for lossless baking:")
print(f"   - 1600 ÷ 16 = {1600/16} ✅")
print(f"   - 1200 ÷ 16 = {1200/16} ✅")
print(f"   - jpegtran -perfect will succeed")
