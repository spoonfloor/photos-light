# Hybrid Logging Setup

This app uses a **hybrid logging approach** (Option C) that combines:
- Interactive `print()` statements for real-time terminal feedback
- Persistent structured logs for debugging and auditing

## Philosophy

During active development, you need to **see what's happening immediately** (imports, errors, processing steps). But you also need **persistent history** when something goes wrong hours later.

The hybrid approach gives you both without compromise.

## Log Files Location

All logs are stored in the hidden `.logs/` directory within your library:

```
/Volumes/eric_files/photo_library_test/.logs/
├── app.log                    # General application events
├── import_YYYYMMDD.log        # Import operations (daily rotation)
└── errors.log                 # Errors and warnings only
```

## What Gets Logged

### 1. Import Logger (`import_YYYYMMDD.log`)
**Purpose:** Track all import sessions for debugging and auditing

**Events:**
- Import session started: file count
- Each file imported: filename → path (ID)
- Thumbnail generation failures
- Import session complete: summary stats

**Rotation:** 10MB max size, 30 backups

**Example:**
```
2026-01-11 10:30:15 - INFO - Import session started: 62 files
2026-01-11 10:30:18 - INFO - Imported: photo1.jpg -> 2024-05-01/img_20240501_a3f2b1c.jpg (ID: 123)
2026-01-11 10:30:45 - WARNING - Thumbnail generation failed for video_4k.mov
2026-01-11 10:32:10 - INFO - Import session complete: 58 imported, 3 duplicates, 1 errors
```

### 2. Error Logger (`errors.log`)
**Purpose:** Centralized error tracking across all operations

**Events:**
- Import failures (per-file)
- Import session aborted (backup failed, etc.)
- Delete operation failures
- Restore operation failures

**Rotation:** 10MB max size, 10 backups

**Example:**
```
2026-01-11 10:31:22 - ERROR - Import failed for corrupt.jpg: Image file is truncated
2026-01-11 14:45:10 - ERROR - Delete failed for photo 999: Photo not found
```

### 3. App Logger (`app.log`)
**Purpose:** General application events and operations

**Events:**
- Delete requests: photo count and IDs
- Successful deletions
- Restore requests: photo count and IDs
- Successful restorations

**Rotation:** 10MB max size, 10 backups

**Example:**
```
2026-01-11 11:05:30 - INFO - Delete request: 5 photos (IDs: [123, 124, 125, 126, 127])
2026-01-11 11:05:31 - INFO - Deleted photo 123: 2024-05-01/img_20240501_a3f2b1c.jpg
2026-01-11 11:10:45 - INFO - Restore request: 2 photos (IDs: [123, 124])
```

## What Stays in Terminal (print statements)

All the emoji-laden, user-friendly output stays in `print()` statements:
- 📥 Import request headers
- 📄 Processing: filename
- 🔢 Hash: xyz
- 📅 Date: 2024-05-01
- ✅ File moved to library
- 💾 Added to DB
- 🖼️ Thumbnail generated
- ⚠️ Duplicates detected
- 🗑️ Delete requests
- ↩️ Restore requests

This gives you **immediate feedback** during development and testing.

## Why Not Pure Logging?

We **didn't** replace all `print()` statements with logging because:

1. **You're actively developing** - need real-time feedback
2. **SSE streaming shows progress** - users see terminal output via UI
3. **Emojis are part of UX** - they make scanning easier
4. **No refactoring needed** - working code stays working

## When to Check Logs

**Check terminal output when:**
- Running imports/deletes in real-time
- Debugging during active development
- Watching SSE progress updates

**Check log files when:**
- Import stalled and you left your desk
- Investigating errors from hours/days ago
- Auditing what happened during batch operations
- Correlating issues with DB backup timestamps

## Log Retention

- **Import logs:** 30 backups × 10MB = ~300MB max
- **Error logs:** 10 backups × 10MB = ~100MB max
- **App logs:** 10 backups × 10MB = ~100MB max
- **Total:** ~500MB max for logging

Logs rotate automatically when they hit 10MB.

## Future Enhancements

Consider adding:
- **Access logs** for API request tracking
- **Performance logs** for slow operations
- **Metrics logs** for analytics (import speeds, file sizes, etc.)
- **Separate video processing log** if video thumbnails become a bottleneck

## Debugging Tips

**Finding import issues:**
```bash
tail -f /Volumes/eric_files/photo_library_test/.logs/import_20260111.log
```

**Finding all errors:**
```bash
cat /Volumes/eric_files/photo_library_test/.logs/errors.log | grep -i "error"
```

**Checking recent operations:**
```bash
tail -50 /Volumes/eric_files/photo_library_test/.logs/app.log
```

**Correlating with DB backups:**
```bash
ls -lt /Volumes/eric_files/photo_library_test/.db_backups/ | head -5
tail -20 /Volumes/eric_files/photo_library_test/.logs/import_20260111.log
```
