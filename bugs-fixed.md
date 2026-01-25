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

## Session 3: January 22, 2026

### Photo Picker - Count Display
**Fixed:** Count readout now shows both folder and file counts  
**Version:** v125

**Issues resolved:**
- ✅ Count readout always shows both folders and files (e.g., "1 folder, 0 files selected")
- ✅ Works with empty folders ("1 folder, 0 files selected")
- ✅ Works with folders containing files ("7 folders, 1,824 files selected")
- ✅ Shows proper pluralization for both counts
- ✅ Displays progress state correctly during background counting

**Root cause:**
- Old logic only showed counts that were greater than zero
- User expected both counts always visible for clarity
- Counting state didn't show folder count clearly

**The fix:**
```javascript
// ALWAYS show both folder and file counts
const folderText = `${folderCount} folder${folderCount !== 1 ? 's' : ''}`;
const fileText = `${fileCount.toLocaleString()} file${fileCount !== 1 ? 's' : ''}`;

// Show counting state or final count
if (isCountingInBackground) {
  countEl.textContent = `Counting files... ${folderText}, ${fileCount.toLocaleString()}+ files selected`;
} else {
  countEl.textContent = `${folderText}, ${fileText} selected`;
}
```

**Testing verified:**
- Empty folder: "1 folder, 0 files selected"
- Folder with files: Correct file count displayed
- Multiple folders: Proper folder and file counts
- Background counting: "Counting files... 1 folder, 100+ files selected" format
- Proper pluralization for singular/plural

---

### Photo Picker - Background Counting Completion
**Fixed:** Folder file count now always resolves to final count  
**Version:** v126

**Issues resolved:**
- ✅ "Counting files... 1100+" now resolves to final count
- ✅ Final count always displayed after recursive folder scan completes
- ✅ Works regardless of how long counting takes
- ✅ No more hanging "X+" readouts

**Root cause:**
- `selectFolderRecursiveBackground()` had conditional logic for final UI update
- Only called `updateSelectionCount()` if counting took > 300ms
- Fast counting operations (< 300ms) never updated UI with final count
- Folder named "1100" on Desktop matched the "1100+" counting display format, making bug obvious

**The fix:**
```javascript
// ALWAYS update UI with final count after counting completes
if (!countingAborted) {
  const totalTime = Date.now() - startTime;
  isCountingInBackground = false;

  // Removed conditional check (was: if (totalTime > 300))
  folderStateCache.clear();
  updateSelectionCount(); // Always show final count

  console.log(`✅ Folder counting complete in ${totalTime}ms`);
}
```

**Testing verified:**
- Select folder "1100" on Desktop → count resolves correctly
- Fast counting (< 300ms): Shows final count
- Slow counting (> 300ms): Shows final count
- Multiple folders: Each resolves properly
- No hanging "X+" readouts

---

### Photo Picker - Button Rename & Confirmation Dialog Removal
**Fixed:** Import button renamed and redundant dialog removed  
**Version:** v127

**Issues resolved:**
- ✅ Button text changed from "Continue" to "Import"
- ✅ Button ID updated from `photoPickerContinueBtn` to `photoPickerImportBtn`
- ✅ Confirmation dialog removed from import flow
- ✅ Import starts immediately after clicking [Import]
- ✅ Streamlined UX - one less click to import

**Root cause:**
- UX feedback indicated confirmation dialog was redundant
- User already made explicit selection in photo picker
- Extra "Found X files. Start import?" dialog added unnecessary friction

**The fix:**
```javascript
// Created new scanAndImport() function (no confirmation dialog)
async function scanAndImport(paths) {
  // ... scan paths to expand folders into files ...
  
  if (total_count === 0) {
    showToast('No media files found', null);
    return;
  }

  // Start import directly (no confirmation dialog)
  await startImportFromPaths(files);
}

// Modified triggerImport() to use new function
await scanAndImport(selectedPaths); // Instead of scanAndConfirmImport()
```

