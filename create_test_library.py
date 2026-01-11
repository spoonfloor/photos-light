#!/usr/bin/env python3
"""
Create a test photo library with a subset of photos
- Last 20 months
- First 5 photos per month
- Copies files to /Volumes/eric_files/photo_library_test/
- Creates test database
"""

import sqlite3
import os
import shutil
from datetime import datetime, timedelta
from collections import defaultdict

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCE_DB = os.path.join(BASE_DIR, '..', 'migration', 'databases', 'photo_library_nas2_full.db')
SOURCE_LIBRARY = '/Volumes/eric_files/photo_library'
TEST_LIBRARY = '/Volumes/eric_files/photo_library_test'
TEST_DB = os.path.join(BASE_DIR, '..', 'migration', 'databases', 'photo_library_test.db')

# Configuration
MONTHS_BACK = 20
PHOTOS_PER_MONTH = 5

def get_db_connection(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn

def main():
    print("🧪 Creating Test Photo Library")
    print("=" * 60)
    
    # Check NAS
    if not os.path.exists(SOURCE_LIBRARY):
        print(f"❌ Source library not found: {SOURCE_LIBRARY}")
        return
    
    # Calculate date range (last 20 months)
    today = datetime.now()
    start_date = today - timedelta(days=MONTHS_BACK * 30)
    start_date_str = start_date.strftime('%Y:%m:01 00:00:00')
    
    print(f"\n📅 Date range: {start_date.strftime('%Y-%m')} to {today.strftime('%Y-%m')}")
    print(f"📊 Target: {PHOTOS_PER_MONTH} photos per month")
    
    # Query source database
    print(f"\n📖 Reading source database...")
    conn = get_db_connection(SOURCE_DB)
    cursor = conn.cursor()
    
    query = """
        SELECT id, current_path, original_filename, date_taken, file_type, 
               content_hash, file_size, width, height
        FROM photos 
        WHERE date_taken >= ?
        ORDER BY date_taken ASC
    """
    cursor.execute(query, (start_date_str,))
    all_photos = cursor.fetchall()
    conn.close()
    
    print(f"   Found {len(all_photos):,} photos in date range")
    
    # Group by month and take first 5 from each
    photos_by_month = defaultdict(list)
    for photo in all_photos:
        if photo['date_taken']:
            month = photo['date_taken'][:7]  # YYYY:MM
            if len(photos_by_month[month]) < PHOTOS_PER_MONTH:
                photos_by_month[month].append(photo)
    
    selected_photos = []
    for month in sorted(photos_by_month.keys()):
        selected_photos.extend(photos_by_month[month])
    
    total_selected = len(selected_photos)
    total_months = len(photos_by_month)
    
    print(f"\n✅ Selected {total_selected} photos from {total_months} months")
    
    # Create test library directory
    print(f"\n📁 Creating test library at: {TEST_LIBRARY}")
    if os.path.exists(TEST_LIBRARY):
        print("   ⚠️  Test library already exists, cleaning...")
        shutil.rmtree(TEST_LIBRARY)
    os.makedirs(TEST_LIBRARY)
    
    # Copy files
    print(f"\n📋 Copying files...")
    copied_count = 0
    error_count = 0
    
    for photo in selected_photos:
        source_path = os.path.join(SOURCE_LIBRARY, photo['current_path'])
        dest_path = os.path.join(TEST_LIBRARY, photo['current_path'])
        
        # Create parent directory
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        
        # Copy file
        try:
            if os.path.exists(source_path):
                shutil.copy2(source_path, dest_path)
                copied_count += 1
                if copied_count % 10 == 0:
                    print(f"   Copied {copied_count}/{total_selected}...")
            else:
                error_count += 1
        except Exception as e:
            print(f"   ❌ Error copying {photo['current_path']}: {e}")
            error_count += 1
    
    print(f"   ✅ Copied: {copied_count}")
    if error_count > 0:
        print(f"   ❌ Errors: {error_count}")
    
    # Create test database
    print(f"\n💾 Creating test database...")
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)
    
    # Copy schema from source database
    source_conn = get_db_connection(SOURCE_DB)
    test_conn = sqlite3.connect(TEST_DB)
    
    # Get schema
    cursor = source_conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='photos'")
    create_table = cursor.fetchone()[0]
    test_conn.execute(create_table)
    
    # Insert selected photos
    cursor = test_conn.cursor()
    for photo in selected_photos:
        cursor.execute("""
            INSERT INTO photos (id, current_path, original_filename, date_taken, 
                                file_type, content_hash, file_size, width, height)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (photo['id'], photo['current_path'], photo['original_filename'],
              photo['date_taken'], photo['file_type'], photo['content_hash'],
              photo['file_size'], photo['width'], photo['height']))
    
    test_conn.commit()
    
    # Get final count
    cursor.execute("SELECT COUNT(*) FROM photos")
    db_count = cursor.fetchone()[0]
    
    source_conn.close()
    test_conn.close()
    
    print(f"   ✅ Database created with {db_count} entries")
    print(f"   📍 Location: {TEST_DB}")
    
    # Summary
    print("\n" + "=" * 60)
    print("✅ Test library created successfully!")
    print(f"   Library: {TEST_LIBRARY}")
    print(f"   Database: {TEST_DB}")
    print(f"   Photos: {copied_count}")
    print(f"   Months: {total_months}")
    print("\n💡 To use the test library:")
    print("   1. Update app.py LIBRARY_PATH to point to photo_library_test")
    print("   2. Update app.py DB_PATH to point to photo_library_test.db")
    print("   3. Restart the Flask server")
    print("=" * 60)

if __name__ == '__main__':
    main()
