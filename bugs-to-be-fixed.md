# Bugs To Be Fixed - Prioritized

Last updated: January 21, 2026

**Status:** 10 items complete (Date Picker, Date Editor, Error Wording, Toast Timing, Database Rebuild, Corrupted DB Detection x2, Photo Picker Checkbox Toggle, Photo Picker Count Display, Photo Picker Background Counting), 3 remaining bugs + 1 deferred feature

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

## 🟡 TIER 2: POLISH - SHOULD FIX (Moderate Impact, Quick Wins)

### Month Dividers During Scroll
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 30 minutes  
**Status:** NOT STARTED

**Issue:** Month dividers update as you scroll, causing flashes of other dates
- Visual polish issue during frequent operation
- Likely throttling/debouncing issue with scroll handler

**Fix approach:** Debounce month divider updates during scroll

---

## 🟢 TIER 3: NICE TO HAVE (Low Impact, Edge Cases)

### Video Format Support (MPG/MPEG)
**Priority:** 🟢 LOW  
**Estimated effort:** 30 minutes  
**Status:** NOT STARTED

**Issue:** MOV, MP4, M4V work fine, but MPG/MPEG won't play in lightbox
- Format-specific issue
- Likely browser codec support issue
- May need server-side transcoding (more complex)
- Users can convert files manually as workaround

**Fix approach:** Check if browser supports format, consider transcoding or better error message

---

### Import Count Issues
**Priority:** 🟢 LOW  
**Estimated effort:** 1-2 hours  
**Status:** NOT STARTED

**Issue 1:** Import scoreboard count bounces around
- Counter resets/restarts (1,2,3,4,1,2,3,1) instead of smooth progression
- Happens when importing from NAS
- Import completes successfully despite visual bug
- Likely async/threading issue with SSE progress updates

**Issue 2:** Import shows double file count
- Shows 2x actual files at scan/import/completion stages (needs verification)

**Impact:** Confusing but doesn't prevent successful import

**Fix approach:** Debug SSE progress updates, ensure atomic counter updates

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
7. 🔴 **Photo Picker - NAS Navigation Issues** (2 hrs, high impact but complex)
8. 🟡 **Month Dividers During Scroll** (30 min, polish)
9. 🟢 **Video Format Support** (30 min, edge case)
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

**Next up:** Month Dividers During Scroll - Polish issue

**Total remaining:** 3 bugs + 1 deferred feature
- 🔴 Critical: 0 bugs (Photo Picker bugs FIXED ✅)
- 🟡 Polish: 1 bug (Month Dividers)
- 🟢 Edge cases: 2 bugs (Video Format, Import Counts)
- 🔵 Deferred: 1 feature (Duplicate Detection + Migration)

**Estimated total effort:** ~3-4 hours for remaining bugs (excluding deferred feature)

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