**HTML changes:**
- Button text: "Continue" → "Import"
- Button ID: `photoPickerContinueBtn` → `photoPickerImportBtn`

**JavaScript changes:**
- All variable references updated: `continueBtn` → `importBtn`
- Handler renamed: `handleContinue()` → `handleImport()`

**Flow comparison:**
- **Old:** Select → [Continue] → Dialog "Found X files. Start import?" → [Import] → Import starts
- **New:** Select → [Import] → Import starts ✓

**Testing verified:**
- Button shows "Import" text
- Button disabled when no selection
- Click [Import] → scanning toast → import starts immediately
- No confirmation dialog appears
- Import completes successfully

---

---

---

## Session 5: January 23, 2026

### Month Dividers During Scroll - Date Picker Flashing
**Fixed:** IntersectionObserver logic for date picker scroll updates  
**Version:** v129

**Issues resolved:**
- ✅ Date picker no longer flashes between months during slow scroll
- ✅ Picker switches instantly at exact boundary when month leaves viewport
- ✅ Rock back/forth over boundary → crisp, instant switches
- ✅ No oscillation or visual glitches

**Root cause:**
- IntersectionObserver compared sections by intersection ratio to find "most visible"
- Used 11 threshold points `[0, 0.1, 0.2, ... 1.0]` causing excessive callbacks
- `entries` array only contained sections that crossed thresholds, not all visible sections
- When scrolling near boundaries, wrong section could temporarily "win" the ratio comparison
- Example: March 55% visible, Feb enters at 12% and crosses 0.1 threshold
  - `entries = [Feb]` (only Feb crossed threshold)
  - Code compared only entries, Feb "won" with 12%
  - Picker flashed to February even though March had 55%
- Next frame: March crosses 0.5 threshold
  - `entries = [March]`, picker switches back to March
  - Result: Flash between Feb and March

**The fix:**
```javascript
// OLD (buggy): Compared only sections that crossed thresholds
const observer = new IntersectionObserver(
  (entries) => {
    let mostVisible = null;
    let maxRatio = 0;
    
    entries.forEach((entry) => {  // ⚠️ Only changed sections
      if (entry.intersectionRatio > maxRatio) {
        maxRatio = entry.intersectionRatio;
        mostVisible = entry.target;
      }
    });
    // ...
  },
  { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] }
);

// NEW (fixed): Tracks ALL visible sections, picks topmost in DOM order
const sectionVisibility = new Map();

const observer = new IntersectionObserver(
  (entries) => {
    // Maintain visibility state for all sections
    entries.forEach((entry) => {
      const monthId = entry.target.dataset.month;
      if (monthId) {
        if (entry.intersectionRatio > 0) {
          sectionVisibility.set(monthId, entry.target);
        } else {
          sectionVisibility.delete(monthId);
        }
      }
    });

    // Get topmost visible section in actual DOM order
    const allSections = document.querySelectorAll('.month-section');
    const topmostVisibleSection = Array.from(allSections).find(section => 
      sectionVisibility.has(section.dataset.month)
    );
    
    if (!topmostVisibleSection) return;
    
    // Update picker to topmost visible section
    const monthId = topmostVisibleSection.dataset.month;
    // ... update pickers
  },
  { threshold: [0] }  // Single threshold - just detect ANY visibility
);
```

**Key improvements:**
1. **Map tracks all visible sections** - Persists state between callbacks
2. **Single threshold `[0]`** - Only fires when sections enter/leave viewport (not at 10 intermediate points)
3. **Topmost visible logic** - Query DOM in order, pick first visible section (not "most visible by ratio")
4. **Newspaper reading model** - "As long as any part of article is showing, you're reading it"

**Behavior:**
- **Before:** March 55%, Feb 30% → Picker could flash to Feb during scroll
- **After:** March visible (any amount) → Shows "March 2026" ✓
- **Before:** Oscillated between months at boundaries
- **After:** Switches instantly when last pixel of month scrolls above fold ✓

