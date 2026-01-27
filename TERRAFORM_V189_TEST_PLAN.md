# Terraform v189 Test Plan

## Changes from v188

### What Changed
- **Removed:** Source folder tracking (`source_folders` set)
- **Added:** Non-media file scanning and immediate trash
- **Replaced:** Two-pass cleanup → Single whitelist-based cleanup
- **Simplified:** "Extract media, destroy everything else"

### New Behavior
1. **Scan phase:** Categorize ALL files into `media_files` and `non_media_files`
2. **Trash non-media:** Move all non-media to `.trash/errors/` before processing
3. **Process media:** Standard import flow (EXIF, hash, organize)
4. **Cleanup folders:** Delete ALL folders except infrastructure and year folders

---

## Test Scenarios

### Test 1: Clean Master Library (Primary Test)
**Source:** `~/Desktop/terraform-master/` (364 media files)

**Pre-terraform state:**
- 11 top-level folders (photo-triage, reference-photos, nature, etc.)
- Non-media files (ANALYSIS.txt, README.txt, helmet-pads-ref.zip, etc.)
- Nested organized structure (reference-photos/Photo Library/2025/)

**Expected result:**
```
terraform-master/
├── photo_library.db
├── .thumbnails/
├── .logs/
├── .db_backups/
├── .trash/
│   ├── duplicates/     (3 files)
│   ├── errors/         (ANALYSIS.txt, README.txt, .zip, .db, etc.)
│   └── exif_failed/    (.bmp files)
├── .import_temp/
├── 2012/
│   ├── 2012-01-07/
│   ├── 2012-01-09/
│   └── 2012-01-10/
├── 2022/
├── 2023/
├── 2024/
├── 2025/
└── 2026/
```

**Verification:**
- [ ] All 11 source folders deleted
- [ ] `reference-photos/` deleted (including nested Photo Library/)
- [ ] ANALYSIS.txt, README.txt in `.trash/errors/`
- [ ] helmet-pads-ref.zip in `.trash/errors/`
- [ ] Old photo_library.db from reference-photos in `.trash/errors/`
- [ ] All .bmp files in `.trash/exif_failed/`
- [ ] Only year folders remain (no other folders at root)
- [ ] Year folders contain only YYYY-MM-DD subfolders
- [ ] ~350 media files organized correctly

---

### Test 2: Already-Terraformed Library
**Source:** Create new library, terraform, then terraform again

**Pre-terraform state:**
- Already organized (YYYY/YYYY-MM-DD/ structure)
- Only infrastructure folders present

**Expected result:**
- No changes (already clean)
- Year folders preserved
- Infrastructure folders preserved
- 0 folders removed

**Verification:**
- [ ] No errors during terraform
- [ ] Structure unchanged
- [ ] Duplicate detection works (0 new files)

---

### Test 3: Mixed Content Library
**Source:** Create test with:
- Media files at root
- Media files in nested folders
- Non-media files (.txt, .pdf, .zip, .db)
- Empty folders
- Hidden folders (.old-thumbnails, .backup)

**Expected result:**
- Media organized into year folders
- All non-media in `.trash/errors/`
- All non-infrastructure folders deleted
- Hidden folders (.old-thumbnails) deleted

**Verification:**
- [ ] Media files organized
- [ ] Non-media files trashed
- [ ] All source folders deleted
- [ ] Only infrastructure and year folders remain

---

### Test 4: Edge Cases

**4a. Year folder with invalid subfolders**
- Create `2025/random-folder/` with media
- Expected: Media moved to `2025/YYYY-MM-DD/`, `random-folder/` deleted

**4b. Files at root of year folder**
- Create `2025/test.txt` (non-media at year level)
- Expected: File deleted (year folders can only contain YYYY-MM-DD subfolders)

**4c. Folder named like infrastructure**
- Create `thumbnails/` (no dot prefix)
- Expected: Deleted (only `.thumbnails` with dot is whitelisted)

**Verification:**
- [ ] Invalid subfolders in year folders deleted
- [ ] Files in year folders deleted
- [ ] Only exact infrastructure names preserved

---

## Success Criteria

### Must Pass
1. ✅ All non-infrastructure folders deleted (not just "source" folders)
2. ✅ Non-media files moved to trash
3. ✅ Reference folders with nested structures deleted
4. ✅ Result identical to blank library + import
5. ✅ No crashes or errors during processing

### Performance
- Process 364 files in < 2 minutes
- No significant slowdown from v188

### Cleanup Verification
```bash
# After terraform, run:
find ~/Desktop/terraform-master -type d -depth 1

# Should show ONLY:
# .thumbnails, .logs, .trash, .db_backups, .import_temp
# YYYY folders (2012, 2022, 2023, 2024, 2025, 2026)
# photo_library.db (file)
```

---

## Rollback Plan

If v189 breaks:
1. Revert `app.py` changes:
   - Restore `source_folders` tracking in scan
   - Restore two-pass cleanup
   - Remove non-media file scanning
2. Revert `main.js` version to v188
3. Test with known-good terraform operation

Rollback commands:
```bash
git diff HEAD~1 app.py > /tmp/v189-changes.patch
git checkout HEAD~1 -- app.py static/js/main.js
# Test
# If needed: git apply /tmp/v189-changes.patch
```

---

## Notes

### Why This Fix Is Better Than v188
- **Simpler logic:** Whitelist > tracking
- **More complete:** Catches hidden folders, non-media files
- **More robust:** Doesn't depend on scan finding everything
- **Clear semantics:** "Keep these folders, delete rest" vs "Track what you saw, delete later"

### What Wasn't Changed
- Database row_factory fix (kept from v188) ✅
- Duplicate detection logic (kept from v188) ✅
- EXIF writing and hashing (kept from v188) ✅
- Manifest logging (kept from v188) ✅
