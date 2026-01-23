# Date Edit Bug Investigation Summary

**Date:** January 23, 2026  
**Status:** Root cause identified, fix ready to implement  
**Affected Feature:** Date editing with file operations (EXIF write + rename + move)

---

## Problem Statement

**User reported behavior:**
```
blank library -> import photo -> change year -> 
  ✅ new year folder created (good)
  ❌ YYYY-MM folder created (bad, should be YYYY-MM-DD)
  ✅ photo moved to new folder (good)
  ❌ photo reverts to original name (bad)
  ❌ old empty year folder/subfolder remains (bad)
  
-> rebuild database -> 
  ❌ photo moved to old date in grid (bad)
  ✅ photo remains in new date folder (good)
```

**Expected behavior:**
- Date change should write EXIF to file
- File should move to `YYYY/YYYY-MM-DD` folder structure
- File should be renamed with new date in filename
- Old empty folders should be cleaned up
- Database rebuild should show the new date (from EXIF)

---

## Root Causes Identified

### 1. **File Type Mismatch (PRIMARY BUG)**

**The Issue:**
Import code uses `file_type = 'image'`, but date edit code checks `if file_type == 'photo'`.

**Location:**
- Import: `app.py` line ~1793: `file_type = 'video' if ext.lower() in VIDEO_EXTENSIONS else 'image'`
- Date edit: `app.py` line ~452: `if file_type == 'photo':`

**Impact:**
EXIF write code never executes. Photos are treated as unknown file type.

**Evidence:**
```sql
sqlite3> SELECT file_type FROM photos;
image  ← Database stores 'image'
```

```python
# Date edit code checks:
if file_type == 'photo':  ← Never matches!
    write_photo_exif(...)
```

Debug logging added to `write_photo_exif()` never appeared in logs, confirming the function never ran.

---

### 2. **Duplicate Function Definitions (FIXED)**

**The Issue:**
`get_date_folder()` was defined 3 times in `app.py`. Python used the last definition, which returned the OLD format `YYYY/YYYY-MM`.

**Locations:**
- Line 283 (intended fix - correct format)
- Line 290 (duplicate - wrong format)  
- Line 372 (duplicate - wrong format) ← This one was active

**Impact:**
Files moved to wrong folder structure missing day component.

**Resolution:**
Removed duplicates at lines 290 and 372. Only one definition remains at line 304 with correct `YYYY/YYYY-MM-DD` format.

---

### 3. **Wrong Database Column Used (FIXED)**

**The Issue:**
Date edit code used `row['original_filename']` which stores the pre-import filename, not the current filename on disk.

**Example:**
```
Pre-import:      import-test_000.jpg
Current on disk: img_20260122_9d6d2dc.jpg  
Database stores: original_filename = "import-test_000.jpg"
                current_path = "2026/2026-01-22/img_20260122_9d6d2dc.jpg"
```

Code tried to parse `import-test_000.jpg` looking for date/hash, failed, and kept the old name.

**Resolution:**
Changed to: `old_filename = os.path.basename(row['current_path'])`

Now correctly gets `img_20260122_9d6d2dc.jpg` from current path.

---

### 4. **Filename Parsing Failed on Collision-Resolved Files (FIXED)**

**The Issue:**
Import adds counter suffix for filename collisions: `img_20260122_abc12345_2.jpg`

Old parsing code:
```python
parts = filename.split('_')
hash_and_ext = parts[2]  # Gets "abc12345" but loses "_2.jpg"
```

**Resolution:**
New parsing code:
```python
remainder = '_'.join(parts[2:])  # Joins "abc12345_2.jpg"
hash_part, ext = os.path.splitext(remainder)  # Correctly splits
```

Now handles counters correctly.

---

### 5. **No Empty Folder Cleanup (FIXED)**

**The Issue:**
After moving a file, old `YYYY/YYYY-MM-DD` and `YYYY/` folders remained empty.

**Resolution:**
Added cleanup logic after file move:
```python
try:
    old_dir = os.path.dirname(old_full_path)
    if os.path.isdir(old_dir) and not os.listdir(old_dir):
        os.rmdir(old_dir)
        year_dir = os.path.dirname(old_dir)
        if os.path.isdir(year_dir) and not os.listdir(year_dir):
            os.rmdir(year_dir)
except Exception as e:
    print(f"  ⚠️  Couldn't clean up empty folders: {e}")
```

Non-critical errors don't fail the operation.

---

## What Was Fixed (v131)

**Changes made to `app.py`:**

1. ✅ Fixed `get_date_folder()` to return `YYYY/YYYY-MM-DD` format
2. ✅ Removed duplicate function definitions (was defined 3x, now 1x)
3. ✅ Fixed `parse_filename()` to handle collision counters
4. ✅ Changed filename source from `original_filename` to `current_path`
5. ✅ Added fallback for unparseable filenames (generates canonical name)
6. ✅ Added empty folder cleanup after file move
7. ✅ Added EXIF write verification (reads back to confirm write succeeded)
8. ✅ Added debug logging to trace EXIF operations

