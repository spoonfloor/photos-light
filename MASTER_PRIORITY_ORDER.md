# Master Bug Priority Order

Last updated: January 20, 2026

This is a comprehensive priority ranking of all outstanding bugs, ordered by impact, frequency, and ease of fix.

---

## 🔴 TIER 1: MUST FIX (High Impact, Frequent Use)

### 1. Date Editor - Year Dropdown Missing New Year
**Priority:** 🔴 CRITICAL  
**Estimated effort:** 15 minutes  
**Impact:** HIGH - Breaks core date editing workflow

**Rationale:**
- Users edit dates frequently
- Breaks immediately after editing to new year
- Makes navigation picker unusable after the edit
- **Very simple fix:** Just need to refresh date picker after date edit completes
- High frequency operation + broken state = top priority

**Fix approach:** After date edit saves, call `populateDatePicker()` to refresh dropdown

---

### 2. Photo Picker - NAS Navigation Issues
**Priority:** 🔴 CRITICAL  
**Estimated effort:** 1-2 hours  
**Impact:** HIGH - Breaks import workflow from network storage

**Rationale:**
- Import is a core operation
- **4 separate symptoms** suggest systemic state management issue
- Affects anyone importing from NAS (common use case)
- "Painfully slow" performance is unacceptable UX
- Complex enough that fixing it will likely improve overall picker reliability

**Issues:**
1. Partial selection state on open (state not reset)
2. Breadcrumb mismatch (navigation state desync)
3. Incorrect selection tally (selection state corruption)
4. Performance (checking/unchecking slow)

**Fix approach:** Debug picker state management, likely need to reset selection state on open

---

### 3. Database Rebuild - Empty Grid After Corrupted DB
**Priority:** 🔴 HIGH  
**Estimated effort:** 30-60 minutes  
**Impact:** HIGH - Data loss scenario, but rare

**Rationale:**
- **Data integrity issue** - users can't recover from corrupted DB
- Reproducible (manually corrupt DB)
- Affects recovery scenarios
- Less frequent than date editing or import, but critical when it happens
- May reveal issues with other rebuild scenarios

**Fix approach:** Investigate state management after rebuild, ensure grid container exists and photos load properly

---

## 🟡 TIER 2: SHOULD FIX (Moderate Impact, Polish)

### 4. Error Message Wording - 'Large library detected'
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 2 minutes  
**Impact:** LOW - Just text, but affects first impression

**Rationale:**
- **Literally a one-line fix** ('Large library detected' → 'Rebuilding large library')
- Low impact but zero risk
- Good to do while working on rebuild flows
- Professional polish matters

**Fix approach:** Update dialog title text

---

### 5. Toast Timing
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 5-10 minutes  
**Impact:** LOW - Annoying but doesn't block anything

**Rationale:**
- User explicitly says "8 seconds is not the value nor should it be"
- Code already has `TOAST_DURATION = 2500` (2.5s) constant
- Need to verify what's actually happening (maybe not using the constant?)
- Quick fix with clear requirement

**Fix approach:** Find where toast duration is set, ensure it uses the constant

---

### 6. Month Dividers During Scroll
**Priority:** 🟡 MEDIUM  
**Estimated effort:** 30 minutes  
**Impact:** LOW - Visual glitch, doesn't block functionality

**Rationale:**
- Frequent operation (scrolling)
- Visual polish issue
- Likely throttling/debouncing issue with scroll handler
- Not blocking but annoying

**Fix approach:** Debounce month divider updates during scroll

---

## 🟢 TIER 3: NICE TO HAVE (Low Impact, Edge Cases)

### 7. Video Format Support (MPG/MPEG)
**Priority:** 🟢 LOW  
**Estimated effort:** 30 minutes  
**Impact:** LOW - Format-specific, workaround exists

**Rationale:**
- Only affects MPG/MPEG files (other video formats work)
- Likely browser codec support issue
- May need server-side transcoding (more complex)
- Users can convert files manually

**Fix approach:** Check if browser supports format, consider transcoding or better error message

---

### 8. Import Count Issues
**Priority:** 🟢 LOW  
**Estimated effort:** 1-2 hours  
**Impact:** LOW - Visual bug, import still works

