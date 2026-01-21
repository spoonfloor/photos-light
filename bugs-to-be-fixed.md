# Bugs To Be Fixed - Prioritized

Last updated: In progress session

---

## TIER 1: CRITICAL UX (Next Priority)

### Database Rebuild - Empty Grid After Corrupted DB
**Priority:** 🟡 MEDIUM - Reproducible data integrity issue  
**Status:** NOT STARTED

**Issue:** Database corrupted → prompt to rebuild
- Prompts to rebuild, but photos don't appear on rebuild complete
- Dialog gives way to blank grid (app UI visible but no photos)
- Can reproduce by manually corrupting DB

**Desired behavior:**
- Dialog: "Database corrupted. Rebuild?" with Confirm/Cancel
- After rebuild, photos should appear in grid

**May reveal:** Issues with other rebuild scenarios

---

## TIER 2: FEATURE WORK (When Ready)

### Import Duplicate Detection + Migration Infrastructure
**Priority:** 🟢 LOW - Feature enhancement, not blocking  
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
- Not blocking current functionality
- Migration is complex, needs dedicated time
- Other bugs have higher UX impact

**Sub-issues from original bug bash:**
- Import dupe counts don't reflect reality - Will work with new definition
- Import count bounces around - Separate issue (see Tier 4)
- Duplicates utility shows zero - Will be fixed by schema change

---

## TIER 4: POLISH & MINOR ISSUES

### Manual Restore & Rebuild
**Priority:** 🟢 LOW - Edge case  
**Status:** NOT STARTED

**Issue:** Manually restore deleted photo so it sits at root level (no date folder) → rebuild database → photo reappears in grid (good) → photo still at root level (bad)
- Files should be organized into date folders during rebuild

---

### Import Count Issues
**Priority:** 🟢 LOW - Visual bug, doesn't block functionality  
**Status:** NOT STARTED

**Issue 1:** Import scoreboard count bounces around
- Counter resets/restarts (1,2,3,4,1,2,3,1) instead of smooth progression
- Happens when importing from NAS
- Import completes successfully despite visual bug
- Likely async/threading issue with SSE progress updates

**Issue 2:** Import shows double file count
- Shows 2x actual files at scan/import/completion stages (needs verification)

**Impact:** Confusing but doesn't prevent successful import

---

### Toast Timing
**Priority:** 🟢 LOW - Quick constant fix  
**Status:** NOT STARTED

**Issue:** Toast shows for 8 seconds with undo option
- 8 seconds is not the value nor should it be
- Need to verify or create a central variable to elect a canonical value

**Note:** Current code has `TOAST_DURATION = 2500` (2.5 seconds) in main.js

---

### Month Dividers During Scroll
**Priority:** 🟢 LOW - Visual glitch  
**Status:** NOT STARTED

**Issue:** Month dividers update as you scroll
- Flashes of other dates appear on scroll

---

### Video Format Support (MPG/MPEG)
**Priority:** 🟢 LOW - Format support  
**Status:** NOT STARTED

**Issue:** MOV, MP4, M4V, MPG, MPEG
- MPG/MPEG won't play in lightbox
- Other formats work fine

---

### Database Missing Prompt
**Priority:** 🟢 LOW - Can't reproduce reliably  
**Status:** NOT STARTED

**Issue:** Database missing → prompt to rebuild
- No such prompt appears
- Can't reliably reproduce (possibly deleted .db manually)

**Desired behavior:**
- Dialog: "No database found. Create new library here?" with Confirm/Cancel

---

## BACKLOG: PASSES WITH NOTES (UX Improvements)

### Library Management
- Hide Time Machine BU folders from list
- Add rescan button to folder picker
- Make last-used path sticky
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

---

## DEFERRED: CAN'T ASSESS / NEED CLARIFICATION

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

---

### Photo Picker - NAS Navigation Issues
**Priority:** TBD  
**Status:** NOT STARTED

**Issue:** Problems adding files from photo_library on NAS

**Sub-issues:**
1. **Partial selection state on open:** Add photos icon in top menu bar → navigate to eric_files → photo_library shows partial selection (bad); selection should be blank slate on invoking add
2. **Breadcrumb mismatch:** Picker can show eric_files in breadcrumbs while showing folders inside photo_library (e.g., 1900, 1950, etc.) (bad)
3. **Incorrect selection tally:** Selection tally shows e.g., "162 folders, 1235 files" where none are selected
4. **Performance:** Checking/unchecking is painfully slow

---

### Index Rebuild - No Resume Capability
**Priority:** TBD  
**Status:** NOT STARTED

**Issue:** Need a way to resume index rebuilding if it fails

**Impact:** If rebuild process fails or is interrupted, must start over from scratch

---

### Library Creation - Better New Library Flow
**Priority:** TBD  
**Status:** NOT STARTED

**Issue:** Need a better way to create a new library

**Desired flow:**
- Switch library → Create new (change to Sentence case) → folder/location selection flow → empty library state (NOT first run state)

**Current problem:** New library points to first run state instead of empty library state

---

## SUMMARY

**Next up:** Error Message Wording (2 min) or Photo Picker NAS Issues (2 hrs)

**Total remaining:** 
- Critical: 1 (DB Rebuild)
- Feature work: 1 (deferred)
- Polish: 7
- Backlog UX: ~15 items
- Needs triage: 4
