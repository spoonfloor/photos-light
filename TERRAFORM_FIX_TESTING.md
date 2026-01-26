# Terraform Fix - Testing Guide

**Version:** v188  
**Date:** January 26, 2026  
**Fixes:** Row factory bug + source folder cleanup

---

## What Was Fixed

### Bug #1: Crash on Duplicates
**Problem:** Missing `conn.row_factory = sqlite3.Row` caused crash when accessing `existing['id']`  
**Fix:** Added row_factory at line 3807  
**Result:** Duplicate detection now works correctly

### Bug #2: Source Folders Not Deleted
**Problem:** Cleanup couldn't distinguish source folders from organized folders, skipped hidden folders  
**Fix:** Track source folders during scan, use aggressive `shutil.rmtree()` cleanup  
**Result:** Source folders deleted, organized folders preserved

---

## Test Plan

### Test 1: Basic Terraform (No Duplicates)
**Purpose:** Verify basic functionality still works

**Setup:**
1. Create test folder: `test-terraform-basic/`
2. Add 10 fresh photos (different from any in library)
3. Mix of JPG, HEIC, MOV

**Steps:**
1. Run terraform on `test-terraform-basic/`
2. Observe progress (should process all 10)
3. Check results

**Expected:**
- ✅ All 10 files processed successfully
- ✅ Files organized into `YYYY/YYYY-MM-DD/` structure
- ✅ Database has 10 new records
- ✅ `test-terraform-basic/` folder deleted (empty of media)
- ✅ No errors in manifest log

**Verify:**
```bash
cd /path/to/library
# Check organized structure
ls 2026/  # Should show date folders
# Check database
sqlite3 photo_library.db "SELECT COUNT(*) FROM photos;"
# Check source folder deleted
ls test-terraform-basic/  # Should not exist or be empty
```

---

### Test 2: Terraform with Duplicates (THE CRITICAL FIX)
**Purpose:** Verify duplicate detection works (was crashing before)

**Setup:**
1. Create test folder: `test-terraform-dupes/`
2. Copy 5 photos that ALREADY exist in library
3. These must have identical content_hash to existing photos

**Steps:**
1. Run terraform on `test-terraform-dupes/`
2. Observe progress (should detect 5 duplicates)
3. Check results

**Expected:**
- ✅ All 5 files detected as duplicates
- ✅ Files moved to `.trash/duplicates/`
- ✅ Duplicate count = 5, processed count = 0
- ✅ NO crash with "tuple indices" error
- ✅ `test-terraform-dupes/` folder deleted

**Verify:**
```bash
cd /path/to/library
# Check duplicates in trash
ls .trash/duplicates/  # Should have 5 files
# Check manifest log
tail -50 .logs/terraform_*.jsonl | grep duplicate
# Check source folder deleted
ls test-terraform-dupes/  # Should not exist
```

**CRITICAL:** This test MUST pass - it was the crash scenario

---

### Test 3: Already-Terraformed Library (COMPLEX SCENARIO)
**Purpose:** Verify source vs organized folder detection

**Setup:**
1. Create: `source-with-organized/2026/2026-01-22/`
2. Add 10 photos to this nested structure
3. Also create: `2026/2026-01-22/` with different 10 photos (at root level)

**Steps:**
1. Run terraform on library containing both folders
2. Observe how it handles each

**Expected:**
- ✅ Files from `source-with-organized/2026/2026-01-22/` processed
- ✅ `source-with-organized/` deleted entirely (including nested structure)
- ✅ `2026/2026-01-22/` at root level PRESERVED (organized structure)
- ✅ Total files = 20 (10 from source + 10 already organized)

**Verify:**
```bash
cd /path/to/library
# Check organized folder preserved
ls 2026/2026-01-22/  # Should have photos
# Check source folder deleted
ls source-with-organized/  # Should not exist
# Check database
sqlite3 photo_library.db "SELECT COUNT(*) FROM photos WHERE current_path LIKE '2026/2026-01-22/%';"
```

**CRITICAL:** This tests the pattern matching logic

---

### Test 4: Source Folder with Hidden Subdirectories
**Purpose:** Verify aggressive cleanup removes hidden folders

**Setup:**
1. Create: `test-with-hidden/`
2. Add `.thumbnails/` subdirectory with files inside
3. Add `.DS_Store` file
4. Add 5 photos

**Steps:**
1. Run terraform on `test-with-hidden/`
2. Check cleanup

**Expected:**
- ✅ 5 photos processed and moved
- ✅ Entire `test-with-hidden/` folder deleted
- ✅ Including `.thumbnails/` subdirectory
- ✅ Including `.DS_Store` file

