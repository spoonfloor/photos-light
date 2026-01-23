# Bugs To Be Fixed - Prioritized

Last updated: January 21, 2026

**Status:** 13 items complete (Date Picker, Date Editor, Error Wording, Toast Timing, Database Rebuild, Corrupted DB Detection x2, Photo Picker Checkbox Toggle, Photo Picker Count Display, Photo Picker Background Counting, Photo Picker Button Rename, Photo Picker Confirmation Dialog Removal, Month Dividers During Scroll), 3 remaining bugs + 1 deferred feature

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

### Date Changes - Don't Survive Database Rebuild
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 1-2 hours  
**Status:** NOT STARTED

**Issue:** Date changes don't survive database rebuild (bad)
- User manually edits photo dates
- Rebuild database is triggered
- Date changes are lost, photos revert to original dates
- Results in data loss from user's perspective

**Fix approach:** Need to persist date edits to file metadata (EXIF) or separate metadata file, not just in database

---

### Date Picker - Missing After Import
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 30 minutes  
**Status:** NOT STARTED

**Issue:** Blank library → import photos → app bar date picker absent (bad)
- After first import into empty library, date picker doesn't appear in app bar
- Likely missing UI refresh/update after import completes
- Prevents navigation by date after import

**Fix approach:** Trigger app bar refresh after import completion

---

### ✅ Month Dividers During Scroll (FIXED v129)
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 30 minutes  
**Status:** ✅ FIXED - See bugs-fixed.md

---

### Dialog Spinner - Remove When Realtime Feedback Exists
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 30 minutes  
**Status:** NOT STARTED

**Issue:** Remove braille spinner from all dialogs where there is already realtime feedback
- Redundant visual element when progress is already shown
- Creates visual clutter
- Affects multiple dialogs (import, rebuild, etc.)

**Fix approach:** Audit all dialogs and remove spinner when progress bars/counts/status text already provide feedback

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
12. 🟡 **Date Changes - Don't Survive Database Rebuild** (1-2 hrs, data loss issue)
13. 🟡 **Date Picker - Missing After Import** (30 min, affects post-import workflow)
14. 🟡 **Dialog Spinner - Remove When Realtime Feedback Exists** (30 min, visual clutter)
10. 🟢 **Import Count Issues** (2 hrs, low impact)
11. 🟢 **Manual Restore & Rebuild** (1 hr, edge case)
12. 🟢 **Database Missing Prompt** (30 min, can't reproduce)
13. 🔵 **Import Duplicate Detection** (deferred feature work)

**Rationale:**
- **Quick wins first (#1-4):** Combined 30 min, immediate visible improvements - ALL DONE ✅
- **Data integrity (#5-6):** Database rebuild and corruption detection - ALL DONE ✅
- **Critical checkbox bug (#7):** Photo picker toggle - DONE ✅
- **Then polish (#8-12):** Visual glitches and edge cases after critical issues resolved
- **Deferred (#13):** Feature work, not bug fixes - save for dedicated feature development

---

## SUMMARY

**Next up:** Date Changes - Don't Survive Database Rebuild (data loss issue)

**Total remaining:** 3 bugs + 1 deferred feature
- 🔴 Critical: 0 bugs (All Photo Picker bugs FIXED ✅)
- 🟡 Polish: 3 bugs (Date Changes Persistence, Date Picker Missing After Import, Dialog Spinner Removal)
- 🟢 Edge cases: 0 bugs (Video Format and Import Counts removed - cannot reproduce or low priority)
- 🔵 Deferred: 1 feature (Duplicate Detection + Migration)

**Estimated total effort:** ~2-3 hours for remaining bugs (excluding deferred feature)

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
- Changes photo order when all photos have same date (sorted by name?) - What is desired UX?

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
