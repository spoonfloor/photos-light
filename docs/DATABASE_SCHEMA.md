# Database Schema Management

## Single Source of Truth

**⚠️ IMPORTANT:** The database schema is defined in ONE place: `db_schema.py`

This file contains:
- Complete table definitions for `photos` and `deleted_photos`
- All index definitions
- A helper function `create_database_schema()` that applies the schema

## Files Using the Schema

All database creation code imports and uses `db_schema.py`:

1. **`init_db.py`** - Command-line tool to initialize a new database
2. **`app.py`** - Web app uses it when creating new libraries via UI
3. **`migrate_db.py`** - Migration tool to update existing databases

## Schema Definition

### Photos Table

```sql
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
    date_added TEXT NOT NULL,
    import_batch_id TEXT
)
```

**Column Descriptions:**
- `id` - Auto-incrementing primary key
- `original_filename` - Original filename when imported (e.g., "IMG_1234.jpg")
- `current_path` - **Relative** path in library (e.g., "2025/2025-01-10/img_20250110_abc123.jpg")
- `date_taken` - Date from EXIF metadata or file mtime (format: "YYYY:MM:DD HH:MM:SS")
- `content_hash` - SHA-256 hash of file contents (for duplicate detection)
- `file_size` - File size in bytes
- `file_type` - Either "image" or "video"
- `width` - Image/video width in pixels
- `height` - Image/video height in pixels
- `date_added` - Timestamp when imported to library
- `import_batch_id` - Optional UUID grouping files from same import session

### Deleted Photos Table

```sql
CREATE TABLE IF NOT EXISTS deleted_photos (
    id INTEGER PRIMARY KEY,
    original_path TEXT NOT NULL,
    trash_filename TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    photo_data TEXT NOT NULL
)
```

**Column Descriptions:**
- `id` - Original photo ID (foreign key to photos.id)
- `original_path` - Path before deletion
- `trash_filename` - Filename in `.trash/` directory
- `deleted_at` - ISO timestamp of deletion
- `photo_data` - JSON blob containing full photo record for restore

### Indices

```sql
CREATE INDEX IF NOT EXISTS idx_content_hash ON photos(content_hash);
CREATE INDEX IF NOT EXISTS idx_date_taken ON photos(date_taken);
CREATE INDEX IF NOT EXISTS idx_date_added ON photos(date_added);
CREATE INDEX IF NOT EXISTS idx_file_type ON photos(file_type);
```

## Making Schema Changes

**DO NOT** modify schema definitions in multiple files!

To add a new column or change the schema:

1. **Update `db_schema.py`** with the new schema
2. **Create a migration** in `migrate_db.py` if needed for existing databases
3. **Test** with both:
   - Fresh database creation (`init_db.py`)
   - Existing database migration (`migrate_db.py`)
   - New library creation via UI

## Tools

### Initialize New Database

```bash
python3 init_db.py
```

Creates a fresh database with the current schema at `$PHOTO_DB_PATH`.

### Migrate Existing Database

```bash
python3 migrate_db.py /path/to/photo_library.db
```

Adds any missing columns/indices to bring an old database up to current schema.

### Check Schema

```bash
sqlite3 /path/to/photo_library.db "PRAGMA table_info(photos);"
```

Shows all columns in the photos table.

## Common Issues

### Import fails with "table photos has no column named X"

This means the database was created with an old schema version.

**Fix:**
```bash
python3 migrate_db.py /path/to/photo_library.db
```

### Database created before width/height columns added

This was a common issue when `width` and `height` columns were missing. Now fixed by:
1. Centralizing schema in `db_schema.py`
2. All creation code uses the same schema
3. Migration tool available for existing databases

### Deleted photos table gets wiped

Fixed in commit. Previously `delete_photos()` in `app.py` was dropping and recreating the table on every delete operation. Now it properly uses `CREATE TABLE IF NOT EXISTS`.

## History

**2026-01-12:** Centralized schema into `db_schema.py`
- Removed duplicate schema definitions from `app.py` and `init_db.py`
- Fixed `delete_photos()` destroying deleted_photos table
- Created `migrate_db.py` tool for schema updates
- Updated documentation

**Previous Issues:**
- Schema defined in 4+ places (app.py, init_db.py, SETUP.md, CODE_REVIEW.md)
- New libraries missing width/height columns
- Manual schema synchronization required
