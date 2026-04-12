# Terraform Cancel/Go Back Bug - Root Cause Analysis

**Date:** January 29, 2026  
**Confidence Level:** 95%

---

## Problem Statement

When a user cancels terraforming (at preview or warning dialogs), the app enters a stalled state showing "Loading library..." indefinitely with all interactive buttons disabled. The user cannot recover without restarting the app.

---

## Root Cause

The bug occurs in the `browseSwitchLibrary()` function flow:

### The Problematic Flow

```
1. User triggers browseSwitchLibrary()
   └─> Line 5244: showLibraryTransitionState() is called
       ├─> Clears photo grid (shows "Loading library...")
       └─> Disables ALL interactive buttons

2. User selects folder with media
   └─> Terraform choice dialog shown (line 5307)

3. User chooses "Convert this library"
   └─> executeTerraformFlow() called (line 5354)

4. User clicks "Go back" or cancels at preview (line 5009-5011)
   └─> executeTerraformFlow() returns false

5. Control returns to browseSwitchLibrary() (line 5361-5363)
   └─> Logs "Terraform flow failed or was cancelled"
   └─> Returns false

6. ❌ BUG: No recovery mechanism executed!
   ├─> Grid still shows "Loading library..."
   ├─> All buttons still disabled
   └─> User is stuck
```

### Key Code Locations

**showLibraryTransitionState()** (Line 5146-5190)

```javascript
function showLibraryTransitionState() {
  // Clears grid, shows "Loading library..."
  container.innerHTML = `<div>Loading library...</div>`;

  // Disables all interactive buttons
  [
    'addPhotoBtn',
    'sortToggleBtn',
    'deleteBtn',
    'editDateBtn',
    'deselectAllBtn',
  ].forEach((id) => {
    btn.style.opacity = '0.3';
    btn.style.pointerEvents = 'none';
  });

  // Disables date pickers
  monthPicker.disabled = true;
  yearPicker.disabled = true;
}
```

**browseSwitchLibrary()** - Cancel handling (Line 5361-5363)

```javascript
if (!success) {
  console.log('Terraform flow failed or was cancelled');
  return false; // ❌ Just returns - no cleanup!
}
```

**executeTerraformFlow()** - Cancel paths (Lines 5009-5011, 5030-5032)

```javascript
// Preview cancel
if (!continuePreview) {
  console.log('User cancelled at preview');
  return false; // ❌ No state restoration
}

// Warning cancel
if (!continueWarning) {
  console.log('User cancelled at warning');
  return false; // ❌ No state restoration
}
```

---

## Why This Happens

1. **Premature state change**: `showLibraryTransitionState()` is called at line 5244, BEFORE we know if the user will actually complete the operation
2. **No rollback**: When terraform is cancelled, there's no code to restore the previous library state
3. **Missing recovery**: The functions that restore UI state (`loadAndRenderPhotos()`, `enableAppBarButtons()`) are never called on cancel

---

## Comparison: Successful Paths vs Cancel Path

### ✅ Successful Path (Switch to existing library)

```
showLibraryTransitionState()  [Line 5244]
  └─> switchToLibrary()  [Line 5262 or 5299 or 5348]
      └─> loadAndRenderPhotos()  [Line 5614-5616]
          └─> enableAppBarButtons()  [Line 2660]
              └─> ✅ UI RESTORED
```

### ✅ Successful Path (Terraform completes)

```
showLibraryTransitionState()  [Line 5244]
  └─> executeTerraformFlow()  [Line 5354]
      └─> switchToLibrary()  [Line 5125]
          └─> loadAndRenderPhotos()  [Line 5614-5616]
              └─> enableAppBarButtons()  [Line 2660]
                  └─> ✅ UI RESTORED
```

### ❌ Cancel Path (BUG)

```
showLibraryTransitionState()  [Line 5244]
  └─> executeTerraformFlow()  [Line 5354]
      └─> [User cancels at preview]
          └─> return false  [Line 5011]
              └─> browseSwitchLibrary() receives false  [Line 5361]
                  └─> return false  [Line 5363]
                      └─> ❌ NO RECOVERY - USER STUCK
```

---

## Solution Requirements

The fix must:

1. **Restore previous library state** - Reload photos from the library that was active before browseSwitchLibrary() was called
2. **Re-enable UI controls** - Call enableAppBarButtons() and related functions
3. **Clear transition state** - Remove "Loading library..." message
4. **Handle all cancel points**:
   - Preview dialog cancel (line 5009-5011)
   - Warning dialog cancel (line 5030-5032)
   - Choice dialog cancel (line 5365-5368)
5. **Be robust** - Handle cases where there was no previous library (first run)

---

## Proposed Solution

### Option 1: Restore Previous Library State (RECOMMENDED)

When terraform is cancelled, restore the previous library:

