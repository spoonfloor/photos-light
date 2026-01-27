Testing Checklist - Photos Light

1. Library Management
   First Run / Setup
   Open existing library (custom folder picker) [ ] pass [ ] fail
   notes:
   Create new library with photos (select location → import) [ ] pass [ ] fail
   notes:
   Create blank library (name it → choose location) [ ] pass [ ] fail
   notes:
   Browse filesystem using custom folder picker (not native macOS) [ ] pass [ ] fail
   notes:
   Switch between multiple libraries (Menu → Switch library) [ ] pass [ ] fail
   notes:
   Edge Cases:
   Handle missing library (show first-run screen) [ ] pass [ ] fail
   notes:
   Handle stale config (auto-delete, reset to first run) [ ] pass [ ] fail
   notes:
   Library health check on switch (missing/corrupt/needs migration) [ ] pass [ ] fail
   notes:
2. Grid View
   Display & Interaction
   View photos in thumbnail grid (400x400 squares, center-cropped) [ ] pass [ ] fail
   notes:
   Lazy-load thumbnails on scroll (hash-based cache) [ ] pass [ ] fail
   notes:
   Month divider headers (auto-group by YYYY-MM) [ ] pass [ ] fail
   notes:
   Select single photo (click) [ ] pass [ ] fail
   notes:
   Shift-select range (click first, shift+click last) [ ] pass [ ] fail
   notes:
   Cancel selection (ESC key or click outside) [ ] pass [ ] fail
   notes:
   Edge Cases:
   Scroll performance with 1k+ photos [ ] pass [ ] fail
   notes:
   Missing thumbnails (regenerate on request) [ ] pass [ ] fail
   notes:
   Month dividers update as you scroll [ ] pass [ ] fail
   notes:
3. Delete & Recovery
   Deletion Flow
   Delete single photo (move to `.trash/`, remove from grid) [ ] pass [ ] fail
   notes:
   Delete multiple photos (batch operation) [ ] pass [ ] fail
   notes:
   Undo deletion (restore via toast notification) [ ] pass [ ] fail
   notes:
   Restore photos from trash (backend `/api/photos/restore`) [ ] pass [ ] fail
   notes:
   Behind the Scenes:
   Auto-cleanup empty folders after delete [ ] pass [ ] fail
   notes:
   Delete thumbnail cache entry [ ] pass [ ] fail
   notes:
   Move DB record to `deleted_photos` table [ ] pass [ ] fail
   notes:
   Toast shows for 8 seconds with undo option [ ] pass [ ] fail
   notes:
4. Date Editing
   Single Photo
   Open date editor from grid (select photo → Edit date) [ ] pass [ ] fail
   notes:
   Open date editor from lightbox ('e' key or Edit date link) [ ] pass [ ] fail
   notes:
   Change date and time (date picker + time input) [ ] pass [ ] fail
   notes:
   Save changes (updates DB, re-sorts grid) [ ] pass [ ] fail
   notes:
   Bulk Editing (Multiple Photos)
   Same date mode (all photos → same date/time) [ ] pass [ ] fail
   notes:
   Offset mode (shift all by offset from first photo) [ ] pass [ ] fail
   notes:
   Sequence mode - seconds interval [ ] pass [ ] fail
   notes:
   Sequence mode - minutes interval [ ] pass [ ] fail
   notes:
   Sequence mode - hours interval [ ] pass [ ] fail
   notes:
   Maintains chronological order in sequence mode [ ] pass [ ] fail
   notes:
   Edge Cases:
   Date picker populates with available years [ ] pass [ ] fail
   notes:
   Invalid dates rejected [ ] pass [ ] fail
   notes:
   Grid re-sorts after save [ ] pass [ ] fail
   notes:
5. Navigation & Sorting
   Controls
   Sort by newest first (DESC by date_taken) [ ] pass [ ] fail
   notes:
   Sort by oldest first (ASC by date_taken) [ ] pass [ ] fail
   notes:
   Jump to specific month/year (date picker) [ ] pass [ ] fail
   notes:
   Find nearest month (if target month has no photos) [ ] pass [ ] fail
   notes:
   Edge Cases:
   Year-aware landing (prefers staying in target year) [ ] pass [ ] fail
   notes:
   Directional landing based on sort order [ ] pass [ ] fail
   notes:
   Month observer updates as you scroll [ ] pass [ ] fail
   notes:
   Date picker shows only years with photos [ ] pass [ ] fail
   notes:
6. Import
   Import Flow
   Menu → Add photos (opens custom photo picker) [ ] pass [ ] fail
   notes:
   Browse filesystem (folders + files) [ ] pass [ ] fail
   notes:
   See media counts in folders ("(243)" or "(many)") [ ] pass [ ] fail
   notes:
   Multi-select files and folders [ ] pass [ ] fail
   notes:
   Import with progress (SSE streaming) [ ] pass [ ] fail
   notes:
   Behind the Scenes:
   Auto-dedupe by content hash (SHA-256) [ ] pass [ ] fail
   notes:
   Extract EXIF date (fallback to file mtime) [ ] pass [ ] fail
   notes:
   Canonical naming: `img_YYYYMMDD_hash.ext` [ ] pass [ ] fail
   notes:
   Organize by: `YYYY/YYYY-MM-DD/filename` [ ] pass [ ] fail
   notes:
   Show counts: imported / duplicates / errors [ ] pass [ ] fail
   notes:
7. Lightbox
   Basic Controls
   Click photo in grid → open lightbox [ ] pass [ ] fail
   notes:
   Navigate with arrow keys (← previous, → next) [ ] pass [ ] fail
   notes:
   Close with ESC key [ ] pass [ ] fail
   notes:
   Auto-hide UI controls (reappear on mouse move) [ ] pass [ ] fail
   notes:
   Display date taken (clickable → jump to grid) [ ] pass [ ] fail
   notes:
   Display filename (clickable → reveal in Finder) [ ] pass [ ] fail
   notes:
   Advanced Features
   Open date editor ('e' key or Edit date button) [ ] pass [ ] fail
   notes:
   Video playback (for .mov, .mp4, .m4v, etc.) [ ] pass [ ] fail
   notes:
   HEIC/HEIF conversion (auto-convert to JPEG) [ ] pass [ ] fail
   notes:
   TIF/TIFF conversion (auto-convert to JPEG) [ ] pass [ ] fail
   notes:
   Aspect ratio preservation (width or height constrained) [ ] pass [ ] fail
   notes:
   Edge Cases:
   Handle missing file (show error) [ ] pass [ ] fail
   notes:
   Portrait vs landscape orientation [ ] pass [ ] fail
   notes:
   Very wide/tall images (maintain aspect ratio) [ ] pass [ ] fail
   notes:
   Video thumbnail shows first frame [ ] pass [ ] fail
   notes:
8. Utilities Menu
   Clean Index (Update Library Index)
   Scan first (shows: ghosts, moles, empty folders) [ ] pass [ ] fail
   notes:
   Execute cleanup (SSE progress streaming) [ ] pass [ ] fail
   notes:
   Removes ghosts (in DB, not on disk) [ ] pass [ ] fail
   notes:
   Adds moles (on disk, not in DB) [ ] pass [ ] fail
   notes:
   Removes empty folders [ ] pass [ ] fail
   notes:
   Remove Duplicates
   Find duplicate content hashes [ ] pass [ ] fail
   notes:
   List all duplicate sets [ ] pass [ ] fail
   notes:
   Show file count, wasted space [ ] pass [ ] fail
   notes:
   Rebuild Thumbnails
   Check count (GET /api/utilities/check-thumbnails) [ ] pass [ ] fail
   notes:
   Clear cache (delete `.thumbnails/` directory) [ ] pass [ ] fail
   notes:
   Confirm lazy regeneration on scroll [ ] pass [ ] fail
   notes:
   Switch Library
   Browse for library [ ] pass [ ] fail
   notes:
   Health check on switch [ ] pass [ ] fail
   notes:
   Handle migration prompts [ ] pass [ ] fail
   notes:
