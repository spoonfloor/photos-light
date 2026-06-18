#!/usr/bin/env python3
"""
Database Schema Migration/Repair Tool

This script checks if a database has the correct schema and adds any missing
columns to bring it up to date with the current schema definition.

Version: Targets schema v4 (date_added on photos)

Usage:
    python3 migrate_db.py <path_to_database.db>

Example:
    python3 migrate_db.py /Users/me/Desktop/tmp-01/photo_library.db
"""

import glob
import json
import os
import sqlite3
import sys

from db_schema import PHOTOS_INDICES, SCHEMA_VERSION


def get_table_columns(cursor, table_name):
    """Get list of column names for a table"""
    cursor.execute(f"PRAGMA table_info({table_name})")
    return {row[1] for row in cursor.fetchall()}


def derive_library_path_from_db(db_path):
    """Best-effort library root from a canonical .library/photo_library.db path."""
    db_dir = os.path.dirname(os.path.abspath(db_path))
    if os.path.basename(db_dir) == '.library':
        return os.path.dirname(db_dir)
    return None


def backfill_date_added_from_import_logs(cursor, library_path):
    """Parse .logs/import_*.jsonl and backfill date_added for imported photo_ids."""
    if not library_path:
        return 0

    logs_dir = os.path.join(library_path, '.logs')
    if not os.path.isdir(logs_dir):
        return 0

    photo_timestamps = {}
    for log_path in sorted(glob.glob(os.path.join(logs_dir, 'import_*.jsonl'))):
        with open(log_path, 'r', encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get('event') != 'imported':
                    continue
                photo_id = entry.get('photo_id')
                timestamp = entry.get('timestamp')
                if not photo_id or not timestamp:
                    continue
                existing = photo_timestamps.get(photo_id)
                if existing is None or timestamp < existing:
                    photo_timestamps[photo_id] = timestamp

    updated = 0
    for photo_id, timestamp in photo_timestamps.items():
        cursor.execute(
            "UPDATE photos SET date_added = ? WHERE id = ? AND date_added IS NULL",
            (timestamp, photo_id),
        )
        updated += cursor.rowcount
    return updated


def check_and_migrate_schema(db_path):
    """Check schema and add any missing columns/tables"""

    if not os.path.exists(db_path):
        print(f"❌ Database not found: {db_path}")
        return False

    print(f"🔍 Checking database schema: {db_path}\n")

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='photos'")
    if not cursor.fetchone():
        print("❌ No 'photos' table found in database")
        conn.close()
        return False

    current_columns = get_table_columns(cursor, 'photos')
    print("Current columns in 'photos' table:")
    print(f"  {', '.join(sorted(current_columns))}\n")

    expected_columns = {
        'id', 'original_filename', 'current_path', 'date_taken',
        'content_hash', 'file_size', 'file_type', 'width', 'height', 'rating',
        'date_added',
    }

    missing_columns = expected_columns - current_columns
    extra_columns = current_columns - expected_columns

    if extra_columns:
        print(f"ℹ️  Extra columns (not in current schema): {', '.join(extra_columns)}")

    if missing_columns:
        print(f"⚠️  Missing columns: {', '.join(missing_columns)}\n")
        print("🔧 Adding missing columns...\n")

        migrations = {
            'width': 'ALTER TABLE photos ADD COLUMN width INTEGER',
            'height': 'ALTER TABLE photos ADD COLUMN height INTEGER',
            'original_filename': 'ALTER TABLE photos ADD COLUMN original_filename TEXT',
            'content_hash': 'ALTER TABLE photos ADD COLUMN content_hash TEXT',
            'file_size': 'ALTER TABLE photos ADD COLUMN file_size INTEGER',
            'file_type': 'ALTER TABLE photos ADD COLUMN file_type TEXT',
            'date_taken': 'ALTER TABLE photos ADD COLUMN date_taken TEXT',
            'current_path': 'ALTER TABLE photos ADD COLUMN current_path TEXT',
            'rating': 'ALTER TABLE photos ADD COLUMN rating INTEGER DEFAULT NULL',
            'date_added': 'ALTER TABLE photos ADD COLUMN date_added TEXT',
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

    print("\n🔍 Checking for infrastructure tables...")

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

    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_state'")
    if cursor.fetchone():
        print("  ⚠️  Found operation_state table from v2 (no longer needed)")
        print("  Note: Keeping it for backward compatibility, but it won't be used")

    print("\n🔍 Checking indices...")
    cursor.execute("SELECT name FROM sqlite_master WHERE type='index'")
    existing_indices = {row[0] for row in cursor.fetchall()}

    expected_indices = {}
    for index_sql in PHOTOS_INDICES:
        index_name = index_sql.split("INDEX IF NOT EXISTS ")[1].split(" ")[0]
        expected_indices[index_name] = index_sql

    from db_schema import HASH_CACHE_INDICES
    for index_sql in HASH_CACHE_INDICES:
        index_name = index_sql.split("INDEX IF NOT EXISTS ")[1].split(" ")[0]
        expected_indices[index_name] = index_sql

    for idx_name, idx_sql in expected_indices.items():
        if idx_name not in existing_indices:
            try:
                cursor.execute(idx_sql)
                print(f"  ✓ Added index: {idx_name}")
            except sqlite3.OperationalError as e:
                print(f"  ❌ Failed to add {idx_name}: {e}")

    library_path = derive_library_path_from_db(db_path)
    backfilled = backfill_date_added_from_import_logs(cursor, library_path)
    if backfilled:
        print(f"\n📅 Backfilled date_added for {backfilled} photo(s) from import logs")

    conn.commit()
    conn.close()

    print("\n✅ Migration complete!")
    print(f"\nDatabase is now at schema v{SCHEMA_VERSION} with:")
    print("  • Photos table with date_added column")
    print("  • hash_cache table")
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
