"""
Single Source of Truth for Database Schema - Version 3

Changes from v2:
- REMOVED: operation_state table (unnecessary complexity for rare edge case)
- KEPT: hash_cache table (necessary for 80-90% performance improvement)
- KEPT: rating column (harmless scope creep, useful feature)

Rationale: See DB_CHANGES_EVALUATION.md for full analysis.
"""

# Schema version for migrations
SCHEMA_VERSION = 3

# Photos table schema (v3: includes rating column from v2)
PHOTOS_TABLE_SCHEMA = """
    CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_filename TEXT NOT NULL,
        current_path TEXT NOT NULL UNIQUE,
        date_taken TEXT,
        content_hash TEXT NOT NULL UNIQUE,
        file_size INTEGER NOT NULL,
        file_type TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        rating INTEGER DEFAULT NULL
    )
"""

# Deleted photos table schema
DELETED_PHOTOS_TABLE_SCHEMA = """
    CREATE TABLE IF NOT EXISTS deleted_photos (
        id INTEGER PRIMARY KEY,
        original_path TEXT NOT NULL,
        trash_filename TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        photo_data TEXT NOT NULL
    )
"""

# Hash cache table schema (v3: retained from v2 - necessary optimization)
HASH_CACHE_TABLE_SCHEMA = """
    CREATE TABLE IF NOT EXISTS hash_cache (
        file_path TEXT NOT NULL,
        mtime_ns INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        cached_at TEXT NOT NULL,
        PRIMARY KEY (file_path, mtime_ns, file_size)
    )
"""

# Indices for photos table
PHOTOS_INDICES = [
    "CREATE INDEX IF NOT EXISTS idx_content_hash ON photos(content_hash)",
    "CREATE INDEX IF NOT EXISTS idx_date_taken ON photos(date_taken)",
    "CREATE INDEX IF NOT EXISTS idx_file_type ON photos(file_type)",
    "CREATE INDEX IF NOT EXISTS idx_rating ON photos(rating)"
]

# Indices for hash_cache table
HASH_CACHE_INDICES = [
    "CREATE INDEX IF NOT EXISTS idx_hash_cache_path ON hash_cache(file_path)",
    "CREATE INDEX IF NOT EXISTS idx_hash_cache_hash ON hash_cache(content_hash)"
]


def create_database_schema(cursor):
    """
    Create all tables and indices in the database (v3).
    
    Args:
        cursor: SQLite cursor object
    """
    # Create tables
    cursor.execute(PHOTOS_TABLE_SCHEMA)
    cursor.execute(DELETED_PHOTOS_TABLE_SCHEMA)
    cursor.execute(HASH_CACHE_TABLE_SCHEMA)
    
    # Create indices
    for index_sql in PHOTOS_INDICES:
        cursor.execute(index_sql)
    
    for index_sql in HASH_CACHE_INDICES:
        cursor.execute(index_sql)


def get_schema_info():
    """
    Get human-readable schema information for documentation.
    
    Returns:
        dict: Schema information including version and table definitions
    """
    return {
        'version': SCHEMA_VERSION,
        'tables': {
            'photos': PHOTOS_TABLE_SCHEMA,
            'deleted_photos': DELETED_PHOTOS_TABLE_SCHEMA,
            'hash_cache': HASH_CACHE_TABLE_SCHEMA
        },
        'indices': {
            'photos': PHOTOS_INDICES,
            'hash_cache': HASH_CACHE_INDICES
        }
    }
