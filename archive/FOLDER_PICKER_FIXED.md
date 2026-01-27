# Folder Picker - FIXED

## What Was Wrong
I replaced the working AppleScript approach with a browser `prompt()` - terrible UX.

## What I Fixed
Restored the proper pattern (copied from Import):

### Frontend (`main.js`)
- Sends AppleScript to backend via `/api/library/browse`
- Same pattern as `importFolders()` - proven to work

### Backend (`app.py`)
- Simple `subprocess.run(['osascript', '-e', script])`
- Same as `/api/import/browse` - no overcomplicated environment hacks
- Returns path or 'cancelled'
- Validates if library exists or needs initialization

### Changes
- `static/js/main.js` - `browseSwitchLibrary()` restored to use AppleScript
- `app.py` - `/api/library/browse` simplified to match import pattern
- `static/index.html` - JS version bumped to v62

## Testing
```bash
# Test endpoint - picker appears
curl -X POST http://localhost:5001/api/library/browse \
  -H "Content-Type: application/json" \
  -d '{"script":"POSIX path of (choose folder with prompt \"Test\")"}'
# Returns: {"status": "cancelled"} or {"status": "needs_init", "library_path": "..."}
```

## Status
✅ **WORKING** - Native macOS folder picker now appears when selecting library location.

## What I Kept
- `/api/library/validate` endpoint (for manual path validation if ever needed)

## Lesson
Check existing working patterns in the codebase FIRST before implementing workarounds.
