# Terraform Feature - Failure Modes & Existing Protections

**Date:** 2026-01-25  
**Purpose:** Comprehensive analysis of failure modes with existing import protections mapped to terraform

---

## Existing Import Protections (Already Implemented)

### 1. EXIF Write Safety

**Photos (using exiftool):**
```python
def write_photo_exif(file_path, new_date):
    # Writes DateTimeOriginal, CreateDate, ModifyDate
    # Uses -overwrite_original flag
    # Uses -P flag (preserve file modification date)
    # 30 second timeout
    # Verifies write by reading back
    # Raises exception if verification fails
```

**Protection:**
- ✅ Write verification (read back and compare)
- ✅ Timeout protection (30s)
- ✅ Tool detection (raises if exiftool not found)
- ✅ Detailed error messages

**Videos (using ffmpeg):**
```python
def write_video_metadata(file_path, new_date):
    # CHECK: Pre-validates format support
    # UNSUPPORTED: .mpg, .mpeg, .vob, .ts, .mts, .avi, .wmv
    # Creates temp file with _temp suffix
    # Uses -codec copy (stream copy, no re-encoding)
    # Uses -y flag (overwrite without asking)
    # 60 second timeout
    # Replaces original only on success
```

**Protection:**
- ✅ **Pre-flight format check** - Rejects unsupported formats BEFORE attempting write
- ✅ **Temp file pattern** - Writes to temp, only replaces on success
- ✅ **No re-encoding** - Stream copy preserves quality
- ✅ **Timeout protection** (60s)
- ✅ **Cleanup on failure** - Deletes temp file if write fails
- ✅ **Tool detection** (raises if ffmpeg not found)

**Unsupported Video Formats:**
```python
unsupported_formats = {'.mpg', '.mpeg', '.vob', '.ts', '.mts', '.avi', '.wmv'}
```

These formats either:
- Don't support embedded metadata containers
- Have unreliable metadata support
- Would require re-encoding (quality loss)

---

### 2. Import Rollback Pattern (CRITICAL FOR TERRAFORM)

**Atomic Per-File Operation:**
```python
# 1. Compute hash FIRST (before any changes)
content_hash = compute_hash(source_path)

# 2. Check duplicate BEFORE copying
cursor.execute("SELECT id FROM photos WHERE content_hash = ?", (content_hash,))
if existing:
    duplicate_count += 1
    continue

# 3. Insert DB record FIRST
cursor.execute("INSERT INTO photos (...) VALUES (...)")
photo_id = cursor.lastrowid
conn.commit()

# 4. Copy file to library
shutil.copy2(source_path, target_path)

# 5. Write EXIF to copied file
try:
    write_photo_exif(target_path, date_taken)
except Exception as exif_error:
    # ROLLBACK: Delete file
    if os.path.exists(target_path):
        os.remove(target_path)
    
    # ROLLBACK: Delete DB record
    cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
    conn.commit()
    
    # Categorize and track rejection
    # Continue to next file
```

**Key Protection:**
- ✅ **Atomic per-file** - Failure in one file doesn't block others
- ✅ **Full rollback** - File AND database record deleted on EXIF failure
- ✅ **Continue on error** - Import doesn't stop, just tracks rejections

---

### 3. Error Categorization (From Import)

```python
# Check error string to categorize
error_str = str(exif_error).lower()

if 'timeout' in error_str:
    category = 'timeout'
    user_message = "Processing timeout (file too large or slow storage)"

elif 'unique constraint' in error_str and 'content_hash' in error_str:
    category = 'duplicate'
    user_message = "Duplicate file (detected after processing)"

elif ('not a valid' in error_str or 'corrupt' in error_str or 
      'invalid data' in error_str or 'moov atom' in error_str):
    category = 'corrupted'
    user_message = "File corrupted or invalid format"

elif 'not found' in error_str and 'exiftool' in error_str:
    category = 'missing_tool'
    user_message = "Required tool not installed (exiftool)"

elif 'not found' in error_str and 'ffmpeg' in error_str:
    category = 'missing_tool'
    user_message = "Required tool not installed (ffmpeg)"

elif 'permission' in error_str or 'denied' in error_str:
    category = 'permission'
    user_message = "Permission denied"

else:
    category = 'unsupported'
    user_message = str(exif_error)
```

**Categories:**
- ✅ **timeout** - File too large or storage too slow
- ✅ **duplicate** - Hash collision detected during rehash after EXIF write
- ✅ **corrupted** - File is damaged or invalid format
- ✅ **missing_tool** - exiftool or ffmpeg not installed
- ✅ **permission** - Access denied
- ✅ **unsupported** - Catch-all for other errors

---

### 4. Hash Rehashing After EXIF Write

