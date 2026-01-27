# Shift-Select Fix

## Problem
Shift-select wasn't working when the referring photo (the first photo clicked) was offscreen or there was a large index distance between the first and second photo.

## Root Cause
The shift-select logic had two main issues:

1. **Inefficient individual queries**: The code was doing a separate `document.querySelector()` call for each index in the range (e.g., if selecting from index 10 to 500, it would do 491 separate queries). This was slow and fragile.

2. **Stale lastClickedIndex**: When photos were deleted, restored, or the grid was reloaded in any way, the `state.lastClickedIndex` wasn't being reset, causing it to point to an outdated index position.

## Solution

### 1. Improved Shift-Select Algorithm
**File**: `static/js/main.js` - `togglePhotoSelection()` function

Changed from:
```javascript
// Old: Loop through each index and query individually
for (let i = start; i <= end; i++) {
  const rangeCard = document.querySelector(`[data-index="${i}"]`);
  if (rangeCard) {
    // select it
  }
}
```

To:
```javascript
// New: Get all cards once, then filter by index
const allCards = Array.from(document.querySelectorAll('.photo-card'));
const cardsInRange = allCards.filter(c => {
  const cardIndex = parseInt(c.dataset.index);
  return cardIndex >= start && cardIndex <= end;
});
cardsInRange.forEach(rangeCard => {
  // select it
});
```

**Benefits**:
- Much faster (one DOM query instead of hundreds/thousands)
- More reliable (works regardless of scroll position)
- Handles any index gaps gracefully
- Added debug logging to diagnose issues

### 2. Reset Anchor on Grid Reload
**File**: `static/js/main.js` - `loadAndRenderPhotos()` function

Added reset logic when the grid is reloaded:
```javascript
// Reset shift-select anchor when reloading (indices may have changed)
if (!append) {
  state.lastClickedIndex = null;
}
```

This ensures that after operations like:
- Deleting photos
- Restoring photos
- Changing sort order
- Importing new photos
- Rebuilding database
- Switching libraries

...the shift-select anchor is cleared, preventing stale references.

### 3. Reset Anchor on Clear All
**File**: `static/js/main.js` - `deselectAllPhotos()` function

Added reset when all selections are cleared:
```javascript
state.selectedPhotos.clear();
state.lastClickedIndex = null; // Reset shift-select anchor
```

### 4. Reset Anchor After Delete
**File**: `static/js/main.js` - `deletePhotos()` function

Added reset after photos are deleted:
```javascript
state.selectedPhotos.clear();
state.lastClickedIndex = null;
```

## Testing
To test the fix:

1. **Basic shift-select**: Click a photo, scroll down, shift+click another photo → should select all in between
2. **Long-range shift-select**: Click photo #1, scroll to photo #500, shift+click → should select all 500
3. **After deletion**: Select and delete photos, then try shift-select → should work correctly
4. **After sort change**: Toggle sort order, then try shift-select → should work correctly
5. **Mixed with month circles**: Use month circle to select a month, then shift+click individual photos → should work

## Performance Impact
- **Before**: O(n) individual DOM queries where n = range size
- **After**: O(m) where m = total cards in DOM (constant, happens once)
- For a range of 500 photos: ~500 queries → 1 query + filter operation

## Debug Output
The improved code now logs:
- Range being selected (start/end indices)
- Total cards in DOM
- Number of cards found in range
- Final selection count

Check browser console when shift-selecting to see diagnostic info.
