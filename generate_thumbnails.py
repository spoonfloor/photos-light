#!/usr/bin/env python3
"""
Pre-generate all thumbnails for the photo library
- Fixed 400px square center crop (matches app lazy generation)
- Hash-based sharding in .thumbnails/
- Can resume if interrupted
- Shows progress bar
"""

import sqlite3
import os
import gc
from tqdm import tqdm

from image_pixels import (
    generate_still_square_thumbnail,
    generate_video_square_thumbnail,
    thumbnail_cache_path,
)

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

def main():
    print("🖼️  Photo Thumbnail Generator")
    print("=" * 50)

    print("\n🔌 Checking NAS connection...")
    if not os.path.exists(LIBRARY_PATH):
        print(f"   ❌ ERROR: NAS not mounted at {LIBRARY_PATH}")
        print("   Please mount the NAS and try again.")
        return

    test_file = os.path.join(THUMBNAIL_CACHE_DIR, '.keepalive')
    try:
        os.makedirs(THUMBNAIL_CACHE_DIR, exist_ok=True)
        with open(test_file, 'w') as f:
            f.write('test')
        os.remove(test_file)
        print("   ✅ NAS connected and writable")
    except Exception as e:
        print(f"   ❌ ERROR: Cannot write to NAS: {e}")
        return

    conn = get_db_connection()
    cursor = conn.cursor()

    print("\n📊 Querying database...")
    cursor.execute("SELECT id, current_path, file_type, content_hash FROM photos ORDER BY id")
    all_photos = cursor.fetchall()
    conn.close()

    total_count = len(all_photos)
    print(f"   Found {total_count:,} photos/videos")

    print("\n🔍 Checking for existing thumbnails...")
    to_generate = []
    for photo in all_photos:
        thumbnail_path = thumbnail_cache_path(THUMBNAIL_CACHE_DIR, photo['content_hash'])
        if not os.path.exists(thumbnail_path):
            to_generate.append(photo)

    needs_generation = len(to_generate)
    already_cached = total_count - needs_generation

    print(f"   ✅ Already cached: {already_cached:,}")
    print(f"   ⏳ Need to generate: {needs_generation:,}")

    if needs_generation == 0:
        print("\n✨ All thumbnails already generated!")
        return

    print(f"\n🚀 Generating {needs_generation:,} thumbnails...")

    success_count = 0
    error_count = 0
    keepalive_file = os.path.join(THUMBNAIL_CACHE_DIR, '.keepalive')

    for i, photo in enumerate(tqdm(to_generate, desc="Progress", unit="photo")):
        if i % 100 == 0:
            try:
                with open(keepalive_file, 'w') as f:
                    f.write(str(i))
            except OSError:
                pass
            gc.collect()

        relative_path = photo['current_path']
        file_type = photo['file_type']
        content_hash = photo['content_hash']
        full_path = os.path.join(LIBRARY_PATH, relative_path)
        thumbnail_path = thumbnail_cache_path(THUMBNAIL_CACHE_DIR, content_hash, mkdir=True)

        if not os.path.exists(full_path):
            error_count += 1
            if error_count <= 5:
                print(f"\n❌ File not found: {full_path}")
            continue

        try:
            if file_type == 'video':
                temp_frame = thumbnail_path + '.temp.jpg'
                generate_video_square_thumbnail(
                    full_path,
                    thumbnail_path,
                    temp_frame_path=temp_frame,
                )
            else:
                generate_still_square_thumbnail(full_path, thumbnail_path)
            success_count += 1
        except Exception as e:
            error_count += 1
            if error_count <= 5:
                print(f"\n❌ Error generating thumbnail for {relative_path}: {e}")

    print("\n" + "=" * 50)
    print("✅ Thumbnail generation complete!")
    print(f"   Success: {success_count:,}")
    print(f"   Errors: {error_count:,}")
    print(f"   Total: {success_count + error_count:,}")

if __name__ == '__main__':
    main()
