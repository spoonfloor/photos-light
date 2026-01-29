"""
Single Source of Truth for Database Schema
All database creation and migration logic should use these definitions.
"""

# Schema version for migrations
SCHEMA_VERSION = 2

# Photos table schema (v2: added rating column)
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

# Operation state table schema (v2: for resumable operations)
OPERATION_STATE_TABLE_SCHEMA = """
    CREATE TABLE IF NOT EXISTS operation_state (
        operation_id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        checkpoint_data TEXT,
        performance_metrics TEXT,
        error_message TEXT
    )
"""

# Hash cache table schema (v2: for hash caching)
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

# Indices for operation_state table
OPERATION_STATE_INDICES = [
    "CREATE INDEX IF NOT EXISTS idx_operation_status ON operation_state(status)",
    "CREATE INDEX IF NOT EXISTS idx_operation_type ON operation_state(operation_type)",
    "CREATE INDEX IF NOT EXISTS idx_operation_updated ON operation_state(updated_at)"
]

# Indices for hash_cache table
HASH_CACHE_INDICES = [
    "CREATE INDEX IF NOT EXISTS idx_hash_cache_path ON hash_cache(file_path)",
    "CREATE INDEX IF NOT EXISTS idx_hash_cache_hash ON hash_cache(content_hash)"
]


def create_database_schema(cursor):
    """
    Create all tables and indices in the database (v2).
    
    Args:
        cursor: SQLite cursor object
    """
    # Create tables
    cursor.execute(PHOTOS_TABLE_SCHEMA)
    cursor.execute(DELETED_PHOTOS_TABLE_SCHEMA)
    cursor.execute(OPERATION_STATE_TABLE_SCHEMA)
    cursor.execute(HASH_CACHE_TABLE_SCHEMA)
    
    # Create indices
    for index_sql in PHOTOS_INDICES:
        cursor.execute(index_sql)
    
    for index_sql in OPERATION_STATE_INDICES:
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
            'operation_state': OPERATION_STATE_TABLE_SCHEMA,
            'hash_cache': HASH_CACHE_TABLE_SCHEMA
        },
        'indices': {
            'photos': PHOTOS_INDICES,
            'operation_state': OPERATION_STATE_INDICES,
            'hash_cache': HASH_CACHE_INDICES
        }
    }
