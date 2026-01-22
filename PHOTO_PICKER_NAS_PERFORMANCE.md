# Photo Picker - NAS Performance Issue

**Status:** PARTIALLY FIXED (reverted to v117)  
**Date:** January 21, 2026  
**Priority:** 🔴 CRITICAL

---

## The Problem

When selecting folders on NAS storage in the Photo Picker:
1. **Checking folders is painfully slow** - Takes 10+ seconds for checkbox to appear
2. **Unchecking is also slow** - Checkbox doesn't disappear when clicked again
3. **Incorrect selection tally** - Shows "162 folders, 1235 files" when nothing selected
4. **Partial selection state on reopen** - Picker shows selections from previous session

**Root cause:** Network latency amplified by synchronous operations and expensive O(n) state calculations.

---

## What Was Tried

### Attempt 1: Remove blocking `await` on check (v117) ✅ PARTIAL SUCCESS

**Change:**
```javascript
// Line 381 - removed await
// Before: await toggleFolder(path);
// After:  toggleFolder(path);
```

**Result:**
- ✅ Checking folders appeared instantly
- ❌ Unchecking still blocked (await inside toggleFolder on line 69)
- ❌ But after selecting large folder, even checking became slow

**Why checking eventually became slow:**
- Background counting added 10,000+ files to `selectedPaths` Map
- `getFolderState()` called after toggle (line 383)
- Line 202: `Array.from(selectedPaths.keys()).some(...)` - O(n) iteration
- With 10,000 items, this takes 10+ seconds

---

### Attempt 2: Remove all async/await (v118) ❌ TOTAL FAILURE

**Changes:**
```javascript
// Removed async from toggleFolder()
// Removed await from unselectFolderRecursive() call
// Removed async from unselectFolderRecursive()
```

**Result:**
- ❌ BOTH checking and unchecking became totally unresponsive
- Waited 10+ seconds, no checkbox appeared or disappeared

**Why it failed:**
- `getFolderState()` on line 383 still being called
- With large `selectedPaths` (10,000+ items), the O(n) iteration froze UI
- Removing async just exposed the underlying performance problem

---

### Attempt 3: Skip expensive getFolderState() call (v119) ❌ TOTAL FAILURE

**Changes:**
```javascript
// Line 380-394 - replaced getFolderState() with simple toggle
const wasChecked = selectedPaths.has(path);
toggleFolder(path);
if (wasChecked) {
  checkbox.textContent = 'folder';
  checkbox.classList.remove('selected');
} else {
  checkbox.textContent = 'check_box';
  checkbox.classList.add('selected');
}
```

**Result:**
- ❌ Check doesn't appear at all
- ❌ Second click doesn't make count disappear
- ✅ No JavaScript errors in console
- ✅ Version confirmed as v119 loaded
- ⚠️ Click handler appears to not be running, but unclear why

**Why it failed:**
- Unknown - code logic appears sound
- No errors in console
- Possibly closure scope issue with `selectedPaths`?
- Possibly event handler not updating after file change?
- **This needs debugging investigation**

---

## Current State (v117)

**Reverted to v117** - partial fix where checking appears instantly, but:
- ✅ First check on empty selection works instantly
- ❌ After selecting large folder, subsequent checks become slow
- ❌ Unchecking still blocks with `await`
- ❌ Other 3 sub-issues still present (breadcrumb mismatch, incorrect tally, partial state)

---

## Root Cause Analysis

### The Core Performance Problem

**`getFolderState()` function (lines 193-217):**
```javascript
function getFolderState(folderPath) {
  // Line 202-204: O(n) where n = items in selectedPaths
  const hasSelectedDescendant = Array.from(selectedPaths.keys()).some(path => 
    path.startsWith(folderPath + '/')
  );
  // ...
}
```

**Called from:**
1. Line 328: `updateFileList()` - when rendering folder list (navigation, not clicks)
2. Line 383: Click handler - after every folder checkbox click

**The problem:**
- Background counting adds all files to `selectedPaths` Map
- Large NAS folder = 10,000+ files in Map
- `Array.from().some()` must iterate through ALL items to check descendants
- Each checkbox click = 10,000 iterations = 10+ seconds

**Compounded by:**
- Line 75/70: `folderStateCache.clear()` called on every toggle
- Cache is invalidated, forcing expensive recalculation

---

## Why Background Counting Exists

The code already has sophisticated background counting (lines 106-181):
- Updates every 50 files OR every 1000ms
- Shows "Counting files... X+" during counting
- Has abort capability
- **This is good architecture!**

**The intent:**
1. User clicks folder → checkbox appears instantly
2. Background counting discovers all files
3. Count updates periodically: "1 folder selected" → "Counting files... 50+" → "162 folders, 1235 files selected"