9. Recovery & Rebuild
   Database Rebuild
   Menu → Rebuild database (when DB missing/corrupt) [ ] pass [ ] fail
   notes:
   Pre-scan library (shows file count) [ ] pass [ ] fail
   notes:
   Estimate duration (displays: "X minutes" or "X hours") [ ] pass [ ] fail
   notes:
   Warning for 1000+ files [ ] pass [ ] fail
   notes:
   Execute rebuild (SSE progress: scan → hash → insert) [ ] pass [ ] fail
   notes:
   Create new database if missing [ ] pass [ ] fail
   notes:
   Auto-Recovery (Tier 1)
   Auto-create missing `.thumbnails/` [ ] pass [ ] fail
   notes:
   Auto-create missing `.trash/` [ ] pass [ ] fail
   notes:
   Auto-create missing `.db_backups/` [ ] pass [ ] fail
   notes:
   Auto-create missing `.import_temp/` [ ] pass [ ] fail
   notes:
   Auto-create missing `.logs/` [ ] pass [ ] fail
   notes:
   Backups
   Database auto-backup before destructive operations [ ] pass [ ] fail
   notes:
   Max 20 backups kept (oldest deleted) [ ] pass [ ] fail
   notes:
   Timestamped filenames: `photo_library_YYYYMMDD_HHMMSS.db` [ ] pass [ ] fail
   notes:
10. Keyboard Shortcuts
    ESC - Close lightbox / close date editor / deselect all (priority order) [ ] pass [ ] fail
    notes:
    Arrow Left - Previous photo (lightbox only) [ ] pass [ ] fail
    notes:
    Arrow Right - Next photo (lightbox only) [ ] pass [ ] fail
    notes:
    e - Open date editor (lightbox only) [ ] pass [ ] fail
    notes:
    Priority Order for ESC:
11. Close date editor (if open in lightbox)
12. Close lightbox (if open)
13. Deselect all photos (if on grid)
14. File Format Support
    Photos
    ✅ JPG, JPEG, HEIC, HEIF, PNG, GIF, BMP, TIFF, TIF
    Videos
    ✅ MOV, MP4, M4V, AVI, MPG, MPEG, 3GP, MTS, MKV
    Conversion
    HEIC/HEIF → JPEG (on-the-fly, 95% quality) [ ] pass [ ] fail
    notes:
    TIF/TIFF → JPEG (on-the-fly, 95% quality) [ ] pass [ ] fail
    notes:
    Video thumbnails → JPEG (first frame, 400x400 center-crop) [ ] pass [ ] fail
    notes:
15. Error Handling & Edge Cases
    Library Issues
    Library not found → first-run screen [ ] pass [ ] fail
    notes:
    Database missing → prompt to rebuild [ ] pass [ ] fail
    notes:
    Database corrupted → critical error modal [ ] pass [ ] fail
    notes:
    Mixed schema → migration prompt [ ] pass [ ] fail
    notes:
    Extra columns → warning but continue [ ] pass [ ] fail
    notes:
    Permission denied → error message [ ] pass [ ] fail
    notes:
    Import Issues
    File not found → skip, increment error count [ ] pass [ ] fail
    notes:
    Duplicate detected → skip, increment duplicate count [ ] pass [ ] fail
    notes:
    Hash collision → rename with counter (`_1`, `_2`) [ ] pass [ ] fail
    notes:
    EXIF extraction fails → fallback to mtime [ ] pass [ ] fail
    notes:
    Dimension extraction fails → store as NULL [ ] pass [ ] fail
    notes:
    Runtime Issues
    Missing thumbnail → regenerate on request [ ] pass [ ] fail
    notes:
    File moved/deleted → show error in lightbox [ ] pass [ ] fail
    notes:
    Network timeout (N/A - local app) [ ] pass [ ] fail
    notes:
    Disk full → OS error propagates [ ] pass [ ] fail
    notes:
    Test Scenarios
    Scenario 1: First-Time User
