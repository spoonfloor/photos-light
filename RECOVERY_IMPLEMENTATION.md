# Recovery Features Implementation Summary

## Date: 2026-01-12

## Overview
Implemented graceful recovery system for missing/corrupted critical resources (database, library directories) during photo library sessions.

---

## ✅ COMPLETED: Backend Implementation

### 1. Core Library Synchronization (`library_sync.py`)
**New module** providing unified sync logic for both maintenance and recovery:

- `synchronize_library_generator()` - Core streaming sync with two modes:
  - `mode='incremental'` - Update Library Index (maintenance)
  - `mode='full'` - Rebuild Database (recovery)
- `count_media_files()` - Fast pre-scan for file counting
- `estimate_duration()` - Time estimates based on file count

**Key improvements:**
- ✅ Removed 50-file hard limit (was for demo only)
- ✅ Added full EXIF date extraction during rebuild
- ✅ Added dimension extraction during rebuild
- ✅ Unified code path eliminates duplication

### 2. Recovery API Endpoints (`app.py`)

**New endpoints:**
```
POST /api/recovery/rebuild-database/scan
  → Pre-scan: counts files, estimates duration
  → Returns: {file_count, estimated_minutes, estimated_display, requires_warning}

POST /api/recovery/rebuild-database/execute  
  → Executes full rebuild with SSE streaming
  → Creates DB if missing
  → Indexes all files from scratch
```

**Modified endpoints:**
```
POST /api/utilities/update-index/execute
  → Now uses synchronize_library_generator(mode='incremental')
  → Cleaner, maintainable code
```

### 3. Database Creation Logic
- Auto-creates database if missing during rebuild
- Uses centralized schema from `db_schema.py`
- Creates parent directories as needed

---

## ✅ COMPLETED: Frontend UI Components

### 1. HTML Fragments Created

**`rebuildDatabaseOverlay.html`**
- Modal overlay for rebuild database flow
- Shows progress stats (indexed count, total files)
- Expandable details section
- Action buttons: Cancel, Proceed, Done

**`criticalErrorModal.html`**
- Blocking modal for Tier 3 errors
- No dismiss button (forces user action)
- Dynamic content and actions
- Used for DB missing, library missing scenarios

### 2. UI Fixes
- ✅ Fixed "Remove Duplicates" to "Remove duplicates" (sentence case consistency)

---

## ⚠️ REMAINING: Frontend JavaScript Wiring

### What's Needed:

#### 1. **Rebuild Database Flow** (in `main.js`)
```javascript
// Needs implementation:
async function rebuildDatabase() {
  // 1. Call /api/recovery/rebuild-database/scan
  // 2. If file_count >= 1000, show warning modal:
  //    "Large library detected"
  //    "Your library contains X photos"
  //    "Rebuilding will take estimated Y hours"
  //    [Cancel] [Continue]
  // 3. If user proceeds, call /api/recovery/rebuild-database/execute
  // 4. Show rebuildDatabaseOverlay with SSE progress
  // 5. Handle completion/errors
}
```

#### 2. **Critical Error Detection** (in `main.js`)
```javascript
// Needs implementation:
function checkCriticalResources() {
  // Called on:
  // - App startup
  // - After any DB operation fails
  // - User clicks "Rebuild Database" button
  
  // Detect scenarios:
  // A) Library exists, DB missing → Show modal with [Rebuild Database] [Switch Library]
  // B) Library missing → Show modal with [Retry] [Switch Library]
  
  // Use criticalErrorModal.html with dynamic content
}
```

#### 3. **Utilities Menu Integration**
```javascript
// Add "Rebuild database" option to utilities menu
// Wire up click handler → rebuildDatabase()
```

#### 4. **Warning Modal Logic**
```javascript
// Extend existing dialog.js or create new warning-dialog.js
// Show pre-scan warning for large libraries (1000+ files)
// Display file count and time estimate
```

---

## 📋 Recovery Tiers (Design Decisions)

### Tier 1: Silent Auto-Recovery
**Resources:** `.thumbnails/`, `.import_temp/`, `.trash/`
- Just recreate with `os.makedirs(exist_ok=True)`
- No user notification needed
- Already implemented in various functions

### Tier 2: Warn Once Per Session  
**Resources:** `.db_backups/`, `.logs/`
- Check before use
- Recreate silently
- Show yellow toast first time: "⚠️ Backup directory was missing and has been recreated"
- Set session flag to avoid spam

**Status:** ⚠️ Not yet implemented (lower priority)

### Tier 3: Block and Ask User (CRITICAL)
**Resources:** `photo_library.db`, library folder/volume
- Show blocking modal immediately
- Differentiate scenarios:
  - Library exists, DB missing → Offer rebuild
  - Library missing → Offer retry/switch
  - Volume missing → Clearer message about drive
