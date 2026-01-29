# Bugs To Be Fixed - Prioritized

Last updated: January 28, 2026

**Status:** 5 remaining bugs

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

### Primary CTAs - Keyboard Activation (Return Key)

**Priority:** 🟡 MEDIUM  
**Estimated effort:** 1-2 hours  
**Status:** NOT STARTED

**Issue:** All primary (purple) CTAs can be activated by pressing return

- Add keyboard accessibility to all primary action buttons
- Return/Enter key should trigger primary action in dialogs
- Improves UX and accessibility
- Common pattern in modern applications

**Impact:** Better keyboard navigation and accessibility

**Fix approach:**

- Identify all primary (purple) CTA buttons across the app
- Add Enter key listener to dialogs that triggers primary button
- Ensure proper focus management
- Test across all dialog types

---

## Recommended Fix Order

Based on impact, frequency, and effort (quick wins first, then deep work):

1. 🔴 **Update Database - Stuck on Removing Untracked Files** (2-3 hrs, CRITICAL - blocks index cleanup)
2. 🔴 **Date Change to Single Date - Not Working** (2-3 hrs, CRITICAL - core functionality)
3. 🔴 **Terraforming - Should Destroy Current Database** (1 hr, CRITICAL - data integrity)
4. 🟡 **Primary CTAs - Keyboard Activation (Return Key)** (1-2 hrs, accessibility)
5. 🟡 **Performance Optimization - High-Latency Operations** (research + implementation TBD)

---

## SUMMARY

**Next up:** Update Database - Stuck on Removing Untracked Files (CRITICAL - 2-3 hrs)

**Total remaining:** 5 bugs

- 🔴 Critical: 3 bugs (Update Database Stuck, Date Change Not Working, Terraforming Database Cleanup)
- 🟡 Polish: 2 bugs (Primary CTA Keyboard Activation, Performance Research)

**Estimated total effort:** ~7-9 hours for remaining bugs + research (excluding performance optimization implementation)

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
