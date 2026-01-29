#!/usr/bin/env python3
"""
Manually replicate the exact thumbnail generation code from app.py
"""

from PIL import Image, ImageOps
import os

# Simulate app.py environment
INPUT_FILE = "/Users/erichenry/Desktop/--test-lib/2026/2026-01-26/img_20260126_60558d9.jpg"
OUTPUT_FILE = "/Users/erichenry/Desktop/photos-light/test_manual_app_replication.jpg"

# Copy the exact convert_to_rgb_properly function from app.py
def convert_to_rgb_properly(img):
    """
    Convert image to RGB mode with proper handling of different color spaces.
    """
    mode = img.mode
    
    # Already RGB - nothing to do
    if mode == 'RGB':
        return img
    
    # Capture ICC profile before any conversions (will restore after)
    icc_profile = img.info.get('icc_profile')
    
    # Modes with alpha channel - composite over white background
    if mode in ('RGBA', 'LA', 'PA', 'RGBa', 'La'):
        if mode in ('RGBA', 'RGBa'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[-1])
            result = background
        elif mode in ('LA', 'La'):
            background = Image.new('L', img.size, 255)
            background.paste(img, mask=img.split()[-1])
            result = background.convert('RGB')
        elif mode == 'PA':
            img = img.convert('RGBA')
            background = Image.new('RGB', img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[-1])
            result = background
    # High bit-depth modes
    elif mode in ('I', 'F', 'I;16', 'I;16B', 'I;16L', 'I;16N'):
        import numpy as np
        arr = np.array(img)
        if arr.size > 0:
            min_val = arr.min()
            max_val = arr.max()
            if max_val > min_val:
                arr = ((arr - min_val) / (max_val - min_val) * 255).astype(np.uint8)
            else:
                arr = np.zeros_like(arr, dtype=np.uint8)
        normalized_img = Image.fromarray(arr, mode='L')
        result = normalized_img.convert('RGB')
    else:
        result = img.convert('RGB')
    
    # Restore ICC profile to converted image
    if icc_profile and result.mode == 'RGB':
        result.info['icc_profile'] = icc_profile
    
    return result

# EXACT code from app.py lines 777-809
print("Generating thumbnail with EXACT app.py code...")
with Image.open(INPUT_FILE) as img:
    print(f"1. Opened image: mode={img.mode}, size={img.size}")
    
    img = ImageOps.exif_transpose(img)
    print(f"2. After exif_transpose: mode={img.mode}")
    
    # Capture ICC profile before any conversions (prevents washed-out thumbnails)
    icc_profile = img.info.get('icc_profile')
    print(f"3. Captured ICC profile: {len(icc_profile) if icc_profile else 0} bytes")
    
    # Convert to RGB with proper color space handling
    img = convert_to_rgb_properly(img)
    print(f"4. After convert_to_rgb_properly: mode={img.mode}")
    
    # Check if ICC still present
    icc_after_convert = img.info.get('icc_profile')
    print(f"5. ICC after convert_to_rgb_properly: {len(icc_after_convert) if icc_after_convert else 0} bytes")
    
    target_size = 400
    
    # Resize so smallest dimension is 400px
    width, height = img.size
    if width < height:
        new_width = target_size
        new_height = int(height * (target_size / width))
    else:
        new_height = target_size
        new_width = int(width * (target_size / height))
    
    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    print(f"6. After resize: size={img.size}")
    
    # Check if ICC still present
    icc_after_resize = img.info.get('icc_profile')
    print(f"7. ICC after resize: {len(icc_after_resize) if icc_after_resize else 0} bytes")
    
    # Center crop to square
    left = (img.width - target_size) // 2
    top = (img.height - target_size) // 2
    img = img.crop((left, top, left + target_size, top + target_size))
    print(f"8. After crop: size={img.size}")
    
    # Check if ICC still present
    icc_after_crop = img.info.get('icc_profile')
    print(f"9. ICC after crop: {len(icc_after_crop) if icc_after_crop else 0} bytes")
    
    # Save with ICC profile preserved (critical for color accuracy)
    save_kwargs = {'format': 'JPEG', 'quality': 85, 'optimize': True}
    if icc_profile:
        save_kwargs['icc_profile'] = icc_profile
        print(f"10. Saving WITH icc_profile in save_kwargs")
    else:
        print(f"10. Saving WITHOUT icc_profile (icc_profile was None)")
    
    img.save(OUTPUT_FILE, **save_kwargs)
    print(f"11. Saved to {OUTPUT_FILE}")

# Verify saved file
print("\nVerifying saved file:")
with Image.open(OUTPUT_FILE) as img:
    icc = img.info.get('icc_profile')
    print(f"  ICC Profile: {len(icc) if icc else 0} bytes")
    if icc:
        print("  ✅ SUCCESS!")
    else:
        print("  ❌ FAILED - ICC profile was not saved!")
