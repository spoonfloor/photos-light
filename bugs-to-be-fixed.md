# Bugs To Be Fixed - Prioritized

Last updated: January 28, 2026

**Status:** 9 remaining bugs

---

## 🟡 TIER 2: POLISH - SHOULD FIX (Moderate Impact, Quick Wins)

### Update Database - Stuck on Removing Untracked Files

**Priority:** 🔴 CRITICAL  
**Estimated effort:** 2-3 hours  
**Status:** NOT STARTED

**Issue:** Update database is stuck on removing untracked files, falsely reporting untracked files

- Operation gets stuck during "removing untracked files" phase
- Reports untracked files that don't actually exist or are false positives
- Blocks completion of update index operation
- May be related to file path detection or database query logic

**Impact:** Prevents users from cleaning up their library index, can leave database in inconsistent state

**Fix approach:**

- Debug untracked file detection logic
- Check if file paths are being compared correctly
- Verify database query for untracked files
- Add timeout or skip mechanism for problematic files
- Improve error handling and reporting

---

### Date Change to Single Date - Not Working

**Priority:** 🔴 CRITICAL  
**Estimated effort:** 2-3 hours  
**Status:** NOT STARTED

**Issue:** Date change to single date still not working (nature photos used for test)

- User attempts to change date on photos
- Operation fails or doesn't apply changes
- Core functionality that should be working
- May be related to previous totalEl error or separate issue

**Impact:** Prevents users from correcting photo dates, core organizational feature

**Fix approach:**

- Debug date change operation for single date changes
- Check if backend is receiving/processing request correctly
- Verify file system operations are completing
- Check database updates are being applied
- Review any error logs or console output

---

### Terraforming - Should Destroy Current Database

**Priority:** 🔴 CRITICAL  
**Estimated effort:** 1 hour  
**Status:** NOT STARTED

**Issue:** Terraforming should destroy current database

- Library conversion (terraforming) creates new organized structure
- Old database should be removed/replaced
- Currently may be leaving old database intact
- Can cause confusion or database conflicts

**Impact:** Leaves stale database files, potential for using wrong database or data inconsistency

**Fix approach:**

- Add database deletion/replacement step to terraforming process
- Ensure new database is created fresh
- Verify no remnants of old database remain
- May need backup/safety checks before deletion

---

### Terraforming - Cancel/Go Back Causes Stalled State

**Priority:** 🔴 CRITICAL  
**Estimated effort:** 1-2 hours  
**Status:** NOT STARTED

**Issue:** 'Go back' action in terraforming leads to a stalled state (loading library)

- During terraform preview, user clicks "go back" or cancels
- App shows "Loading library..." indefinitely
- Console shows "User cancelled at preview" and "Terraform flow failed or was cancelled"
- App enters limbo state and can't recover to show library
- User is stuck with no way to proceed

**Impact:** Blocks user from accessing their library after canceling terraforming, requires app restart

**Fix approach:**

- Add proper cleanup/state reset when terraform is cancelled
- Ensure library state is restored properly after cancel
- Return user to previous valid state (e.g., folder picker or previous library)
- Add error recovery mechanism
- Test all cancel/back paths in terraform flow

---

### Performance Optimization - High-Latency Operations

**Priority:** 🟡 MEDIUM  
**Estimated effort:** Research + implementation (TBD)  
**Status:** NOT STARTED

**Issue:** Research improvements to efficiency of operations requiring rehashing and high-latency processing

**Operations to analyze:**

1. Import (file scanning, hashing, EXIF extraction)
2. Date change (file moves, EXIF updates, rehashing)
3. Rebuild database (full rescan, rehashing all files)
4. Update database/index (incremental scanning, hash comparison)
5. Any other operations requiring rehashing

**Research goals:**

- Identify bottlenecks in each operation
- Evaluate caching strategies for hashes
- Consider incremental vs full processing
- Explore parallelization opportunities
- Assess trade-offs between speed and accuracy

**Outcome:** Performance optimization plan with prioritized improvements

---

### Duplicates Feature - Why Show-Only?

**Priority:** 🟡 MEDIUM  
**Estimated effort:** Research/documentation  
**Status:** NOT STARTED

**Issue:** Determine why we no longer offer 'remove duplicates'. Show only

- Feature currently only shows duplicates, doesn't remove them
- Need to research history and design decision
- May have been intentional change or incomplete implementation
- Documentation needed to understand rationale

**Research goals:**

- Check code history for when removal functionality was present
- Determine if this was an intentional design change or incomplete feature
- Document reasoning behind current show-only approach
- Assess if removal functionality should be restored

---

### Lightbox - RAW Format Not Displaying

**Priority:** 🔴 CRITICAL  
**Estimated effort:** 2-3 hours  
**Status:** NOT STARTED

**Issue:** RAW format doesn't show in lightbox

- Lightbox opens for RAW files but image fails to load
- Console shows "Image 1 failed to load" despite Status: 200, OK: true
- Corruption check passes but display fails
- Likely needs RAW file conversion or proper MIME type handling

**Impact:** RAW photos are common in photo libraries, prevents viewing significant portion of library

**Fix approach:**

- Check if server is serving RAW files with correct MIME type
- May need to generate preview/proxy image for RAW files
- Consider converting RAW to JPEG on-the-fly for display
- Check if browser can handle RAW formats natively
- Add error handling and user feedback for unsupported formats

---

### Lightbox - MOV Videos Not Displaying

**Priority:** 🔴 CRITICAL  
**Estimated effort:** 2-3 hours  
**Status:** NOT STARTED

