#!/usr/bin/env python3
"""
Database Schema Migration/Repair Tool

This script checks if a database has the correct schema and adds any missing
columns to bring it up to date with the current schema definition.

Usage:
    python3 migrate_db.py <path_to_database.db>
    
Example:
    python3 migrate_db.py /Users/me/Desktop/tmp-01/photo_library.db
"""

import sqlite3
import sys
import os


def get_table_columns(cursor, table_name):
    """Get list of column names for a table"""
    cursor.execute(f"PRAGMA table_info({table_name})")
    return {row[1] for row in cursor.fetchall()}


def check_and_migrate_schema(db_path):
    """Check schema and add any missing columns/tables"""
    
    if not os.path.exists(db_path):
        print(f"❌ Database not found: {db_path}")
        return False
    
    print(f"🔍 Checking database schema: {db_path}\n")
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Check if photos table exists
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='photos'")
    if not cursor.fetchone():
        print("❌ No 'photos' table found in database")
        conn.close()
        return False
    
    # === PHASE 1: Migrate photos table columns ===
    
    # Get current columns
    current_columns = get_table_columns(cursor, 'photos')
    print("Current columns in 'photos' table:")
    print(f"  {', '.join(sorted(current_columns))}\n")
    
    # Expected columns based on current schema (v2)
    expected_columns = {
        'id', 'original_filename', 'current_path', 'date_taken', 
        'content_hash', 'file_size', 'file_type', 'width', 'height', 'rating'
    }
    
    # Find missing columns
    missing_columns = expected_columns - current_columns
    extra_columns = current_columns - expected_columns
    
    if extra_columns:
        print(f"ℹ️  Extra columns (not in current schema): {', '.join(extra_columns)}")
    
    if missing_columns:
        print(f"⚠️  Missing columns: {', '.join(missing_columns)}\n")
        print("🔧 Adding missing columns...\n")
        
        # Add missing columns with appropriate defaults
        migrations = {
            'width': 'ALTER TABLE photos ADD COLUMN width INTEGER',
            'height': 'ALTER TABLE photos ADD COLUMN height INTEGER',
            'original_filename': 'ALTER TABLE photos ADD COLUMN original_filename TEXT',
            'content_hash': 'ALTER TABLE photos ADD COLUMN content_hash TEXT',
            'file_size': 'ALTER TABLE photos ADD COLUMN file_size INTEGER',
            'file_type': 'ALTER TABLE photos ADD COLUMN file_type TEXT',
            'date_taken': 'ALTER TABLE photos ADD COLUMN date_taken TEXT',
            'current_path': 'ALTER TABLE photos ADD COLUMN current_path TEXT',
            'rating': 'ALTER TABLE photos ADD COLUMN rating INTEGER DEFAULT NULL'
        }
        
        for column in missing_columns:
            if column in migrations:
                try:
                    cursor.execute(migrations[column])
                    print(f"  ✓ Added column: {column}")
                except sqlite3.OperationalError as e:
                    print(f"  ❌ Failed to add {column}: {e}")
            else:
                print(f"  ⚠️  No migration defined for: {column}")
    else:
        print("✅ Photos table schema is up to date!")
    
    # === PHASE 2: Add new v2 tables ===
    
    print("\n🔍 Checking for v2 infrastructure tables...")
    
    # Check for operation_state table
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_state'")
    if not cursor.fetchone():
        print("  Adding operation_state table...")
        from db_schema import OPERATION_STATE_TABLE_SCHEMA, OPERATION_STATE_INDICES
        try:
            cursor.execute(OPERATION_STATE_TABLE_SCHEMA)
            for index_sql in OPERATION_STATE_INDICES:
                cursor.execute(index_sql)
            print("  ✓ Added operation_state table with indices")
        except sqlite3.OperationalError as e:
            print(f"  ❌ Failed to add operation_state table: {e}")
    else:
        print("  ✓ operation_state table exists")
    
    # Check for hash_cache table
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='hash_cache'")
    if not cursor.fetchone():
        print("  Adding hash_cache table...")
        from db_schema import HASH_CACHE_TABLE_SCHEMA, HASH_CACHE_INDICES
        try:
            cursor.execute(HASH_CACHE_TABLE_SCHEMA)
            for index_sql in HASH_CACHE_INDICES:
                cursor.execute(index_sql)
            print("  ✓ Added hash_cache table with indices")
        except sqlite3.OperationalError as e:
            print(f"  ❌ Failed to add hash_cache table: {e}")
    else:
        print("  ✓ hash_cache table exists")
    
    # === PHASE 3: Check/add indices ===
    
    print("\n🔍 Checking indices...")
    cursor.execute("SELECT name FROM sqlite_master WHERE type='index'")
    existing_indices = {row[0] for row in cursor.fetchall()}
    
    expected_indices = {
        'idx_content_hash': 'CREATE INDEX IF NOT EXISTS idx_content_hash ON photos(content_hash)',
        'idx_date_taken': 'CREATE INDEX IF NOT EXISTS idx_date_taken ON photos(date_taken)',
        'idx_file_type': 'CREATE INDEX IF NOT EXISTS idx_file_type ON photos(file_type)',
        'idx_rating': 'CREATE INDEX IF NOT EXISTS idx_rating ON photos(rating)'
    }
    
    for idx_name, idx_sql in expected_indices.items():
        if idx_name not in existing_indices:
            try:
                cursor.execute(idx_sql)
                print(f"  ✓ Added index: {idx_name}")
            except sqlite3.OperationalError as e:
                print(f"  ❌ Failed to add {idx_name}: {e}")
    
    # Commit changes
    conn.commit()
    conn.close()
    
    print("\n✅ Migration complete!")
    print(f"\nDatabase is now at schema v2 with:")
    print(f"  • Photos table with rating column")
    print(f"  • operation_state table (resumable operations)")
    print(f"  • hash_cache table (performance optimization)")
    return True


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print("Usage: python3 migrate_db.py <path_to_database.db>")
        print("\nExample:")
        print("  python3 migrate_db.py /Users/me/Desktop/tmp-01/photo_library.db")
        sys.exit(1)
    
    db_path = sys.argv[1]
    success = check_and_migrate_schema(db_path)
    sys.exit(0 if success else 1)
