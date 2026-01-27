# Recovery Features - Testing Guide

## Quick Start Testing

### Prerequisites
1. Start the Flask server: `python3 app.py`
2. Open browser to `http://localhost:5001`

---

## Test 1: Rebuild Database (Small Library)

**Purpose:** Test the basic rebuild flow with a warning-free library

**Steps:**
1. Click utilities menu (⚙️ icon in top right)
2. Click "Rebuild database"
3. Overlay appears with "Scanning library" spinner
4. If < 1000 files:
   - Shows "Ready to rebuild database. Found X files."
   - Click "Proceed"
5. Progress shows: "Rebuilding database" with indexed count
6. On completion: "✅ Database rebuilt successfully!"
7. Click "Done"
8. Photos reload automatically

**Expected Results:**
- ✅ Smooth flow, no errors
- ✅ Progress updates in real-time
- ✅ Final count matches file count
- ✅ All photos visible after reload

---

## Test 2: Rebuild Database (Large Library Warning)

**Purpose:** Test the warning modal for libraries with 1000+ files

**Steps:**
1. Use a library with >= 1000 files
2. Click utilities → "Rebuild database"
3. After scan, dialog appears:
   - Title: "Large library detected"
   - Message: "Your library contains X photos. Rebuilding will take..."
   - Buttons: [Cancel] [Continue]
4. Click "Cancel" → overlay closes, nothing happens
5. Try again, click "Continue" → rebuild proceeds

**Expected Results:**
- ✅ Warning shows correct file count
- ✅ Time estimate is reasonable (count / 150 files/minute)
- ✅ Cancel works without side effects
- ✅ Continue proceeds to rebuild

---

## Test 3: Rebuild with Missing Database

**Purpose:** Test recovery when database file is missing

**Setup:**
```bash
# Backup and remove database
cp /path/to/photo_library.db /tmp/backup.db
rm /path/to/photo_library.db
```

**Steps:**
1. Restart Flask server
2. Try to access app → errors occur
3. OR manually trigger rebuild database
4. Should create new database automatically
5. Rebuild should proceed normally

**Expected Results:**
- ✅ Database created in correct location
- ✅ Schema applied correctly
- ✅ All files indexed
- ✅ EXIF dates extracted
- ✅ Dimensions populated

**Cleanup:**
```bash
# Restore backup if needed
cp /tmp/backup.db /path/to/photo_library.db
```

---

## Test 4: Cancel During Rebuild

**Purpose:** Test cancellation mid-process

**Steps:**
1. Start rebuild on large library
2. Let it run for a few seconds (some files indexed)
3. Close browser tab or click cancel (if we add it)
4. Check server logs

**Expected Results:**
- ✅ Server-side operation continues even if browser closes
- ✅ No corrupted database state
- ⚠️ Note: Currently no mid-stream cancel - operation runs to completion

---

## Test 5: Critical Error Modal (Manual Testing)

**Purpose:** Test error modal appearance and actions

**Simulate Database Missing:**
```javascript
// In browser console:
showCriticalError(
  'Database missing',
  'Your library is missing the file needed to display and keep track of your photos. To continue, you can rebuild the database or switch to a different library.',
  [
    { text: 'Switch library', action: 'switch_library', primary: false },
    { text: 'Rebuild database', action: 'rebuild_database', primary: true }
  ]
);
```

