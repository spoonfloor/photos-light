# Bugs To Be Fixed - Prioritized

Last updated: January 25, 2026

**Status:** 19 items complete (Date Picker Duplicates, Date Editor Year Dropdown, Error Wording, Toast Timing, Database Rebuild, Corrupted DB Detection x2, Photo Picker Checkbox Toggle, Photo Picker Count Display, Photo Picker Background Counting, Photo Picker Button Rename, Photo Picker Confirmation Dialog Removal, Month Dividers During Scroll, Date Changes Survive Rebuild, Date Changes Latency & Feedback, Import Duplicate Categorization, Date Picker Missing After Import, Database Operations Empty Folder Cleanup, Dialog Spinner Removal), 4 remaining bugs + 1 deferred feature

---

## 🔴 TIER 1: CRITICAL - MUST FIX (High Impact, Core Workflows)

### ✅ Photo Picker - Checkbox Toggle Bug (FIXED v123-v124)
**Priority:** 🔴 CRITICAL  
**Estimated effort:** 1 hour  
**Status:** ✅ FIXED - See bugs-fixed.md

---

### ✅ Photo Picker - Count Display (FIXED v125)
**Priority:** 🔴 CRITICAL  
**Estimated effort:** 30 minutes  
**Status:** ✅ FIXED - See bugs-fixed.md

---

### ✅ Photo Picker - Background Counting Completion (FIXED v126)
**Priority:** 🔴 CRITICAL  
**Estimated effort:** 30 minutes  
**Status:** ✅ FIXED - See bugs-fixed.md

---

### ✅ Photo Picker - Button Rename & Confirmation Dialog (FIXED v127)
**Priority:** 🔴 CRITICAL  
**Estimated effort:** 1 hour  
**Status:** ✅ FIXED - See bugs-fixed.md

---

## 🟡 TIER 2: POLISH - SHOULD FIX (Moderate Impact, Quick Wins)

### ✅ Date Changes - Survive Database Rebuild (FIXED v146-v150)
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 1-2 hours  
**Status:** ✅ FIXED - See bugs-fixed.md

---

### ✅ Date Picker - Missing After Import (FIXED v158)
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 30 minutes  
**Status:** ✅ FIXED - Already implemented, verified working

**Issue:** Blank library → import photos → app bar date picker absent (bad)

**Resolution:** Investigation revealed this was already fixed in v158. Import completion automatically calls `loadAndRenderPhotos()` which refreshes the date picker via `populateDatePicker()`. Verified working correctly.

---

### ✅ Month Dividers During Scroll (FIXED v129)
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 30 minutes  
**Status:** ✅ FIXED - See bugs-fixed.md

---

### ✅ Dialog Spinner - Remove When Realtime Feedback Exists (FIXED v162)
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 30 minutes  
**Status:** ✅ FIXED - See bugs-fixed.md

---

### Dialog Framework - Multiple Dialogs Showing Simultaneously
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 2 hours  
**Status:** NOT STARTED

**Issue:** Need way to prevent two dialogs from appearing at the same time
- Multiple dialogs can appear on top of each other
- Creates confusing UX and potential interaction issues
- Need modal queue or dialog manager

**Special case - Toast interaction:**
- Toast needs to show at same time as many dialogs, but should push dialog up so they don't interact (or similar strategy)
- Toast and dialog should be able to coexist without overlapping

**Fix approach:** Implement dialog queue/manager system to ensure only one dialog displays at a time, with special handling for toast notifications that can coexist with dialogs

---

### Utilities Menu - String and Order Changes
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 15 minutes  
**Status:** NOT STARTED

**Issue:** Utilities menu items need reordering and renaming

**Required changes:**
1. "Switch library" → "Open library" (switch is implied when you open another file)
2. "Rebuild database" → "Clean database"
3. "Update library index" - keep as is (2nd place)
4. "Rebuild thumbnails" - move to 3rd place (currently 4th)
5. "Remove duplicates" → "Show duplicates" (4th place)

**Current order:**
1. Switch library
2. Update library index
3. Rebuild database
4. Remove duplicates
5. Rebuild thumbnails

**New order:**
1. Open library (renamed)
2. Update library index
3. Clean database (renamed)
4. Rebuild thumbnails (moved up)
5. Show duplicates (renamed, moved down)

---

### Duplicates Feature - Why Show-Only?
**Priority:** 🟡 MEDIUM  
**Estimated effort:** Research/documentation  
**Status:** NOT STARTED

**Issue:** Find out why we decided to rewrite the remove dupes feature so that it only shows dupes
- Original feature removed duplicates
- Now it only shows them
- Need to document the reasoning behind this design decision
- May inform future feature work

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

### ✅ Date Changes - Latency & Feedback Issues (FIXED v155)
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 2-3 hours  
**Status:** ✅ FIXED - See bugs-fixed.md

---

## 🟢 TIER 3: NICE TO HAVE (Low Impact, Edge Cases)

