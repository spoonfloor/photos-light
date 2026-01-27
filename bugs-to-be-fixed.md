# Bugs To Be Fixed - Prioritized

Last updated: January 27, 2026

**Status:** 5 remaining bugs + 1 deferred feature

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

### Folder Picker - Add Folder Selection via Checkbox
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 1-2 hours  
**Status:** NOT STARTED

**Issue:** Add ability to select a folder in folder picker by toggling checkmark
- Currently must click "Select this location" button
- Would be more intuitive to click folder checkbox to select it
- Checkbox toggle should immediately select that folder location
- Improves UX consistency with file selection patterns

**Fix approach:** Add click handler to folder checkbox that selects the folder location directly

---

### Image Rotation - Bake Metadata into Pixels
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 3-4 hours  
**Status:** NOT STARTED

**Issue:** Consider baking rotation metadata into the file
- If a portrait file is relying on metadata to display properly, rotate the pixels and ditch the rotation flag
- Some viewers don't respect EXIF rotation flags properly
- Causes images to display incorrectly in other applications
- Better compatibility if rotation is applied to actual pixel data

**Impact:** Improves interoperability with other photo viewers/editors that don't respect EXIF orientation

**Fix approach:** 
- Detect images with EXIF rotation flags
- Rotate pixel data to match intended orientation
- Remove/reset EXIF rotation flag
- Possibly offer as optional operation (could be part of import, rebuild, or manual utility)

---

## 🔵 TIER 3: DEFERRED FEATURE WORK (Not Bugs)

### Import Duplicate Detection + Migration Infrastructure
**Priority:** 🔵 DEFERRED  
**Estimated effort:** 4-6 hours  
**Status:** SCHEMA DESIGNED, REVERTED (60% complete)

**Decision made:**
- Duplicate = Same Hash + Same Date/Time (to the second)
- Allows "Christmas tree scenario" (same photo at different dates)
- Requires schema change: `UNIQUE(content_hash, date_taken)`

**What's done:**
- ✅ Schema v2 designed
- ✅ Import logic updated
- ✅ Library sync logging added
- ✅ Documentation created
- ✅ Reverted to v1 to unblock testing

**What's needed:**
- ❌ Migration infrastructure (schema version detection + v1→v2 migration)
- ❌ Frontend testing with new schema
- ❌ "Show Duplicates" utility update (keep as informational, move to bottom of menu)

**Defer because:**
- Not a bug - current functionality works
- Not blocking current functionality
- Migration is complex, needs dedicated time as feature work
- Other bugs have higher UX impact

**Sub-issues from original bug bash:**
- Import dupe counts don't reflect reality - Will work with new definition
- Import count bounces around - Separate issue (see backlog)
- Duplicates utility shows zero - Will be fixed by schema change

---

## Recommended Fix Order

Based on impact, frequency, and effort (quick wins first, then deep work):

1. 🔴 **Update Database - Stuck on Removing Untracked Files** (2-3 hrs, CRITICAL - blocks index cleanup)
2. 🔴 **Date Change to Single Date - Not Working** (2-3 hrs, CRITICAL - core functionality)
3. 🟡 **Folder Picker - Add Folder Selection via Checkbox** (1-2 hrs, UX improvement)
4. 🟡 **Image Rotation - Bake Metadata into Pixels** (3-4 hrs, compatibility improvement)
5. 🟡 **Performance Optimization - High-Latency Operations** (research + implementation TBD)
6. 🔵 **Import Duplicate Detection** (deferred feature work)

---

## SUMMARY

**Next up:** Update Database - Stuck on Removing Untracked Files (CRITICAL - 2-3 hrs)

**Total remaining:** 5 bugs + 1 deferred feature
- 🔴 Critical: 2 bugs (Update Database Stuck, Date Change Not Working)
- 🟡 Polish: 3 bugs (Folder Picker Checkbox, Image Rotation Baking, Performance Research)
- 🔵 Deferred: 1 feature (Duplicate Detection + Migration)

**Estimated total effort:** ~9-10 hours for remaining bugs + research (excluding deferred feature and performance optimization implementation)

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
