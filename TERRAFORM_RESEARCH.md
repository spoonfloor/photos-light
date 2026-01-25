# Terraform Feature - Research & Specification

**Date:** 2026-01-25  
**Status:** Research Complete  
**Purpose:** Enable non-destructive, in-place conversion of existing photo collections to app-compliant structure

---

## Executive Summary

This feature will allow users to "terraform" an existing messy photo collection (from Apple Photos, Google Takeout, old file systems, etc.) into a compliant library **by reorganizing files in-place** (no copying). This is critical for large collections (100GB+) where copying is impractical.

**⚠️ CRITICAL:** Terraform WILL modify files by writing EXIF metadata. This is required for the app to function correctly. Users must be warned this is a one-way operation and advised to make backups first.

---

## Current App Conventions (Discovered)

### 1. File Naming Convention

**Pattern:** `img_YYYYMMDD_XXXXXXXX.ext`

- Prefix: `img_` for all media (photos and videos)
- Date: `YYYYMMDD` format (e.g., `20250115`)
- Hash: 8-character content hash (first 8 chars of SHA-256)
- Extension: Lowercase (e.g., `.jpg`, `.mov`, `.heic`)

**Examples:**
```
img_20250115_a3f8d92c.jpg
img_20241225_e0d7504.mov
img_20230601_1b3c5d7.heic
```

**Collision handling:**
If file exists, append counter: `img_20250115_a3f8d92c_1.jpg`

**Code reference:** `app.py` lines 2064-2073
```python
short_hash = content_hash[:8]
base_name = f"img_{date_obj.strftime('%Y%m%d')}_{short_hash}"
canonical_name = base_name + ext.lower()
target_path = os.path.join(target_dir, canonical_name)

# Handle naming collisions
counter = 1
while os.path.exists(target_path):
    canonical_name = f"{base_name}_{counter}{ext.lower()}"
    target_path = os.path.join(target_dir, canonical_name)
    counter += 1
```

---

### 2. Folder Structure

**Pattern:** `YYYY/YYYY-MM-DD/`

- Top level: Year folders (e.g., `2025/`)
- Second level: Date folders (e.g., `2025-01-15/`)
- Files organized by `date_taken` (EXIF or mtime fallback)

**Example:**
```
photo_library_test/
├── 2024/
│   ├── 2024-12-25/
│   │   ├── img_20241225_abc123.jpg
│   │   └── img_20241225_def456.mov
│   └── 2024-12-31/
│       └── img_20241231_xyz789.heic
├── 2025/
│   ├── 2025-01-10/
│   │   └── img_20250110_aaa111.jpg
│   └── 2025-01-15/
│       └── img_20250115_bbb222.png
```

**Code reference:** `app.py` lines 2058-2061
```python
date_obj = datetime.strptime(date_taken, '%Y:%m:%d %H:%M:%S')
year = date_obj.strftime('%Y')
date_folder = date_obj.strftime('%Y-%m-%d')
target_dir = os.path.join(LIBRARY_PATH, year, date_folder)
```

---

### 3. Hidden Folder Structure

All hidden folders use dot-prefix and live at library root:

```
photo_library_test/
├── .thumbnails/        # Thumbnail cache (hash-based sharding)
│   └── ab/
│       └── cd/
│           └── abcd1234efgh5678.jpg
├── .trash/             # Soft-deleted photos
│   └── 20260115_143022_img_xyz.jpg
├── .db_backups/        # Automatic database backups
│   └── photo_library_20260115_143022.db
├── .import_temp/       # Temporary files during import
│   └── temp_frame_abc123.jpg
└── .logs/              # Application logs
    ├── app.log
    ├── import_20260115.log
    └── errors.log
```

**Code reference:** `app.py` lines 2812-2816
```python
THUMBNAIL_CACHE_DIR = os.path.join(LIBRARY_PATH, '.thumbnails')
TRASH_DIR = os.path.join(LIBRARY_PATH, '.trash')
DB_BACKUP_DIR = os.path.join(LIBRARY_PATH, '.db_backups')
IMPORT_TEMP_DIR = os.path.join(LIBRARY_PATH, '.import_temp')
LOG_DIR = os.path.join(LIBRARY_PATH, '.logs')
```

