# Fix: Date Picker Duplicate Years

**Date:** January 20, 2026  
**Priority:** 🔴 CRITICAL UX - Fixed  
**Status:** ✅ COMPLETE

---

## Issue

Same year could appear multiple times in the year dropdown of the date picker navigation.

**Impact:** Annoying every time user navigates by date

---

## Root Cause

The `populateDatePicker()` function was called multiple times in different scenarios:
1. After database rebuild completes
2. After library health check passes on startup

Each time the function was called, it would **append** new year options to the dropdown without clearing existing options first. This caused duplicate years to accumulate in the dropdown.

---

## The Fix

Added a single line to clear existing options before populating:

```javascript
// Clear existing options before populating (prevents duplicates)
yearPicker.innerHTML = '';
```

**Location:** `static/js/main.js`, line 208 (inside `populateDatePicker()` function)

---

## Code Changes

```208:208:static/js/main.js
// Clear existing options before populating (prevents duplicates)
yearPicker.innerHTML = '';
```

This ensures that every time `populateDatePicker()` is called, the year picker starts fresh and only contains one instance of each year.

---

## Testing

**Scenarios to verify:**
1. ✅ Fresh load - years appear once
2. ✅ After database rebuild - no duplicate years
3. ✅ After switching libraries - no duplicate years

**How to reproduce original bug:**
1. Load a library with multiple years
2. Trigger a database rebuild (Menu → Rebuild Database)
3. Check year dropdown - would have shown duplicates

**Expected result after fix:**
- Each year appears exactly once in the dropdown
- Years are sorted newest to oldest

---

## Notes

- The month picker did not have this issue because its options are static HTML (not dynamically populated)
- The year picker gets its data from `/api/years` endpoint which correctly returns DISTINCT years
- The bug was purely on the frontend - appending to the dropdown multiple times
