# Folder Picker Issue - Agent Handoff Document

## Problem Statement
The "Add photos" button on first run (no library configured) prompts user to choose a location, but the native macOS folder picker dialog never appears. User sees "User cancelled folder selection" immediately.

## Current State (as of 2026-01-13)

### What's Running
- Flask server on port 5001 (terminal 5)
- App at http://localhost:5001
- JavaScript version: `?v=60`
- Database: `../photo-migration-and-script/migration/databases/photo_library_test.db`
- Library path: `/Volumes/eric_files/photo_library_test` (not accessible - first run state)

### Code Changes Made
1. **Backend** (`app.py` lines 2096-2150): Modified `/api/library/browse` to accept AppleScript from frontend (matching pattern used by working `/api/import/browse`)
2. **Frontend** (`static/js/main.js` lines 3965-4000): Modified `browseSwitchLibrary()` to send AppleScript in request body
3. **JS Cache**: Bumped version to v60 in `static/index.html`

## Root Cause Analysis

### The AppleScript
```applescript
POSIX path of (choose folder with prompt "Select photo library folder")
```

### What Was Discovered

**✅ Script syntax is CORRECT:**
- Manual terminal test: `osascript -e 'POSIX path of (choose folder with prompt "Select photo library folder")'` → **WORKS** (dialog opens)
- Python subprocess test outside Flask → **WORKS**
- Quotes are straight ASCII quotes (verified with `od -c`)

**❌ Script FAILS from Flask:**
- Error: `22:28: syntax error: Expected "," but found identifier. (-2741)`
- Same error whether using `-e` flag or writing to temp file
- Return code: 1
- No dialog ever appears

**Debug log location:** `/tmp/applescript_debug.log`

### Key Insight
The AppleScript syntax error is likely a **red herring**. The real issue is that **AppleScript cannot display GUI dialogs from the Flask process** (possibly due to macOS security/permissions, background process restrictions, or session context).

## What Was Attempted (All Failed)
1. ❌ Fixed Python quote escaping (moved script to frontend)
2. ❌ Cleared browser cache multiple times (v58 → v59 → v60)
3. ❌ Restarted Flask cleanly (killed processes, cleared port 5001)
4. ❌ Added `window.blur()` before API call (from working import code)
5. ❌ Wrote AppleScript to temp file (avoiding quote parsing)
6. ❌ Added explicit environment to subprocess
7. ❌ Multiple rounds of diagnostic logging

## Critical Questions for Next Agent

### 1. Does `/api/import/browse` Actually Work?
The codebase has a "working" implementation at `/api/import/browse` (lines 1230-1269) that uses identical AppleScript pattern. **Has this ever been tested successfully from this Flask instance?**

**Test:** In the app UI, use the utilities menu → Import → select files/folders. Does a native dialog open?

### 2. macOS Permissions
Check: **System Settings → Privacy & Security → Automation**
- Is Python listed? 
- Is Terminal listed?
- Are they authorized to control System Events or Finder?

Also check: **Accessibility** permissions

### 3. Flask Process Context
When Flask runs in debug mode, it spawns multiple processes. The reloader process might not have GUI access. The user is running from terminal - does that terminal have proper permissions?

## Recommended Approaches

### Option A: Use tkinter (Cross-Platform)
```python
from tkinter import Tk, filedialog

def browse_library():
    root = Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    path = filedialog.askdirectory(title='Select photo library folder')
    root.destroy()
    # ... rest of logic
```

**Pros:** No AppleScript, works on macOS/Windows/Linux, pure Python
**Cons:** Requires tkinter (check: `python3 -m tkinter`)

### Option B: Debug AppleScript Permissions
1. Run Flask from a terminal that has Full Disk Access
2. Check Console.app for security/permission errors when dialog fails
3. Try adding Python to Accessibility/Automation permissions manually
4. Test with Flask debug mode OFF (might be reloader process issue)

### Option C: Use Separate Helper Process
Run AppleScript from a helper subprocess that's NOT spawned by Flask's worker process. Flask returns immediately, polls for result.

## Files Modified
- `app.py` (lines 2096-2150)
- `static/js/main.js` (lines 3965-4000) 
- `static/index.html` (line 52: version bump)

## Debug Resources
- Log file: `/tmp/applescript_debug.log`
- Flask terminal: terminal 5
- Latest successful manual test proves script syntax is valid

## Why I Was Fired
- Took too many trial-and-error attempts without thorough diagnosis first
- Did not identify the permissions/process context issue early enough
- Made multiple failed "fixes" that didn't address root cause
- Failed to test whether the "working" import feature actually works

## Success Criteria
User clicks "Add photos" → clicks "Choose location" → **native macOS folder picker appears** → user selects folder → confirmation dialog shows with selected path

---

**Next Agent:** Start with permissions/process context investigation. Don't touch the code until you understand WHY AppleScript can't show dialogs from this Flask process.