**Thumbnail sharding:** Hash-based 2-level sharding for performance
- Pattern: `.thumbnails/AB/CD/ABCD1234567890.jpg`
- First 2 chars → first level folder
- Next 2 chars → second level folder
- Full hash → filename

---

### 4. Database Schema

**Table: `photos`**
```sql
CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_filename TEXT NOT NULL,           -- Original name (preserved)
    current_path TEXT NOT NULL UNIQUE,         -- Relative path in library
    date_taken TEXT,                           -- EXIF or mtime (YYYY:MM:DD HH:MM:SS)
    content_hash TEXT NOT NULL UNIQUE,         -- Full SHA-256 hash
    file_size INTEGER NOT NULL,                -- Bytes
    file_type TEXT NOT NULL,                   -- 'image' or 'video'
    width INTEGER,                             -- Display width (post-EXIF rotation)
    height INTEGER                             -- Display height (post-EXIF rotation)
)
```

**Table: `deleted_photos`**
```sql
CREATE TABLE IF NOT EXISTS deleted_photos (
    id INTEGER PRIMARY KEY,                    -- Original photo ID
    original_path TEXT NOT NULL,               -- Path before deletion
    trash_filename TEXT NOT NULL,              -- Filename in .trash/
    deleted_at TEXT NOT NULL,                  -- ISO timestamp
    photo_data TEXT NOT NULL                   -- JSON snapshot of photo record
)
```

**Indices:**
- `idx_content_hash` on `photos(content_hash)` - Fast duplicate detection
- `idx_date_taken` on `photos(date_taken)` - Fast chronological queries
- `idx_file_type` on `photos(file_type)` - Fast filtering

**Code reference:** `db_schema.py`

---

### 5. Supported File Types

**Photos:**
```python
PHOTO_EXTENSIONS = {
    '.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.bmp', '.tiff', '.tif',
    '.webp', '.avif', '.jp2',
    '.raw', '.cr2', '.nef', '.arw', '.dng'
}
```

**Videos:**
```python
VIDEO_EXTENSIONS = {
    '.mov', '.mp4', '.m4v', '.mkv',
    '.wmv', '.webm', '.flv', '.3gp',
    '.mpg', '.mpeg', '.vob', '.ts', '.mts', '.avi'
}
```

**Unsupported files:** Moved to `.trash/` during terraform

**Code reference:** `app.py` lines 72-82

---

## Terraform Operation Specification

### Input
- Folder path with existing photos (any structure, any naming)
- May contain subfolders (recursive scan)
- May contain unsupported files
- May contain duplicates

### Output
- Compliant folder structure (`YYYY/YYYY-MM-DD/`)
- Compliant file naming (`img_YYYYMMDD_XXXXXXXX.ext`)
- SQLite database with all metadata indexed
- Hidden folder structure (`.thumbnails/`, `.trash/`, etc.)
- Unsupported files and duplicates moved to `.trash/`

### Operations (In Order)

1. **Scan Phase**
   - Recursive walk of folder
   - Count supported media files
   - Estimate duration (150 files/minute)
   - Show confirmation dialog with count and estimate

2. **Process Phase** (SSE streaming progress)
   - For each file:
     - Compute SHA-256 hash (full, not just first 7 chars)
     - Check for duplicate in DB (by hash)
     - Extract EXIF date (fallback to mtime)
     - Get dimensions (with EXIF orientation handling)
     - **Write EXIF metadata to file** (required for app functionality)
     - Compute new hash (post-EXIF write)
     - Generate canonical filename
     - Create target folder structure
     - **Move** (not copy) file to new location
     - Insert record into database
   - Unsupported files → move to `.trash/unsupported/`
   - Duplicates → move to `.trash/duplicates/`
   - EXIF write failures → move to `.trash/exif_failed/` + log error

