# Fix: Lazy Loading & Thumbnail Issues

## Issue
After "Rebuild Thumbnails" (purges `.thumbnails/` folder), images below the fold show broken image icons. Running "Update Library Index" restores them.

## Root Cause
**IntersectionObserver stale reference bug.**

When the grid reloads after thumbnail purge:

1. Initial page load:
   - IntersectionObserver created
   - Observes all 1,100 images
   - Images load as they intersect viewport
   - Observer calls `unobserve(img)` for each loaded image
   
2. "Rebuild Thumbnails" clicked:
   - `.thumbnails/` folder deleted
   - Grid cleared: `container.innerHTML = ''` (destroys all DOM elements)
   - `loadAndRenderPhotos()` creates NEW `<img>` elements
   - `setupThumbnailLazyLoading()` runs
   
3. **THE BUG:**
   - Old observer still exists (not destroyed)
   - `setupThumbnailLazyLoading()` sees `if (!thumbnailObserver)` = false
   - **Reuses old observer** instead of creating new one
   - Queries for new images: `document.querySelectorAll('.photo-thumb:not([src])')`
   - Calls `thumbnailObserver.observe(thumb)` for each new image
   - **BUT:** Observer has stale internal state from old DOM elements
   - Only images within initial viewport + 1000px rootMargin trigger intersection
   - Below-fold images never trigger because observer is confused about element positions

**Why "Update Library Index" fixed it:**
Full page reload destroys JavaScript context, creates fresh observer with no stale state.

## The Fix

### Disconnect Observer Before Grid Reload

**Changed:** `setupThumbnailLazyLoading()` function (line ~2188-2241)

**Before:**
```javascript
function setupThumbnailLazyLoading() {
  // Create observer if it doesn't exist
  if (!thumbnailObserver) {  // ← BUG: Reuses stale observer!
    thumbnailObserver = new IntersectionObserver(...);
  }
  
  const thumbnails = document.querySelectorAll('.photo-thumb:not([src])');
  thumbnails.forEach((thumb) => thumbnailObserver.observe(thumb));
}
```

**After:**
```javascript
function setupThumbnailLazyLoading() {
  // Disconnect existing observer to clear stale references
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();  // ← Clear all observations
  }

  // Create fresh observer
  thumbnailObserver = new IntersectionObserver(...);
  
  const thumbnails = document.querySelectorAll('.photo-thumb:not([src])');
  thumbnails.forEach((thumb) => thumbnailObserver.observe(thumb));
}
```

**Why this works:**
- `disconnect()` stops observing all targets and clears internal state
- Fresh observer created each time grid reloads
- No stale references to old DOM elements
- All new images correctly tracked

## What This Fixes

✅ **Broken images after thumbnail purge**
- Images below fold now load correctly after "Rebuild Thumbnails"
- IntersectionObserver has fresh state, no stale references

✅ **More reliable lazy loading**
- Observer recreated on every grid reload
- Works correctly after: thumbnail rebuild, library switch, sort change

✅ **Cleaner code**
- No need for complex state management
- Simple: disconnect old, create new

## Testing Instructions

### Test 1: Purge Thumbnails (Main Issue)

1. Load library with 100+ photos
2. Scroll down to bottom - verify all images load
3. Scroll back to top
4. Utilities → Rebuild Thumbnails → Proceed
5. Wait for dialog to close (300ms blank grid + reload)
6. **Scroll down slowly** through entire grid

**Expected:** ✅ All images load correctly as you scroll (no broken icons)

**Network tab should show:** Many thumbnail requests as you scroll (not just ~30)

### Test 2: Multiple Rebuilds

1. Rebuild thumbnails
2. Scroll through grid - verify images load
3. Rebuild thumbnails again
4. Scroll through grid - verify images still load

**Expected:** ✅ Works every time

### Test 3: After Library Switch

1. Switch to different library
2. Scroll through grid

**Expected:** ✅ All images load

## Technical Details

### Why Not Keep Observer?

**Original logic:** "Creating IntersectionObserver is expensive, reuse it"

**Problem:** IntersectionObserver tracks elements by reference. When you:
1. Destroy DOM elements (`container.innerHTML = ''`)
2. Create new DOM elements (same HTML structure)
3. Call `observe(newElement)`

The observer doesn't know these are "the same" photos. It has stale internal state about element positions, intersection ratios, etc. from the old DOM tree.

### Performance Impact

**Negligible:**
- Creating IntersectionObserver is fast (~1ms)
- Only happens when grid reloads (not during normal scrolling)
- Far less expensive than leaving 1,100 images broken!

### Why `disconnect()` Instead of Recreating?

We do both:
1. `disconnect()` - Clears all observations and internal state
2. Create new observer - Fresh start

You could skip `disconnect()` and just create new observer, but:
- `disconnect()` is explicit about intent
- Ensures old observer is fully cleaned up (GC can reclaim memory)
- Defensive programming against edge cases

## Files Changed

- `static/js/main.js`
  - Line ~2190-2195: Disconnect old observer before creating new one
  - Line ~2165-2170: Removed unnecessary `requestAnimationFrame` wait (wasn't the issue)