```python
# After EXIF write, rehash file (content changed)
sha256 = hashlib.sha256()
with open(target_path, 'rb') as f:
    while chunk := f.read(1024 * 1024):
        sha256.update(chunk)
new_hash = sha256.hexdigest()

if new_hash != content_hash:
    print(f"Hash changed: {content_hash[:8]} → {new_hash[:8]}")
    
    # Delete old thumbnail (if exists)
    old_thumb_path = os.path.join(THUMBNAIL_CACHE_DIR, content_hash[:2], ...)
    if os.path.exists(old_thumb_path):
        os.remove(old_thumb_path)
    
    # Update database with new hash
    cursor.execute("UPDATE photos SET content_hash = ? WHERE id = ?", (new_hash, photo_id))
    conn.commit()
```

**Protection:**
- ✅ **Detects content change** - EXIF write changes file bytes
- ✅ **Updates hash in DB** - Maintains duplicate detection accuracy
- ✅ **Cleans up old thumbnail** - Prevents orphaned cache entries
- ✅ **Handles hash collision** - If new hash already exists, UNIQUE constraint triggers → rollback

---

### 5. Special Format Handling

**HEIC/HEIF:**
```python
from pillow_heif import register_heif_opener
register_heif_opener()  # Enables PIL to open HEIC files
```

**Protection:**
- ✅ **Supported for reading** - Can extract EXIF and generate thumbnails
- ✅ **Converted on serve** - HEIC/TIF converted to JPEG when serving to browser
- ⚠️ **EXIF write untested** - exiftool should handle, but may have edge cases

**RAW Formats (.raw, .cr2, .nef, .arw, .dng):**
```python
PHOTO_EXTENSIONS = {
    '.raw', '.cr2', '.nef', '.arw', '.dng'
}
```

**Protection:**
- ✅ **Recognized as photos** - Won't be rejected as unsupported
- ⚠️ **EXIF write risky** - RAW formats are manufacturer-specific and fragile
- ⚠️ **Recommendation:** Move RAW files to `.trash/raw_unsupported/` during terraform
  - Reason: Writing EXIF to RAW can corrupt the file
  - Alternative: Only terraform the sidecar JPG, leave RAW untouched

**TIF/TIFF:**
```python
# Converted to JPEG when serving to browser
if ext in ['.heic', '.heif', '.tif', '.tiff']:
    img = Image.open(full_path)
    if img.mode != 'RGB':
        img = img.convert('RGB')
    # Save as JPEG to memory buffer
```

**Protection:**
- ✅ **Supported for reading**
- ✅ **Converted for display**
- ⚠️ **EXIF write** - Should work, but TIF files are large (timeout risk)

---

## Additional Protections Needed for Terraform

### 1. Pre-flight Checks (Before Starting)

**Verify tools installed:**
```python
def check_required_tools():
    """Verify exiftool and ffmpeg are installed"""
    try:
        subprocess.run(['exiftool', '-ver'], capture_output=True, timeout=5)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        raise Exception("exiftool not found. Install with: brew install exiftool")
    
    try:
        subprocess.run(['ffmpeg', '-version'], capture_output=True, timeout=5)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        raise Exception("ffmpeg not found. Install with: brew install ffmpeg")
```

**Check disk space:**
```python
def check_disk_space(library_path):
    """Ensure at least 10% free space"""
    stat = os.statvfs(library_path)
    free_bytes = stat.f_bavail * stat.f_frsize
    total_bytes = stat.f_blocks * stat.f_frsize
    free_percent = (free_bytes / total_bytes) * 100
    
    if free_percent < 10:
        raise Exception(f"Low disk space: {free_percent:.1f}% free. Need at least 10%.")
```

**Check write permissions:**
```python
def check_write_permissions(library_path):
    """Verify we can write to library folder"""
    test_file = os.path.join(library_path, '.terraform_write_test')
    try:
        with open(test_file, 'w') as f:
            f.write('test')
        os.remove(test_file)
    except (PermissionError, OSError) as e:
        raise Exception(f"Cannot write to library folder: {e}")
```

**Detect if library is in use:**
```python
def check_library_lock(library_path):
    """Check if another terraform or rebuild is running"""
    lock_file = os.path.join(library_path, '.terraform.lock')
    if os.path.exists(lock_file):
        # Check if process is still alive (read PID from lock file)
        try:
            with open(lock_file, 'r') as f:
                pid = int(f.read().strip())
            # Check if PID exists
            os.kill(pid, 0)  # Doesn't kill, just checks existence
            raise Exception("Another terraform operation is running")
        except (ProcessLookupError, ValueError):
            # Process dead or invalid PID, safe to remove lock
            os.remove(lock_file)
```

---

