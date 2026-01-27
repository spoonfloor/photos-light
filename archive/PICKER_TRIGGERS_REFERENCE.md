# File/Folder Picker Triggers - Complete Reference

## All User Actions That Trigger Pickers

### 1. FOLDER PICKER (FolderPicker.show)
**Purpose:** Browse filesystem to select a folder

#### Trigger A: Switch Library > Browse (Open Existing)
- **Function:** `browseSwitchLibrary()` in main.js:4431
- **User Action:** 
  - Menu → Switch library → Browse button
- **Picker Options:**
  - Title: "Open library"
  - Subtitle: "Select an existing library folder or choose where to create one"
- **Default Start:** Desktop

#### Trigger B: Create New Library (First Run or Manual)
- **Function:** `createNewLibraryWithName()` in main.js:4522
- **User Actions:**
  - First run → "Add photos" button → (triggers library creation)
  - Welcome screen → "Add photos" button
  - Menu → Create new library
- **Picker Options:**
  - Title: "Library location"
  - Subtitle: "Choose where to create \"[Library Name]\""
- **Default Start:** Desktop
- **Note:** This happens AFTER user names the library

---

### 2. PHOTO PICKER (PhotoPicker.show)
**Purpose:** Browse filesystem to select photos/folders for import

#### Trigger: Add Photos → Import from folder
- **Function:** `triggerImport()` in main.js:4782
- **User Actions:**
  - Menu → Add photos (when library exists)
  - Camera icon → Add photos
  - First run → "Add photos" → (after library creation)
- **Picker Options:**
  - Title: "Select photos"
  - Subtitle: "Choose photos and folders to import"
- **Default Start:** Desktop
- **Multi-select:** Yes (files and folders)

---

### 3. NATIVE FILE PICKER (AppleScript - DEPRECATED)
**Purpose:** Native macOS file picker for selecting individual files

#### Trigger A: Import Individual Files (Old Path)
- **Function:** `importFiles()` in main.js:4810
- **Status:** ⚠️ May still be used somewhere - needs verification
- **AppleScript:** `choose file of type {"public.image", "public.movie"}`
- **Default Start:** ❌ No control (native macOS default)

#### Trigger B: Import Browse Endpoint
- **Endpoint:** `/api/import/browse` in app.py:1190
- **Status:** Still in backend, receives AppleScript from frontend
- **Default Start:** ❌ No control (native macOS default)

---

## Summary by Default Path

### Desktop Default (✅ Controlled)
1. **FolderPicker** → Browsing for library
2. **FolderPicker** → Creating new library (parent location)
3. **PhotoPicker** → Importing photos/folders

### Native macOS Default (❌ Not Controlled)
4. **Native file picker** (if still used) → AppleScript defaults

---

## Code Locations

### Frontend Pickers
- `static/js/folderPicker.js` - Lines 272-292 (Desktop default logic)
- `static/js/photoPicker.js` - Lines 401-415 (Desktop default logic)

### Trigger Functions (main.js)
- `browseSwitchLibrary()` - Line 4431
- `createNewLibraryWithName()` - Line 4522 (calls FolderPicker)
- `triggerImport()` - Line 4782 (calls PhotoPicker)
- `importFiles()` - Line 4810 (native picker - verify if used)

### Backend Endpoints
- `/api/import/browse` - app.py:1190 (AppleScript handler)
- `/api/library/browse` - app.py:2286 (AppleScript handler for library)

---

## Recommendation

**To ensure ALL pickers default to Desktop:**
1. ✅ FolderPicker already defaults to Desktop
2. ✅ PhotoPicker already defaults to Desktop  
3. ❓ Verify if `importFiles()` is still used
4. ❓ If yes, consider replacing with PhotoPicker for consistency
5. ❌ Native AppleScript pickers cannot default to Desktop (macOS limitation)
