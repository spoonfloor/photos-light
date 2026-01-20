# Fixed Bugs

Issues that have been fixed and verified.

---

## Session 1: January 19, 2026

### Database Backup System
**Fixed:** All backup functionality  
**Documentation:** FIX_DATABASE_BACKUP.md

**Issues resolved:**
- ✅ Database auto-backup before destructive operations
- ✅ Backups now created with timestamped filenames: `photo_library_YYYYMMDD_HHMMSS.db`
- ✅ Max 20 backups kept (cleanup logic now active)
- ✅ Backups created before: delete photos, rebuild database, update library index

**Testing verified:**
- Delete operation creates backup in `.db_backups/` folder
- Backup file is valid SQLite database with correct timestamp format

---

### Database Rebuild Dialog
**Fixed:** JavaScript errors and missing UI elements  
**Documentation:** FIX_REBUILD_DIALOG.md

**Issues resolved:**
- ✅ **Estimated duration display** - Now shows for all library sizes (e.g., "less than a minute", "7-8 minutes")
- ✅ **JavaScript error fixed** - `buttons.forEach is not a function` error resolved
- ✅ **Warning dialog for 1000+ files** - Now displays correctly with proper button array format
- ✅ **Completion message** - Now shows correct indexed count instead of "Indexed 0 files"

**Testing verified:**
- Small library (69 files): Shows estimate, completes correctly
- Large library (1,100 files): Warning dialog appears, no JS errors, completion message accurate
- All buttons render correctly (Cancel/Continue, Proceed, Done)

---

### Invalid Date Handling
**Fixed:** Date validation in date editor  
**Documentation:** FIX_INVALID_DATES.md

**Issues resolved:**
- ✅ Prevents selection of invalid dates (e.g., February 31st)
- ✅ Day dropdown dynamically updates based on selected month and year
- ✅ Handles leap years correctly (Feb 29 only in leap years)
- ✅ Auto-adjusts selected day if it becomes invalid (e.g., Jan 31 → Feb changes day to 28/29)

**Testing verified:**
- February 2024 (leap year): Shows 1-29 days only
- February 2025 (non-leap year): Shows 1-28 days only
- 30-day months (April, June, etc.): Shows 1-30 days only
- 31-day months: Shows all 31 days
- Day auto-adjustment works correctly

---

### Lazy Loading & Thumbnail Issues
**Fixed:** Done button corrupting unloaded image src attributes  
**Documentation:** FIX_LAZY_LOADING.md

**Issues resolved:**
- ✅ **Broken images after thumbnail purge** - Images below fold now load correctly after "Rebuild Thumbnails"
- ✅ **Done button bug** - Fixed cachebuster code corrupting unloaded images
- ✅ **IntersectionObserver setup** - Disconnects and recreates observer on grid reload

**Root cause:**
- "Rebuild Thumbnails" dialog's Done button added cachebuster to ALL images
- For unloaded images (no src attribute), `img.src` returns `""` (empty string)
- `"".split('?')[0]` returns `""`  
- Set `img.src = "?t=timestamp"` (invalid URL)
- When user scrolled, IntersectionObserver check `!img.src` failed (src was truthy but invalid)
- Images never loaded proper thumbnail URLs

**The fix:**
```javascript
// Only add cachebuster to images with valid thumbnail URLs
if (img.src && img.src.includes('/api/photo/')) {
  const src = img.src.split('?')[0];
  img.src = `${src}?t=${cacheBuster}`;
}
```

**Testing verified:**
- Small library (1,100 photos): All images load correctly after thumbnail rebuild
- Scroll through entire grid: No broken images
- Done button only modifies loaded images

---
