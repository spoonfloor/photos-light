# Fix: Database Rebuild Dialog Issues

## Issues Fixed

### 1. JavaScript Error: `buttons.forEach is not a function`
**Status:** ✅ FIXED

**Root Cause:**
The `showDialog()` function signature was changed to accept a buttons array, but the rebuild database code was still calling it with the old signature (string parameters).

**Old Code (Line 689-696):**
```javascript
const confirmed = await showDialog(
  'Large library detected',
  `Your library contains ${data.file_count.toLocaleString()} photos...`,
  'Continue',    // Wrong: string instead of buttons array
  'Cancel'       // Wrong: string instead of buttons array
);
```

**New Code:**
```javascript
const confirmed = await showDialog(
  'Large library detected',
  `Your library contains ${data.file_count.toLocaleString()} photos...`,
  [
    { text: 'Cancel', value: false, primary: false },
    { text: 'Continue', value: true, primary: true }
  ]
);
```

### 2. Missing Estimated Duration Display
**Status:** ✅ FIXED

**Root Cause:**
The estimated duration was only shown in the warning dialog for large libraries (1000+ files), but not in the normal ready state for smaller libraries.

**Solution:**
Added estimated duration to the ready state message for all library sizes.

**New Code (Line 706-708):**
```javascript
// Update UI to show ready state
const estimateText = data.estimated_display ? `<p>Estimated time: ${data.estimated_display}</p>` : '';
statusText.innerHTML = `<p>Ready to rebuild database.</p><p>Found ${data.file_count.toLocaleString()} files.</p>${estimateText}`;
proceedBtn.style.display = 'block';
```

## What This Fixes

✅ **Warning for 1000+ files**
- Dialog now displays correctly without JavaScript errors
- Users can see warning and cancel before starting long rebuilds

✅ **Estimate duration displays**
- Now shows for all library sizes, not just large ones
- Format: "X minutes" or "X hours" based on file count

## Testing Checklist

### Test Case 1: Small Library (< 1000 files)
1. Open library with fewer than 1000 files
2. Menu → Rebuild Database
3. Should see: "Ready to rebuild database. Found X files. Estimated time: Y minutes"
4. No warning dialog should appear
5. Click Proceed to verify rebuild works

### Test Case 2: Large Library (≥ 1000 files)
1. Open library with 1000+ files
2. Menu → Rebuild Database
3. Should see warning dialog: "Large library detected"
4. Dialog should show file count and estimated duration
5. Should have two buttons: "Cancel" (secondary) and "Continue" (primary)
6. No JavaScript errors in console
7. Click Continue to proceed or Cancel to abort

### Test Case 3: Very Large Library
1. Test with library containing 10,000+ files
2. Verify estimate shows hours (e.g., "6-7 hours")
3. Verify warning appears correctly
4. Verify no JavaScript errors

## Related Issues Still Being Tracked

These rebuild-related issues are NOT fixed by this PR:

❌ **Database corrupted → prompt to rebuild**
- Prompts to rebuild, but photos don't appear on rebuild complete
- Dialog gives way to a blank page where grid should be
- Requires separate investigation

❌ **Database missing → prompt to rebuild**
- No such prompt appears
- Requires separate investigation

## Files Changed

- `static/js/main.js` (lines 688-708)
  - Fixed showDialog() call to use buttons array
  - Added estimated duration to ready state display