**What broke it:**
- The `await` keyword made it synchronous
- The `getFolderState()` call created O(n) overhead after every click

---

## Proposed Next Steps

### Option A: Debug v119 (Why didn't it work?)

**Investigate:**
1. Add `console.log` statements to verify click handler fires
2. Check if `selectedPaths` is accessible in closure
3. Check if `checkbox` DOM element is what we expect
4. Verify `toggleFolder()` is actually being called

**Time estimate:** 1 hour

**Risk:** May discover deeper architectural issue

---

### Option B: Different approach - Don't expand folders into files

**Current behavior:**
- Check folder → background counting adds ALL files to `selectedPaths`
- Result: Map grows to 10,000+ items

**New behavior:**
- Check folder → ONLY add folder path to `selectedPaths` (no files)
- Backend expands folder during import (already does this)
- `selectedPaths` stays small (only folder paths, not files)

**Changes needed:**
```javascript
// Remove selectFolderRecursiveBackground() entirely
// toggleFolder() becomes:
function toggleFolder(folderPath) {
  if (selectedPaths.has(folderPath)) {
    selectedPaths.delete(folderPath); // Just remove folder
  } else {
    selectedPaths.set(folderPath, { type: 'folder' }); // Just add folder
  }
  updateSelectionCount();
}

// updateSelectionCount() shows:
// "3 folders selected" (not file count)
// OR "3 folders (counting files...)" while backend counts
```

**Pros:**
- `selectedPaths` stays tiny (only folder paths)
- No O(n) performance issues
- Simple, predictable behavior
- Backend already handles folder expansion

**Cons:**
- User doesn't see file count before importing
- Less feedback than current design

**Time estimate:** 1-2 hours

**Risk:** Low - simplifies architecture

---

### Option C: Optimize getFolderState() with indexed lookup

**Current:** O(n) iteration through entire Map

**New:** Build prefix index for fast lookups

```javascript
// Maintain separate index of selected folders
let selectedFolderPrefixes = new Set();

// When selecting folder:
selectedFolders.add(folderPath);

// When checking state:
function getFolderState(folderPath) {
  if (selectedPaths.has(folderPath)) return 'checked';
  
  // O(1) check if any parent folder is selected
  for (const folder of selectedFolderPrefixes) {
    if (folderPath.startsWith(folder + '/')) return 'indeterminate';
  }
  
  return 'unchecked';
}
```

**Pros:**
- Keeps current architecture
- Makes getFolderState() fast
- Preserves all current features

**Cons:**
- More complex state management
- Need to keep index in sync

**Time estimate:** 2-3 hours

**Risk:** Medium - adds complexity

---

## Recommendation

**Try Option B: Don't expand folders into files**

**Rationale:**
1. Simplest solution
2. Matches industry standard (Google Drive, Finder don't pre-count)
3. Backend already handles folder expansion
4. Eliminates entire class of performance issues
5. User gets instant feedback (folder selected) without waiting for count

**Implementation order:**
1. Remove `selectFolderRecursiveBackground()` function
2. Simplify `toggleFolder()` to just add/remove folder path
3. Update `unselectFolderRecursive()` to just remove folder (not descendants)
4. Update `updateSelectionCount()` to show folder count only
5. Test on NAS with large folders

**If this doesn't meet user needs:**
- Can add backend endpoint to count files in folder
- Show count in tooltip or async after selection
- But keep `selectedPaths` small for performance

---

## Testing Plan

**Test on NAS with folder structure:**
- photo_library/
  - 1900/ (100 files)
  - 1950/ (500 files)
  - 2000/ (5,000 files)
  - 2025/ (10,000 files)

**Verify:**
1. Click folder → checkbox appears instantly (< 100ms)
2. Click again → checkbox disappears instantly
3. Count updates immediately ("1 folder selected" → "0 selected")
4. Can select/unselect multiple folders rapidly
5. Background counting doesn't block UI
6. Count shows meaningful information

---

## Lessons Learned

1. **Profile before optimizing** - Should have measured O(n) iteration cost upfront
2. **Test with realistic data** - Small test folders hid the performance issue
3. **Understand the full flow** - Removed `await` but missed the `getFolderState()` bottleneck
4. **Verify fixes work** - v119 appeared correct but failed mysteriously (need better debugging)
5. **Simpler is better** - The most complex solution (background counting + state calculation) created the most problems

---

## Open Questions

1. Why did v119 fail? (No errors, but checkboxes don't update)
2. Is file count necessary before import? (User testing needed)
3. Should indeterminate state exist if we don't expand folders?
4. Can we lazy-load file counts after folder selection?
