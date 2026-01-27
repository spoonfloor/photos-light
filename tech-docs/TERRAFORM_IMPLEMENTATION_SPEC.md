# Terraform Implementation Specification

**Date:** 2026-01-25  
**Status:** Pre-Implementation Research Complete  
**Confidence:** 95%

---

## Complete Code Path Analysis

### **1. FolderPicker API** ✅

**Location:** `static/js/folderPicker.js`

**Usage:**
```javascript
const selectedPath = await FolderPicker.show({
  title: 'Open library',
  subtitle: 'Select an existing library folder or choose where to create one'
});

// Returns: string path or null (if cancelled)
```

**Behavior:**
- Returns single folder path (not file paths)
- Returns `null` on cancel
- Handles saved path restoration from localStorage
- Has keyboard shortcut (Cmd+Shift+D for Desktop)
- Shows database file indicator when present

---

### **2. Empty State Rendering** ✅

**Two functions (need to merge):**

**Function 1:** `renderFirstRunEmptyState()` - Lines 2521-2543
- Used when: `status === 'not_configured'` (first run)
- Shows: "Welcome!" + "Add photos or open an existing library to get started"
- Buttons: `browseSwitchLibrary()` + `handleAddPhotosFirstRun()` (DOESN'T EXIST)
- Actually calls: `triggerImportWithLibraryCheck()` (line 2561)

**Function 2:** `renderFirstRunEmptyState()` - Lines 2548-2568 (DUPLICATE!)
- Same function name, different implementation
- Identical to Function 1
- This is the version that's actually used

**Empty library state:** `renderPhotoGrid([], false)` - Lines 2581-2601
- Used when: Library exists but `photos.length === 0`
- Shows: "No photos found" + "Add photos or switch to an existing library"
- Buttons: `openSwitchLibraryOverlay()` + `triggerImportWithLibraryCheck()`

**Fix:** Delete duplicate, merge both into single function

---

### **3. Current "Open Library" Flow** ✅

**From empty state button:**
```javascript
onclick="browseSwitchLibrary()"  // First run state
onclick="openSwitchLibraryOverlay()"  // Empty library state
```

**From utilities menu:**
```javascript
switchLibraryBtn.addEventListener('click', () => {
  hideUtilitiesMenu();
  openSwitchLibraryOverlay();
});
```

**`openSwitchLibraryOverlay()` (lines 4828-4853):**
1. Loads overlay fragment if needed
2. Fetches current library path from `/api/library/current`
3. Displays dialog showing current path
4. Shows 3 buttons: Cancel / Create New / Browse

**`browseSwitchLibrary()` (lines 4868-4935):**
1. Closes switch library overlay
2. Opens FolderPicker
3. Gets selected path
4. Calls `/api/library/check` with path
5. If exists: calls `switchToLibrary()`
6. If not exists: resets config and reloads page

**Fix:** Remove `openSwitchLibraryOverlay()` entirely, call `browseSwitchLibrary()` directly

---

### **4. Switch Library Backend** ✅

**`POST /api/library/check`** (lines 3352-3378)
```python
Request: {"library_path": "/path/to/folder"}
Response: {
  "exists": true/false,
  "library_path": "/path/to/folder",
  "db_path": "/path/to/folder/photo_library.db"
}
```

**Enhancement needed:**
```python
Response: {
  "exists": true/false,
  "has_media": true/false,  # NEW
  "media_count": 1234,      # NEW
  "library_path": "/path/to/folder",
  "db_path": "/path/to/folder/photo_library.db"
}
```

**`POST /api/library/switch`** (lines 3434-3476)
```python
Request: {"library_path": "...", "db_path": "..."}
Response: {"library_path": "...", "db_path": "..."}

# Side effects:
# - Updates global LIBRARY_PATH, DB_PATH variables
# - Saves to .config.json
# - Reinitializes logging
```

**`POST /api/library/create`** (lines 3381-3432)
```python
Request: {"library_path": "...", "db_path": "..."}
Response: {"status": "created", "library_path": "...", "db_path": "..."}

# Side effects:
# - Creates folder structure
# - Creates hidden folders (.thumbnails, .trash, etc.)
# - Creates empty database with schema
```

---

### **5. switchToLibrary() Frontend** ✅

**Function:** Lines 5128-5158

**What it does:**
1. Calls `/api/library/switch` with paths
2. Shows toast: "Opened {foldername}"
3. Closes any open overlays
4. Waits 500ms
5. Calls `loadAndRenderPhotos()` to refresh grid

**Note:** Does NOT reload page, just refreshes photos

---

### **6. Add Photos Flow** ✅

**`triggerImportWithLibraryCheck()`** (lines 5172-5202)

**Logic:**
```javascript
1. Check /api/library/status
2. If status === 'not_configured':
   - Call createNewLibraryWithName() 
   - (this handles folder picker + name dialog + creation)
   - After creation, page reloads
3. Else:
   - Call triggerImport() (opens photo picker immediately)
```

**So [Add photos] button IS already context-sensitive** ✅

---

### **7. Import SSE Pattern** ✅

**Backend:** `/api/photos/import-from-paths` (lines 1998-2226)

**SSE Events:**
```
event: start
data: {"total": 100}

event: progress
data: {"imported": 50, "duplicates": 5, "errors": 2, "current": 57, "total": 100}

event: rejected
data: {"file": "IMG.jpg", "source_path": "/path", "reason": "...", "category": "corrupted"}

event: complete
data: {"imported": 93, "duplicates": 5, "errors": 2}

event: error
data: {"error": "Something went wrong"}
```

**Frontend handler:** `handleImportEvent()` (lines 5516-5660)
- Updates scoreboard in real-time
- Tracks rejections in `window.importRejections` array
- Shows expandable error details on completion

**Pattern to copy exactly for terraform**

---

### **8. Media Counting Logic** ✅

**Backend:** `library_sync.py` has `count_media_files(library_path)`

**Returns:** Integer count of all media files recursively

**Used for:** Estimating rebuild time

**Can reuse for terraform preview count**

---

### **9. Utilities Menu Changes** ✅

**Location:** `static/fragments/utilitiesMenu.html`

**Changes needed:**
- Line 3: Change "Switch library" → "Open library"
- Line 3409-3413: Change handler from `openSwitchLibraryOverlay()` → `browseSwitchLibrary()`

---

### **10. File Move Handling** ✅

**Import uses:**
```python
shutil.copy2(source_path, target_path)  # Copy + preserve metadata
```

**Terraform will use:**
```python
shutil.move(source_path, target_path)  # Move (atomic, handles cross-device)
```

**Cross-device handled automatically:**
- `shutil.move()` detects cross-device moves
- Falls back to copy + delete automatically
- No extra code needed ✅

---

## Complete Implementation Plan

### **Phase 1: Empty State Unification** (30 mins)

1. Delete duplicate `renderFirstRunEmptyState()` function (one of the two copies)
2. Change text: "Welcome!" → remove, "No photos found" → "No photos to display"
3. Change button onclick: Both states call `browseSwitchLibrary()` now
4. Change button text: "Switch library" → "Open library"

**Files:**
- `static/js/main.js` - Lines 2521-2568, 2586-2592

---

### **Phase 2: Remove Switch Library Dialog** (15 mins)

1. Delete call to `openSwitchLibraryOverlay()` everywhere
2. Replace with `browseSwitchLibrary()` direct call
3. Update utilities menu HTML: "Switch library" → "Open library"
4. Update utilities menu handler to call `browseSwitchLibrary()`

**Files:**
- `static/js/main.js` - Lines 3409-3414, 1707, 1734
- `static/fragments/utilitiesMenu.html` - Line 3

---

### **Phase 3: Enhance Library Check Backend** (30 mins)

**Add media detection to `/api/library/check`:**

```python
@app.route('/api/library/check', methods=['POST'])
def check_library():
    data = request.json
    library_path = data.get('library_path')
    
    if not os.path.exists(library_path):
        return jsonify({'exists': False, 'has_media': False, 'media_count': 0})
    
    db_path = os.path.join(library_path, 'photo_library.db')
    exists = os.path.exists(db_path)
    
    # NEW: Check for media files
    has_media = False
    media_count = 0
    
    if not exists:
        # Only scan if no DB (don't scan existing libraries)
        from library_sync import count_media_files
        media_count = count_media_files(library_path)
        has_media = media_count > 0
    
    return jsonify({
        'exists': exists,
        'has_media': has_media,
        'media_count': media_count,
        'library_path': library_path,
        'db_path': db_path
    })
```

**Files:**
- `app.py` - Lines 3352-3378

---

### **Phase 4: Update browseSwitchLibrary() Logic** (1 hour)

**Current logic (lines 4868-4935):**
```javascript
if (checkResult.exists) {
  switchToLibrary(path);
} else {
  resetConfigAndReload();
}
```

**New logic:**
```javascript
if (checkResult.exists) {
  // Has DB - open it
  await switchToLibrary(path, dbPath);
}
else if (!checkResult.has_media) {
  // No DB, no media - create blank library
  await showNameLibraryDialog({parentPath: path});
  // Then create library in subfolder
}
else {
  // No DB, has media - show choice dialog
  await showTerraformChoiceDialog({
    path: path,
    media_count: checkResult.media_count
  });
}
```

**Files:**
- `static/js/main.js` - Lines 4868-4935

---

### **Phase 5: Create Terraform Dialogs** (3 hours)

**5 new HTML fragments:**
1. `terraformChoiceOverlay.html` - Choice dialog
2. `terraformPreviewOverlay.html` - Preview with counts
3. `terraformWarningOverlay.html` - Warning with backup prompts
4. `terraformProgressOverlay.html` - Progress scoreboard
5. `terraformCompleteOverlay.html` - Completion summary

**5 new JavaScript functions:**
1. `loadTerraformChoiceOverlay()` - Load and wire dialog
2. `showTerraformChoiceDialog()` - Show dialog, return choice
3. `showTerraformPreview()` - Show counts, confirm folder
4. `showTerraformWarning()` - Show warnings, get backup confirmation
5. `executeTerraform()` - Start SSE, handle progress, show completion

**Files:**
- New: `static/fragments/terraform*.html` (5 files)
- `static/js/main.js` - Add ~500 lines

---

### **Phase 6: Terraform Backend** (4-5 hours)

**New endpoint:** `POST /api/library/terraform`

**Request:**
```json
{"library_path": "/Users/eric/OldPhotos"}
```

**Response:** SSE stream (same pattern as import)

**Logic flow:**
```python
def terraform_library():
    def generate():
        # Pre-flight checks
        check_required_tools()
        check_disk_space(library_path)
        check_write_permissions(library_path)
        
        # Create manifest log
        log_file = create_manifest_log(library_path)
        
        # Scan for all media files
        media_files = scan_media_files_recursive(library_path)
        
        yield f"event: start\ndata: {json.dumps({'total': len(media_files)})}\n\n"
        
        # Process each file
        for file_path in media_files:
            try:
                # 1. Compute hash
                content_hash = compute_hash(file_path)
                
                # 2. Check duplicate
                cursor.execute("SELECT id FROM photos WHERE content_hash = ?", (content_hash,))
                if cursor.fetchone():
                    # Move to .trash/duplicates/
                    move_to_trash(file_path, 'duplicates')
                    duplicate_count += 1
                    continue
                
                # 3. Extract date
                date_taken = extract_exif_date(file_path)
                
                # 4. Get dimensions
                dimensions = get_image_dimensions(file_path)
                
                # 5. Write EXIF (IN PLACE)
                ext = os.path.splitext(file_path)[1].lower()
                file_type = 'video' if ext in VIDEO_EXTENSIONS else 'image'
                
                if file_type == 'image':
                    write_photo_exif(file_path, date_taken)
                else:
                    write_video_metadata(file_path, date_taken)
                
                # 6. Rehash after EXIF write
                new_hash = compute_hash(file_path)
                
                # 7. Generate target path
                date_obj = datetime.strptime(date_taken, '%Y:%m:%d %H:%M:%S')
                year = date_obj.strftime('%Y')
                date_folder = date_obj.strftime('%Y-%m-%d')
                target_dir = os.path.join(library_path, year, date_folder)
                os.makedirs(target_dir, exist_ok=True)
                
                # 8. Generate canonical filename
                short_hash = new_hash[:8]
                base_name = f"img_{date_obj.strftime('%Y%m%d')}_{short_hash}"
                canonical_name = base_name + ext.lower()
                target_path = os.path.join(target_dir, canonical_name)
                
                # Handle collisions
                counter = 1
                while os.path.exists(target_path):
                    canonical_name = f"{base_name}_{counter}{ext.lower()}"
                    target_path = os.path.join(target_dir, canonical_name)
                    counter += 1
                
                # 9. Move file
                shutil.move(file_path, target_path)
                
                # 10. Insert DB record
                relative_path = os.path.relpath(target_path, library_path)
                cursor.execute("""
                    INSERT INTO photos (...)
                    VALUES (...)
                """, (...))
                conn.commit()
                
                # 11. Log success
                log_manifest(log_file, 'success', {...})
                processed_count += 1
                
            except Exception as e:
                # Categorize error (same categories as import)
                category = categorize_error(e)
                
                # Move to appropriate trash subfolder
                move_to_trash(file_path, category)
                
                # Log failure
                log_manifest(log_file, 'failed', {...})
                error_count += 1
                
                # Yield rejection event
                yield f"event: rejected\ndata: ..."
            
            # Yield progress
            yield f"event: progress\ndata: ..."
        
        # Cleanup empty folders
        cleanup_empty_folders_recursive(library_path)
        
        # Complete
        yield f"event: complete\ndata: ..."
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')
```

**Files:**
- `app.py` - New function ~400 lines

---

### **Phase 7: Manifest Logging** (1 hour)

**Format:** JSONL (newline-delimited JSON)

**Location:** `.logs/terraform_YYYYMMDD_HHMMSS.jsonl`

**Entry format:**
```json
{"timestamp":"2026-01-25T14:30:22Z","event":"start","total_files":1234}
{"timestamp":"2026-01-25T14:30:23Z","event":"processing","file":"/old/IMG.jpg"}
{"timestamp":"2026-01-25T14:30:24Z","event":"success","original":"/old/IMG.jpg","new":"2024/2024-12-25/img_20241225_abc.jpg","hash":"abc123..."}
{"timestamp":"2026-01-25T14:30:25Z","event":"failed","file":"/old/BAD.jpg","reason":"corrupted","category":"corrupted"}
{"timestamp":"2026-01-25T14:40:22Z","event":"complete","processed":1200,"duplicates":25,"errors":9}
```

**Resume logic:**
```python
def get_processed_files(log_file):
    """Parse manifest log to see what's already done"""
    processed = set()
    if os.path.exists(log_file):
        with open(log_file, 'r') as f:
            for line in f:
                entry = json.loads(line)
                if entry['event'] == 'success':
                    processed.add(entry['original'])
    return processed
```

**Files:**
- `app.py` - Helper functions ~100 lines

---

### **Phase 8: Pre-flight Checks** (1 hour)

**Functions to add:**
```python
def check_required_tools():
    """Verify exiftool and ffmpeg installed"""
    
def check_disk_space(path):
    """Ensure >10% free space"""
    
def check_write_permissions(path):
    """Verify writable"""
```

**Run before starting terraform, raise exceptions if checks fail**

**Files:**
- `app.py` - Helper functions ~80 lines

---

## Summary: Remaining Questions

### ✅ ANSWERED:
1. FolderPicker API - Fully documented
2. Empty state rendering - Found duplicate function, know how to merge
3. Switch library flow - Complete path traced
4. Add photos context-sensitivity - Already works correctly
5. SSE pattern - Import pattern ready to copy
6. File move handling - shutil.move() handles cross-device
7. Utilities menu wiring - Know exact lines to change
8. RAW file handling - Try all formats, let failures happen naturally

### ❓ NO REMAINING QUESTIONS

---

## Estimated Effort (Updated)

- Phase 1: Empty state unification - 30 mins
- Phase 2: Remove switch dialog - 15 mins
- Phase 3: Backend library check - 30 mins
- Phase 4: Frontend browse logic - 1 hour
- Phase 5: Terraform dialogs - 3 hours
- Phase 6: Terraform backend - 4-5 hours
- Phase 7: Manifest logging - 1 hour
- Phase 8: Pre-flight checks - 1 hour
- Testing - 3 hours

**Total:** 14-15 hours implementation time

**Current main.js version:** v162
**Next version:** v163+

---

## Ready to Implement

95% confidence. No remaining questions. All APIs documented. All patterns identified.

Ready for your approval to proceed.
