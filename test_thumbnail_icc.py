#!/usr/bin/env python3
"""
Test different thumbnail generation approaches to diagnose ICC profile handling
"""

from PIL import Image, ImageOps
import os

INPUT_FILE = "/Users/erichenry/Desktop/--test-lib/2026/2026-01-26/img_20260126_60558d9.jpg"
OUTPUT_DIR = "/Users/erichenry/Desktop/photos-light"

def analyze_image(img_path, label):
    """Quick analysis of an image"""
    print(f"\n{label}:")
    with Image.open(img_path) as img:
        icc = img.info.get('icc_profile')
        print(f"  ICC Profile: {'Present (' + str(len(icc)) + ' bytes)' if icc else 'MISSING'}")
        print(f"  Mode: {img.mode}")
        print(f"  Size: {img.size}")
        
        # Sample center pixel
        pixels = img.load()
        x, y = img.width // 2, img.height // 2
        if img.mode == 'RGB':
            r, g, b = pixels[x, y]
            print(f"  Center pixel: R={r}, G={g}, B={b}")

def test_current_approach():
    """Current v203 approach with convert_to_rgb_properly()"""
    print("\n" + "="*60)
    print("TEST 1: Current v203 Approach (with ICC preservation attempt)")
    print("="*60)
    
    with Image.open(INPUT_FILE) as img:
        img = ImageOps.exif_transpose(img)
        
        # Capture ICC profile
        icc_profile = img.info.get('icc_profile')
        print(f"Original ICC profile: {len(icc_profile) if icc_profile else 0} bytes")
        
        # Simple convert (not the complex convert_to_rgb_properly)
        if img.mode != 'RGB':
            img = img.convert('RGB')
        
        target_size = 400
        width, height = img.size
        if width < height:
            new_width = target_size
            new_height = int(height * (target_size / width))
        else:
            new_height = target_size
            new_width = int(width * (target_size / height))
        
        img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
        
        left = (img.width - target_size) // 2
        top = (img.height - target_size) // 2
        img = img.crop((left, top, left + target_size, top + target_size))
        
        # Check if ICC profile survived
        icc_after = img.info.get('icc_profile')
        print(f"ICC profile after resize/crop: {len(icc_after) if icc_after else 0} bytes")
        
        # Save WITH explicit ICC profile (v203 approach)
        output_path = os.path.join(OUTPUT_DIR, "test_thumb_v203.jpg")
        save_kwargs = {'format': 'JPEG', 'quality': 85, 'optimize': True}
        if icc_profile:
            save_kwargs['icc_profile'] = icc_profile
            print(f"Saving WITH ICC profile: {len(icc_profile)} bytes")
        img.save(output_path, **save_kwargs)
    
    analyze_image(output_path, "Result v203")
    return output_path

def test_original_approach():
    """Original pre-v202 approach (simple convert)"""
    print("\n" + "="*60)
    print("TEST 2: Original Approach (no ICC preservation)")
    print("="*60)
    
    with Image.open(INPUT_FILE) as img:
        img = ImageOps.exif_transpose(img)
        
        if img.mode != 'RGB':
            img = img.convert('RGB')
        
        target_size = 400
        width, height = img.size
        if width < height:
            new_width = target_size
            new_height = int(height * (target_size / width))
        else:
            new_height = target_size
            new_width = int(width * (target_size / height))
        
        img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
        
        left = (img.width - target_size) // 2
        top = (img.height - target_size) // 2
        img = img.crop((left, top, left + target_size, top + target_size))
        
        output_path = os.path.join(OUTPUT_DIR, "test_thumb_original.jpg")
        img.save(output_path, format='JPEG', quality=85, optimize=True)
    
    analyze_image(output_path, "Result original")
    return output_path

