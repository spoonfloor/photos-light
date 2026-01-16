# Scorched Earth Path Removal - Complete

## What Changed

### 1. Removed All Hard-Coded Paths from app.py
**Before:**
```python
DB_PATH = os.path.join(BASE_DIR, '..', 'photo-migration-and-script', 'migration', 'databases', 'photo_library_test.db')
LIBRARY_PATH = '/Volumes/eric_files/photo_library_test'
```

**After:**
```python
DB_PATH = None
LIBRARY_PATH = None
# All paths initialized from .config.json on startup
```

### 2. Removed Directory Creation at Startup
**Before:** App tried to create `.thumbnails`, `.trash`, `.logs`, etc. immediately on startup (causing crashes if paths didn't exist)

**After:** Directories only created when a library is selected via `update_app_paths()`

### 3. Updated library_status Behavior
**Before:** Missing library returned `library_missing` error

**After:** Missing library automatically deletes stale config and returns `not_configured` (first-run state)

### 4. Folder Picker Defaults to Desktop
Already implemented - folder picker tries to start at user's Desktop if accessible

### 5. Deleted run.sh
No longer needed - just run `python3 app.py` directly

### 6. Simplified Startup Code
**Before:** Complex path validation, logging setup, error handling

**After:** Simple config check:
- Has config + paths exist → load library
- Has config but paths missing → delete config, show welcome
- No config → show welcome

## How It Works Now

### First Run (No Config)
1. Start app: `python3 app.py`
2. App shows: "No library configured - user will be prompted"
3. Open http://localhost:5001
4. Frontend shows welcome screen: "Add photos or open an existing library"
5. User picks library → saves to `.config.json`
6. App reloads with that library

### Subsequent Runs
1. Start app: `python3 app.py`
2. App loads `.config.json`
3. If library exists → loads it
4. If library missing → deletes config, shows welcome screen

### Switch Library > Reset
- Deletes `.config.json`
- Returns to first-run state
- (This is a debug feature and may be removed)

## The Only Hard-Coded Path
**Desktop** - folder picker tries to start there by default (in `folderPicker.js`)

## What Gets Remembered
`.config.json` contains:
```json
{
  "library_path": "/Users/you/Desktop/My Photos",
  "db_path": "/Users/you/Desktop/My Photos/photo_library.db"
}
```

That's it. No environment variables, no hard-coded paths in code.

## Testing Results
✅ App starts with no config → shows welcome screen
✅ API returns `not_configured` status
✅ App handles missing library gracefully → auto-deletes stale config
✅ Flask runs successfully at http://localhost:5001
