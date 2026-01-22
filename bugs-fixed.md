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

## Session 2: January 21, 2026

### Database Rebuild - Empty Grid After Corrupted DB
**Fixed:** Database rebuild now properly handles corrupted databases  
**Version:** v99-v100

**Issues resolved:**
- ✅ Rebuild now always creates fresh database (deletes corrupted file first)
- ✅ Backend health check called after rebuild completes
- ✅ Photos appear in grid after rebuild completes
- ✅ Date picker populated correctly after rebuild

**Root causes:**
1. Backend only created new DB if file didn't exist - skipped creation if corrupted file present
2. Frontend didn't call library status check after rebuild - backend thought DB still missing

**The fix:**
```python
# Backend: Always delete old DB before creating fresh one
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)
conn = sqlite3.connect(DB_PATH)
create_database_schema(cursor)
```

```javascript
// Frontend: Call health check after rebuild completes
checkLibraryHealthAndInit()
```

**Testing verified:**
- Corrupt database with garbage text → trigger rebuild
- Rebuild completes successfully with fresh database
- Photos appear in grid immediately
- All API endpoints work correctly

---

### Corrupted DB Detection During Operations + Rebuild UI Polish
**Fixed:** Database corruption now detected during normal operations with polished rebuild dialog  
**Version:** v101-v116

**Issues resolved:**
- ✅ Backend detects SQLite corruption errors in all database routes
- ✅ Returns specific JSON error for corruption keywords
- ✅ Frontend checks for corruption and shows rebuild dialog
- ✅ Works during any operation (lightbox, grid, date picker, etc.)
- ✅ No more silent failures with console errors
- ✅ Rebuild dialog appears above lightbox (z-index fix)
- ✅ Lightbox closes when rebuild proceeds (shows grid during rebuild)
- ✅ Unified corruption/missing dialog messaging
- ✅ Fixed estimate display (e.g., "1-1 minutes" → "1 minute")
- ✅ Polished rebuild dialog state titles and text
- ✅ Removed Braille spinners from progress states
- ✅ Fixed stale state when reopening rebuild dialog

**Root causes:**
1. Backend routes had individual try/catch blocks that returned generic errors
2. Frontend corruption detection looked for wrong error format
3. Lightbox and rebuild overlay at same z-index (20000) - rebuild hidden
4. Lightbox stayed open during rebuild, blocking view of progress
5. Estimate calculation produced "1-1 minutes" when lower == upper bound
6. Rebuild overlay just hidden (not destroyed), showed stale state on reopen

**The fix:**
```python
# Backend: Catch corruption in route exception handlers
except sqlite3.DatabaseError as e:
    error_str = str(e).lower()
    if 'not a database' in error_str or 'malformed' in error_str or 'corrupt' in error_str:
        return jsonify({'error': 'file is not a database'}), 500
```

```javascript
// Frontend: Check for corruption keywords
if (errorMsg.includes('not a database') || 
    errorMsg.includes('malformed') || 
    errorMsg.includes('corrupt')) {
  showCriticalErrorModal('db_corrupted');
}
```

```css
/* Z-index fix: Rebuild overlay above lightbox */
--z-import-overlay: 20001; /* was 5000 */
--z-dialog: 20000; /* lightbox */
```

```javascript
// Close lightbox when rebuild proceeds
if (lightbox && lightbox.style.display !== 'none') {
  closeLightbox(); // Show grid during rebuild
}

// Destroy overlay on close (recreated fresh on next open)
function hideRebuildDatabaseOverlay() {
  if (overlay) overlay.remove();
}
```