**Changes made to `main.js`:**
- Updated version to v131

---

## The Remaining Bug

**File type mismatch:** `'image'` vs `'photo'`

**Current code path:**
```python
# Line ~452
if file_type == 'photo':          # Never matches
    write_photo_exif(...)
else:                              # Always goes here
    write_video_metadata(...)      # Wrong function for images!
```

**This causes:**
1. EXIF never written to photos
2. Videos might get wrong metadata writes (untested)
3. Database rebuild reads old/missing EXIF, shows wrong date

---

## Recommended Next Steps

### IMMEDIATE FIX (5 minutes)

**Option A: Change the check to match reality**
```python
# Line ~452
if file_type == 'image':  # Match what import uses
    write_photo_exif(...)
elif file_type == 'video':
    write_video_metadata(...)
```

**Option B: Standardize on 'photo' everywhere**
```python
# Line ~1793 in import
file_type = 'video' if ext.lower() in VIDEO_EXTENSIONS else 'photo'

# Requires schema migration for existing databases
```

**Recommendation:** Option A (faster, no migration needed)

### FOLLOW-UP IMPROVEMENTS

1. **Write EXIF during import** (30-60 min)
   - Ensures all imported files have date metadata
   - Prevents date edit failures on files without EXIF structure
   - Makes "truth in media" philosophy complete
   
   Add after line ~1772 (after file copy):
   ```python
   # Write EXIF if not present
   if not extract_exif_date(target_path):
       try:
           write_photo_exif(target_path, date_taken)
       except Exception as e:
           print(f"   ⚠️  Could not write EXIF: {e}")
   ```

2. **Clean up `original_filename` column** (1-2 hours)
   - Remove from schema (it's redundant with `current_path`)
   - Or repurpose to store current filename (not pre-import name)
   - Requires schema migration + update all code that uses it

3. **Test with real photos** (critical!)
   - Current testing used synthetic image without EXIF
   - Need to verify with actual JPEG/HEIC photos from camera
   - Test edge cases: PNG, GIF, various video formats

---

## Important Context

### Philosophy: "Truth in Media"

The app treats files as source of truth, not the database. This means:
- Date changes MUST write to file metadata (EXIF)
- Filename MUST reflect date (`img_YYYYMMDD_hash.ext`)
- Folder structure MUST reflect date (`YYYY/YYYY-MM-DD/`)
- Database is derived from files, not vice versa

**Implication:** Date editing isn't just a database update. It's a file operation that modifies:
1. EXIF metadata
2. Filename
3. File location
4. Database (last, derived from above)

### Test File Issue

The test file (`import-test_000.jpg`) is a synthetic image from a graphics program:
- No EXIF data initially
- Can accept EXIF writes (manually verified with exiftool)
- But edge case that revealed the file type bug

Real photos from cameras/phones have EXIF natively, so this bug might not have been caught in production use.

### File Type Consistency

**Current state:**
- Database stores: `'image'` or `'video'`
- UI might use: `'photo'` terminology
- Code inconsistently checks both

**Need to decide:**
- Standardize on `'photo'/'video'` OR `'image'/'video'`
- Update all code/schema/docs to match
- Consider migration path for existing databases

---

## Testing Checklist

After implementing the fix:

- [ ] Import a real photo (JPEG with EXIF)
- [ ] Change its date
- [ ] Verify EXIF written (check with exiftool manually)
- [ ] Verify filename updated with new date
- [ ] Verify moved to correct `YYYY/YYYY-MM-DD` folder
- [ ] Verify old folders cleaned up
- [ ] Rebuild database
- [ ] Verify photo appears at new date in grid
- [ ] Test with multiple file types (HEIC, PNG, MOV, MP4)
- [ ] Test with synthetic images (no EXIF initially)
- [ ] Test bulk date edit (multiple photos)
- [ ] Test date edit on filename with collision counter (`_2`, `_3`)

---

## Questions/Decisions Needed

1. **File type naming:** Standardize on `'photo'` or `'image'`?

2. **Import EXIF write:** Should import write EXIF to files lacking it? (Recommended: YES)

3. **Schema cleanup:** Remove/repurpose `original_filename` column? (Lower priority)

4. **Error handling:** What should happen if EXIF write fails?
   - Current: Transaction rolls back, file returns to original state
   - Alternative: Keep file operations, warn user about EXIF failure?

---

## Files Modified

- `app.py` (multiple functions, ~100 lines changed)
- `static/js/main.js` (version bump to v131)

## Branches/Versions

- Working code: v131
- Next version after fix: v132 (suggested)

---

**END OF SUMMARY**
