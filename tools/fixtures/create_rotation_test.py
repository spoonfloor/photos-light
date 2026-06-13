#!/usr/bin/env python3
"""
Create a test PNG image with EXIF orientation flag.
This simulates a camera that captures pixels in one orientation but sets a flag to rotate on display.
"""

from PIL import Image, ExifTags
import piexif

# Create a simple test image (landscape: 400x300)
# Draw something asymmetric so rotation is obvious
width, height = 400, 300
img = Image.new('RGB', (width, height), color='white')

# Draw colored bars to make orientation obvious
from PIL import ImageDraw, ImageFont
draw = ImageDraw.Draw(img)

# Red bar on left
draw.rectangle([0, 0, 50, height], fill='red')
# Blue bar on top
draw.rectangle([0, 0, width, 50], fill='blue')
# Green text saying "TOP"
draw.text((width//2 - 30, 20), "TOP", fill='white')
draw.text((20, height//2 - 10), "LEFT", fill='white')

# Save as landscape PNG first (no rotation)
output_normal = '/Users/erichenry/Desktop/photos-light/test_rotation_normal.png'
img.save(output_normal, 'PNG')
print(f"✅ Created {output_normal} (400x300, no rotation flag)")

# Now create rotated version: physically rotate pixels 90° CCW, then add Orientation=6 flag
# Orientation=6 means "Rotate 90° CW to display" 
# So: pixels are portrait (300x400), flag says "rotate CW" → displays as landscape (400x300)
img_rotated = img.rotate(90, expand=True)  # Pixels now 300x400 (portrait)

# Convert to JPEG to support EXIF (PNG EXIF support is limited)
output_rotated = '/Users/erichenry/Desktop/photos-light/test_rotation_flag6.jpg'

# Create EXIF data with Orientation=6
exif_dict = {
    "0th": {
        piexif.ImageIFD.Orientation: 6,  # Rotate 90° CW
        piexif.ImageIFD.Make: "TestCamera",
        piexif.ImageIFD.Model: "RotationTest",
    }
}
exif_bytes = piexif.dump(exif_dict)

# Save as JPEG with EXIF
img_rotated.save(output_rotated, 'JPEG', quality=100, exif=exif_bytes)
print(f"✅ Created {output_rotated} (300x400 pixels, Orientation=6 flag)")
print(f"   Pixels are portrait (rotated 90° CCW)")
print(f"   EXIF flag says 'Rotate 90° CW to display'")
print(f"   Result: Should display as landscape in rotation-aware apps")

print("\n📋 Test plan:")
print("1. Open in rotation-aware app (macOS Preview/Photos) → should show landscape")
print("2. Open in rotation-ignorant app (simple viewer) → shows portrait (sideways)")
print("3. Import to photo library → app should handle correctly")
print("4. After terraform → pixels baked, flag removed, shows correctly everywhere")
