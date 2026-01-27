# EXIF Write on Import - Validation Checklist

**Feature:** Write EXIF metadata to all imported files, reject files that fail
**Version:** v135-v138

---

## Test Scenarios

### 1. Basic JPEG Import with EXIF Write
- Import valid JPEG photo
- Verify EXIF written to file
- Verify file appears in library at correct date
- Check console for "✅ EXIF written and verified"

### 2. Multiple JPEGs - Batch Import
- Import 4-5 JPEG photos
- Verify all get EXIF written
- Verify all appear in library
- Check import count: "5 imported, 0 errors"

### 3. PNG Import with EXIF Write
- Import valid PNG file
- Verify EXIF written (slower, ~2s)
- Verify file appears in library
- Note: Should work but slower than JPEG

### 4. GIF Import with EXIF Write
- Import valid GIF file
- Verify EXIF written
- Verify file appears in library

### 5. Video Import (MOV/MP4)
- Import valid video file
- Verify metadata written via ffmpeg
- Verify video appears in library
- Check console for ffmpeg success

### 6. Corrupted File Rejection
- Import corrupted/fake JPEG (echo "text" > fake.jpg)
- Verify file is REJECTED (not imported)
- Verify error count shows 1
- Verify file NOT in library
- Verify database has no record

### 7. Rejection UI Display
- Import corrupted file
- Check import dialog shows "Import complete with 1 error"
- Verify error count: "ERRORS: 1"
- Click "Hide error details" to expand
- Verify shows: filename, error message, icon
- Verify shows "Collect rejected files" button
- Verify shows "Export list" button

### 8. Mixed Batch (Good + Bad Files)
- Import 3 valid JPEGs + 1 corrupted file
- Verify 3 imported successfully
- Verify 1 rejected
- Verify counts: "3 imported, 0 duplicates, 1 error"
- Verify 3 files in library, 1 not

### 9. Collect Rejected Files
- Import corrupted file (to get rejection)
- Click "Collect rejected files"
- Verify import dialog hides
- Verify folder picker appears cleanly (not blocked)
- Select destination folder
- Verify import dialog reappears
- Verify folder created: "rejected_YYYYMMDD_HHMMSS"
- Verify file copied to folder
- Verify report.txt exists with details
- Verify toast: "Copied N files to [folder]" (3s, no undo)

### 10. Export Rejection List
- Import corrupted file
- Click "Export list"
- Verify .txt file downloads
- Open file, verify contains: filename, reason, category, source path
- Verify toast: "Report downloaded" (3s, no undo)

### 11. Long Rejection List (20+ files)
- Import 25+ corrupted files
- Expand error details
- Verify shows first 20 items
- Verify shows "... and N more" at bottom
- Verify list is scrollable (300px max-height)
- Verify no visual clutter (flat list, no cards)

### 12. Rejection Cleanup Verification
- Import corrupted file
- Check library folder - file should NOT exist
- Check database - record should NOT exist
- Verify console shows "🗑️ Deleted copied file"
- Verify console shows "🗑️ Deleted database record"

### 13. File Without EXIF (Fresh PNG)
- Create new PNG with no EXIF: python -c "from PIL import Image; Image.new('RGB', (100,100), 'blue').save('test.png')"
- Import the PNG
- Verify EXIF gets written
- Verify import succeeds
- Use exiftool to verify EXIF exists in file

### 14. Import Then Rebuild Database
- Import JPEG with EXIF write
- Note the date it appears at
- Rebuild database
- Verify photo still appears at same date (EXIF persists in file)

### 15. Duplicate Detection Still Works
- Import same file twice
- Verify second import shows "1 duplicate"
- Verify only 1 file in library

### 16. File Permissions Issue
- Create file, make read-only: chmod 000 test.jpg
- Try to import
- Should get permission error? (might fail at copy stage)

### 17. Very Large File Timeout
- Skip (need 100MB+ file, slow test)

### 18. Network Storage (NAS)
- Skip unless on NAS (would test timeout behavior)

### 19. Multiple File Formats in One Batch
- Import: 2 JPEGs, 1 PNG, 1 GIF, 1 MOV
- Verify all succeed with EXIF/metadata written
- Verify all appear in library

### 20. Error Details Toggle
- Import corrupted file
- Verify details start collapsed
- Click "Hide error details" (should say "Show" when collapsed)
- Verify expands
- Click "Hide error details" again
- Verify collapses

---

## Pass Criteria

- ✅ All valid files get EXIF written and verified
- ✅ All corrupted files are rejected (not in library or DB)
- ✅ Error UI is clean, readable, no cards/dividers
- ✅ Rejection actions work (collect, export)
- ✅ No regressions (duplicates, rebuild, etc.)
- ✅ Console logging is clear and helpful

---

## Known Limitations (Expected Behavior)

- PNG writes are slower (~2s vs 0.3s for JPEG) - acceptable
- 20-item cap on error display - matches existing pattern
- Timeout on very slow storage - will reject with timeout category

---

**Ready to test one by one!**