**Testing verified:**
- Slow scroll through months with 12 images (2 rows)
- First row scrolls above fold → picker stays on current month
- Last row scrolls above fold → instant switch to next month
- Rock back/forth over boundary → crisp, reliable switches
- No flashing, no oscillation, no visual glitches

---

## Session 5: January 23, 2026

### Month Dividers During Scroll - Date Picker Flashing
**Fixed:** Date picker scroll update logic  
**Version:** v129

**Issues resolved:**
- ✅ Date picker no longer flashes between months during scroll
- ✅ Picker switches instantly when month boundary crossed
- ✅ Rock back/forth test passes - crisp, instant switches
- ✅ No oscillation or visual glitches

**Root cause:**
The IntersectionObserver callback only received `entries` for sections that crossed thresholds since the last callback, not all visible sections. With 11 thresholds `[0, 0.1, 0.2, ... 1.0]`, sections crossing different thresholds could temporarily "win" the visibility comparison even when another section had higher overall visibility.

Example bug scenario:
- March at 55% visible (stable, no threshold crossed)
- Feb enters viewport, crosses 0.1 threshold
- `entries = [Feb]` (only Feb in array)
- Code finds "most visible" in entries → Feb wins with 12%
- Picker flashes to "February" even though March had 55%
- Next frame: March crosses 0.5 threshold → picker switches back

**The fix:**
```javascript
// OLD: Compared only sections that crossed thresholds
const observer = new IntersectionObserver((entries) => {
  let mostVisible = null;
  let maxRatio = 0;
  
  entries.forEach((entry) => {  // ⚠️ Only changed sections
    if (entry.intersectionRatio > maxRatio) {
      maxRatio = entry.intersectionRatio;
      mostVisible = entry.target;
    }
  });
}, {
  threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
});

// NEW: Tracks all visible sections, picks topmost in DOM order
const sectionVisibility = new Map();

const observer = new IntersectionObserver((entries) => {
  // Maintain visibility state for all sections
  entries.forEach((entry) => {
    const monthId = entry.target.dataset.month;
    if (monthId) {
      if (entry.intersectionRatio > 0) {
        sectionVisibility.set(monthId, entry.target);
      } else {
        sectionVisibility.delete(monthId);
      }
    }
  });

  // Get topmost visible section in actual DOM order
  const allSections = document.querySelectorAll('.month-section');
  const topmostVisibleSection = Array.from(allSections).find(section => 
    sectionVisibility.has(section.dataset.month)
  );
  
  // Update picker to topmost visible section
}, {
  threshold: [0]  // Single threshold - just detect ANY visibility
});
```

**Key improvements:**
1. **Map tracks all visible sections** - Persists state between callbacks
2. **Single threshold `[0]`** - Only fires when sections enter/leave viewport
3. **Topmost visible logic** - Query DOM in order, pick first visible section
4. **"Newspaper reading" model** - Show month as long as any part is visible

**Testing verified:**
- Slow scroll through months with 12 images (2 rows)
- First row scrolls above fold → picker stays on current month
- Last row scrolls above fold → instant switch to next month
- Rock back/forth over boundary → crisp, reliable switches
- No flashing, no oscillation

---

## Session 4: January 22, 2026

### Import Counting - Duplicate File Path Bug
**Fixed:** Import scan now reports accurate file counts  
**Version:** v128

**Issues resolved:**
- ✅ Photo picker now sends only root selections to backend (not expanded file lists)
- ✅ Import scan counts each file once (not multiple times)
- ✅ Duplicate count now accurate (reflects actual content duplicates)
- ✅ Preserves UX showing full recursive file count in picker

**Root cause:**
- Photo picker recursively expanded folders into individual file paths
- When user selected a folder, it sent BOTH the folder AND all individual files to backend
- Backend scanned the folder (adding all files), then added individual files again
- Files in nested folders counted 3+ times (once per parent folder + once individually)
- Example: Selecting folder with 265 files sent 267 paths (2 folders + 265 files)
- Backend counted: 250 root files × 2 + 15 subfolder files × 3 = 545 files (should be 265)
- Duplicate count was wrong: 545 - 250 = 295 duplicates (should be 15)