**Expected Results:**
- ✅ Modal appears, blocks interaction
- ✅ No X button (can't dismiss)
- ✅ "Rebuild database" button triggers rebuild flow
- ✅ "Switch library" button opens library picker

**Simulate Library Missing:**
```javascript
showCriticalError(
  'Library folder not found',
  "Can't access your library: /Volumes/eric_files/photo_library_test\n\nYour library folder is no longer accessible. This usually means a drive was disconnected.",
  [
    { text: 'Switch library', action: 'switch_library', primary: false },
    { text: 'Retry connection', action: 'retry', primary: true }
  ]
);
```

**Expected Results:**
- ✅ Modal shows path clearly
- ✅ "Retry" checks and reloads if accessible
- ✅ "Switch library" opens picker

---

## Test 6: Progress Tracking

**Purpose:** Verify progress updates work correctly

**Steps:**
1. Start rebuild on library with ~500 files (good for watching progress)
2. Watch the overlay stats
3. Check browser console for event logs

**Expected Results:**
- ✅ "Indexed" count increments
- ✅ "Total Files" shows correct count
- ✅ Status updates: "Indexing files" → "Cleaning up"
- ✅ Console shows SSE events: progress, complete

---

## Test 7: Multiple Operations

**Purpose:** Test rebuild after other operations

**Steps:**
1. Import some photos
2. Delete some photos
3. Run "Update library index"
4. Run "Rebuild database"
5. Verify all operations work correctly

**Expected Results:**
- ✅ Operations don't interfere
- ✅ Rebuild shows all current files
- ✅ No duplicates or missing entries

---

## Test 8: Network/Server Errors

**Purpose:** Test error handling

**Simulate:**
1. Stop Flask server mid-rebuild
2. Network timeout
3. Invalid response

**Expected Results:**
- ✅ Error messages displayed
- ✅ No infinite spinners
- ✅ User can close overlay

---

## Backend Verification

**Check Database After Rebuild:**
```bash
sqlite3 /path/to/photo_library.db

# Count records
SELECT COUNT(*) FROM photos;

# Check EXIF dates populated
SELECT COUNT(*) FROM photos WHERE date_taken IS NOT NULL;

# Check dimensions populated
SELECT COUNT(*) FROM photos WHERE width IS NOT NULL AND height IS NOT NULL;

# Sample records
SELECT id, original_filename, date_taken, width, height, file_type 
FROM photos 
LIMIT 10;
```

**Check Server Logs:**
```bash
tail -f /path/to/library/.logs/app.log
tail -f /path/to/library/.logs/import_*.log
```

Look for:
- ✅ "LIBRARY SYNC (full mode): Scanning filesystem..."
- ✅ "Found X files on disk"
- ✅ "Full rebuild: indexing all X files"
- ✅ Progress messages
- ✅ "✅ Library sync (full mode) complete"

---

## Performance Benchmarks

**Expected Processing Speed:** ~150 files/minute

| Library Size | Expected Time | Test Result |
|--------------|---------------|-------------|
| 100 files    | < 1 minute    |             |
| 1,000 files  | ~7 minutes    |             |
| 10,000 files | ~67 minutes   |             |
| 60,000 files | ~7 hours      |             |

**Factors affecting speed:**
- Drive type (SSD vs HDD vs Network)
- File sizes
- EXIF complexity
- CPU speed

---

## Known Limitations

1. **No mid-stream cancel**: Once rebuild starts, it runs to completion
2. **App blocks during rebuild**: Database locked, other operations wait
3. **No resume**: If interrupted, must start over
4. **Memory usage**: Large libraries may use significant memory during scan

---

## Troubleshooting

### Rebuild Fails Immediately
- Check: Library path accessible?
- Check: Permissions to create database?
- Check: Disk space available?

### Progress Stops/Hangs
- Check: Server still running?
- Check: Network drive still connected?
- Check: Browser console for errors

### Incorrect File Count
- Check: Hidden files excluded? (expected)
- Check: Only media files counted? (expected)
- Check: Subdirectories scanned? (expected)

### Missing EXIF Data
- Check: `exiftool` installed?
- Check: File formats supported?
- Note: Falls back to file modification time

---

## Success Criteria

✅ **All tests pass**
✅ **No console errors**
✅ **Database schema correct**
✅ **All files indexed**
✅ **EXIF dates extracted**
✅ **Dimensions populated**
✅ **UI responsive**
✅ **Error messages helpful**

