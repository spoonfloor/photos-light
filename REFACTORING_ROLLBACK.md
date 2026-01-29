# Extension List Refactoring - Rollback Documentation

## Current Checkpoint

**Commit:** `402e878` (v221-v222: Remove BMP support, add WebP/AVIF/JP2 skip)  
**Date:** 2026-01-28  
**Status:** ✅ SAFE - Working state before major refactoring

## Rollback Instructions

### Option 1: Revert Last Commit (keeps history)

```bash
cd /Users/erichenry/Desktop/photos-light
git revert HEAD
```

This creates a new commit that undoes the changes.

### Option 2: Hard Reset (destructive - removes commit)

```bash
cd /Users/erichenry/Desktop/photos-light
git reset --hard HEAD~1
```

⚠️ WARNING: This deletes the commit. Only use if refactoring goes very wrong.

### Option 3: Return to Specific Commit

```bash
cd /Users/erichenry/Desktop/photos-light
git reset --hard 402e878
```

Returns to this exact checkpoint.

---

## Planned Refactoring (NOT YET DONE)

### Goal

Eliminate duplicate extension lists throughout app.py and library_sync.py by using global constants.

### Changes Planned

#### Phase 1: Add New Constants (app.py lines 73-90)

```python
# Existing
PHOTO_EXTENSIONS = {...}
VIDEO_EXTENSIONS = {...}
ALL_MEDIA_EXTENSIONS = PHOTO_EXTENSIONS | VIDEO_EXTENSIONS

# NEW: Named subsets with clear purposes
EXIF_WRITABLE_PHOTO_EXTENSIONS = {
    '.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.tiff', '.tif'
}  # Formats that support EXIF writes (no RAW, no ambiguous lossy formats)
```

#### Phase 2: Replace Duplicates in app.py

| Location        | Current                 | Replace With                           | Risk Level                |
| --------------- | ----------------------- | -------------------------------------- | ------------------------- |
| Line 175        | `video_exts = {...)`    | `VIDEO_EXTENSIONS`                     | ✅ LOW - Identical        |
| Lines 615, 675  | `photo_exts = {...}`    | `EXIF_WRITABLE_PHOTO_EXTENSIONS`       | ⚠️ MEDIUM - New constant  |
| Lines 1321-1323 | `MEDIA_EXTS = {...}`    | `ALL_MEDIA_EXTENSIONS`                 | ⚠️ MEDIUM - Fixes bug     |
| Lines 2892-2894 | `photo_exts/video_exts` | `PHOTO_EXTENSIONS`, `VIDEO_EXTENSIONS` | ⚠️ MEDIUM - Fixes bug     |
| Lines 3529-3536 | `photo_exts/video_exts` | `PHOTO_EXTENSIONS`, `VIDEO_EXTENSIONS` | ✅ LOW - Nearly identical |
| Lines 4047-4050 | `MEDIA_EXTS = {...}`    | `ALL_MEDIA_EXTENSIONS`                 | ⚠️ MEDIUM - Fixes bug     |
| Lines 4111-4114 | `MEDIA_EXTS = {...}`    | `ALL_MEDIA_EXTENSIONS`                 | ⚠️ MEDIUM - Fixes bug     |

#### Phase 3: Update library_sync.py

- Remove `.bmp` from all lists (lines 23, 55, 131)
- Replace duplicate lists with imports from app.py (if possible)

### Testing After Refactoring

1. Run test_unchanged_files.py to verify no files are modified
2. Import test files in various formats
3. Run terraform on test library
4. Delete photos and verify folder cleanup works
5. Check library status endpoint counts all formats

### Success Criteria

- All tests pass
- No behavioral changes (only code cleanup)
- Single source of truth for extension lists
- Clear comments explaining any intentional subsets

---

## If Refactoring Fails

1. **Immediate rollback:**

   ```bash
   git reset --hard 402e878
   ```

2. **Analyze what broke:**
   - Check Flask logs
   - Run specific test that failed
   - Review git diff to see what changed

3. **Incremental fix:**
   - Revert just the problematic change
   - Test again
   - Continue with remaining changes

---

## Notes

- Current state (402e878) is fully working
- BMP support removed (exiftool limitation)
- WebP/AVIF/JP2 skip orientation baking (cannot detect lossy vs lossless)
- Version at v222
- Ready for extension list consolidation refactoring