```javascript
async function browseSwitchLibrary() {
  try {
    console.log('🔍 Opening custom folder picker...');
    closeSwitchLibraryOverlay();

    const selectedPath = await FolderPicker.show({...});
    if (!selectedPath) {
      console.log('User cancelled folder selection');
      return false;
    }

    console.log('📂 Selected path:', selectedPath);

    // ✅ NEW: Save current library state before transition
    const previousLibraryPath = state.currentLibraryPath; // Assumes we track this

    showLibraryTransitionState();

    const checkResponse = await fetch('/api/library/check', {...});
    const checkResult = await checkResponse.json();

    // ... existing scenarios 1 & 2 (no media) ...

    else {
      // SCENARIO 3: No DB, has media - show terraform choice dialog
      const choice = await showTerraformChoiceDialog({...});

      if (choice === 'blank') {
        // ... existing blank library creation ...
      } else if (choice === 'terraform') {
        console.log('User chose: Convert this library');

        const success = await executeTerraformFlow({...});

        if (!success) {
          console.log('Terraform flow failed or was cancelled');
          // ✅ NEW: Restore previous library state
          await restorePreviousLibraryState(previousLibraryPath);
          return false;
        }
      } else {
        // User cancelled choice dialog
        console.log('User cancelled choice dialog');
        // ✅ NEW: Restore previous library state
        await restorePreviousLibraryState(previousLibraryPath);
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error('❌ Failed to browse library:', error);
    showToast(`Error: ${error.message}`, 'error');
    // ✅ NEW: Restore previous library state on error
    await restorePreviousLibraryState(previousLibraryPath);
    return false;
  }
}

/**
 * Restore previous library state after cancel/error
 * @param {string} previousLibraryPath - Path to restore, or null if no previous library
 */
async function restorePreviousLibraryState(previousLibraryPath) {
  if (previousLibraryPath) {
    console.log('🔙 Restoring previous library:', previousLibraryPath);
    // Reload the previous library's photos
    await loadAndRenderPhotos();
  } else {
    // No previous library - show first run state
    console.log('🔙 No previous library - showing first run state');
    renderFirstRunEmptyState();
  }
}
```

### Option 2: Delay Transition State (ALTERNATIVE)

Don't call `showLibraryTransitionState()` until user commits to an action:

```javascript
async function browseSwitchLibrary() {
  try {
    // ... folder picker ...
    // ... check for DB/media ...

    if (checkResult.exists && !checkResult.has_media) {
      // ✅ Enter transition state ONLY when committing
      showLibraryTransitionState();
      await switchToLibrary(selectedPath, potentialDbPath);
    } else if (!checkResult.has_media) {
      const libraryName = await showNameLibraryDialog({...});
      if (!libraryName) return false; // No state change yet

      // ✅ Enter transition state ONLY when committing
      showLibraryTransitionState();
      // ... create and switch ...
    } else {
      const choice = await showTerraformChoiceDialog({...});

      if (choice === 'blank') {
        const libraryName = await showNameLibraryDialog({...});
        if (!libraryName) return false; // No state change yet

        // ✅ Enter transition state ONLY when committing
        showLibraryTransitionState();
        // ... create and switch ...
      } else if (choice === 'terraform') {
        // ✅ Enter transition state ONLY when committing to terraform
        showLibraryTransitionState();
        const success = await executeTerraformFlow({...});

        if (!success) {
          // ✅ Restore immediately
          await loadAndRenderPhotos();
          return false;
        }
      } else {
        return false; // No state change occurred
      }
    }
  }
}
```

---

## Recommendation

**Option 1 (Restore Previous Library State)** is more robust because:

1. Handles all error cases uniformly
2. Works even if state change happens early (current behavior)
3. Provides better error recovery
4. Easier to maintain (single recovery function)

**Option 2 (Delay Transition State)** is cleaner architecturally but:

1. Requires moving `showLibraryTransitionState()` to multiple locations
2. More invasive code changes
3. Harder to ensure all paths are covered

---

## Testing Checklist

After implementing the fix, test these scenarios:

1. ✅ Cancel at terraform choice dialog → previous library restored
2. ✅ Choose "Convert this library" → Cancel at preview → previous library restored
3. ✅ Choose "Convert this library" → Cancel at warning → previous library restored
4. ✅ First run (no previous library) → Cancel terraform → first run state shown
5. ✅ Error during terraform → previous library restored
6. ✅ Network error during API call → previous library restored
7. ✅ Successful terraform → new library loaded correctly (regression test)
8. ✅ Switch to existing library → works correctly (regression test)
9. ✅ Create blank library → works correctly (regression test)

---

## Additional Considerations

### State Tracking Required

Currently, we don't track `state.currentLibraryPath`. We need to:

1. Add `currentLibraryPath` to state object (line ~50 where state is defined)
2. Set it in `switchToLibrary()` after successful switch (line ~5601)
3. Set it on initial load in `loadAndRenderPhotos()` (line ~2620)

```javascript
// Add to state object (around line 50)
const state = {
  // ... existing properties ...
  currentLibraryPath: null, // Track current library path for recovery
};

// Update in switchToLibrary() (around line 5601)
async function switchToLibrary(libraryPath, dbPath) {
  // ... existing code ...
  console.log('✅ Switched to:', result.library_path);
  state.currentLibraryPath = libraryPath; // ✅ Track current library
  // ... rest of code ...
}
```

### Backend Support

Check if backend provides current library path:

- `/api/library/status` endpoint should return `library_path`
- Load this on app initialization

---

## Files to Modify

1. **static/js/main.js**
   - Add `currentLibraryPath` to state object (~line 50)
   - Add `restorePreviousLibraryState()` function (new, ~50 lines)
   - Modify `browseSwitchLibrary()` to save/restore state (~lines 5223-5378)
   - Update `switchToLibrary()` to track current path (~line 5601)

---

## Estimated Effort

- **Investigation**: ✅ Complete
- **Implementation**: 30-45 minutes
- **Testing**: 30-45 minutes
- **Total**: 1-1.5 hours

---

## Confidence

**95%** - Root cause is definitively identified through code analysis. The fix is straightforward and follows existing patterns in the codebase. Only remaining uncertainty is whether `state.currentLibraryPath` tracking will require any backend changes.
