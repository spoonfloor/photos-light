#!/usr/bin/env python3
"""
Initialize the photo library database with the required schema
"""

import sqlite3
import os
import sys
from db_schema import create_database_schema

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LIBRARY_PATH = os.environ.get('PHOTO_LIBRARY_PATH', '/Volumes/eric_files/photo_library_test')
DB_PATH = os.environ.get('PHOTO_DB_PATH', os.path.join(LIBRARY_PATH, 'photo_library.db'))

def init_database():
    """Create the database schema using the single source of truth"""
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
    
    # Create all tables and indices using centralized schema
    create_database_schema(cursor)
    
    conn.commit()
    conn.close()
    
    print("   ✅ Database schema created successfully!")
    print("\n📊 Tables created:")
    print("   - photos (stores all photo/video metadata)")
    print("   - deleted_photos (stores deleted items for restore)")
    print("\n💡 Next steps:")
    print("   1. Use the import feature in the web UI to add photos")
    print("   2. Or run tools/fixtures/create_test_library.py to populate with test data")

if __name__ == '__main__':
    init_database()