**Issue:** .mov doesn't show in lightbox

- Lightbox opens for .mov files and shows video player controls
- Video duration shows (e.g., "0:03 / 0:05") but video content is black/not displaying
- Console shows proper dimensions and viewport calculations
- Likely codec or MIME type issue

**Impact:** MOV is a very common video format, prevents viewing videos in lightbox

**Fix approach:**

- Check if server is serving .mov files with correct MIME type (video/quicktime)
- Verify browser codec support for MOV container
- May need to transcode MOV to MP4/WebM for broader browser compatibility
- Check video element source and loading
- Add codec detection and error handling
- Consider generating web-compatible preview versions on import

---

### Lightbox - Add Rotation Action

**Priority:** 🟡 MEDIUM  
**Estimated effort:** 3-4 hours  
**Status:** NOT STARTED

**Issue:** Add rotation action in lightbox; needs to rotate actual pixels when possible losslessly, use flag when not (per terraforming protocol)

- Lightbox currently lacks ability to rotate images
- Should rotate actual pixels for lossless formats (JPEG with proper tools)
- Should use EXIF rotation flag for formats where pixel rotation would be lossy
- Follow terraforming protocol for file handling

**Impact:** Allows quick photo correction without leaving lightbox view

**Fix approach:**

- Add rotation button(s) to lightbox UI (rotate left/right)
- Use Material Symbols icon: `rotate_right` at 100 weight
- Decide if rotation should be clockwise (cw) or counterclockwise (ccw)
- Icon stylesheet: `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&icon_names=rotate_right" />`
- Implement backend endpoint for rotation
- Use lossless JPEG rotation when possible (jpegtran or similar)
- Fall back to EXIF rotation flag for other formats
- Update thumbnail after rotation
- Refresh display in lightbox

---

## Recommended Fix Order

Based on impact, frequency, and effort (quick wins first, then deep work):

1. 🔴 **Update Database - Stuck on Removing Untracked Files** (2-3 hrs, CRITICAL - blocks index cleanup)
2. 🔴 **Date Change to Single Date - Not Working** (2-3 hrs, CRITICAL - core functionality)
3. 🔴 **Terraforming - Should Destroy Current Database** (1 hr, CRITICAL - data integrity)
4. 🔴 **Terraforming - Cancel/Go Back Causes Stalled State** (1-2 hrs, CRITICAL - blocks app access)
5. 🔴 **Lightbox - RAW Format Not Displaying** (2-3 hrs, CRITICAL - common file format)
6. 🔴 **Lightbox - MOV Videos Not Displaying** (2-3 hrs, CRITICAL - common video format)
7. 🟡 **Lightbox - Add Rotation Action** (3-4 hrs, feature addition with lossless rotation)
8. 🟡 **Duplicates Feature - Why Show-Only?** (research/documentation)
9. 🟡 **Performance Optimization - High-Latency Operations** (research + implementation TBD)

---

## SUMMARY

**Next up:** Update Database - Stuck on Removing Untracked Files (CRITICAL - 2-3 hrs)

**Total remaining:** 9 bugs

- 🔴 Critical: 6 bugs (Update Database Stuck, Date Change Not Working, Terraforming Database Cleanup, Terraforming Cancel Stall, Lightbox RAW Format, Lightbox MOV Videos)
- 🟡 Polish: 3 bugs (Lightbox Rotation, Duplicates Research, Performance Research)

**Estimated total effort:** ~16-21 hours for remaining bugs + research (excluding performance optimization implementation)

---

## 📝 BACKLOG: UX IMPROVEMENTS (Not Bugs, Future Enhancements)

These are enhancement ideas, not bugs. To be considered for future feature work.

### Library Management

- Add rescan button to folder picker
- Add keyboard shortcut for desktop (command-shift D)
- Photo picker is a bit sluggish
- 'Select this location' should read 'Open' and be disabled for folders without DB
- Add 'Create new' button that creates blank DB and navigates to empty library state

### Delete & Recovery

- Should also remove thumbnail folder when deleting thumbnail cache entry

### Date Editing

- Date change causes navigation from lightbox to grid (bad UX)
- Date change anchor date should be topmost photo in grid

### Lightbox

- Date jump should frame grid so date is visible
- Full frame icon → spacebar → closes full frame (bad)
- Video thumbnail shows first frame (bad UX when frame is black)

### Library Creation - Better New Library Flow

- Switch library → Create new (change to Sentence case) → folder/location selection flow → empty library state (NOT first run state)
- Current problem: New library points to first run state instead of empty library state

### Index Rebuild - No Resume Capability

- Need a way to resume index rebuilding if it fails
- Impact: If rebuild process fails or is interrupted, must start over from scratch

---

## ⏸️ DEFERRED: CAN'T ASSESS / NEED CLARIFICATION

These issues need more information or test cases before they can be prioritized.

### Navigation & Sorting Edge Cases

- Year-aware landing (prefers staying in target year) - Don't understand; need script to test
- Directional landing based on sort order - Don't understand; need script to test

### Date Editing

- Sequence mode seconds interval - Can't assess in app because lacks seconds display

### Import Behind the Scenes

- Extract EXIF date (fallback to mtime) - What does this mean?

### Various Features Need Backend Verification

- Clean Index: scan/execute/ghosts/moles
- Remove Duplicates utility internals (will be "Show Duplicates" after migration)
- Rebuild Thumbnails: check count/clear cache/lazy regen
- Health check on switch library
- Handle migration prompts
- Execute rebuild SSE progress
- File format conversions (HEIC/TIF → JPEG)
- Error handling for import/runtime issues