**The fix:**
```javascript
// photoPicker.js: New function to filter expanded paths
function getRootSelections() {
  const allPaths = Array.from(selectedPaths.keys());
  const rootPaths = [];
  
  for (const path of allPaths) {
    // Check if any OTHER path is a parent of this path
    const hasParentInSelection = allPaths.some(otherPath => {
      if (otherPath === path) return false; // Skip self
      return path.startsWith(otherPath + '/');
    });
    
    // If no parent found in selection, this is a root selection
    if (!hasParentInSelection) {
      rootPaths.push(path);
    }
  }
  
  return rootPaths;
}

// Send only root selections (folders user checked)
const rootSelections = getRootSelections();
resolve(rootSelections);
```

**Data flow (before fix):**
1. User checks folder `import-test` (contains 250 files + `dupes` subfolder with 15 files)
2. Picker expands: adds folder + all 265 files individually → 267 paths
3. Backend scans folder (265 files) + processes 265 individual files → 545 file paths
4. Import: 250 unique → imported, 295 remaining → marked as duplicates

**Data flow (after fix):**
1. User checks folder `import-test`
2. Picker shows: "2 folders, 265 files selected" (UX preserved)
3. Picker sends: Only root selections `["/import-test", "/import-test/dupes"]` → 2 paths
4. Backend scans both folders → 265 unique file paths
5. Import: 250 unique → imported, 15 actual duplicates → rejected

**Architecture improvement:**
- **Separation of concerns:** Frontend handles UI/display, backend handles filesystem scanning
- **Single source of truth:** Backend is authoritative for file discovery
- **Clean data contract:** "Here are folders to scan" vs "here's a messy mix of folders AND files"
- **No hacks:** Fixed root cause instead of adding defensive deduplication

**Testing verified:**
- Folder with 265 files (250 unique + 15 duplicates)
- Picker displays: "2 folders, 265 files selected" ✓
- Import reports: "Importing 265 files" ✓ (was 545)
- Import completes: "250 imported, 15 duplicates" ✓ (was 250 imported, 295 duplicates)
- Database contains: 250 unique photos with 250 unique hashes ✓
- No duplicate file paths sent to backend ✓

---

## Session 6: January 23, 2026

### Photo Order Instability with Identical Timestamps
**Fixed:** Deterministic ordering when photos have same date  
**Version:** v133-v134

**Issues resolved:**
- ✅ Photos with identical timestamps now sort consistently
- ✅ Order stable across database rebuilds
- ✅ Order stable across page reloads
- ✅ Predictable tie-breaking using filepath (alphabetical)

**Root cause:**
SQL query used `ORDER BY date_taken DESC` with no secondary sort key. When multiple photos had identical `date_taken` values (down to the second), SQLite returned them in arbitrary order. While consistent within a session, the order could change after database rebuild because:
1. Rebuild deletes database → all `id` values lost
2. Files walked in arbitrary filesystem order
3. New `id` values assigned based on insertion order
4. Different insertion order = different tie-breaking order

**Edge case trigger:**
This situation occurs when:
- User manually changes multiple photos to same date/time (e.g., bulk edit to "2026-01-15 12:00:00")
- Photos from burst mode have identical timestamps (rare, camera dependent)

**Decision:**
This is **not a bug** - it's expected behavior. When timestamps are identical, some tie-breaker must determine order. The fix ensures that tie-breaker is stable and deterministic.

If users need specific ordering, they already have the tool: offset photos by 1 second using the date editor.

**The fix:**
```python
# app.py: Added current_path as secondary sort key (3 locations)
ORDER BY date_taken DESC, current_path ASC

# library_sync.py: Sort files before inserting during rebuild
untracked_files_list = sorted(list(filesystem_paths))
```