- User must take action (no dismiss)

**Status:** ✅ Backend ready, ⚠️ Frontend wiring needed

---

## 🔄 User Flows

### Flow 1: Database Missing (Recovery)
```
1. User opens app → DB connection fails
2. Check: Library folder exists? YES
3. Show modal: "Database missing"
   "Your library is missing the file needed to display photos..."
   [Switch Library] [Rebuild Database]
4. User clicks "Rebuild Database"
5. Pre-scan → count files
6. If >= 1000 files → show warning with estimate
7. User confirms → Execute rebuild (SSE streaming)
8. Show progress overlay
9. Complete → Done button → close overlay
10. App now functional
```

### Flow 2: Library Folder Missing
```
1. User opens app → operations fail
2. Check: Library folder exists? NO
3. Show modal: "Library folder not found"
   "Can't access your library: /path/to/folder"
   "Your library folder is no longer accessible..."
   [Retry Connection] [Switch Library]
4. User clicks "Retry" → check again
5. If still missing → keep modal open
6. User clicks "Switch Library" → library picker
```

---

## 🧪 Testing Checklist

### Backend Tests (Can run now)
- [ ] `/api/recovery/rebuild-database/scan` with small library (< 100 files)
- [ ] `/api/recovery/rebuild-database/scan` with large library (> 1000 files)
- [ ] `/api/recovery/rebuild-database/execute` with no DB → creates DB
- [ ] `/api/recovery/rebuild-database/execute` with existing DB → full reindex
- [ ] Verify no 50-file limit (check stats show all files)
- [ ] Verify EXIF dates extracted correctly
- [ ] Verify dimensions extracted correctly

### Frontend Tests (After wiring complete)
- [ ] Rebuild database from utilities menu
- [ ] Large library warning shows correct estimate
- [ ] Cancel during rebuild works
- [ ] Progress updates correctly
- [ ] Completion shows correct stats
- [ ] Database missing modal appears and works
- [ ] Library missing modal appears and works
- [ ] Retry connection logic works
- [ ] Switch library from modal works

---

## 📁 Files Modified/Created

### Created:
- `library_sync.py` - Core synchronization logic
- `static/fragments/rebuildDatabaseOverlay.html` - Rebuild UI
- `static/fragments/criticalErrorModal.html` - Error modal

### Modified:
- `app.py` - Added recovery endpoints, refactored execute_update_index
- `static/fragments/duplicatesOverlay.html` - Fixed title case

---

## 🎯 Next Steps (Priority Order)

1. **HIGH:** Wire up rebuild database flow in main.js
   - Add function to utilities menu
   - Implement pre-scan + warning modal
   - Connect to rebuild overlay
   - Handle SSE streaming

2. **HIGH:** Implement critical error detection
   - Check on app start
   - Check after DB errors
   - Show appropriate modal
   - Wire up action buttons

3. **MEDIUM:** Add Tier 2 warnings (backup/log dirs)
   - Session-based warning flags
   - Toast notifications
   - Auto-recreation

4. **LOW:** Polish and refinement
   - Better error messages
   - Loading states
   - Keyboard shortcuts
   - Accessibility

---

## 💡 Design Philosophy

**Silent recovery:** Cache/temp files → just fix
**Warn once:** Safety features missing → inform but don't spam  
**Block and ask:** Critical resources missing → user must decide

**Unified code:** One sync function, two modes (maintenance vs recovery)
**Honest UI:** Don't offer actions we can't deliver
**Clear communication:** Specific messages about what's wrong and what to do

---

## 🔍 Code Patterns

### Backend API Pattern:
```python
@app.route('/api/recovery/rebuild-database/scan', methods=['POST'])
def scan_rebuild_database():
    # 1. Quick pre-scan (no side effects)
    # 2. Return counts and estimates
    # 3. Frontend decides whether to show warning

@app.route('/api/recovery/rebuild-database/execute', methods=['POST'])
def execute_rebuild_database():
    # 1. Create DB if missing
    # 2. Call synchronize_library_generator(mode='full')
    # 3. Stream SSE progress events
    # 4. Return completion stats
```

### Frontend Pattern (to implement):
```javascript
// 1. Pre-scan first
const {file_count, estimated_display, requires_warning} = await scan();

// 2. Show warning if needed
if (requires_warning) {
  const confirmed = await showWarningModal(file_count, estimated_display);
  if (!confirmed) return;
}

// 3. Execute with progress
await executeWithProgress('/api/recovery/rebuild-database/execute');
```

---

## 📝 Notes

- Time estimates based on 150 files/minute (conservative)
- Threshold for warnings: 1000 files
- Database location coupled with library location (by design)
- All backend work complete and syntax-validated
- Frontend needs ~2-3 hours of JavaScript work to complete

