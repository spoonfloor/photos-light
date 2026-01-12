# Photos Light - Setup Guide

## Architecture Overview

This app has **two main dependencies**:

1. **SQLite Database** - Stores photo metadata (paths, dates, hashes)
2. **Photo Library Directory** - Contains actual photo files

```
Database (photo_library_test.db)
├─ id: 6612
├─ current_path: "2025/2025-05-01/mov_20250501_e0d7504.mov"
└─ date_taken: "2025:05:01 14:15:14"
          ↓
Photo Library (/Volumes/eric_files/photo_library_test/)
├─ 2025/
│  └─ 2025-05-01/
│     └─ mov_20250501_e0d7504.mov  ← actual file
├─ .thumbnails/  ← generated on demand
├─ .trash/       ← deleted files
└─ .db_backups/  ← automatic backups
```

## Configuration

The app uses **environment variables** to find your files:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PHOTO_DB_PATH` | Path to SQLite database | `./photo_library.db` |
| `PHOTO_LIBRARY_PATH` | Path to photo library directory | `/Volumes/eric_files/photo_library_test` |

**Set these in one of three ways:**

### Option 1: Use `run.sh` (Recommended)
Edit `run.sh` lines 4-5:
```bash
export PHOTO_DB_PATH="/path/to/your/database.db"
export PHOTO_LIBRARY_PATH="/path/to/your/photos"
```

### Option 2: Set in shell
```bash
export PHOTO_DB_PATH="/path/to/database.db"
export PHOTO_LIBRARY_PATH="/path/to/photos"
python3 app.py
```

### Option 3: Inline
```bash
PHOTO_DB_PATH="/path/to/db.db" PHOTO_LIBRARY_PATH="/path/to/photos" python3 app.py
```

## Database Schema

**⚠️ Single Source of Truth:** The database schema is defined in `db_schema.py`.

All database creation logic uses this centralized schema to ensure consistency across:
- Initial library creation (`init_db.py`)
- New library creation via UI (`app.py`)
- Documentation

### Main Tables

**photos** - Stores all photo/video metadata:
- `id` - Unique identifier
- `original_filename` - Original filename when imported
- `current_path` - Relative path in library (e.g., "2025/2025-01-10/img_xyz.jpg")
- `date_taken` - Date from EXIF or file modification time
- `content_hash` - SHA-256 hash for duplicate detection
- `file_size` - Size in bytes
- `file_type` - "image" or "video"
- `width`, `height` - Image/video dimensions
- `date_added` - When imported to library
- `import_batch_id` - Groups files from same import

**deleted_photos** - Stores metadata for soft-deleted photos:
- `id` - Original photo ID
- `original_path` - Path before deletion
- `trash_filename` - Filename in `.trash/` directory
- `deleted_at` - Deletion timestamp
- `photo_data` - JSON snapshot of photo record

**Key Points:**
- `current_path` is **relative** to `PHOTO_LIBRARY_PATH`
- `content_hash` is used for duplicate detection
- Photos are organized as `YYYY/YYYY-MM-DD/filename.ext`

## File Organization

```
photo_library_test/
├── 2024/
│   └── 2024-12-25/
│       ├── img_20241225_abc123.jpg
│       └── mov_20241225_def456.mov
├── 2025/
│   └── 2025-01-10/
│       └── img_20250110_xyz789.jpg
├── .thumbnails/           # Auto-generated (gitignored)
│   ├── 6612.jpg
│   └── 6613.jpg
├── .trash/                # Soft-deleted photos
├── .db_backups/           # Automatic DB backups before imports
├── .import_temp/          # Temp storage during import
└── .logs/                 # Application logs
    ├── app.log
    ├── import_20260111.log
    └── errors.log
```

## Common Issues

### "Database not found"
- Check `PHOTO_DB_PATH` points to existing `.db` file
- Use absolute paths, not relative

### "404 errors for thumbnails"
- Check `PHOTO_LIBRARY_PATH` is correct
- Thumbnails generate on first view (may take a moment)
- Check `.thumbnails/` directory exists and is writable

### "Empty grid, no photos showing"
- Check database has photos: `sqlite3 $PHOTO_DB_PATH "SELECT COUNT(*) FROM photos;"`
- Check file paths in DB match actual files
- Open browser console (F12) for error messages

### "Import fails"
- Check `.import_temp/` directory exists and is writable
- Check disk space available
- Check logs in `.logs/import_YYYYMMDD.log`

## Development

**Port:** 5001  
**Debug mode:** Enabled by default  
**Auto-reload:** Yes (Flask development server)

**File locations:**
- Backend: `app.py` (Flask routes, database logic)
- Frontend: `static/` (HTML, CSS, JS)
- Styles: `static/css/styles.css`
- Main JS: `static/js/main.js`

**API Endpoints:**
- `GET /api/photos` - List photos (paginated, filterable)
- `GET /api/photo/:id` - Get single photo
- `GET /api/photo/:id/thumbnail` - Get thumbnail (generated on demand)
- `POST /api/photos/import` - Import new photos (SSE stream)
- `PATCH /api/photo/:id/date` - Update photo date
- `DELETE /api/photo/:id` - Move to trash
- `POST /api/restore/:id` - Restore from trash

## Testing

Create a test library:
```bash
python3 create_test_library.py
```

This creates a small test database you can experiment with safely.

## For AI Agents

**When debugging:**
1. Check `PHOTO_DB_PATH` and `PHOTO_LIBRARY_PATH` are set correctly
2. Verify database file exists at that path
3. Query database to see what photos exist: `sqlite3 $PHOTO_DB_PATH "SELECT id, current_path FROM photos LIMIT 5;"`
4. Check if actual photo files exist at `$PHOTO_LIBRARY_PATH/$current_path`
5. Look at browser console for frontend errors
6. Check `.logs/app.log` for backend errors

**Critical paths to verify:**
- Database file exists and is readable
- Library directory exists and is readable
- Paths in database match actual file locations
- `.thumbnails/` directory is writable