**Why `current_path`?**
- Stable across rebuilds (path doesn't change)
- Contains date and hash: `2026/2026-01-15/img_20260115_hash.jpg`
- Alphabetical sort is deterministic
- No schema changes required

**Why not `id`?**
- `id` values are not stable across rebuilds
- Database rebuild assigns new sequential ids based on insertion order
- Insertion order varies based on filesystem walk order

**Testing verified:**
- Import 4 photos with different dates
- Change all to same date → order changes to alphabetical by filename (expected)
- Rebuild database → order stays identical (stable) ✓
- Reload page → order stays identical (deterministic) ✓
- No random reordering, predictable behavior

**User guidance:**
- When photos have identical timestamps, they sort alphabetically by filename
- To control exact ordering, use date editor to offset photos by 1 second

---

## Session 7: January 24, 2026

### Date Changes - Survive Database Rebuild
**Fixed:** EXIF/metadata writes now persist through rebuilds with clean thumbnail management  
**Version:** v146-v150

**Issues resolved:**
- ✅ Video dates now persist across rebuilds (ffprobe for reading metadata)
- ✅ WMV format explicitly rejected (cannot store metadata reliably)
- ✅ Old thumbnails automatically deleted when hash changes (keeps filesystem clean)
- ✅ Database and filesystem stay synchronized
- ✅ Format extension lists synced between app.py and library_sync.py

**Root causes:**
1. **Video metadata not read during rebuild:** `extract_exif_date()` used `exiftool` for all files, which doesn't read video metadata. Fell back to filesystem modification time (unreliable - changes during file operations).
2. **WMV can't store metadata:** Despite being pickable, WMV format cannot reliably store `creation_time` metadata. Files were accepted on import but dates didn't persist.
3. **Orphaned thumbnails:** EXIF writes change file hashes, but old thumbnails with old hashes were left on disk, wasting space.
4. **Format list drift:** `library_sync.py` had hardcoded extension lists that weren't updated when `app.py` expanded its lists. Rebuild ignored new formats.

**The fixes:**

**Fix 1: Enhanced `extract_exif_date()` to use ffprobe for videos**
```python
def extract_exif_date(file_path):
    ext = os.path.splitext(file_path)[1].lower()
    video_exts = {'.mov', '.mp4', '.m4v', ...}
    
    if ext in video_exts:
        # Try ffprobe for video metadata
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-show_entries', 'format_tags=creation_time', ...],
            ...
        )
        if result.returncode == 0 and result.stdout.strip():
            # Convert ISO 8601 to EXIF format: 2000-01-01T08:00:06.000000Z -> 2000:01:01 08:00:06
            iso_date = result.stdout.strip()
            date_part, time_part = iso_date.split('T')
            time_part = time_part.split('.')[0].split('Z')[0]
            exif_date = date_part.replace('-', ':') + ' ' + time_part
            return exif_date
    else:
        # Try exiftool for photo EXIF
        result = subprocess.run(['exiftool', '-DateTimeOriginal', ...])
```

**Fix 2: Added WMV to unsupported formats**
```python
def write_video_metadata(file_path, new_date):
    unsupported_formats = {'.mpg', '.mpeg', '.vob', '.ts', '.mts', '.avi', '.wmv'}
    if ext_lower in unsupported_formats:
        raise Exception(f"Format {ext.upper()} does not support embedded metadata")
```

**Fix 3: Auto-delete old thumbnails on hash change**
```python
# In both import and date edit flows:
if new_hash != old_hash:
    print(f"  📝 Hash changed: {old_hash[:8]} → {new_hash[:8]}")
    
    # Delete old thumbnail if hash changed (keep DB squeaky clean)
    if old_hash:
        old_thumb_path = os.path.join(THUMBNAIL_CACHE_DIR, old_hash[:2], old_hash[2:4], f"{old_hash}.jpg")
        if os.path.exists(old_thumb_path):
            os.remove(old_thumb_path)
            print(f"  🗑️  Deleted old thumbnail")
    
    # Update database with new hash
    cursor.execute("UPDATE photos SET content_hash = ? WHERE id = ?", (new_hash, photo_id))
```

**Fix 4: Synced format lists across modules**
```python
# library_sync.py: Updated hardcoded lists to match app.py
photo_exts = {
    '.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.bmp', '.tiff', '.tif',
    '.webp', '.avif', '.jp2',
    '.raw', '.cr2', '.nef', '.arw', '.dng'
}
video_exts = {
    '.mov', '.mp4', '.m4v', '.mkv',
    '.wmv', '.webm', '.flv', '.3gp',
    '.mpg', '.mpeg', '.vob', '.ts', '.mts', '.avi'
}
```

**Workflow verification:**
1. ✅ **Blank library → import with date → rebuild → correct dates**
   - Fresh import to August 2030
   - 17/18 files correctly in `2030/2030-08-24/`
   - 1 WMV stuck at 2026 (expected - can't store metadata)
   
2. ✅ **Date edit → rebuild → edited date persists**
   - Photos: EXIF DateTimeOriginal written and read correctly
   - Videos (MOV, MP4, WEBM, etc.): `creation_time` written and read correctly
   - WMV: Rejected on import with clear error
   
3. ✅ **Hash consistency**
   - File hash matches database hash after EXIF write
   - Thumbnails regenerate with correct hash
   - No orphaned thumbnails accumulating

**Testing verified:**
- Import test library with mixed formats → all supported formats import correctly
- Edit dates on photos and videos → dates survive rebuild
- WMV files rejected on import with message: "Format WMV does not support embedded metadata"
- Thumbnail directory stays clean (old thumbnails deleted automatically)
- Database rebuild finds all files (no formats ignored due to outdated extension lists)

**Documentation:**
- Added investigation notes to `EXIF_IMPORT_HOMEWORK.md`
- Captures full diagnosis process and testing results

---

## Session 8: January 24, 2026

### Import Duplicate Categorization
**Fixed:** Duplicate files during import now correctly categorized and counted  
**Documentation:** FIX_IMPORT_DUPLICATE_CATEGORIZATION.md  
**Version:** v157

**Issues resolved:**
- ✅ Duplicates detected during hash collision (after EXIF write) now categorized as "duplicate" instead of "unsupported"
- ✅ UI counters now accurate: DUPLICATES shows duplicate count, not lumped into ERRORS
- ✅ Clear error message: "Duplicate file (detected after processing)" instead of raw SQL constraint
- ✅ Rejection report shows duplicates under "DUPLICATE" section, not "UNSUPPORTED"

**Root cause:**
When files were imported and EXIF metadata written, the file content changed and was rehashed. If the new hash matched an existing photo, the database UPDATE failed with `UNIQUE constraint failed: photos.content_hash`. This error wasn't recognized as a duplicate and fell through to "unsupported" category. Additionally, all rejections incremented `error_count` instead of distinguishing duplicates.

**The fix (2 parts):**

**v156:** Added UNIQUE constraint detection to error categorization:
```python
elif 'unique constraint' in error_str and 'content_hash' in error_str:
    category = 'duplicate'
    user_message = "Duplicate file (detected after processing)"
```

**v157:** Fixed counter logic to distinguish duplicates from errors:
```python
if category == 'duplicate':
    duplicate_count += 1
else:
    error_count += 1
```

**Testing verified:**
- Ground truth: 62 files (59 unique, 3 duplicates) hashed with SHA-256
- Import attempt: 48 imported, 3 duplicates, 10 errors
- UI counters: IMPORTED: 48, DUPLICATES: 3, ERRORS: 10 ✓
- Report structure:
  - 3 files under "DUPLICATE" section with clear message ✓
  - 8 files under "UNSUPPORTED" (video formats) ✓
  - 2 files under "CORRUPTED" (test files) ✓

**Investigation:**
- Full code flow traced from import through EXIF write to rehashing
- Database and filesystem verified to establish ground truth
- Error categorization logic analyzed and tested
- Multiple import attempts with known duplicate sets

**Impact:** Pure UX improvement. Files were always correctly rejected and rolled back. Now users get accurate counts and clear messaging about why files were rejected.

---

### Date Picker - Missing After Import
**Fixed:** Date picker now automatically refreshes after import completes  
**Version:** v158 (already implemented)

**Issues resolved:**
- ✅ Date picker appears/updates automatically after importing into blank library
- ✅ No page refresh required to see date navigation after first import
- ✅ Works for all import scenarios (blank library, additional imports)

**Root cause:**
This bug was reported as missing behavior, but investigation revealed it was already implemented correctly in v158. The import completion flow automatically triggers a photo grid reload, which includes refreshing the date picker.

**The implementation:**
```javascript
// handleImportEvent() - when import completes
if (importedPhotos > 0) {
  console.log(`🔄 Reloading ${importedPhotos} newly imported photos...`);
  loadAndRenderPhotos();  // Reloads grid
}

// loadAndRenderPhotos() - after loading photos
await populateDatePicker();  // Refreshes date picker
```

**Flow:**
1. Import completes → `handleImportEvent()` receives `'complete'` event
2. If photos imported > 0 → calls `loadAndRenderPhotos()`
3. `loadAndRenderPhotos()` → calls `await populateDatePicker()`
4. Date picker refreshed with new years from database

**Testing verified:**
- Blank library → import photos → date picker appears immediately ✓
- Existing library → import additional photos to new years → date picker updates ✓
- No manual refresh required ✓

**Impact:** This was verified as already working correctly. Moved to fixed bugs list for documentation purposes.

---

### Lightbox Image Sizing - EXIF Orientation
**Fixed:** Portrait images with EXIF rotation now fill lightbox properly  
**Documentation:** FIX_LIGHTBOX_EXIF_ORIENTATION.md  
**Version:** v160

**Issues resolved:**
- ✅ Portrait photos with EXIF orientation metadata now fill viewport without letterboxing
- ✅ Lightbox sizing works correctly at all window sizes
- ✅ Database stores display dimensions (EXIF-corrected) instead of raw sensor dimensions

**Root cause:**
Camera sensors are always landscape. When you take a portrait photo, the camera:
1. Captures pixels in landscape (e.g., 3264×2448)
2. Writes EXIF Orientation tag (e.g., "rotate 90° CW")

Browsers/viewers read EXIF and rotate for display (2448×3264). But `get_image_dimensions()` returned raw sensor dimensions without applying EXIF rotation, storing wrong dimensions in database.

Result: Lightbox used landscape dimensions (3264×2448) to calculate sizing, but image displayed as portrait (2448×3264) → wrong aspect ratio → letterboxing.

**The fix:**
```python
# Before (app.py line 133):
with Image.open(file_path) as img:
    return img.size  # Raw dimensions, ignores EXIF

# After (v160):
with Image.open(file_path) as img:
    from PIL import ImageOps
    img_oriented = ImageOps.exif_transpose(img)
    return img_oriented.size  # Display dimensions, EXIF applied
```

`ImageOps.exif_transpose()` reads EXIF Orientation tag and returns image with correct display dimensions.

**Testing verified:**
- Portrait photo with EXIF Orientation = 6 (rotate 90° CW)
- Before: Database had 3264×2448 (landscape), lightbox letterboxed
- After rebuild: Database has 2448×3264 (portrait), lightbox fills properly ✓
- Works at all window sizes ✓

**Migration required:**
- New imports (v160+): Work immediately ✅
- Existing photos: Need "Rebuild Database" to fix stored dimensions
- Only affects photos with EXIF orientation tags 5, 6, 7, 8 (~10-40% of phone photo libraries)

**Impact:** Proper architecture - database is source of truth with correct data. No runtime workarounds needed.

---