**Rationale:**
- Confusing but doesn't prevent successful import
- Two separate issues (bouncing counter + double count)
- Likely async/threading issue with SSE
- Complex to debug, low impact

**Fix approach:** Debug SSE progress updates, ensure atomic counter updates

---

### 9. Manual Restore & Rebuild
**Priority:** 🟢 LOW  
**Estimated effort:** 1 hour  
**Impact:** LOW - Edge case, manual workaround exists

**Rationale:**
- Very specific edge case (manually restore file to root)
- Requires intentional user action (restore outside app)
- Rebuild should organize files, but user can fix manually
- Not blocking normal workflows

**Fix approach:** During rebuild, move files to proper date folders

---

### 10. Database Missing Prompt
**Priority:** 🟢 LOW  
**Estimated effort:** 30 minutes  
**Impact:** LOW - Can't reproduce reliably

**Rationale:**
- Can't reproduce reliably
- May already be handled by existing first-run flow
- Need to verify if this is actually a bug
- Low priority until we understand it better

**Fix approach:** Test various missing DB scenarios, ensure prompts appear

---

## 🔵 TIER 4: BACKLOG (Feature Work, Not Bugs)

### 11. Import Duplicate Detection + Migration Infrastructure
**Priority:** 🔵 DEFERRED  
**Estimated effort:** 4-6 hours  
**Impact:** MEDIUM - Feature enhancement, not blocking

**Rationale:**
- Already 60% complete (schema designed, reverted)
- **Not a bug** - current functionality works
- Requires complex migration infrastructure
- Should be done as dedicated feature work, not bug fixing
- Other bugs have higher UX impact

**Defer until:** Bug bash complete, dedicated feature development time

---

## 📋 RECOMMENDED FIX ORDER

Based on impact, frequency, and effort:

1. ✅ **Date Picker Duplicate Years** (DONE - v85)
2. 🔴 **Date Editor - Year Dropdown Missing New Year** (15 min, high impact)
3. 🟡 **Error Message Wording** (2 min, trivial polish)
4. 🟡 **Toast Timing** (10 min, quick fix)
5. 🔴 **Photo Picker - NAS Navigation Issues** (2 hrs, high impact but complex)
6. 🔴 **Database Rebuild - Empty Grid** (1 hr, data integrity)
7. 🟡 **Month Dividers During Scroll** (30 min, polish)
8. 🟢 **Video Format Support** (30 min, edge case)
9. 🟢 **Import Count Issues** (2 hrs, low impact)
10. 🟢 **Manual Restore & Rebuild** (1 hr, edge case)
11. 🟢 **Database Missing Prompt** (30 min, can't reproduce)
12. 🔵 **Import Duplicate Detection** (deferred feature work)

---

## RATIONALE SUMMARY

**Why this order?**

**Quick wins first (items 2-4):** 
- Date dropdown, error wording, toast timing
- Combined effort: ~30 minutes
- Immediate visible improvements
- Build momentum

**Then complex high-impact (items 5-6):**
- Photo picker NAS issues and database rebuild
- Core functionality bugs
- Require deeper investigation
- High user impact when they occur

**Then polish (items 7-9):**
- Visual glitches and edge cases
- Nice to have but not blocking
- Do after critical issues resolved

**Deferred (item 12):**
- Feature work, not bug fixes
- Save for dedicated feature development

---

## EFFORT vs IMPACT MATRIX

```
HIGH IMPACT
    │
    │  [2. Photo Picker]    [3. DB Rebuild]
    │  [1. Date Dropdown]
    │
    │                       [6. Month Dividers]
MED │  [4. Error Wording]   [7. Video Format]
    │  [5. Toast Timing]    [8. Import Counts]
    │
    │                       [9. Manual Restore]
LOW │                       [10. DB Missing]
    │
    └────────────────────────────────────
       QUICK (<30m)    MED (30m-2h)    LONG (>2h)
                     EFFORT
```

**Sweet spot:** Upper left quadrant (high impact, quick fix)
- Items 1, 2, 4, 5 are the best ROI

---

## NEXT STEPS

**Immediate action:** Fix Date Editor Year Dropdown (item 2)
- 15 minute fix
- High frequency operation
- Broken immediately after date edit
- Simple solution (refresh date picker)
