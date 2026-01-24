# EXIF Write on Import - Homework Report

**Date:** January 24, 2026  
**Task:** Add EXIF writing during import with rejection handling

---

## 1. Import Flow Analysis

### Current Flow (app.py: `import_from_paths()`)

**Location:** Lines 1704-1850

**Structure:** SSE streaming generator
```
For each file:
1. Compute hash
2. Check for duplicates → skip if exists
3. Extract EXIF date (READ ONLY)
4. Build target path (YYYY/YYYY-MM-DD/filename)
5. Insert into database
6. Copy file to library
7. Yield progress event
```

**Error Handling:**
- Try/except around each file
- Errors logged, counted, file skipped
- Import continues for remaining files
- Error details tracked: `window.importErrors = [{file, message}]`

**Key Finding:** Import already handles per-file failures gracefully. Perfect for adding EXIF write step.

---

## 2. Existing EXIF Functions

### `write_photo_exif(file_path, new_date)` - Line 202
- Uses exiftool
- Writes DateTimeOriginal, CreateDate, ModifyDate
- Has timeout protection (30s)
- **Has verification** - reads back to confirm
- Raises exceptions on failure

### `write_video_metadata(file_path, new_date)` - Line 245
- Uses ffmpeg
- Writes creation_time
- Creates temp file, replaces original
- Has timeout protection (60s)
- **No verification step** (could add)

### `extract_exif_date(file_path)` - Line 157
- Reads EXIF using exiftool
- Falls back to filesystem mtime
- Has timeout (5s)
- Already used during import

**Key Finding:** Functions exist, are tested, have timeout protection. Can reuse directly.

---

## 3. File Format Support

### Constants (Line 72-74)
```python
PHOTO_EXTENSIONS = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.bmp', '.tiff', '.tif'}
VIDEO_EXTENSIONS = {'.mov', '.mp4', '.m4v', '.avi', '.mpg', '.mpeg', '.3gp', '.mts', '.mkv'}
```

### Format Support Matrix

| Format | Import | EXIF Write Tool | Expected Success Rate |
|--------|--------|----------------|---------------------|
| JPEG   | ✅ | exiftool | 99%+ |
| HEIC   | ✅ | exiftool | 99%+ |
| HEIF   | ✅ | exiftool | 99%+ |
| PNG    | ✅ | exiftool (text chunks) | 95%+ |
| GIF    | ✅ | exiftool (XMP/Comment) | 90%+ |
| TIFF   | ✅ | exiftool | 99%+ |
| BMP    | ✅ | exiftool (limited) | 70%? |
| MOV    | ✅ | ffmpeg | 95%+ |
| MP4    | ✅ | ffmpeg | 95%+ |
| M4V    | ✅ | ffmpeg | 95%+ |
| AVI    | ✅ | ffmpeg | 80%? |
| MKV    | ✅ | ffmpeg | 80%? |
| Others | ✅ | varies | unknown |

**Key Finding:** Most formats should work. Exotic formats may fail, but that's acceptable (rejection handling).

---

## 4. UI Pattern for Results

### Import Overlay (importOverlay.html)

**Already has:**
- Progress display (imported/duplicates/errors)
- Error counter
- Expandable details section
- Error list with file + message
- "Show error details" toggle

**JavaScript tracking:**
- `window.importErrors = [{file, message}]`
- Populated during `event: 'progress'` with `data.error` and `data.error_file`
- Displayed in expandable list on completion

**Key Finding:** Error display mechanism already exists. Need to add:
1. "View rejected files" button
2. Dialog with rejection reasons
3. "Copy files to folder" action

---

## 5. Folder Copy Pattern

### Folder Picker (`folderPicker.js`)
- Custom folder picker UI
- Shows system locations + navigation
- Returns selected path
- Used in library creation flow

**Key Finding:** Can reuse `FolderPicker.show()` for copy destination selection.

---

## 6. Rejection Tracking Strategy

### During Import

**Add new variables to track:**
```javascript
window.importRejections = [
  {
    file: 'corrupted.jpg',
    path: '/source/path/corrupted.jpg',
    reason: 'EXIF write failed: file corrupted',
    category: 'corrupted' // or 'unsupported', 'permission', 'timeout'
  }
]
```

**Backend sends:**
```python
yield f"event: rejected\ndata: {json.dumps({
    'file': filename,
    'path': source_path,
    'reason': error_message,
    'category': category
})}\n\n"
```

**Frontend handles:**
```javascript
if (event === 'rejected') {
  window.importRejections.push(data);
  // Update rejection counter
}
```

---

## 7. Implementation Plan

### Phase 1: Backend Changes (app.py)

**Location:** `import_from_paths()` function, line ~1704

**Add after line 1767 (after EXIF extraction):**