All edge case bugs resolved or moved to backlog.

---

### Manual Restore & Rebuild
**Priority:** 🟢 LOW  
**Estimated effort:** 1 hour  
**Status:** ✅ CANNOT REPRODUCE - Photo organizes correctly during rebuild

**Issue:** Manually restore deleted photo to root level (no date folder) → rebuild database → photo reappears (good) but still at root level (bad)
- Files should be organized into date folders during rebuild
- Very specific edge case requiring intentional user action
- Manual workaround exists

**Testing notes:** Cannot reproduce issue. Photos automatically organize into date folders during rebuild as expected.

---

### Database Missing Prompt
**Priority:** 🟢 LOW  
**Estimated effort:** 30 minutes  
**Status:** ✅ CANNOT REPRODUCE - First-run flow handles missing DB

**Issue:** Database missing → should prompt to rebuild, but no prompt appears
- Can't reliably reproduce (possibly deleted .db manually)
- May already be handled by existing first-run flow
- Need to verify if this is actually a bug

**Testing notes:** First-run and library switching flows properly handle missing database. Cannot reproduce missing prompt scenario.

---

## 🔵 TIER 4: DEFERRED FEATURE WORK (Not Bugs)

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
- Import count bounces around - Separate issue (see Tier 3, #8)
- Duplicates utility shows zero - Will be fixed by schema change

---

## 📋 RECOMMENDED FIX ORDER

Based on impact, frequency, and effort:

1. ✅ **Date Picker Duplicate Years** (DONE - v85)
2. ✅ **Date Editor - Year Dropdown Missing New Year** (DONE - v86)
3. ✅ **Error Message Wording** (DONE - v88)
4. ✅ **Toast Timing + Date Edit Undo** (DONE - v89-v94)
5. ✅ **Database Rebuild - Empty Grid** (DONE - v99-v100)
6. ✅ **Corrupted DB Detection During Operations** (DONE - v101-v110)
7. ✅ **Photo Picker - Checkbox Toggle Bug** (DONE - v123-v124)
8. ✅ **Photo Picker - Count Display** (DONE - v125)
9. ✅ **Photo Picker - Background Counting** (DONE - v126)
10. ✅ **Photo Picker - Button Rename & Confirmation Dialog** (DONE - v127)
11. ✅ **Month Dividers During Scroll** (DONE - v129)
12. ✅ **Date Changes - Don't Survive Database Rebuild** (DONE - v146-v150)
13. ✅ **Date Changes - Latency & Feedback Issues** (DONE - v155)
14. ✅ **Import Duplicate Categorization** (DONE - v156-v157)
15. ✅ **Date Picker - Missing After Import** (DONE - v158, verified working)
16. ✅ **Database Operations - Empty Folder Cleanup** (DONE - v161)
17. 🟡 **Dialog Spinner - Remove When Realtime Feedback Exists** (30 min, visual clutter)
18. 🟡 **Dialog Framework - Multiple Dialogs Showing Simultaneously** (2 hrs, UX consistency)
19. 🟡 **Utilities Menu - String and Order Changes** (15 min, UX consistency)
20. 🟡 **Duplicates Feature - Why Show-Only?** (research/documentation)
21. 🟡 **Performance Optimization - High-Latency Operations** (research + implementation TBD)
22. 🔵 **Import Duplicate Detection** (deferred feature work)

**Rationale:**
- **Quick wins first (#1-4):** Combined 30 min, immediate visible improvements - ALL DONE ✅
- **Data integrity (#5-6):** Database rebuild and corruption detection - ALL DONE ✅
- **Critical checkbox bug (#7):** Photo picker toggle - DONE ✅
- **Then polish (#8-12):** Visual glitches and edge cases after critical issues resolved
- **Deferred (#13):** Feature work, not bug fixes - save for dedicated feature development

---

## SUMMARY

**Next up:** Utilities Menu - String and Order Changes (15 min quick win)

**Total remaining:** 4 bugs + 1 deferred feature
- 🔴 Critical: 0 bugs (All Photo Picker bugs FIXED ✅)
- 🟡 Polish: 4 bugs (Dialog Framework, Utilities Menu Changes, Duplicates Feature Research, Performance Optimization Research)
- 🟢 Edge cases: 0 bugs (All edge cases resolved ✅)
- 🔵 Deferred: 1 feature (Duplicate Detection + Migration)

**Estimated total effort:** ~2-3 hours for remaining bugs + research (excluding deferred feature and performance optimization implementation)

---

## 📝 BACKLOG: UX IMPROVEMENTS (Not Bugs, Future Enhancements)

These are enhancement ideas, not bugs. To be considered for future feature work.

### Library Management
- ~~Hide Time Machine BU folders from list~~ ✅ FIXED v117 (also hides backup/archive folders and system volumes)
- ~~Make last-used path sticky~~ ✅ FIXED v118-v122 (persists across sessions, shared between pickers, saves on cancel)
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
