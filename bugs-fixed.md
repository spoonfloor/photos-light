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

### Date Picker Duplicate Years
**Fixed:** Year dropdown showing duplicate years  
**Documentation:** FIX_DATE_PICKER_DUPLICATES.md  
**Version:** v85

**Issues resolved:**
- ✅ Same year no longer appears multiple times in year picker dropdown
- ✅ Function now clears existing options before repopulating
- ✅ Works correctly after database rebuild
- ✅ Works correctly after switching libraries

**Root cause:**
- `populateDatePicker()` was called multiple times (after rebuild, after health check)
- Function appended new options without clearing existing ones
- Duplicate years accumulated in the dropdown

**The fix:**
```javascript
// Clear existing options before populating (prevents duplicates)
yearPicker.innerHTML = '';
```

**Testing verified:**
- Each year appears exactly once in dropdown
- Years remain sorted newest to oldest
- No duplicates after database operations
- Tested with database rebuild flow

---

### Date Editor - Year Dropdown Missing New Year
**Fixed:** Date picker dropdown not updating after editing to new year  
**Version:** v86

**Issues resolved:**
- ✅ Year dropdown now refreshes immediately after date edit saves
- ✅ Works for single photo edits
- ✅ Works for bulk photo edits (all modes: same, shift, sequence)
- ✅ New years appear in dropdown right away

**Root cause:**
- After date edit saved successfully, code reloaded grid (`loadAndRenderPhotos()`)
- But it didn't refresh the date picker dropdown (`populateDatePicker()`)
- If user edited photos to a new year, dropdown was stale
- Navigation dropdown became unusable (couldn't jump to new year)

**The fix:**
```javascript
// After both single and bulk date edits:
setTimeout(() => {
  loadAndRenderPhotos(false);
  populateDatePicker(); // Refresh year dropdown to include new years
}, 300);
```

Added `populateDatePicker()` call in two locations:
- After single photo date edit (line ~1349)
- After bulk photo date edit (line ~1281)

**Testing verified:**
- Library with only 2016 photos
- Edited photo to 2025
- Year dropdown immediately updated to show both 2016 and 2025
- Can now navigate to newly created years

---

### Error Message Wording - Large Library Dialog
**Fixed:** Improved dialog title for large library rebuilds  
**Version:** v88

**Issues resolved:**
- ✅ Changed 'Large library detected' to 'Large library'
- ✅ More concise, less robotic language
- ✅ Better first impression for rebuild warnings

**The fix:**
```javascript
// Before: 'Large library detected'
// After:  'Large library'
showDialog('Large library', `Your library contains ${count} photos...`)
```

**Testing verified:**
- Rebuild database with 1000+ files
- Warning dialog shows "Large library" title
- Clean, simple wording

---

### Toast Timing + Date Edit Undo
**Fixed:** Centralized toast durations and added undo to date edits  
**Version:** v89-v94

**Issues resolved:**
- ✅ Centralized toast durations (3s for info, 7s with undo)
- ✅ Auto-selects duration based on whether undo is provided
- ✅ Added undo to single photo date edits
- ✅ Added undo to bulk photo date edits (all modes: same, shift, sequence)
- ✅ Removed emoji from all toast messages
- ✅ Fixed undo button showing when it shouldn't
- ✅ Improved "Restored" message to show count

**Root cause:**
- Toast durations were hardcoded inconsistently throughout codebase
- No undo capability for date edits (destructive operation)
- Undo button always visible even when no undo callback

**The fix:**
```javascript
// Centralized constants
const TOAST_DURATION = 3000; // 3s for info/error
const TOAST_DURATION_WITH_UNDO = 7000; // 7s with undo

// Auto-select duration in showToast()
if (duration === undefined) {
  duration = onUndo ? TOAST_DURATION_WITH_UNDO : TOAST_DURATION;
}

// Show/hide undo button
if (onUndo) {
  newUndoBtn.style.display = 'block';
  newUndoBtn.addEventListener('click', () => {
    hideToast();
    onUndo();
  });
} else {
  newUndoBtn.style.display = 'none';
}

// Capture original dates before edit
const originalDates = photoIds.map(id => {
  const photo = state.photos.find(p => p.id === id);
  return { id: id, originalDate: photo.date };
});

// Pass undo callback to toast
showToast('Date updated', () => undoDateEdit(originalDates));
```

**Testing verified:**
- Info toasts display for 3 seconds
- Delete and date edit toasts display for 7 seconds with undo
- Undo button only appears when undo callback provided
- Single photo date edit undo works correctly
- Bulk photo date edit undo works correctly (all modes)
- Original dates restored correctly (ID-mapped, no confusion)
- "Restored 1 photo" / "Restored 2 photos" messaging
- No emoji in toast messages

---

### Date Picker Duplicate Years
**Fixed:** Year dropdown showing duplicate years  
**Documentation:** FIX_DATE_PICKER_DUPLICATES.md

**Issues resolved:**
- ✅ Same year no longer appears multiple times in year picker dropdown
- ✅ Function now clears existing options before repopulating
- ✅ Works correctly after database rebuild
- ✅ Works correctly after switching libraries

**Root cause:**
- `populateDatePicker()` was called multiple times (after rebuild, after health check)
- Function appended new options without clearing existing ones
- Duplicate years accumulated in the dropdown

**The fix:**
```javascript
// Clear existing options before populating (prevents duplicates)
yearPicker.innerHTML = '';
```

**Testing verified:**
- Each year appears exactly once in dropdown
- Years remain sorted newest to oldest
- No duplicates after database operations

---