```python
# NEW: Write EXIF to file
try:
    if file_type == 'image':
        write_photo_exif(target_path, date_taken)
    else:  # video
        write_video_metadata(target_path, date_taken)
    print(f"   ✅ EXIF written")
except Exception as e:
    # EXIF write failed - reject this file
    error_msg = f"EXIF write failed: {str(e)}"
    print(f"   ❌ {error_msg}")
    
    # Categorize error
    if 'timeout' in str(e).lower():
        category = 'timeout'
    elif 'not found' in str(e).lower():
        category = 'missing_tool'
    elif 'permission' in str(e).lower():
        category = 'permission'
    elif 'corrupt' in str(e).lower() or 'invalid' in str(e).lower():
        category = 'corrupted'
    else:
        category = 'unsupported'
    
    # Send rejection event
    yield f"event: rejected\ndata: {json.dumps({
        'file': filename,
        'path': source_path,
        'reason': error_msg,
        'category': category
    })}\n\n"
    
    # Continue to next file (don't insert into DB)
    continue
```

**Update completion event to include rejections:**
```python
yield f"event: complete\ndata: {json.dumps({
    'imported': imported_count,
    'duplicates': duplicate_count,
    'errors': error_count,
    'rejected': rejected_count  # NEW
})}\n\n"
```

---

### Phase 2: Frontend Changes (main.js)

**Add rejection tracking (line ~5377):**
```javascript
if (event === 'start') {
  // ... existing code ...
  
  // Initialize rejection tracking
  window.importRejections = [];
}

if (event === 'progress') {
  // ... existing code ...
}

// NEW: Handle rejections
if (event === 'rejected') {
  if (!window.importRejections) {
    window.importRejections = [];
  }
  window.importRejections.push({
    file: data.file,
    path: data.path,
    reason: data.reason,
    category: data.category
  });
}

if (event === 'complete') {
  // Update status text to include rejections
  const totalRejected = data.rejected || 0;
  if (totalRejected > 0) {
    statusText.innerHTML = `<p>Import complete: ${totalRejected} file${totalRejected > 1 ? 's' : ''} rejected</p>`;
    // Show rejection details UI
    showRejectionDetails();
  }
}
```

---

### Phase 3: Rejection UI

**Option A: Reuse existing error details section**
- Already has expandable list
- Add "Copy rejected files..." button
- Show rejection reasons in list

**Option B: New rejection-specific dialog**
- More specific messaging
- Categories (corrupted vs unsupported vs permission)
- More prominent "Copy files" action

**Recommendation:** Option A (faster, consistent with error handling)

**Changes to importOverlay.html:**
```html
<!-- Add after error details section -->
<div class="import-rejection-actions" id="importRejectionActions" style="display: none;">
  <button class="import-btn import-btn-secondary" id="copyRejectedBtn">
    <span class="material-symbols-outlined">folder_copy</span>
    Copy rejected files to folder...
  </button>
  <button class="import-btn import-btn-secondary" id="exportRejectionListBtn">
    <span class="material-symbols-outlined">description</span>
    Export list
  </button>
</div>
```

---

### Phase 4: Copy Files Functionality

**New function in main.js:**
```javascript
async function copyRejectedFiles() {
  try {
    // Show folder picker
    const destFolder = await FolderPicker.show({
      title: 'Copy Rejected Files',
      subtitle: 'Choose destination folder'
    });
    
    if (!destFolder) return; // Cancelled
    
    // Call backend to copy files
    const response = await fetch('/api/import/copy-rejected-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: window.importRejections,
        destination: destFolder
      })
    });
    
    if (!response.ok) throw new Error('Copy failed');
    
    showToast('Rejected files copied successfully', 'success');
  } catch (error) {
    showToast(`Copy failed: ${error.message}`, 'error');
  }
}
```

**New endpoint in app.py:**
```python
@app.route('/api/import/copy-rejected-files', methods=['POST'])
def copy_rejected_files():
    try:
        data = request.json
        files = data.get('files', [])
        destination = data.get('destination')
        
        # Create timestamp subfolder
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        reject_folder = os.path.join(destination, f'Photos_Rejected_{timestamp}')
        os.makedirs(reject_folder, exist_ok=True)
        
        # Copy files
        copied = 0
        for item in files:
            source = item['path']
            if os.path.exists(source):
                shutil.copy2(source, reject_folder)
                copied += 1
        
        # Create report
        report_path = os.path.join(reject_folder, 'rejection_report.txt')
        with open(report_path, 'w') as f:
            f.write(f"Import Rejection Report\n")
            f.write(f"Generated: {datetime.now()}\n\n")
            f.write(f"Total files: {len(files)}\n")
            f.write(f"Copied: {copied}\n\n")
            f.write("=" * 60 + "\n\n")
            
            for item in files:
                f.write(f"File: {item['file']}\n")
                f.write(f"Reason: {item['reason']}\n")
                f.write(f"Category: {item['category']}\n\n")
        
        return jsonify({
            'success': True,
            'copied': copied,
            'folder': reject_folder
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500
```

---

## 8. Error Categories & Messages

### User-Facing Messages

**Corrupted:**
> ❌ File corrupted or damaged  
> This file could not be processed. Try re-downloading or recovering from backup.

**Unsupported:**
> ⚠️ Format not supported  
> This file format cannot store date metadata reliably.