16. Launch app (no config)
17. See welcome screen
18. Click "Add photos"
19. Name library: "My Photos"
20. Choose location via custom picker
21. Browse to folder with photos
22. Select folder, confirm import
23. Watch progress bar (SSE streaming)
24. See photos in grid
25. Click photo → lightbox opens
    Overall result: [ ] pass [ ] fail
    notes:
    Scenario 2: Power User Workflow
26. Open existing library
27. Sort by oldest first
28. Shift-select 50 photos
29. Edit date → Sequence (5 min intervals)
30. Save, watch grid re-sort
31. Jump to 2023-06
32. Delete 10 photos
33. Undo via toast
34. Switch to different library
35. Import more photos
    Overall result: [ ] pass [ ] fail
    notes:
    Scenario 3: Recovery
36. Delete `photo_library.db`
37. Launch app
38. See "Database missing" error
39. Click "Rebuild database"
40. Watch pre-scan estimate
41. Confirm rebuild
42. Watch SSE progress
43. Database recreated, photos load
    Overall result: [ ] pass [ ] fail
    notes:
    Scenario 4: Library Health Check
44. Copy old database (missing width/height columns)
45. Switch to that library
46. See "Database needs migration" prompt
47. Run migration (or rebuild)
48. Successfully load library
    Overall result: [ ] pass [ ] fail
    notes:
    Performance Benchmarks
    Load grid (first 500 photos) - Expected: < 2 seconds [ ] pass [ ] fail
    notes:
    Scroll + lazy load - Expected: < 100ms per thumbnail [ ] pass [ ] fail
    notes:
    Import 100 photos - Expected: ~2-3 minutes [ ] pass [ ] fail
    notes:
    Hash 1GB file - Expected: ~5-10 seconds [ ] pass [ ] fail
    notes:
    Generate thumbnail - Expected: ~50-200ms (image), ~500ms (video) [ ] pass [ ] fail
    notes:
    Open lightbox - Expected: < 100ms [ ] pass [ ] fail
    notes:
    Delete 100 photos - Expected: < 5 seconds [ ] pass [ ] fail
    notes:
    Rebuild database (65k photos) - Expected: ~6-7 hours [ ] pass [ ] fail
    notes:
    Technical Notes
    Hash-Based Deduplication

- Uses SHA-256, first 7 characters
- Computed during import (single-pass with save)
- Duplicate detection at DB level (`content_hash` unique constraint)
  Thumbnail Caching
- Hash-based sharding: `.thumbnails/ab/cd/abcd1234.jpg`
- 400x400 center-cropped squares
- JPEG quality: 85
- Lazy generation (on-demand)
  Database Schema
- Single source of truth: `db_schema.py`
- 8 columns: id, current_path, original_filename, content_hash, file_size, file_type, date_taken, width, height
- Indices: date_taken, content_hash, file_type
  SSE Streaming Events
- `start` - Operation begins (total count)
- `progress` - Update (current, total, counts)
- `complete` - Operation finished (final counts)
- `error` - Operation failed (error message)
  Critical Paths (Must Test)

1. Import flow - Files + folders, dedupe, progress
2. Lightbox - Open, navigate, date/filename links, close
3. Delete + undo - Delete, toast, undo, restore
4. Date editing - Single, bulk (all modes)
5. Library switch - Health check, migration
6. Grid performance - Lazy load, scroll, 1000+ photos
7. Recovery - Missing DB, rebuild, auto-recovery