3. **Cleanup Phase**
   - Remove empty folders (recursive, like library sync)
   - Create hidden folder structure
   - Generate initial manifest/log

4. **Completion**
   - Show summary (moved, duplicates, unsupported, errors)
   - Reload app to show new library

### Safety Features

1. **Pre-flight checks:**
   - Verify folder is writable
   - Verify sufficient disk space (for DB + hidden folders)
   - Warn user this is irreversible
   - Require explicit confirmation

2. **Manifest log:**
   - Create `.logs/terraform_YYYYMMDD_HHMMSS.json`
   - Record every file move: `original_path → new_path`
   - Record every rejection: `path + reason`
   - Enables manual recovery if needed

3. **Atomic operations:**
   - Insert DB record BEFORE moving file
   - On error: delete DB record, don't move file
   - Use try/except with rollback on failure

4. **Error handling:**
   - Permission errors → skip file, log error
   - Corrupt files → move to `.trash/corrupted/`
   - Hash collision → append counter to filename

---

## Integration with "Browse" Flow

When user clicks "Browse" in "Open library" dialog:

1. **User selects folder**
2. **App detects folder contents:**
   - Has `photo_library.db` → Open existing library (existing behavior)
   - Empty or no media → Offer "Create new library here" (existing behavior)
   - Has media files but no DB → **NEW:** Offer "Terraform this folder"

3. **Terraform dialog:**
   ```
   ┌─────────────────────────────────────────────────┐
   │  Terraform folder into library?                  │
   │                                                  │
   │  This will reorganize 1,234 photos in place:     │
   │  • Write EXIF metadata to all files              │
   │  • Rename all photos to standard format          │
   │  • Organize into YYYY/YYYY-MM-DD folders         │
   │  • Move duplicates and unsupported files to      │
   │    .trash/ folder                                │
   │                                                  │
   │  ⚠️  WARNING: This will modify your files and    │
   │  folder structure. This cannot be undone.        │
   │                                                  │
   │  ⚠️  IMPORTANT: Make a backup before proceeding! │
   │                                                  │
   │  Estimated time: 8-10 minutes                    │
   │                                                  │
   │  [Cancel]  [Create New Instead]  [Terraform]     │
   └─────────────────────────────────────────────────┘
   ```

4. **If user clicks "Terraform":**
   - Create DB at `folder_path/photo_library.db`
   - Run terraform operation with SSE progress
   - On completion, reload app with new library

---

## API Endpoints to Create

### `POST /api/library/terraform`

**Request:**
```json
{
  "library_path": "/Users/eric/OldPhotos"
}
```

**Response (SSE stream):**
```
event: start
data: {"total_files": 1234, "estimated_minutes": 8}

event: progress
data: {"phase": "processing", "current": 50, "total": 1234, "file": "IMG_1234.jpg"}

event: progress
data: {"phase": "processing", "current": 51, "total": 1234, "duplicate": true}

event: complete
data: {
  "processed": 1200,
  "duplicates": 25,
  "unsupported": 9,
  "errors": 0,
  "manifest_path": ".logs/terraform_20260115_143022.json"
}
```

### `POST /api/library/check`

**Enhancement:** Add `has_media` field to response

**Current response:**
```json
{
  "exists": false,
  "library_path": "/Users/eric/OldPhotos"
}
```

**New response:**
```json
{
  "exists": false,
  "has_media": true,
  "media_count": 1234,
  "library_path": "/Users/eric/OldPhotos"
}
```

---

## Code Changes Required

### Backend (`app.py`)

1. **New route:** `/api/library/terraform` (SSE streaming)
2. **Enhanced route:** `/api/library/check` (add media detection)
3. **New function:** `terraform_library_generator()` (similar to `synchronize_library_generator`)
4. **New function:** `count_media_files_recursive()` (reuse from `library_sync.py`)

### Frontend (`main.js`)

