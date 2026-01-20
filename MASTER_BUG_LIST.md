# Master Bug Priority List - Updated

Status as of: Session in progress

---

## ✅ COMPLETED (This Session)

### 1. Database Backup System
- Added backup calls before all destructive operations
- Creates timestamped backups in `.db_backups/`
- Tested and verified working

### 2. Database Rebuild Dialog  
- Fixed JavaScript error (`buttons.forEach`)
- Added estimated duration display
- Fixed completion message ("Indexed 0 files" bug)
- Tested with small and large libraries

### 3. Invalid Date Handling
- Added dynamic day validation (prevents February 31st)
- Updates day dropdown based on month/year selection
- Handles leap years correctly
- Tested and verified working

---

## 🚧 IN PROGRESS

### 4. Import Duplicate Detection (5 Related Issues)

**Current Status:** Schema & logic updated, needs migration + testing

**What we decided:**
- New definition: Duplicate = Same Hash + Same Date/Time (to the second)
- Allows "Christmas tree scenario" (same photo at different dates)
- Changed schema: `UNIQUE(content_hash, date_taken)` instead of `content_hash UNIQUE`
- Changed import logic: check hash + date together

**What's done:**
- ✅ Updated schema definition (v2)
- ✅ Updated import duplicate check
- ✅ Updated library sync logging
- ✅ Documentation created

**What's NOT done:**
- ❌ Migration infrastructure for existing libraries
- ❌ Frontend testing with new schema
- ❌ "Show Duplicates" utility update (keep as informational)
- ❌ Move "Show Duplicates" to bottom of utilities menu

**Sub-issues from original bug bash:**
1. Auto-dedupe by content hash - Will work with new definition
2. Import progress counts bounce around - Separate issue, not addressed yet
3. Show counts non-sequential - Separate issue, not addressed yet
4. Duplicates utility shows zero - Will be fixed by schema change + kept as "Show Duplicates" (info only)
5. Import says double file count - Separate issue, not addressed yet

---

## 📋 REMAINING CRITICAL ISSUES

### 5. Lazy Loading & Thumbnail Issues
**Status:** NOT STARTED

**Issue:** Purging thumbnails causes broken images below fold; rebuilding index restores
- Core viewing experience problem
- May be cache invalidation issue

### 6. Date Picker Issues (Duplicate Years)
**Status:** NOT STARTED

**Issue:** Same year appears multiple times in date picker dropdown
- Affects navigation significantly
- Likely SQL/query issue

### 7. Database Rebuild Issues (Remaining)
**Status:** PARTIAL (2 sub-issues remain)

**Completed:**
- ✅ Estimate duration display
- ✅ Warning dialog JS error
- ✅ Completion message

**Remaining:**
- ❌ Database corrupted → prompt to rebuild (photos don't appear after)
- ❌ Database missing → prompt to rebuild (no prompt appears)

### 8. Manual Restore & Rebuild
**Status:** NOT STARTED

**Issue:** Manually restored file at root level stays at root after rebuild
- Should be organized into date folders during rebuild
- Edge case but affects data organization

---

## 📋 POLISH & UX ISSUES

### 9. Toast Timing
**Status:** NOT STARTED

**Issue:** Toast duration not consistent/centralized
- Quick fix: create constant
- Verify current duration value

### 10. Month Dividers During Scroll
**Status:** NOT STARTED

**Issue:** Flashes of other dates appear on scroll
- Visual glitch affecting UX

### 11. Video Format Support
**Status:** NOT STARTED

**Issue:** MPG/MPEG won't play in lightbox
- Other formats work fine

### 12. Import Count Issues (Separate from Duplicates)
**Status:** NOT STARTED

**Issues:**
- Import scoreboard can bounce around non-sequentially
- Import can say double the file count
- These are display/counting bugs, not duplicate detection

---

## 🆕 NEW FEATURES / IMPROVEMENTS

### 13. Migration Infrastructure
**Status:** PARTIALLY EXISTS

**What exists:**
- Manual migration script (`migrate_db.py`) - adds columns only
- Health check detection in switch library
- No frontend UI

**What's needed:**
- Schema version detection (`PRAGMA user_version`)
- Constraint migration (table recreation for v1→v2)
- Frontend migration dialog
- Automatic or prompted migration flow

**Priority:** HIGH - Blocks testing duplicate definition changes

### 14. Create Blank Library Feature
**Status:** NOT STARTED

**What's needed:**
- Menu option: "Create New Library"
- Folder picker
- Create blank DB + folder structure
- Load empty library state
- Distinguish from "Open Library"

**Priority:** MEDIUM - Nice to have, not blocking

---

## 🔍 NEEDS DEFINITION

### Import Count Issues
**Questions:**
- Are "bounce around counts" and "double file count" the same root cause?
- Do they still occur with new duplicate definition?
- Need reproduction steps to debug

### Database Rebuild Prompts
**Questions:**  
- When should "missing DB" prompt appear? (first run vs. switch library)
- What should "corrupted DB" flow look like?
- Should these be dialogs or toasts?

---

## 📊 CURRENT STATUS SUMMARY

**Completed:** 3 major issues (backup, rebuild dialog, date validation)

**In Progress:** 1 major issue (duplicate definition - 60% done)

**Blocked:** Testing duplicate changes (needs migration)

**Next Priority:** Finish duplicate definition work (migration + testing)

**After That:** Lazy loading & thumbnails (critical UX issue)

---

## 🎯 RECOMMENDED NEXT STEPS

### Option A: Finish Duplicate Definition (Complete the Work)
1. Build migration infrastructure (v1→v2 schema)
2. Test with new library
3. Test migration with existing library
4. Update "Show Duplicates" utility (make informational)
5. Mark complete, move to next bug

**Pros:** Completes one feature fully
**Cons:** Migration is complex, could take time

### Option B: Defer Migration, Test What We Have
1. Test duplicate definition with NEW library only
2. Document: "Migration needed for existing libraries"
3. Move to next bug (lazy loading)
4. Come back to migration later

**Pros:** Make progress on other bugs
**Cons:** Leaves duplicate work incomplete

### Option C: Pause, Define Unclear Items
1. Clarify import count issues (reproduction steps)
2. Clarify rebuild prompt requirements
3. Then decide on next priority

**Pros:** Better understanding before building
**Cons:** No immediate progress

---

## RECOMMENDATION

**Option A: Finish Duplicate Definition**

Why:
- We're 60% done, finish what we started
- Migration infrastructure will help future schema changes
- Clean stopping point before moving to next bug

Next immediate step:
**Build schema version detection + v1→v2 migration**

---

**Does this organization make sense? Which option do you prefer?**
