# Shift-Select Testing Checklist

Test these scenarios to verify the fix works:

## ✅ Basic Tests

### Test 1: Short Range Shift-Select
1. Load the app with photos
2. Click on a photo (e.g., photo #5)
3. Hold Shift and click photo #10
4. **Expected**: Photos 5-10 should all be selected
5. Check console for: "Shift-selected 6 photos"

### Test 2: Long Range with Scrolling (The Main Bug)
1. Click on photo at top of library
2. Scroll down several pages (so first photo is offscreen)
3. Hold Shift and click a photo far down (e.g., 100+ photos away)
4. **Expected**: All photos in range should be selected
5. Check console for: "Cards in range: [number]" matching expected count

### Test 3: Very Long Range
1. Click first photo in library
2. Scroll to bottom
3. Hold Shift and click last photo
4. **Expected**: Entire library should be selected
5. Check console for accurate count

### Test 4: Reverse Range (Bottom to Top)
1. Click a photo near bottom
2. Scroll up
3. Hold Shift and click photo near top
4. **Expected**: All photos between should be selected (order doesn't matter)

## ✅ Edge Case Tests

### Test 5: After Delete
1. Select and delete some photos
2. Click a photo
3. Scroll and shift+click another
4. **Expected**: Shift-select works with new indices

### Test 6: After Sort Change
1. Click a photo
2. Change sort order (newest ↔ oldest)
3. Click a photo, scroll, shift+click another
4. **Expected**: Shift-select works after sort change

### Test 7: After Undo Delete
1. Delete some photos
2. Undo the deletion
3. Try shift-select
4. **Expected**: Works with restored photos

### Test 8: Mixed with Deselect All
1. Select some photos
2. Click "Deselect All"
3. Try shift-select
4. **Expected**: Shift-select still works

### Test 9: With Month Circles
1. Click month circle to select entire month
2. Click a photo in a different month
3. Shift+click another photo
4. **Expected**: Shift-select works normally

## 🔍 Console Diagnostics

When shift-selecting, you should see these logs:
```
🔍 Shift-select: range 10 to 150 (141 photos)
📊 Total cards in DOM: 523
📋 Cards in range: 141
📷 Shift-selected 141 photos (141 total selected)
```

## 🐛 Known Limitations

- Shift-select only works with photos currently in the DOM
- All photos are rendered at once, so this shouldn't be an issue
- If you encounter problems, check console for diagnostic output

## 🚨 If Something's Wrong

If shift-select still doesn't work:
1. Open browser console (F12 or Cmd+Option+I)
2. Try the failing scenario
3. Check for:
   - Error messages in console
   - The diagnostic logs mentioned above
   - Whether "Cards in range" matches expected count
4. Report the console output
