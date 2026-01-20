# Fix: Duplicate Definition Change (Hash + Date)

## Issue
Original duplicate definition was too strict: any file with the same content hash was considered a duplicate, preventing legitimate use cases like the same photo at different dates.

## Decision
**New Definition:** Duplicate = Same Hash + Same Date/Time (to the second)

This allows users to intentionally use the same photo at different dates (e.g., annual tradition photos, reference images).

## Changes Made (Step 1: New Libraries Only)

### 1. Database Schema (`db_schema.py`)
**Changed:**
```python
# Old (v1)
content_hash TEXT NOT NULL UNIQUE

# New (v2)
content_hash TEXT NOT NULL,
UNIQUE(content_hash, date_taken)
```

**Impact:**
- Same hash can exist multiple times if dates differ
- Duplicate constraint now checks BOTH hash and date
- Schema version bumped to 2

### 2. Import Logic (`app.py`)
**Changed:**
- Moved date extraction BEFORE duplicate check (was after)
- Updated duplicate query to check hash + date (was just hash)

**Before:**
```python
# Check duplicates
SELECT id FROM photos WHERE content_hash = ?

# Then extract date
date_taken = extract_exif_date(source_path)
```

**After:**
```python
# Extract date FIRST
date_taken = extract_exif_date(source_path)

# Check duplicates (hash + date)
SELECT id FROM photos WHERE content_hash = ? AND date_taken = ?
```

### 3. Library Sync Logging (`library_sync.py`)
**Added:**
```python
if cursor.rowcount > 0:
    details['untracked_files'].append(mole_path)
else:
    # INSERT OR IGNORE failed - duplicate
    print(f"  ⏭️  Skipped duplicate: {mole_path} (same hash + date)")
```

**Impact:**
- Rebuild/index operations now log when duplicates are skipped
- Users can see in terminal which files were identified as duplicates

## What This Fixes

### ✅ Christmas Tree Scenario
**User wants same photo at multiple dates:**
- Copy `christmas-tree.jpg` twice
- Import first, set date to Dec 25, 2023
- Import second, set date to Dec 25, 2024
- **Result:** Both photos appear (different dates)

### ✅ True Duplicates Still Detected
**User accidentally imports same photo twice:**
- Import `vacation.jpg` on Jan 1
- Import `vacation.jpg` again (same EXIF date)
- **Result:** Second rejected as duplicate (same hash + same date)

### ✅ Manual Duplicate Detection
**User copies file to root level (test case):**
- Original: `2024/2024-01-15/img_abc.jpg`
- Copy at root: `img_abc.jpg`
- Run "Update Library Index"
- **Result:** Logged as duplicate, only one in database

## Known Limitations (Step 1)

**⚠️ Only works with NEW libraries:**
- Existing libraries have old schema (hash UNIQUE)
- Opening old library with new code may cause errors
- Migration script needed (future step)

**⚠️ Duplicate files not deleted:**
- System detects duplicates but doesn't remove them from disk
- Files remain untracked on filesystem
- Cleanup feature needed (future step)

**⚠️ No UI for duplicate report:**
- Duplicates only logged to terminal
- Users don't see count or list in UI
- Enhancement needed (future step)

## Testing Required

See `TEST_DUPLICATE_DEFINITION.md` for detailed test plan.

**Key tests:**
1. Same hash, different dates → both accepted
2. Same hash, same date → rejected as duplicate
3. Rebuild with duplicate file → detected and logged
4. Different times (seconds) → both accepted

## Future Steps

**Phase 2: Migration**
- Create migration script for existing libraries
- Safely update schema on library load
- Handle edge cases (existing duplicates in DB)

**Phase 3: Cleanup**
- Automatically delete duplicate files from disk
- Show report to user: "Removed X duplicate files"

**Phase 4: Remove Utilities**
- Delete "Remove Duplicates" utility (no longer needed)
- The UNIQUE constraint handles it automatically

**Phase 5: Create Blank Library**
- Add "Create New Library" feature
- Allows creating empty library in any folder

## Files Changed

- `db_schema.py` - Schema update (UNIQUE constraint change)
- `app.py` - Import logic (duplicate check with date)
- `library_sync.py` - Logging (report skipped duplicates)
- `TEST_DUPLICATE_DEFINITION.md` - Test documentation

## Rollback Plan

If issues arise:
1. Revert schema to v1 (hash UNIQUE)
2. Revert import logic (check hash only)
3. Remove duplicate logging
4. Delete test library and start fresh