1. **Enhanced function:** `browseSwitchLibrary()` - Detect media and show terraform option
2. **New function:** `showTerraformDialog()` - Confirmation dialog with estimate
3. **New function:** `executeTerraform()` - SSE progress handling
4. **New overlay:** `terraformOverlay.html` - Progress UI (reuse import overlay pattern)

### Database (`db_schema.py`)

No changes needed - existing schema supports terraform operation.

---

## Testing Checklist

1. **Empty folder:** Should offer "Create new library"
2. **Folder with DB:** Should open existing library
3. **Folder with photos:** Should offer "Terraform"
4. **Nested photos:** Should recurse and find all
5. **Duplicates:** Should detect and move to trash
6. **Unsupported files:** Should move to trash
7. **Name collisions:** Should append counter
8. **Permission errors:** Should skip and log
9. **Corrupt files:** Should move to trash
10. **Manifest log:** Should record all operations

---

## Open Questions & Decisions

### Q1: What about EXIF writing?
**Decision:** Terraform MUST write EXIF data to all files, just like import does.

**Rationale:** 
- The app requires EXIF metadata to function correctly
- Import always writes EXIF (and rolls back on failure)
- Terraform must follow the same pattern for consistency
- Users will be warned prominently and advised to backup first
- Files that fail EXIF write → moved to `.trash/exif_failed/`

**Process:**
1. Read existing EXIF or use mtime as fallback
2. Write standardized EXIF to file (using exiftool/ffmpeg)
3. Rehash file (content changed after EXIF write)
4. If write fails → move to trash, log error, continue

### Q2: What about manual date changes?
**Decision:** User can manually change dates AFTER terraform using the Date Editor (existing feature). Terraform just uses whatever date it finds (EXIF or mtime).

### Q3: What if user cancels mid-terraform?
**Decision:** No cancel button. Operation runs to completion. User must wait.

**Rationale:** 
- File moves are atomic per-file
- Partial completion is recoverable (manifest log exists)
- Adding cancel logic is complex (need to track what's been moved)
- Estimated duration shown upfront (user can decide before starting)

### Q4: What about video thumbnails?
**Decision:** Thumbnails are generated on-demand (lazy loading), not during terraform.

**Rationale:** Terraform focuses on organizing files. Thumbnail generation happens naturally when user browses.

---

## Success Criteria

- ✅ User can select folder with 10k+ messy photos
- ✅ User is warned about EXIF writing and advised to backup
- ✅ App writes EXIF metadata to all files
- ✅ App reorganizes files into compliant structure in-place
- ✅ No files copied (only moved)
- ✅ All supported files indexed in database
- ✅ Duplicates detected and moved to trash
- ✅ Unsupported files moved to trash
- ✅ EXIF write failures moved to trash (with error log)
- ✅ Progress shown with accurate estimates
- ✅ Manifest log created for recovery
- ✅ App loads new library automatically

---

## Future Enhancements (Not in Scope)

- Dry-run mode (preview changes without executing)
- Undo/rollback using manifest log
- Resume capability (for interrupted terraforms)
- Parallel processing (currently sequential)
- Custom naming patterns (currently hard-coded)

---

## Related Documentation

- **TERRAFORM_FAILURE_MODES.md** - Comprehensive failure analysis and existing protections from import code
  - All error categories and handling patterns
  - RAW file handling decisions
  - Live Photo pair detection
  - Pre-flight check requirements
  - Safety protocols

## Estimated Implementation Effort

- **Backend (terraform logic):** 6-8 hours (includes pre-flight checks, manifest logging)
- **Frontend (dialog + progress):** 2-3 hours
- **Testing:** 3-4 hours (includes RAW files, edge cases)
- **Documentation:** 1 hour

**Total:** 12-16 hours

---

## Next Steps

1. Get user approval on specification
2. Implement backend `/api/library/terraform` endpoint
3. Implement frontend detection and dialog
4. Test with small test folder (100 photos)
5. Test with large folder (10k+ photos)
6. Update documentation
7. Ship!
