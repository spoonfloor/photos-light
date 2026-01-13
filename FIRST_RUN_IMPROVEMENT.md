# First Run Experience Improvement

## Problem Solved
Previously, when creating a new library, the app would dump the database and media files directly into the selected folder (e.g., `/Users/bob/Desktop/`), creating clutter.

## Solution Implemented
Added a library naming step that creates a self-contained folder with a user-chosen name.

## New Flow

### Before (Old Behavior)
1. User clicks "Add photos" on first run
2. Shows dialog: "Choose a location for your library"
3. Folder picker opens
4. User selects `/Users/bob/Desktop`
5. **Creates library directly at `/Users/bob/Desktop/`** ❌
   - `photo_library.db` ends up at `/Users/bob/Desktop/photo_library.db`
   - Photos at `/Users/bob/Desktop/2024/2024-01-15/...`

### After (New Behavior)
1. User clicks "Add photos" on first run
2. **Shows dialog: "Create new library"** with text input (default: "Photo Library")
3. User can rename (e.g., "Family Photos")
4. Folder picker opens: "Choose where to create your library"
5. User selects `/Users/bob/Desktop`
6. **Creates library at `/Users/bob/Desktop/Family Photos/`** ✅
   - `photo_library.db` at `/Users/bob/Desktop/Family Photos/photo_library.db`
   - Photos at `/Users/bob/Desktop/Family Photos/2024/2024-01-15/...`

## Implementation Details

### Files Changed
1. **`static/fragments/nameLibraryOverlay.html`** (NEW)
   - Dialog overlay with text input for library name
   - Pre-filled with "Photo Library"
   - Input validation with error display

2. **`static/js/main.js`**
   - Added `loadNameLibraryOverlay()` - Loads the dialog fragment
   - Added `showNameLibraryDialog()` - Shows dialog and returns chosen name (Promise-based)
   - Added `createNewLibraryWithName()` - New flow: name → parent folder → combine paths
   - Modified `triggerImportWithLibraryCheck()` - Uses new flow for first-run
   - Existing `browseSwitchLibrary()` unchanged - switching to existing libraries works as before

3. **`static/index.html`**
   - Bumped JS version to v66 for cache busting

### Sanitization
Library names are sanitized to remove:
- Invalid filesystem characters: `/ \ : * ? " < > |`
- Leading dots (hidden files)
- Whitespace trimmed
- Max length: 255 characters

### Edge Cases Handled
- User cancels naming → returns to empty state
- User cancels folder picker → returns to empty state
- Empty name after sanitization → shows error, stays in dialog
- Enter key confirms, Escape key cancels
- Input field auto-focused and text pre-selected

### Existing Flows Preserved
- **Switch existing library** (Utilities → Switch library) still works exactly as before
- Only the first-run "Add photos" flow uses the new naming step

## Testing Checklist
- [ ] First run: Click "Add photos" → name dialog appears
- [ ] Enter custom name → folder picker opens
- [ ] Select parent folder → creates `[parent]/[name]/` with library inside
- [ ] Cancel at naming step → returns to empty state
- [ ] Cancel at folder picker → returns to empty state
- [ ] Utilities → Switch library → still works without naming step
- [ ] Switch to existing library → works normally

## Status
✅ Implementation complete
⏳ Ready for user testing
