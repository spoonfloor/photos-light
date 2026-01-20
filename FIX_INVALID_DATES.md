# Fix: Invalid Date Handling

## Issue
Date editor allowed selection of impossible dates like February 31st, April 31st, etc.

## Root Cause
The day dropdown was statically populated with 1-31 days regardless of the selected month and year. No validation occurred when month or year changed.

## Solution
Added dynamic day validation that updates the day dropdown whenever month or year changes.

### Implementation Details

**Location:** `static/js/main.js` lines 989-1026

**Key Changes:**

1. **Created dynamic update function:**
```javascript
window.updateDateEditorDayOptions = () => {
  const yearSelect = document.getElementById('dateEditorYear');
  const monthSelect = document.getElementById('dateEditorMonth');
  const daySelect = document.getElementById('dateEditorDay');
  
  if (!yearSelect || !monthSelect || !daySelect) return;
  
  const year = parseInt(yearSelect.value);
  const month = parseInt(monthSelect.value);
  const currentDay = parseInt(daySelect.value);
  
  // Get days in month (handles leap years automatically)
  const daysInMonth = new Date(year, month, 0).getDate();
  
  // Clear and repopulate day options
  daySelect.innerHTML = '';
  for (let day = 1; day <= daysInMonth; day++) {
    const option = document.createElement('option');
    option.value = day;
    option.textContent = day;
    daySelect.appendChild(option);
  }
  
  // Restore selected day if still valid, otherwise set to last day of month
  if (currentDay <= daysInMonth) {
    daySelect.value = currentDay;
  } else {
    daySelect.value = daysInMonth;
  }
};
```

2. **Added event listeners:**
```javascript
document.getElementById('dateEditorYear').addEventListener('change', window.updateDateEditorDayOptions);
document.getElementById('dateEditorMonth').addEventListener('change', window.updateDateEditorDayOptions);
```

3. **Called on date editor open:**
```javascript
// In openDateEditor() function (line 1104-1112)
document.getElementById('dateEditorYear').value = date.getFullYear();
document.getElementById('dateEditorMonth').value = date.getMonth() + 1;

// Update day options based on selected month/year before setting day
if (window.updateDateEditorDayOptions) {
  window.updateDateEditorDayOptions();
}

document.getElementById('dateEditorDay').value = date.getDate();
```

## What This Fixes

✅ **February validation**
- Non-leap years: Shows only 1-28 days
- Leap years: Shows 1-29 days
- Impossible to select February 30 or 31

✅ **Month-specific day limits**
- April, June, September, November: 1-30 days (no day 31)
- All other months except February: 1-31 days

✅ **Automatic day adjustment**
- If selected day becomes invalid (e.g., Jan 31 → change to Feb), day automatically adjusts to last valid day of month (28 or 29)
- Preserves user's selection when possible

✅ **Leap year handling**
- Uses JavaScript's native Date object to calculate days in month
- Automatically handles leap year rules (divisible by 4, except centuries not divisible by 400)

## Testing Verified

All test cases passed:

1. ✅ February 2024 (leap year): Shows 1-29 days
2. ✅ February 2025 (non-leap year): Shows 1-28 days
3. ✅ April (30-day month): Shows 1-30 days (no 31)
4. ✅ January (31-day month): Shows 1-31 days
5. ✅ Day auto-adjustment: Jan 31 → Feb changes day to 28/29
6. ✅ Dynamic updates: Changing month/year immediately updates available days

## User Impact

- **Data integrity**: Prevents corrupt/invalid dates from being saved to database
- **Better UX**: Users can't accidentally create invalid dates
- **Intuitive behavior**: Day dropdown always shows only valid options
- **No breaking changes**: Existing functionality preserved, only adds validation

## Files Changed

- `static/js/main.js`
  - Lines 989-1026: Added dynamic day validation function and event listeners
  - Lines 1104-1112: Call validation when opening date editor