```python
# Fix estimate display for edge cases
if lower == upper:
    unit = "minute" if lower == 1 else "minutes"
    return (minutes, f"{lower} {unit}")
```
```

**Dialog flow now works correctly:**
1. Corruption detected in lightbox → modal appears (visible above lightbox)
2. User clicks "Rebuild database" → scan shows (visible above lightbox)  
3. User clicks "Proceed" → lightbox closes, grid appears, rebuild progresses
4. Complete → grid with fresh photos

**Rebuild dialog states (polished):**
- **State 1:** "Database missing" modal with unified messaging
- **State 2:** "Rebuild database" - scan results with estimate (e.g., "1 minute" not "1-1 minutes")
- **State 3:** "Rebuilding database" - "Indexing files..." progress (no spinners)
- **State 4:** "Database rebuilt" - "Database rebuilt successfully." with file count

**Testing verified:**
- Corrupt database → click photo → immediate rebuild dialog appears
- Dialog visible above lightbox (not hidden behind)
- Click "Rebuild database" → scan completes → "Proceed" button visible
- Click "Proceed" → lightbox closes, grid appears, rebuild progresses over grid
- Grid loading with corrupted DB → rebuild dialog  
- Date picker with corrupted DB → rebuild dialog
- No silent failures, clear user feedback at every step
- Utilities menu → rebuild after corruption flow → clean UI (no stale state)
- Estimate displays correctly for all file counts

---

### Folder Picker - Backup/System Volume Filtering
**Fixed:** Folder picker now filters out backup and system volumes  
**Version:** v117

**Issues resolved:**
- ✅ Time Machine backup volumes filtered from top-level locations (`Backups of...`)
- ✅ System volumes filtered (`Macintosh HD`, `Data`, `Preboot`, `Recovery`, `VM`)
- ✅ Backup/archive folders filtered during browsing
- ✅ Symlinks to system locations filtered
- ✅ Only shows user directories, Shared, and legitimate external drives

**Root cause:**
- Top-level locations list (`/api/filesystem/get-locations`) showed all volumes in `/Volumes`
- Only filtered `Macintosh HD` and hidden volumes
- Time Machine backups and other system volumes visible
- Directory listing showed backup/archive folders when browsing

**The fix:**
```python
# Top-level locations: Enhanced volume filtering
system_volumes = ['Macintosh HD', 'Macintosh SSD', 'Data', 'Preboot', 'Recovery', 'VM']
if volume in system_volumes:
    continue

volume_lower = volume.lower()
if volume.startswith('Backups of') or 'backup' in volume_lower or 'time machine' in volume_lower:
    continue

if os.path.islink(volume_path):
    continue

# Directory browsing: Enhanced backup folder filtering
backup_patterns = ['backup', 'backups', 'archive', 'archives', 'time machine', 'time_machine']
if any(pattern in item_lower for pattern in backup_patterns):
    continue
```

**Testing verified:**
- `/Volumes` shows only legitimate external drives (e.g., `eric_files`)
- `Backups of Eric's MacBook Pro` volumes hidden (3 volumes filtered)
- `Macintosh HD` symlink hidden
- System volumes hidden (`Data`, etc.)
- Browsing directories: `Backups`, `Archive` folders hidden
- User home, Shared, and external drives still visible

---

### Photo Picker - Checkbox Toggle Bug
**Fixed:** Checkboxes now toggle on/off correctly  
**Version:** v123-v124

**Issues resolved:**
- ✅ Folder checkboxes toggle properly (check → uncheck → check)
- ✅ Selection count updates correctly ("1 folder selected" ↔ "No items selected")
- ✅ Continue button only enabled when items actually selected
- ✅ Works with empty folders and folders with contents
- ✅ No more duplicate click handlers firing

**Root cause:**
- `updateFileList()` was called multiple times during navigation
- Each call added a NEW click event listener to the file list element
- Listeners accumulated, causing multiple handlers to fire for single click
- First handler: Added folder to selection → count updated → icon updated
- Second handler: Removed folder from selection → count updated → icon NOT updated
- Result: Checkbox appeared checked but selection was empty

**The fix:**
```javascript
// Store handler reference at module level
let fileListClickHandler = null;

// Remove old listener before adding new one
if (fileListClickHandler) {
  fileList.removeEventListener('click', fileListClickHandler);
}

// Create and store new handler
fileListClickHandler = async (e) => { /* handler logic */ };
fileList.addEventListener('click', fileListClickHandler);

// Simplified icon update: Re-render instead of manual DOM manipulation
if (type === 'folder') {
  await toggleFolder(path);
  await updateFileList(); // Re-render to get correct state
} else {
  toggleFile(path);
  await updateFileList(); // Re-render to get correct state
}
```