**Permission:**
> 🔒 Permission denied  
> Cannot access this file. Check file permissions.

**Timeout:**
> ⏱️ Processing timeout  
> File took too long to process (possibly very large or slow storage).

**Missing Tool:**
> 🛠️ Required tool not found  
> Install exiftool or ffmpeg to process this file type.

---

## 9. Testing Strategy

### Test Files Needed

1. **Valid JPEG** (should succeed)
2. **Valid HEIC** (should succeed)
3. **Valid MOV** (should succeed)
4. **PNG without EXIF** (should succeed - exiftool can write text chunks)
5. **GIF** (should succeed - exiftool can write XMP)
6. **Corrupted JPEG** (should reject)
7. **Zero-byte file** (should reject)
8. **File without write permission** (should reject)
9. **Exotic format** (.tga, .webp) (may reject)

### Test Scenarios

1. Import 10 files, all succeed → no rejection UI shown
2. Import 10 files, 2 fail → rejection UI shown, can expand details
3. Click "Copy rejected files" → folder picker → files copied with report
4. Import with exiftool not installed → all photos rejected with "missing tool"
5. Import with timeout (slow NAS) → timeout rejections
6. Mixed batch: some succeed, some reject → proper counts

---

## 10. Risks & Mitigations

### Risk 1: EXIF write is slow
**Impact:** Import takes 2-3x longer  
**Mitigation:** User accepted this. Show progress clearly.

### Risk 2: Unexpected format failures
**Impact:** Many rejections for "normal" files  
**Mitigation:** Extensive testing. Start with conservative format list if needed.

### Risk 3: Timeout on slow storage (NAS)
**Impact:** Many timeout rejections  
**Mitigation:** Increase timeout for network storage? Or accept rejections.

### Risk 4: ffmpeg video write changes file
**Impact:** File hash might change, duplicates missed  
**Mitigation:** Write EXIF AFTER computing hash, BEFORE copying to library.

**WAIT - THIS IS CRITICAL:** Need to write to TARGET file after copy, not source file.

---

## 11. Critical Correction: Write Location

**PROBLEM:** Current plan writes EXIF to source file (user's original).  
**SOLUTION:** Write EXIF to target file AFTER copy.

**Revised flow:**
```
1. Compute hash from source
2. Check duplicates
3. Extract EXIF from source
4. Build target path
5. COPY source to target  ← file is now in library
6. Write EXIF to target    ← modify library copy, not original
7. Verify EXIF in target
8. If EXIF write/verify fails → delete target, reject file
9. Insert into database
```

**This preserves user's original files untouched.**

---

## 12. Confidence Assessment

### What Will Work
- EXIF write for JPEG/HEIC (99% confidence)
- Video metadata for MOV/MP4 (95% confidence)
- Rejection tracking and display (95% confidence)
- Copy files functionality (90% confidence)

### What Needs Testing
- PNG/GIF EXIF support (70% confidence)
- Exotic video formats (70% confidence)
- Timeout handling on slow storage (80% confidence)
- Error categorization accuracy (80% confidence)

### What Might Break
- Import stream interrupted by exception (needs careful try/except)
- File cleanup on rejection (target file already copied)
- Hash computation after EXIF write (MUST compute before)
- Folder picker integration (different context)

**Overall confidence: 60-70%** - Will need iteration, especially for edge cases and cleanup logic.

---

## 13. Estimated Changes

**Backend (app.py):**
- Import function: +60 lines (EXIF write, rejection handling)
- New endpoint (copy rejected): +40 lines

**Frontend (main.js):**
- Event handling: +30 lines (rejection tracking)
- UI updates: +40 lines (show rejection details)
- Copy functionality: +50 lines

**HTML (importOverlay.html):**
- Rejection UI: +20 lines

**Total: ~240 lines of new code**

---

## 14. Open Questions

1. **Should we write EXIF even if file already has EXIF?**
   - Pro: Ensures consistency, corrects any bad EXIF
   - Con: Modifies files unnecessarily
   - **Recommendation:** Always write (user accepted "truth in files")

2. **Timeout values for NAS?**
   - Current: 30s (exiftool), 60s (ffmpeg)
   - NAS might need longer?
   - **Recommendation:** Start with current, adjust if needed

3. **What to do with rejected files' source copies?**
   - They stay in original location
   - User can re-import after fixing
   - **Recommendation:** This is correct

4. **Should we support "import anyway" option?**
   - Skip EXIF write, import without metadata
   - Violates "truth in files" philosophy
   - **Recommendation:** No, stick to rejection

---

## 15. Next Steps

**Awaiting approval to proceed with implementation.**

**Recommended approach:**
1. Implement backend EXIF write + rejection (Phase 1)
2. Test with various file types
3. Implement frontend tracking (Phase 2)
4. Implement UI (Phase 3)
5. Implement copy functionality (Phase 4)
6. Full integration testing

**Estimated time: 3-4 hours of focused work + testing**

---

**END OF HOMEWORK**