**Verify:**
```bash
cd /path/to/library
# Check source folder completely gone
ls -la test-with-hidden/  # Should not exist
# Verify photos moved
ls 2026/*/img_*.jpg | wc -l  # Should include the 5 new photos
```

**CRITICAL:** This tests shutil.rmtree() vs os.rmdir()

---

### Test 5: Mixed Success and Failures
**Purpose:** Verify partial cleanup behavior

**Setup:**
1. Create: `test-mixed/`
2. Add 8 good photos
3. Add 2 corrupt files (fake jpgs)

**Steps:**
1. Run terraform on `test-mixed/`
2. Check results

**Expected:**
- ✅ 8 good photos processed
- ✅ 2 corrupt files moved to `.trash/exif_failed/`
- ✅ `test-mixed/` folder deleted (no media remains)
- ✅ Manifest shows: 8 processed, 2 errors

**Verify:**
```bash
cd /path/to/library
# Check processed photos
ls 2026/*/img_*.jpg | tail -8
# Check failed files
ls .trash/exif_failed/
# Check source folder deleted
ls test-mixed/  # Should not exist
```

---

### Test 6: Real-World Scenario (User's Contaminated Library)
**Purpose:** Test on actual problematic library structure

**Current state of `/Users/erichenry/Desktop/--test-lib`:**
- 313 photos in database
- `terraform-me/` folder (should be empty but has `.thumbnails/`)
- `blank-lib-for-import-test/` folder with 908 files
- `Photo Library/` empty folder
- 326 files in `.trash/errors/`

**Steps:**
1. **BACKUP FIRST:** `cp -r --test-lib --test-lib-backup`
2. Delete database: `rm --test-lib/photo_library.db`
3. Run terraform on fresh `--test-lib`
4. Compare to backup

**Expected:**
- ✅ All files scanned and processed
- ✅ `terraform-me/` deleted
- ✅ `blank-lib-for-import-test/` deleted
- ✅ `Photo Library/` deleted
- ✅ Organized structure preserved
- ✅ Database has all media tracked

**Verify:**
```bash
cd /Users/erichenry/Desktop/--test-lib
# Check source folders gone
ls terraform-me/  # Should not exist
ls blank-lib-for-import-test/  # Should not exist
ls "Photo Library"/  # Should not exist
# Check organized structure intact
ls 2016/ 2017/ 2025/ 2026/
# Check database
sqlite3 photo_library.db "SELECT COUNT(*) FROM photos;"
# Compare to manifest
tail -1 .logs/terraform_*.jsonl
```

---

## Test Matrix Summary

| Test | Purpose | Status | Critical? |
|------|---------|--------|-----------|
| 1. Basic terraform | Verify no regression | ⬜ Pending | No |
| 2. Duplicates | Verify crash fix | ⬜ Pending | **YES** |
| 3. Already-terraformed | Verify pattern matching | ⬜ Pending | **YES** |
| 4. Hidden folders | Verify aggressive cleanup | ⬜ Pending | **YES** |
| 5. Mixed results | Verify partial cleanup | ⬜ Pending | No |
| 6. Real-world | Verify user's scenario | ⬜ Pending | **YES** |

**Minimum for release:** Tests 2, 3, 4, 6 must pass

---

## Known Limitations

1. **Non-media files in source folders:** Will be deleted with folder
2. **Extremely nested structures:** Pattern matching checks exact depth (2 levels)
3. **Custom folder names:** If user has folder named "2026" as source, might be confused with year folder
4. **Concurrent terraform runs:** No locking mechanism (don't run multiple simultaneously)

---

## Rollback Plan

If terraform fails catastrophically:

1. **Restore from backup:**
   ```bash
   rm -rf /path/to/library
   cp -r /path/to/library-backup /path/to/library
   ```

2. **Check manifest log:**
   ```bash
   cat .logs/terraform_*.jsonl | jq .
   ```
   - Find last successful operation
   - Manually move files if needed

3. **Revert code:**
   ```bash
   git revert HEAD
   ```

---

## Success Criteria

✅ All critical tests pass (2, 3, 4, 6)  
✅ No crashes or Python errors  
✅ Duplicates go to correct trash folder  
✅ Source folders deleted  
✅ Organized folders preserved  
✅ User's contaminated library cleaned up

---

## Next Steps After Testing

1. Test all scenarios above
2. Document any failures or edge cases discovered
3. If all pass: Mark bug as fixed in tracker
4. If failures: Investigate and fix before closing
