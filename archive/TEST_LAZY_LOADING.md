# Test: Lazy Loading Fix (v2)

## Quick Test (Essential)

**Steps:**
1. Restart Flask app to load new code
2. Refresh browser (`Cmd+R`)
3. Load library with 100+ photos
4. Scroll to bottom - verify all images load
5. Scroll back to top
6. Utilities → Rebuild Thumbnails → Proceed
7. Wait for dialog to close (300ms blank + reload)
8. **Scroll down slowly** through entire grid
9. **Open Network tab** - should see many thumbnail requests as you scroll

**Expected:** ✅ All images load correctly (no broken image icons)

**Network tab:** Should show hundreds of thumbnail requests as you scroll, not just ~30

**If broken:** ❌ Take screenshot, check browser console for errors

---

## What Changed (v2)

**Fix:** Disconnect IntersectionObserver before recreating it
- Changed from "create if doesn't exist" to "disconnect + create fresh"
- Clears stale references to old DOM elements
- Observer now correctly tracks new images after grid reload

**What went wrong in v1:**
- My initial fix (requestAnimationFrame wait) was wrong diagnosis
- Real problem: Observer reused with stale DOM references
- Below-fold images never triggered intersection events

---

## Why This Should Work

**Before (BUG):** 
- Initial load: Observer created, images load, unobserved
- Rebuild: Grid destroyed, new elements created
- `setupThumbnailLazyLoading()` sees existing observer, reuses it
- Observer has stale state from old DOM elements
- Only visible elements trigger (within initial rootMargin)
- Below-fold images never trigger (observer confused)

**After (FIXED):**
- Initial load: Observer created, images load
- Rebuild: Grid destroyed, new elements created
- `setupThumbnailLazyLoading()` disconnects old observer
- Creates fresh observer with no stale state
- Observes all new images correctly
- All images trigger intersection when scrolled into view

---

## Evidence from Network Tab

**Before fix:**
- ~30 thumbnail requests after rebuild (only visible images)

**After fix (expected):**
- Hundreds of thumbnail requests as user scrolls
- Matches initial page load behavior

---

## Confidence: VERY HIGH (95%)

This is definitely the bug. Network tab proved it:
- Observer works initially (many requests)
- Observer breaks after rebuild (few requests)
- Root cause: Stale observer references

The fix (disconnect + recreate) is standard pattern for this exact problem.