### 2. Manifest Logging (Write-Ahead Log)

**Log format:**
```python
# Append-only log file: .logs/terraform_YYYYMMDD_HHMMSS.jsonl
def log_terraform_event(log_file, event_type, details):
    """Append event to manifest log"""
    entry = {
        'timestamp': datetime.now().isoformat(),
        'event': event_type,
        **details
    }
    with open(log_file, 'a') as f:
        f.write(json.dumps(entry) + '\n')

# Event types:
# START: {"event": "start", "total_files": 1234}
# PROCESSING: {"event": "processing", "file": "/path/to/file.jpg"}
# SUCCESS: {"event": "success", "original": "/old/path", "new": "/new/path", "hash": "abc123"}
# FAILED: {"event": "failed", "file": "/path", "reason": "EXIF write failed", "category": "corrupted"}
# COMPLETE: {"event": "complete", "processed": 1200, "duplicates": 25, "errors": 9}
```

**Benefits:**
- ✅ **Crash recovery** - Log survives crashes, can see what was processed
- ✅ **Audit trail** - Complete record of all operations
- ✅ **Debugging** - Can reproduce issues from log
- ✅ **Future rollback** - Log contains enough info to reverse operations (except EXIF changes)

---

### 3. Terraform-Specific Error Handling

**Move vs Copy:**
```python
# Terraform uses MOVE (not copy) - different failure modes
try:
    shutil.move(source_path, target_path)
except OSError as e:
    if e.errno == errno.EXDEV:
        # Cross-device move - need to copy + delete
        shutil.copy2(source_path, target_path)
        os.remove(source_path)
    elif e.errno == errno.ENOENT:
        # Source disappeared - log and continue
        log_terraform_event(log_file, 'failed', {
            'file': source_path,
            'reason': 'File not found (may have been deleted)',
            'category': 'missing'
        })
    else:
        raise
```

**Symlink handling:**
```python
def should_process_file(file_path):
    """Skip symlinks to avoid moving files outside library"""
    if os.path.islink(file_path):
        print(f"⚠️  Skipping symlink: {file_path}")
        return False
    return True
```

**Hard link detection:**
```python
def check_hard_links(file_path):
    """Warn if file has multiple hard links (same inode)"""
    stat_info = os.stat(file_path)
    if stat_info.st_nlink > 1:
        print(f"⚠️  File has {stat_info.st_nlink} hard links: {file_path}")
        # Decision: Process anyway? Skip? Let user decide?
```

---

### 4. RAW File Handling Decision

**Option A: Skip RAW files entirely**
```python
RAW_EXTENSIONS = {'.raw', '.cr2', '.nef', '.arw', '.dng'}

if ext.lower() in RAW_EXTENSIONS:
    # Move to .trash/raw_skipped/ with explanation
    trash_path = os.path.join(library_path, '.trash', 'raw_skipped', filename)
    shutil.move(source_path, trash_path)
    log_terraform_event(log_file, 'skipped', {
        'file': source_path,
        'reason': 'RAW format - EXIF write too risky',
        'category': 'raw_skipped'
    })
    continue
```

**Option B: Try RAW, but expect failures**
```python
if ext.lower() in RAW_EXTENSIONS:
    # Warn in log, attempt EXIF write
    print(f"⚠️  Processing RAW file (risky): {filename}")
    try:
        write_photo_exif(file_path, date_taken)
    except Exception as e:
        # Expected - move to trash
        trash_path = os.path.join(library_path, '.trash', 'raw_failed', filename)
        shutil.move(source_path, trash_path)
        continue
```

**Recommendation:** **Option A** (skip RAW files)
- RAW formats are proprietary and fragile
- Writing EXIF can corrupt manufacturer-specific data
- Better to skip and let user handle separately
- Can still show count: "Skipped 45 RAW files (too risky)"

---

### 5. Live Photos / Photo Pairs

**Problem:** iOS Live Photos are .jpg + .mov pairs with related filenames
- Example: `IMG_1234.jpg` + `IMG_1234.mov`
- No metadata links them together
- Terraform will separate them (different hashes → different dates possibly)

**Detection:**
```python
def find_live_photo_pairs(files):
    """Find .jpg + .mov pairs with same base name"""
    pairs = []
    by_basename = {}
    
    for file in files:
        base, ext = os.path.splitext(file)
        if base not in by_basename:
            by_basename[base] = []
        by_basename[base].append((file, ext))
    
    for base, group in by_basename.items():
        if len(group) == 2:
            exts = [ext for _, ext in group]
            if '.jpg' in exts and '.mov' in exts:
                pairs.append(group)
    
    return pairs
```

