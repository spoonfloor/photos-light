#!/usr/bin/env python3
"""
Pre-generate all thumbnails for the photo library
- Fixed 400px height, width determined by aspect ratio
- Mirrors folder structure in .thumbnails/
- Can resume if interrupted
- Shows progress bar
"""

import sqlite3
import os
import gc
from PIL import Image, ImageOps, ImageFile
from pillow_heif import register_heif_opener
import subprocess
from tqdm import tqdm

# Register HEIF/HEIC support
register_heif_opener()
Image.MAX_IMAGE_PIXELS = None

# Allow loading truncated images (suppress warnings)
ImageFile.LOAD_TRUNCATED_IMAGES = True

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, '..', 'migration', 'databases', 'photo_library_nas2_full.db')
LIBRARY_PATH = '/Volumes/eric_files/photo_library'
THUMBNAIL_CACHE_DIR = os.path.join(LIBRARY_PATH, '.thumbnails')

def get_db_connection():
    """Create database connection"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def generate_image_thumbnail(full_path, thumbnail_path):
    """Generate thumbnail for an image file"""
    img = None
    try:
        # Use context manager to ensure file is closed
        with Image.open(full_path) as img:
            # Apply EXIF orientation
            try:
                img = ImageOps.exif_transpose(img)
            except Exception:
                pass
            
            # Convert to RGB if needed
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
            # Fixed height 400px, width determined by aspect ratio
            original_width, original_height = img.size
            target_height = 400
            target_width = int((original_width / original_height) * target_height)
            
            # Resize
            img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
            
            # Save
            img.save(thumbnail_path, format='JPEG', quality=85, optimize=True)
        
        return True
    except Exception as e:
        print(f"\n❌ Error generating thumbnail: {e}")
        return False

def generate_video_thumbnail(full_path, thumbnail_path):
    """Generate thumbnail for a video file"""
    temp_frame = None
    img = None
    try:
        temp_frame = thumbnail_path + '.temp.jpg'
        
        # Extract first frame using ffmpeg
        cmd = [
            'ffmpeg',
            '-i', full_path,
            '-vframes', '1',
            '-vf', 'scale=-1:400',  # Fixed height 400px
            '-y',
            temp_frame
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode != 0 or not os.path.exists(temp_frame):
            return False
        
        # Convert to final thumbnail
        img = Image.open(temp_frame)
        if img.mode != 'RGB':
            img = img.convert('RGB')
        img.save(thumbnail_path, format='JPEG', quality=85, optimize=True)
        img.close()
        
        # Clean up
        if os.path.exists(temp_frame):
            os.remove(temp_frame)
        return True
    except Exception as e:
        print(f"\n❌ Error generating video thumbnail: {e}")
        return False
    finally:
        if img:
            try:
                img.close()
            except:
                pass
        if temp_frame and os.path.exists(temp_frame):
            try:
                os.remove(temp_frame)
            except:
                pass

def main():
    print("🖼️  Photo Thumbnail Generator")
    print("=" * 50)
    
    # Check if NAS is mounted
    print("\n🔌 Checking NAS connection...")
    if not os.path.exists(LIBRARY_PATH):
        print(f"   ❌ ERROR: NAS not mounted at {LIBRARY_PATH}")
        print("   Please mount the NAS and try again.")
        return
    
    # Test write access
    test_file = os.path.join(THUMBNAIL_CACHE_DIR, '.test')
    try:
        os.makedirs(THUMBNAIL_CACHE_DIR, exist_ok=True)
        with open(test_file, 'w') as f:
            f.write('test')
        os.remove(test_file)
        print(f"   ✅ NAS connected and writable")
    except Exception as e:
        print(f"   ❌ ERROR: Cannot write to NAS: {e}")
        return
    
    # Connect to database
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Get all photos
    print("\n📊 Querying database...")
    cursor.execute("SELECT id, current_path, file_type FROM photos ORDER BY id")
    all_photos = cursor.fetchall()
    conn.close()
    
    total_count = len(all_photos)
    print(f"   Found {total_count:,} photos/videos")
    
    # Filter to only those without cached thumbnails
    print("\n🔍 Checking for existing thumbnails...")
    to_generate = []
    for photo in all_photos:
        # Add _thumb suffix to check for thumbnail
        base, ext = os.path.splitext(photo['current_path'])
        thumbnail_relative_path = f"{base}_thumb{ext}"
        thumbnail_path = os.path.join(THUMBNAIL_CACHE_DIR, thumbnail_relative_path)
        if not os.path.exists(thumbnail_path):
            to_generate.append(photo)
    
    needs_generation = len(to_generate)
    already_cached = total_count - needs_generation
    
    print(f"   ✅ Already cached: {already_cached:,}")
    print(f"   ⏳ Need to generate: {needs_generation:,}")
    
    if needs_generation == 0:
        print("\n✨ All thumbnails already generated!")
        return
    
    # Generate thumbnails
    print(f"\n🚀 Generating {needs_generation:,} thumbnails...")
    print("   (Fixed 400px height, width = aspect ratio × 400)")
    
    success_count = 0
    error_count = 0
    keepalive_file = os.path.join(THUMBNAIL_CACHE_DIR, '.keepalive')
    created_dirs = set()  # Track directories we've already created
    
    for i, photo in enumerate(tqdm(to_generate, desc="Progress", unit="photo")):
        # Keep NAS connection alive (touch file every 100 photos)
        if i % 100 == 0:
            try:
                with open(keepalive_file, 'w') as f:
                    f.write(str(i))
            except:
                pass
            
            # Force garbage collection every 100 photos to release file handles
            gc.collect()
        
        photo_id = photo['id']
        relative_path = photo['current_path']
        file_type = photo['file_type']
        
        full_path = os.path.join(LIBRARY_PATH, relative_path)
        
        # Add _thumb suffix: img_xyz.jpg -> img_xyz_thumb.jpg
        base, ext = os.path.splitext(relative_path)
        thumbnail_relative_path = f"{base}_thumb{ext}"
        thumbnail_path = os.path.join(THUMBNAIL_CACHE_DIR, thumbnail_relative_path)
        
        # Skip if source doesn't exist
        if not os.path.exists(full_path):
            error_count += 1
            if error_count <= 5:  # Print first 5 errors for debugging
                print(f"\n❌ File not found: {full_path}")
            continue
        
        # Ensure parent directory exists (only create once per directory)
        thumbnail_dir = os.path.dirname(thumbnail_path)
        if thumbnail_dir not in created_dirs:
            try:
                os.makedirs(thumbnail_dir, exist_ok=True)
                created_dirs.add(thumbnail_dir)
            except OSError as e:
                print(f"\n❌ Error creating directory {thumbnail_dir}: {e}")
                error_count += 1
                continue
        
        # Generate thumbnail
        if file_type == 'video':
            success = generate_video_thumbnail(full_path, thumbnail_path)
        else:
            success = generate_image_thumbnail(full_path, thumbnail_path)
        
        if success:
            success_count += 1
        else:
            error_count += 1
    
    # Summary
    print("\n" + "=" * 50)
    print("✅ Thumbnail generation complete!")
    print(f"   Success: {success_count:,}")
    print(f"   Errors: {error_count:,}")
    print(f"   Total: {success_count + error_count:,}")

if __name__ == '__main__':
    main()
