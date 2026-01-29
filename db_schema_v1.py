"""
Single Source of Truth for Database Schema
All database creation and migration logic should use these definitions.
"""

# Schema version for migrations
SCHEMA_VERSION = 1

# Photos table schema
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
        height INTEGER
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

# Indices for photos table
PHOTOS_INDICES = [
    "CREATE INDEX IF NOT EXISTS idx_content_hash ON photos(content_hash)",
    "CREATE INDEX IF NOT EXISTS idx_date_taken ON photos(date_taken)",
    "CREATE INDEX IF NOT EXISTS idx_file_type ON photos(file_type)"
]


def create_database_schema(cursor):
    """
    Create all tables and indices in the database.
    
    Args:
        cursor: SQLite cursor object
    """
    # Create tables
    cursor.execute(PHOTOS_TABLE_SCHEMA)
    cursor.execute(DELETED_PHOTOS_TABLE_SCHEMA)
    
    # Create indices
    for index_sql in PHOTOS_INDICES:
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
            'deleted_photos': DELETED_PHOTOS_TABLE_SCHEMA
        },
        'indices': PHOTOS_INDICES
    }