**Options:**
- **Option A:** Treat separately (current behavior)
- **Option B:** Warn user about Live Photo pairs being separated
- **Option C:** Keep pairs together (complex - need linking in DB)

**Recommendation:** **Option B** (warn user)
- Too complex to link in DB right now
- User can manually identify pairs later if needed
- Show warning: "Found 12 potential Live Photo pairs - these will be separated"

---

## Terraform Safety Protocol (Recommended)

### Phase 0: Pre-flight Checks
```python
1. Check exiftool installed
2. Check ffmpeg installed
3. Check disk space (>10% free)
4. Check write permissions
5. Check for active terraform lock
6. Scan for symlinks (warn user)
7. Count RAW files (warn user they'll be skipped)
8. Count Live Photo pairs (warn user they'll be separated)
9. Show confirmation dialog with all warnings
```

### Phase 1: Process Files
```python
For each file:
    1. Check if symlink → skip
    2. Check if RAW → move to .trash/raw_skipped/
    3. Compute original hash
    4. Check for duplicate in DB → move to .trash/duplicates/
    5. Extract EXIF date (or use mtime)
    6. Check video format support → if unsupported, move to .trash/unsupported_video/
    7. Get dimensions
    8. Generate canonical filename
    9. Create target folder
    10. Write EXIF to original file (IN PLACE)
    11. Verify file still opens
    12. Compute new hash
    13. Move file to target location
    14. Insert DB record
    15. Log success
    
    On any error:
        - Log failure with category
        - Move file to appropriate .trash/ subfolder
        - Continue to next file
```

### Phase 2: Cleanup
```python
1. Remove empty folders (recursive)
2. Create hidden folder structure
3. Write final manifest summary
4. Remove terraform lock
```

---

## Risk Assessment

### Low Risk (Well Protected)
- ✅ Duplicate detection (robust hashing)
- ✅ EXIF write for photos (verified read-back)
- ✅ EXIF write for supported videos (temp file pattern)
- ✅ Atomic per-file operations (rollback on failure)
- ✅ Error categorization (comprehensive)
- ✅ Timeout protection (30s photos, 60s videos)

### Medium Risk (Mitigated)
- ⚠️ Unsupported video formats → Pre-flight check rejects them
- ⚠️ Corrupted files → Detected during EXIF write, moved to trash
- ⚠️ Permission errors → Pre-flight check + per-file handling
- ⚠️ Disk space → Pre-flight check
- ⚠️ Cross-device moves → Handled with copy + delete fallback

### High Risk (Needs User Awareness)
- ⚠️ **RAW files** → Skip entirely (too risky to write EXIF)
- ⚠️ **Live Photo pairs** → Will be separated (warn user)
- ⚠️ **HEIC/TIF EXIF writes** → Less tested, may have edge cases
- ⚠️ **No rollback of EXIF changes** → EXIF writes are permanent
- ⚠️ **Original filenames lost** → Saved in DB, but if DB corrupts, gone forever

---

## Warning Dialog (Final Version)

```
┌─────────────────────────────────────────────────┐
│  Terraform folder into library?                  │
│                                                  │
│  Found: 1,234 photos, 156 videos, 45 RAW files  │
│                                                  │
│  This will reorganize files in place:            │
│  ✓ Write EXIF metadata to all files              │
│  ✓ Rename to standard format                     │
│  ✓ Organize into YYYY/YYYY-MM-DD folders         │
│  ✓ Move duplicates to .trash/                    │
│  ✓ Skip RAW files (too risky - see .trash/)      │
│                                                  │
│  ⚠️  WARNING: This modifies files permanently.   │
│  EXIF changes cannot be undone.                  │
│                                                  │
│  ⚠️  CRITICAL: Make a backup before proceeding!  │
│  Time Machine, copy to external drive, etc.      │
│                                                  │
│  Estimated time: 8-10 minutes                    │
│                                                  │
│  [Cancel]  [Create New Library]  [I Have Backup]│
└─────────────────────────────────────────────────┘
```

Key changes:
- Show file counts including RAW
- Explicit "I Have Backup" button (not just "Terraform")
- List what will be skipped
- Clear permanent warning

---

## Summary

**Existing protections from import are EXCELLENT:**
- EXIF write verification
- Temp file patterns for videos
- Format pre-checks
- Atomic rollback
- Comprehensive error categorization
- Hash rehashing after EXIF write

**Additional needs for terraform:**
- Pre-flight checks (tools, space, permissions, locks)
- Manifest logging (write-ahead log pattern)
- RAW file handling (skip them)
- Live Photo warning
- Cross-device move handling
- Symlink detection

**Risk level: MEDIUM**
- Most risks are well-mitigated
- High-risk operations (RAW, HEIC) can be skipped or warned
- User must understand: EXIF writes are permanent, backup required
