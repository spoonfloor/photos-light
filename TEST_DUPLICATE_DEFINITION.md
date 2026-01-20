# Test: New Duplicate Definition (Hash + Date)

## Changes Made

### 1. Schema Update (`db_schema.py`)
- Changed: `content_hash TEXT NOT NULL UNIQUE`
- To: `content_hash TEXT NOT NULL, UNIQUE(content_hash, date_taken)`
- Bumped: `SCHEMA_VERSION = 2`

**Effect:** Duplicates are now defined as same hash AND same date, not just same hash.

### 2. Import Logic Update (`app.py` line ~1345)
- Moved date extraction BEFORE duplicate check
- Changed duplicate check from: `WHERE content_hash = ?`
- To: `WHERE content_hash = ? AND date_taken = ?`

**Effect:** Import only rejects files with matching hash AND matching date.

### 3. Library Sync Logging (`library_sync.py` line ~177)
- Added logging when INSERT OR IGNORE fails
- Prints: "Skipped duplicate: {path} (same hash + date as existing photo)"

**Effect:** Rebuild/index operations now log when duplicates are skipped.

---

## Test Plan: New Library Only

**IMPORTANT:** These changes only work with NEW libraries. Existing libraries with old schema will have issues.

### Test 1: Christmas Tree Scenario (Same Hash, Different Dates)

**Setup:**
1. Find any photo file (e.g., `test.jpg`)
2. Make two copies: `test-2023.jpg` and `test-2024.jpg`

**Steps:**
1. Create a NEW blank library (delete existing `.db` file or use fresh folder)
2. Import `test-2023.jpg`
3. Check the date in the grid - note the date (likely today's date or EXIF date)
4. Open date editor, change date to: **December 25, 2023, 12:00 PM**
5. Save and verify it appears in grid at that date

6. Import `test-2024.jpg`
7. Open date editor, change date to: **December 25, 2024, 12:00 PM**
8. Save and verify it appears in grid at that date

**Expected Result:**
- ✅ Both photos appear in grid
- ✅ One at 2023-12-25, one at 2024-12-25
- ✅ Same visual photo, different dates
- ✅ Import didn't reject as duplicate (different dates)

**If it fails:**
- ❌ Second import rejected as duplicate → logic broken
- ❌ Database constraint error → schema issue

---

### Test 2: True Duplicate (Same Hash, Same Date)

**Setup:**
1. Use the same `test.jpg` from Test 1
2. Make a copy: `test-duplicate.jpg` (exact same file)

**Steps:**
1. Import `test-duplicate.jpg` to the same library
2. In date editor, set date to: **December 25, 2023, 12:00 PM** (same as first photo)
3. Try to save

**Expected Result:**
- ✅ Import rejected as duplicate
- ✅ Terminal shows: "⏭️ Duplicate (existing ID: X, same hash + date)"
- ✅ Only ONE photo appears at 2023-12-25 in grid

**If it fails:**
- ❌ Both photos appear → duplicate detection broken
- ❌ Database constraint error → schema issue

---

### Test 3: Rebuild with Duplicate File

**Setup:**
1. Manually copy a photo file to library root (your original test case)
2. Make sure it has same date as the original

**Steps:**
1. Copy `2024/2024-01-15/img_20240115_abc.jpg` to root level
2. Run: Menu → Utilities → Update Library Index
3. Check terminal output

**Expected Result:**
- ✅ Terminal shows: "⏭️ Skipped duplicate: img_20240115_abc.jpg (same hash + date as existing photo)"
- ✅ File stays at root (not deleted yet - future enhancement)
- ✅ Only one entry in database

**If it fails:**
- ❌ Two entries in database → UNIQUE constraint not working
- ❌ Error during index → constraint or logic issue

---

### Test 4: Import Same File, Different Times (Seconds Matter)

**Setup:**
1. Use `test.jpg` again

**Steps:**
1. Import file
2. Set date to: **December 25, 2023, 12:00:00** (note seconds at :00)
3. Import same file again
4. Set date to: **December 25, 2023, 12:00:01** (one second later)

**Expected Result:**
- ✅ Both photos appear (different times, even by 1 second)
- ✅ Duplicate = same hash + same date/time TO THE SECOND

**If it fails:**
- ❌ Second rejected as duplicate → date comparison too coarse (day-level instead of second-level)

---

## Known Limitations (Current Implementation)

**❌ Existing libraries will break:**
- Old schema has `content_hash UNIQUE`
- New code expects `UNIQUE(content_hash, date_taken)`
- Migration script needed (Phase 2)

**❌ Duplicate files not deleted from disk:**
- Library sync logs duplicates but doesn't delete them
- Files remain on filesystem, untracked
- Cleanup feature needed (Phase 2)

**❌ No user-facing duplicate report:**
- Duplicates only logged to terminal
- Users don't see summary of skipped duplicates
- UI enhancement needed (Phase 2)

---

## Rollback Plan

If tests fail and you need to revert:

1. **Revert schema** (`db_schema.py`):
   ```python
   SCHEMA_VERSION = 1
   content_hash TEXT NOT NULL UNIQUE
   ```

2. **Revert import logic** (`app.py`):
   ```python
   # Move date extraction back after duplicate check
   # Change WHERE clause back to: content_hash = ?
   ```

3. **Revert library sync** (`library_sync.py`):
   ```python
   # Remove logging for skipped duplicates
   ```

4. **Delete test library** and start fresh

---

## Next Steps After Testing

If tests pass:
- ✅ Document in bugs-fixed.md
- ✅ Plan Phase 2: Migration script for existing libraries
- ✅ Plan Phase 3: Delete duplicate files from disk
- ✅ Plan Phase 4: Remove "Remove Duplicates" utility
- ✅ Plan Phase 5: "Create Blank Library" feature

If tests fail:
- ❌ Debug and fix issues
- ❌ May need to revisit schema design
- ❌ May need to handle edge cases
