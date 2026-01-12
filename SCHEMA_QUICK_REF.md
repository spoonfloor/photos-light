# Quick Reference: Database Schema

## ⚠️ RULE #1: Single Source of Truth

**ALWAYS use `db_schema.py` for schema definitions.**

Never hardcode schema in other files!

## Common Tasks

### View Current Schema
```bash
python3 -c "from db_schema import get_schema_info; import json; print(json.dumps(get_schema_info(), indent=2))"
```

### Create New Database
```bash
python3 init_db.py
```

### Fix/Migrate Existing Database
```bash
python3 migrate_db.py /path/to/photo_library.db
```

### Check Database Columns
```bash
sqlite3 /path/to/db.db "PRAGMA table_info(photos);"
```

### Check Database Health
```bash
python3 -c "from db_health import check_database_health, format_health_report; print(format_health_report(check_database_health('/path/to/db.db')))"
```

## Schema Overview (8 columns)

### Photos Table
- **id** - Primary key
- **original_filename** - Original name when imported
- **current_path** - Relative path in library (UNIQUE)
- **date_taken** - EXIF date or file mtime
- **content_hash** - SHA-256 for duplicates (UNIQUE)
- **file_size** - Bytes
- **file_type** - "image" or "video"
- **width** - Pixels (for lightbox aspect ratio)
- **height** - Pixels (for lightbox aspect ratio)

### Deleted Photos Table (5 columns)
- **id** - Original photo ID
- **original_path** - Before deletion
- **trash_filename** - Name in .trash/
- **deleted_at** - Deletion timestamp
- **photo_data** - JSON snapshot for restore

## When Schema Changes

1. ✅ Edit `db_schema.py`
2. ✅ Update `migrate_db.py` with migration logic
3. ✅ Update docs
4. ✅ Test on fresh database
5. ✅ Test migration on existing database

## Troubleshooting

### "table photos has no column named X"
```bash
python3 migrate_db.py /path/to/photo_library.db
```

### "Database needs migration" when switching libraries
Run migration tool or create new library.

### Schema looks wrong
```bash
# Check current schema
sqlite3 /path/to/db.db "PRAGMA table_info(photos);"

# Compare with expected
python3 -c "from db_schema import PHOTOS_TABLE_SCHEMA; print(PHOTOS_TABLE_SCHEMA)"
```

### Need to start over
```bash
# Backup first!
cp /path/to/photo_library.db /path/to/photo_library.db.backup

# Recreate schema (WARNING: loses data)
rm /path/to/photo_library.db
PHOTO_DB_PATH=/path/to/photo_library.db python3 init_db.py
```

## Files to Know

- **`db_schema.py`** - THE schema (edit this)
- **`db_health.py`** - Health checking system
- **`init_db.py`** - Create fresh database
- **`migrate_db.py`** - Update existing database
- **`docs/DATABASE_SCHEMA.md`** - Full documentation

