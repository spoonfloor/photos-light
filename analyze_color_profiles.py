#!/usr/bin/env python3
"""
Analyze ICC color profiles and image properties
to diagnose thumbnail washout issue
"""

from PIL import Image
import os
import sys

def analyze_image(filepath):
    """Analyze an image's color profile and properties"""
    print(f"\n{'='*60}")
    print(f"Analyzing: {os.path.basename(filepath)}")
    print(f"{'='*60}")
    
    if not os.path.exists(filepath):
        print(f"❌ File not found: {filepath}")
        return
    
    try:
        with Image.open(filepath) as img:
            print(f"Format: {img.format}")
            print(f"Mode: {img.mode}")
            print(f"Size: {img.size}")
            
            # Check for ICC profile
            icc_profile = img.info.get('icc_profile')
            if icc_profile:
                print(f"ICC Profile: Present ({len(icc_profile)} bytes)")
                
                # Try to parse profile name
                try:
                    # ICC profiles have description at specific offset
                    # This is simplified - real parsing is more complex
                    if len(icc_profile) > 100:
                        # Look for common profile names in the data
                        profile_str = str(icc_profile)
                        if 'Adobe RGB' in profile_str or b'Adobe RGB' in icc_profile:
                            print(f"Profile Type: Adobe RGB (detected)")
                        elif 'sRGB' in profile_str or b'sRGB' in icc_profile:
                            print(f"Profile Type: sRGB (detected)")
                        elif 'Display P3' in profile_str or b'Display P3' in icc_profile:
                            print(f"Profile Type: Display P3 (detected)")
                        elif 'ProPhoto' in profile_str or b'ProPhoto' in icc_profile:
                            print(f"Profile Type: ProPhoto RGB (detected)")
                        else:
                            print(f"Profile Type: Unknown/Custom")
                except:
                    print(f"Profile Type: Unable to parse")
            else:
                print(f"ICC Profile: ❌ NOT PRESENT")
            
            # Check other metadata
            exif_data = img.getexif()
            if exif_data:
                print(f"EXIF data: Present ({len(exif_data)} tags)")
            else:
                print(f"EXIF data: Not present")
            
            # Sample some pixel values for comparison
            pixels = img.load()
            sample_coords = [
                (img.width // 4, img.height // 4),
                (img.width // 2, img.height // 2),
                (3 * img.width // 4, 3 * img.height // 4)
            ]
            
            print(f"\nSample pixel RGB values:")
            for x, y in sample_coords:
                if img.mode == 'RGB':
                    r, g, b = pixels[x, y]
                    print(f"  ({x}, {y}): R={r}, G={g}, B={b}")
            
            # Calculate average brightness
            if img.mode == 'RGB':
                pixels_list = list(img.getdata())
                avg_r = sum(p[0] for p in pixels_list) / len(pixels_list)
                avg_g = sum(p[1] for p in pixels_list) / len(pixels_list)
                avg_b = sum(p[2] for p in pixels_list) / len(pixels_list)
                avg_brightness = (avg_r + avg_g + avg_b) / 3
                print(f"\nAverage RGB: R={avg_r:.1f}, G={avg_g:.1f}, B={avg_b:.1f}")
                print(f"Average Brightness: {avg_brightness:.1f}/255 ({avg_brightness/255*100:.1f}%)")
                
    except Exception as e:
        print(f"❌ Error analyzing image: {e}")
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 analyze_color_profiles.py <image1> [image2] ...")
        print("\nExample:")
        print("  python3 analyze_color_profiles.py original.jpg thumbnail.jpg")
        sys.exit(1)
    
    for filepath in sys.argv[1:]:
        analyze_image(filepath)
    
    print(f"\n{'='*60}")
    print("Analysis complete")
    print(f"{'='*60}")
