# Bugs To Be Fixed - Prioritized

Last updated: January 27, 2026

**Status:** 6 remaining bugs + 1 deferred feature

---

## 🟡 TIER 2: POLISH - SHOULD FIX (Moderate Impact, Quick Wins)

### Utilities Menu - String and Order Changes
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 5 minutes  
**Status:** PARTIALLY COMPLETE (v164-v175)

**Issue:** Utilities menu items need reordering and renaming

**What's done:**
- ✅ "Switch library" → "Open library" (v164-v175)

**What remains:**
1. "Rebuild database" → "Clean database"
2. "Remove duplicates" → "Show duplicates"
3. Move "Rebuild thumbnails" to 3rd place (currently 5th)

**Current order:**
1. Open library ✅
2. Update library index ✅
3. Rebuild database ❌ (should be "Clean database")
4. Remove duplicates ❌ (should be "Show duplicates")
5. Rebuild thumbnails ❌ (should be 3rd)

**Target order:**
1. Open library ✅
2. Update library index ✅
3. Clean database (renamed + moved up)
4. Rebuild thumbnails (moved up)
5. Show duplicates (renamed + moved down)

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

### Library Conversion Scoreboard - Remove Green Text Color
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 5 minutes  
**Status:** NOT STARTED

**Issue:** Kill green text color from library conversion scoreboard
- "PROCESSED" count displays in green (e.g., 251 in green)
- Inconsistent with other counts (DUPLICATES, ERRORS in white)
- Green color is unnecessary emphasis

**Fix approach:** Remove green color styling from PROCESSED count, use consistent white text

---

### Lightbox - Non-Functional Scrollbar
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 30 minutes  
**Status:** NOT STARTED

**Issue:** Lightbox has a scrollbar that does nothing
- Scrollbar appears in lightbox view
- Scrollbar is non-functional/doesn't scroll
- Creates visual clutter and confusion
- Likely CSS overflow issue

**Fix approach:** Remove scrollbar by fixing CSS (overflow: hidden or proper height constraints)

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

1. 🟡 **Utilities Menu - String and Order Changes** (5 min, quick win builds momentum)
2. 🟡 **Library Conversion Scoreboard - Remove Green Text Color** (5 min, quick win same area)
3. 🟡 **Lightbox - Non-Functional Scrollbar** (30 min, visual polish)
4. 🟡 **Folder Picker - Add Folder Selection via Checkbox** (1-2 hrs, UX improvement)
5. 🟡 **Image Rotation - Bake Metadata into Pixels** (3-4 hrs, compatibility improvement)
6. 🟡 **Duplicates Feature - Why Show-Only?** (research/documentation)
7. 🟡 **Performance Optimization - High-Latency Operations** (research + implementation TBD)
8. 🔵 **Import Duplicate Detection** (deferred feature work)

**Strategy:** Clear quick wins (10 min, 2 bugs) before deep work on conversion cleanup

---

## SUMMARY

**Next up:** Utilities Menu + Scoreboard (10 min, quick wins)

**Total remaining:** 6 bugs + 1 deferred feature
- 🟡 Polish: 6 bugs (Utilities Menu, Scoreboard Color, Lightbox Scrollbar, Folder Picker Checkbox, Image Rotation Baking, Duplicates Research, Performance Research)
- 🔵 Deferred: 1 feature (Duplicate Detection + Migration)

**Estimated total effort:** ~7-8 hours for remaining bugs + research (excluding deferred feature and performance optimization implementation)

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
