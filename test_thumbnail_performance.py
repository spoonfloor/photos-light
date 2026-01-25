#!/usr/bin/env python3
"""
Test thumbnail generation performance
Measures actual time to generate thumbnails for different file types
"""

import os
import time
import subprocess
from PIL import Image, ImageOps
from io import BytesIO

# Test files from Desktop
TEST_FILES = [
    "/Users/erichenry/Desktop/doesnt-fill-lightbox.jpg",
    "/Users/erichenry/Desktop/Screenshot 2026-01-22 at 8.30.35 PM.png",
    "/Users/erichenry/Desktop/1094-a-Health Insurance Marketplace Statement.jpg",
]

def test_photo_thumbnail(file_path, size=48):
    """Test photo thumbnail generation"""
    try:
        start = time.time()
        
        with Image.open(file_path) as img:
            # Apply EXIF orientation
            img = ImageOps.exif_transpose(img)
            
            # Convert to RGB if needed
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
            # Create thumbnail
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            
            # Encode to JPEG in memory
            buffer = BytesIO()
            img.save(buffer, format='JPEG', quality=70)
            buffer.seek(0)
            
        elapsed = time.time() - start
        file_size = buffer.tell()
        
        return {
            'success': True,
            'time_ms': elapsed * 1000,
            'thumbnail_size': file_size,
            'original_size': os.path.getsize(file_path)
        }
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'time_ms': (time.time() - start) * 1000
        }

def test_video_thumbnail(file_path, size=48):
    """Test video thumbnail generation using ffmpeg"""
    try:
        start = time.time()
        
        # Create temp file
        temp_file = "/tmp/test_thumb.jpg"
        
        # Extract first frame
        cmd = [
            'ffmpeg', '-i', file_path,
            '-vf', f'scale={size}:{size}:force_original_aspect_ratio=decrease',
            '-vframes', '1', '-y', temp_file
        ]
        
        result = subprocess.run(cmd, capture_output=True, timeout=10)
        
        elapsed = time.time() - start
        
        if result.returncode == 0 and os.path.exists(temp_file):
            file_size = os.path.getsize(temp_file)
            os.remove(temp_file)
            return {
                'success': True,
                'time_ms': elapsed * 1000,
                'thumbnail_size': file_size,
                'original_size': os.path.getsize(file_path)
            }
        else:
            return {
                'success': False,
                'error': 'ffmpeg failed',
                'time_ms': elapsed * 1000
            }
            
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'time_ms': (time.time() - start) * 1000
        }

def main():
    print("=" * 70)
    print("THUMBNAIL GENERATION PERFORMANCE TEST")
    print("=" * 70)
    print()
    
    results = []
    
    for file_path in TEST_FILES:
        if not os.path.exists(file_path):
            print(f"⚠️  Skipping (not found): {os.path.basename(file_path)}")
            continue
            
        filename = os.path.basename(file_path)
        ext = os.path.splitext(filename)[1].lower()
        file_size_mb = os.path.getsize(file_path) / (1024 * 1024)
        
        print(f"\n📄 {filename}")
        print(f"   Size: {file_size_mb:.2f} MB")
        
        # Determine file type
        is_video = ext in ['.mov', '.mp4', '.m4v', '.avi']
        
        # Run test 3 times and average
        times = []
        for i in range(3):
            if is_video:
                result = test_video_thumbnail(file_path)
            else:
                result = test_photo_thumbnail(file_path)
            
            if result['success']:
                times.append(result['time_ms'])
        
        if times:
            avg_time = sum(times) / len(times)
            min_time = min(times)
            max_time = max(times)
            
            print(f"   ✅ Average: {avg_time:.1f}ms (min: {min_time:.1f}ms, max: {max_time:.1f}ms)")
            
            results.append({
                'filename': filename,
                'type': 'video' if is_video else 'photo',
                'size_mb': file_size_mb,
                'avg_time_ms': avg_time,
                'min_time_ms': min_time,
                'max_time_ms': max_time
            })
        else:
            print(f"   ❌ Failed to generate thumbnail")
    
    # Summary
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    
    if results:
        photo_results = [r for r in results if r['type'] == 'photo']
        video_results = [r for r in results if r['type'] == 'video']
        
        if photo_results:
            avg_photo_time = sum(r['avg_time_ms'] for r in photo_results) / len(photo_results)
            print(f"\n📷 Photos ({len(photo_results)} tested)")
            print(f"   Average time: {avg_photo_time:.1f}ms")
            print(f"   Range: {min(r['min_time_ms'] for r in photo_results):.1f}ms - {max(r['max_time_ms'] for r in photo_results):.1f}ms")
        
        if video_results:
            avg_video_time = sum(r['avg_time_ms'] for r in video_results) / len(video_results)
            print(f"\n🎬 Videos ({len(video_results)} tested)")
            print(f"   Average time: {avg_video_time:.1f}ms")
            print(f"   Range: {min(r['min_time_ms'] for r in video_results):.1f}ms - {max(r['max_time_ms'] for r in video_results):.1f}ms")
        
        print("\n" + "=" * 70)
        print("ANALYSIS")
        print("=" * 70)
        
        if photo_results:
            avg = sum(r['avg_time_ms'] for r in photo_results) / len(photo_results)
            if avg < 100:
                print(f"✅ Photo thumbnails: FAST ({avg:.1f}ms avg)")
                print("   Should feel instant in UI")
            elif avg < 300:
                print(f"⚠️  Photo thumbnails: ACCEPTABLE ({avg:.1f}ms avg)")
                print("   Slight delay but usable with lazy loading")
            else:
                print(f"❌ Photo thumbnails: SLOW ({avg:.1f}ms avg)")
                print("   Noticeable lag, users may perceive as broken")
        
        if video_results:
            avg = sum(r['avg_time_ms'] for r in video_results) / len(video_results)
            if avg < 1000:
                print(f"✅ Video thumbnails: ACCEPTABLE ({avg:.1f}ms avg)")
                print("   Under 1 second, tolerable with loading state")
            elif avg < 3000:
                print(f"⚠️  Video thumbnails: SLOW ({avg:.1f}ms avg)")
                print("   Noticeable delay, need good loading UX")
            else:
                print(f"❌ Video thumbnails: VERY SLOW ({avg:.1f}ms avg)")
                print("   Too slow, consider disabling video thumbnails")
    else:
        print("\n❌ No results to analyze")

if __name__ == '__main__':
    main()