**Testing verified:**
- Empty folder: Click checkbox → "1 folder selected" → click again → "No items selected"
- Folder with files: Same behavior, recursive counting works
- Multiple folders: Each toggles independently
- Continue button: Enabled only when count > 0
- No console errors, clean state management

---

### Folder Picker - Sticky Last Directory
**Fixed:** Folder picker now remembers last selected location across sessions  
**Version:** v118

**Issues resolved:**
- ✅ Last selected path saved to localStorage
- ✅ Picker opens to last location on subsequent uses (across page reloads)
- ✅ Validates saved path exists and is accessible before using it
- ✅ Falls back to Desktop if saved path no longer exists or is inaccessible
- ✅ Works with both "Choose" button and clicking database file

**Root cause:**
- Picker had in-memory persistence within a session (`currentPath` variable)
- No persistence across page reloads or app restarts
- Always defaulted to Desktop on fresh load

**The fix:**
```javascript
// Save path when user selects it
localStorage.setItem('folderPicker.lastPath', selectedPath);

// Load saved path on picker open (before defaulting to Desktop)
const savedPath = localStorage.getItem('folderPicker.lastPath');
if (savedPath) {
  try {
    await listDirectory(savedPath); // Validate it exists
    initialPath = savedPath;
  } catch (error) {
    // Path no longer accessible, fall through to Desktop
  }
}
```

**Path resolution order:**
1. `options.initialPath` (if explicitly provided)
2. `currentPath` (in-memory, same session)
3. `localStorage.getItem('folderPicker.lastPath')` (persisted across sessions) ← NEW
4. Desktop (fallback)
5. Home folder (if Desktop fails)
6. First location (if all else fails)

**Testing verified:**
- Navigate to `/Volumes/eric_files` → choose → reload page → picker opens to `eric_files`
- Navigate to external drive → unmount drive → reload → picker falls back to Desktop
- Works with "Choose" button selection
- Works with clicking database file shortcut
- Saved path validated before use (handles deleted/unmounted paths gracefully)

---

### Picker Improvements - Shared Path Logic & Cancel Behavior
**Fixed:** Extracted shared default path logic and improved picker UX  
**Version:** v119-v122

**Issues resolved:**
- ✅ PhotoPicker now has sticky last directory (persists across sessions)
- ✅ Extracted default path logic to shared `pickerUtils.js` utility
- ✅ Single place to change default folder (Desktop → Pictures, etc.)
- ✅ Both pickers use shared localStorage key (`picker.lastPath`)
- ✅ Navigate in PhotoPicker → FolderPicker starts at same location
- ✅ Switch Library dialog hidden before FolderPicker opens (visibility bug)
- ✅ PhotoPicker saves path on cancel (not just on continue)

**Root causes:**
- PhotoPicker reset `currentPath` on every open (no persistence)
- Default path logic duplicated in both pickers (~80 lines)
- Separate localStorage keys prevented cross-picker memory
- Switch Library dialog stayed visible behind FolderPicker
- PhotoPicker only saved path on "Continue", not "Cancel"

**The fix:**
```javascript
// v119: PhotoPicker sticky path (same pattern as FolderPicker)
// Preserve currentPath between opens, check localStorage, save on continue

// v120: Shared utility for default path
// pickerUtils.js: getDefaultPath(topLevelLocations, listDirectory)
// Both pickers call PickerUtils.getDefaultPath()

// v121: Shared localStorage key
// Changed: folderPicker.lastPath / photoPicker.lastPath
// To: picker.lastPath (shared)
// Also: Close Switch Library dialog before opening FolderPicker

// v122: Save on cancel
if (currentPath !== VIRTUAL_ROOT) {
  localStorage.setItem('picker.lastPath', currentPath);
}
```

**Testing verified:**
- PhotoPicker: Navigate → cancel → reopen → remembers location
- PhotoPicker: Navigate → continue → refresh → reopen → remembers location
- FolderPicker: Navigate → cancel → reopen → remembers location
- FolderPicker: Navigate → choose → refresh → reopen → remembers location
- Cross-picker: Navigate in PhotoPicker → open FolderPicker → starts at same location
- Switch Library: Dialog hides cleanly when FolderPicker opens
- Both pickers fall back to Desktop if saved path no longer exists

---
