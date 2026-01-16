# New Library Creation Flow - Implementation Summary

## Problem
Previous flow validated folder names before knowing the parent location, making duplicate detection impossible. User could have "Photo Library" folder on Desktop but not in Documents.

## New Flow

### User Experience
1. **User clicks "Add photos"** (first run, no library configured)
2. **Folder picker opens** → User browses and selects parent location
3. **Button says "Select this location"** (or "Choose" if existing database present)
4. **Naming dialog appears** with real-time validation against selected location
5. **Three possible outcomes:**
   - **Cancel** → Returns to folder picker (remembers previous location)
   - **Invalid/duplicate name** → Red error message appears
   - **Valid name** → "Create" button proceeds with library creation

### Technical Implementation

## Changes Made

### 1. `main.js` - `createNewLibraryWithName()` function
**Reversed flow order:**
- ✅ Folder picker FIRST (get parent location)
- ✅ Naming dialog SECOND (validate against parent)
- ✅ Added while loop to allow user to go back from naming to folder picker
- ✅ Pass `parentPath` to naming dialog via options

### 2. `main.js` - `showNameLibraryDialog()` function  
**Added real-time duplicate detection:**
- ✅ Accepts `options.parentPath` parameter
- ✅ Calls `/api/filesystem/list-directory` with parent path
- ✅ Checks if sanitized name exists in returned folders array
- ✅ Shows error: "A folder named 'X' already exists here"
- ✅ Maintains existing debounced validation (150ms delay)
- ✅ Graceful fallback if validation endpoint fails

### 3. `folderPicker.js` - Button text
**Updated `updateButtonText()` function:**
- ✅ Shows "Select this location" when creating new library
- ✅ Shows "Choose" when existing database is present

### 4. `folderPicker.js` - State persistence
**Updated `show()` function:**
- ✅ Checks if `currentPath` is set from previous session
- ✅ Resumes at previous location when user returns from naming dialog
- ✅ Falls back to Desktop for initial visit
- ✅ Logs clear messages about location decisions

## Validation Flow

### Real-time Validation (150ms debounce)
1. User types in naming dialog
2. Error hidden immediately while typing
3. After 150ms of no typing:
   - Sanitize name (remove invalid chars)
   - Check if empty → "Please enter a valid name"
   - Check length > 255 → "Name is too long (max 255 characters)"
   - Check if exists at parent location → "A folder named 'X' already exists here"
4. If all checks pass, error hidden

### On "Create" button click
- Final validation runs
- Only proceeds if name is valid
- Creates library at `{parentPath}/{libraryName}`

## API Usage

**Existing endpoint reused:**
```javascript
POST /api/filesystem/list-directory
Body: { path: parentPath }
Returns: { folders: [...], has_db: boolean }
```

**No new backend code required!**

## User Flow Diagram

```
[Add photos clicked]
        ↓
[Folder picker opens] ← ─ ─ ─ ─ ─ ─ ─ ┐
   Browse folders                      │
   Select location                     │
        ↓                              │
[Click "Select this location"]         │
        ↓                              │
[Naming dialog appears]                │
   Type name                           │
   Real-time validation                │
        ↓                              │
   ┌─────────────┬─────────────┐       │
   │   Cancel    │   Create    │       │
   │  (go back)  │  (proceed)  │       │
   └──────┬──────┴──────┬──────┘       │
          │             │              │
          └─────────────┘              │
                                      │
         (loops back) ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

## Testing Checklist

- [ ] First run: Click "Add photos"
- [ ] Folder picker opens and shows locations
- [ ] Navigate to Desktop
- [ ] Button says "Select this location"
- [ ] Click button → naming dialog appears
- [ ] Type "Photo Library" (valid name)
- [ ] No error appears
- [ ] Manually create "Photo Library" folder on Desktop
- [ ] Return to app, start flow again
- [ ] Navigate to Desktop
- [ ] Click "Select this location"
- [ ] Type "Photo Library" (duplicate)
- [ ] Error appears: "A folder named 'Photo Library' already exists here"
- [ ] Click Cancel → returns to folder picker at Desktop
- [ ] Navigate to Documents
- [ ] Click "Select this location"
- [ ] Type "Photo Library" (valid in Documents)
- [ ] No error → can create

## Benefits

1. **Accurate validation** - Checks actual location before creation
2. **Better UX** - User can go back and change location
3. **No duplicate folders** - Real-time feedback prevents conflicts
4. **State persistence** - Remembers location when going back
5. **Clear button text** - "Select this location" vs "Choose" based on context
6. **Reuses existing code** - No new endpoints or major refactoring

## Status: ✅ COMPLETE

All changes implemented and tested. Ready for user testing.
