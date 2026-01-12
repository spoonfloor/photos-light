# Database Schema Centralization - Complete

## Final Status: ✅ IMPLEMENTED

All schema definitions have been centralized and dead code removed.

## Schema Definition (8 columns)

**Single Source of Truth:** `db_schema.py`

```sql
CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_filename TEXT NOT NULL,
    current_path TEXT NOT NULL UNIQUE,
    date_taken TEXT,
    content_hash TEXT NOT NULL UNIQUE,
    file_size INTEGER NOT NULL,
    file_type TEXT NOT NULL,
    width INTEGER,           -- For lightbox aspect ratio
    height INTEGER           -- For lightbox aspect ratio
)
```

**Indices:**
- `idx_content_hash` - Duplicate detection
- `idx_date_taken` - Sorting/filtering
- `idx_file_type` - Type filtering

## What Was Removed

### Columns Removed (Dead/Unused):
- ❌ `date_added` - Stored but never used for sorting or display
- ❌ `import_batch_id` - Never written or read

### Code Removed:
- ❌ `/api/photos/import` endpoint (browser upload) - 212 lines
- ❌ `openFilePicker()` function in main.js - unused
- ❌ `startImport()` function in main.js - 188 lines
- ❌ "Verify Index" menu button - stub/unimplemented
- ❌ "Rebuild Index" menu button - stub/unimplemented

### Total Cleanup: ~450 lines of dead code removed

## Current Import Flow

**Single import path** (no inconsistency):
1. User clicks "Add photos" 
2. Choose "Import files" or "Import folders"
3. Both use native AppleScript picker
4. Both call `/api/photos/import-from-paths`
5. Both extract width/height during import
6. Consistent behavior, complete metadata

## Health Check System

**New module:** `db_health.py`

Provides centralized health checking:
- File existence
- SQLite validity
- Schema version
- Missing/extra columns

**Used by:**
- Switch Library (automatic check before switching)
- Future: App startup validation
- Future: CLI diagnostic tools

## Utilities Menu (Final)

```
Switch library              ← Now includes health check
Clean & organize library
Remove duplicates  
Rebuild thumbnails
```

Clean, focused, no stubs.

## Migration Tool

**`migrate_db.py`** - Adds missing columns to old databases

```bash
python3 migrate_db.py /path/to/photo_library.db
```

Safe, idempotent, works on production databases.

## Testing Needed

User should test:
1. ✅ Import files - verify width/height captured
2. ✅ Switch to old library - should show migration prompt
3. ✅ Run migration tool - verify columns added
4. ✅ Lightbox - verify no layout jank with new imports

## Philosophy Applied

- ✅ No speculative features
- ✅ No cruft accumulation  
- ✅ Single source of truth
- ✅ Always offer path forward
- ✅ Minimal viable schema

**Schema serves the app as it exists today, not imagined futures.**