def test_lightbox_approach():
    """Lightbox approach (higher quality, no resize)"""
    print("\n" + "="*60)
    print("TEST 3: Lightbox Approach (no resize, quality=95)")
    print("="*60)
    
    with Image.open(INPUT_FILE) as img:
        if img.mode != 'RGB':
            img = img.convert('RGB')
        
        output_path = os.path.join(OUTPUT_DIR, "test_thumb_lightbox.jpg")
        img.save(output_path, format='JPEG', quality=95)
    
    analyze_image(output_path, "Result lightbox")
    return output_path

def test_resize_with_icc():
    """Test if resize destroys ICC profile"""
    print("\n" + "="*60)
    print("TEST 4: Does resize() preserve ICC profile?")
    print("="*60)
    
    with Image.open(INPUT_FILE) as img:
        icc_before = img.info.get('icc_profile')
        print(f"Before resize: {len(icc_before) if icc_before else 0} bytes")
        
        img = img.resize((400, 400), Image.Resampling.LANCZOS)
        
        icc_after = img.info.get('icc_profile')
        print(f"After resize: {len(icc_after) if icc_after else 0} bytes")
        
        if icc_before and not icc_after:
            print("❌ ICC profile was LOST during resize()")
        elif icc_before and icc_after:
            print("✅ ICC profile survived resize()")

def test_crop_with_icc():
    """Test if crop destroys ICC profile"""
    print("\n" + "="*60)
    print("TEST 5: Does crop() preserve ICC profile?")
    print("="*60)
    
    with Image.open(INPUT_FILE) as img:
        icc_before = img.info.get('icc_profile')
        print(f"Before crop: {len(icc_before) if icc_before else 0} bytes")
        
        img = img.crop((100, 100, 500, 500))
        
        icc_after = img.info.get('icc_profile')
        print(f"After crop: {len(icc_after) if icc_after else 0} bytes")
        
        if icc_before and not icc_after:
            print("❌ ICC profile was LOST during crop()")
        elif icc_before and icc_after:
            print("✅ ICC profile survived crop()")

def test_quality_comparison():
    """Test different quality settings"""
    print("\n" + "="*60)
    print("TEST 6: Quality 85 vs 95 (both with ICC)")
    print("="*60)
    
    with Image.open(INPUT_FILE) as img:
        img = ImageOps.exif_transpose(img)
        icc_profile = img.info.get('icc_profile')
        
        if img.mode != 'RGB':
            img = img.convert('RGB')
        
        # Resize to thumbnail size
        img = img.resize((400, 400), Image.Resampling.LANCZOS)
        
        # Quality 85
        output_85 = os.path.join(OUTPUT_DIR, "test_thumb_q85.jpg")
        save_kwargs = {'format': 'JPEG', 'quality': 85, 'optimize': True}
        if icc_profile:
            save_kwargs['icc_profile'] = icc_profile
        img.save(output_85, **save_kwargs)
        
        # Quality 95
        output_95 = os.path.join(OUTPUT_DIR, "test_thumb_q95.jpg")
        save_kwargs = {'format': 'JPEG', 'quality': 95}
        if icc_profile:
            save_kwargs['icc_profile'] = icc_profile
        img.save(output_95, **save_kwargs)
    
    analyze_image(output_85, "Quality 85")
    analyze_image(output_95, "Quality 95")

if __name__ == '__main__':
    print("Testing thumbnail generation approaches...")
    print(f"Input file: {INPUT_FILE}")
    
    analyze_image(INPUT_FILE, "Original")
    
    # Run tests
    test_resize_with_icc()
    test_crop_with_icc()
    test_current_approach()
    test_original_approach()
    test_lightbox_approach()
    test_quality_comparison()
    
    print("\n" + "="*60)
    print("Tests complete!")
    print("="*60)
    print("\nGenerated test files:")
    print("  - test_thumb_v203.jpg")
    print("  - test_thumb_original.jpg")
    print("  - test_thumb_lightbox.jpg")
    print("  - test_thumb_q85.jpg")
    print("  - test_thumb_q95.jpg")
    print("\nOpen these in a browser/Photoshop to compare visually")
