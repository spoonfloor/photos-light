#!/usr/bin/env python3
"""
Initialize the photo library database with the required schema
"""

import sqlite3
import os
import sys

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LIBRARY_PATH = os.environ.get('PHOTO_LIBRARY_PATH', '/Volumes/eric_files/photo_library_test')
DB_PATH = os.environ.get('PHOTO_DB_PATH', os.path.join(LIBRARY_PATH, 'photo_library.db'))

def init_database():
    """Create the database schema"""
    print("🔧 Initializing database schema...")
    print(f"   Database: {DB_PATH}")
    
    # Check if database already has tables
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='photos'")
    if cursor.fetchone():
        print("   ⚠️  Database already has 'photos' table")
        response = input("   Do you want to recreate it? (yes/no): ")
        if response.lower() != 'yes':
            print("   ❌ Aborted")
            conn.close()
            return
        cursor.execute("DROP TABLE IF EXISTS photos")
        cursor.execute("DROP TABLE IF EXISTS deleted_photos")
    
    # Create photos table
    cursor.execute("""
        CREATE TABLE photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_filename TEXT NOT NULL,
            current_path TEXT NOT NULL UNIQUE,
            date_taken TEXT,
            content_hash TEXT NOT NULL UNIQUE,
            file_size INTEGER NOT NULL,
            file_type TEXT NOT NULL,
            width INTEGER,
            height INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Create deleted_photos table
    cursor.execute("""
        CREATE TABLE deleted_photos (
            id INTEGER PRIMARY KEY,
            original_path TEXT NOT NULL,
            trash_filename TEXT NOT NULL,
            deleted_at TEXT NOT NULL,
            photo_data TEXT NOT NULL
        )
    """)
    
    # Create indexes for better performance
    cursor.execute("CREATE INDEX idx_date_taken ON photos(date_taken)")
    cursor.execute("CREATE INDEX idx_content_hash ON photos(content_hash)")
    cursor.execute("CREATE INDEX idx_file_type ON photos(file_type)")
    
    conn.commit()
    conn.close()
    
    print("   ✅ Database schema created successfully!")
    print("\n📊 Tables created:")
    print("   - photos (stores all photo/video metadata)")
    print("   - deleted_photos (stores deleted items for restore)")
    print("\n💡 Next steps:")
    print("   1. Use the import feature in the web UI to add photos")
    print("   2. Or run create_test_library.py to populate with test data")

if __name__ == '__main__':
    init_database()
