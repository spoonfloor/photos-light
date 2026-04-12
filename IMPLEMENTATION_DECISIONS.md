# Universal Library Operation - Implementation Decisions

**Date:** January 29, 2026  
**Status:** Pre-implementation analysis

---

## 📋 **ANSWERS TO CRITICAL QUESTIONS:**

### **1. Backup Overhead Options:**

#### **Option A: Full backup every file**

```python
for file in all_files:
    shutil.copy2(file, file + '.backup')  # 0.1s per file
    modify(file)
    os.remove(file + '.backup')
```

**Cost:** 64,357 files × 0.1s = 1.8 hours overhead
**Pro:** Maximum safety
**Con:** 30% slower

#### **Option B: No backup (current Terraform approach)**

```python
for file in all_files:
    modify(file)  # Hope for the best
```

**Cost:** 0 hours overhead
**Pro:** Fast
**Con:** Corrupted files can't be recovered

#### **Option C: Selective backup (size-based cutoff)**

```python
for file in all_files:
    if file_size < 100MB:
        backup(file)
    modify(file)
    if backup_exists:
        verify_and_delete_backup(file)
```

**Cost:** Most files < 100MB = ~1.5 hour overhead
**Pro:** Balance of safety and speed
**Con:** Large files at risk

#### **Option D: Copy-on-write filesystem features**

```python
# If on APFS/Btrfs: Use CoW snapshots (instant)
create_snapshot(file)
modify(file)
delete_snapshot(file)
```

**Cost:** Near-zero (CoW is instant)
**Pro:** Best of both worlds
**Con:** Requires CoW filesystem, complex

---

### **🎯 RECOMMENDATION #1: Option C (Selective Backup)**

**Reasoning:**

- Files in your library: Mostly 2-10MB (photos), some 5-42MB (videos)
- 100MB cutoff covers 99%+ of files
- Large files are rare, acceptable risk
- Saves ~20% of overhead vs full backup

**Implementation:**

```python
BACKUP_SIZE_THRESHOLD = 100 * 1024 * 1024  # 100MB

def safe_modify_file(file_path, modification_func):
    file_size = os.path.getsize(file_path)

    if file_size < BACKUP_SIZE_THRESHOLD:
        # Small file: Use backup
        backup_path = file_path + '.backup'
        shutil.copy2(file_path, backup_path)

        try:
            modification_func(file_path)
            verify_file(file_path)
            os.remove(backup_path)
        except Exception as e:
            shutil.move(backup_path, file_path)  # Restore
            raise e
    else:
        # Large file: No backup (accept risk)
        log(f"⚠️  Large file {file_size/1024/1024:.1f}MB, modifying without backup")
        modification_func(file_path)
        verify_file(file_path)
```

---

### **2. Orphaned Backup Cleanup:**

#### **🎯 RECOMMENDATION: Auto-cleanup on startup**

```python
def cleanup_orphaned_backups(library_path):
    """
    On app startup: Clean up any .backup files from previous crashes.

    Strategy:
    1. Find all .backup files
    2. If original exists and is valid: Delete backup (operation completed)
    3. If original missing: Restore from backup
    4. If original corrupted: Restore from backup
    """
    backups = glob.glob(f"{library_path}/**/*.backup", recursive=True)

    for backup in backups:
        original = backup.replace('.backup', '')

        if os.path.exists(original):
            # Original exists, check if valid
            if is_valid_file(original):
                # Operation completed, just didn't cleanup backup
                os.remove(backup)
                print(f"  🧹 Cleaned orphaned backup: {backup}")
            else:
                # Original corrupted, restore from backup
                shutil.move(backup, original)
                print(f"  🔄 Restored corrupted file from backup: {original}")
        else:
            # Original missing, restore from backup
            shutil.move(backup, original)
            print(f"  🔄 Restored missing file from backup: {original}")
```

**Call on app startup:**

```python
@app.before_first_request
def startup_cleanup():
    if os.path.exists(LIBRARY_PATH):
        cleanup_orphaned_backups(LIBRARY_PATH)
```

---

### **3. File Verification:**

#### **🎯 RECOMMENDATION: Multi-level verification**

```python
def verify_file(file_path):
    """
    Verify file is not corrupted after modification.

    Levels:
    1. File exists and non-zero size (cheap)
    2. Can open file (cheap)
    3. EXIF is readable (medium, but we need it anyway)
    4. Optional: Hash matches expected (expensive, only if critical)
    """
    # Level 1: Basic checks
    if not os.path.exists(file_path):
        raise VerificationError("File doesn't exist")

    if os.path.getsize(file_path) == 0:
        raise VerificationError("File is empty")

    # Level 2: Can we open it?
    ext = os.path.splitext(file_path)[1].lower()

    if ext in {'.jpg', '.jpeg', '.heic', '.png', '.gif'}:
        # Try to open image
        try:
            from PIL import Image
            with Image.open(file_path) as img:
                img.verify()  # Check if image is valid
        except Exception as e:
            raise VerificationError(f"Image corrupted: {e}")

    elif ext in {'.mov', '.mp4', '.m4v'}:
        # Check if video metadata is readable
        try:
            result = subprocess.run([
                'ffprobe', '-v', 'error',
                '-show_format', file_path
            ], capture_output=True, timeout=5)
            if result.returncode != 0:
                raise VerificationError("Video corrupted")
        except Exception as e:
            raise VerificationError(f"Video corrupted: {e}")

    # Level 3: EXIF readable (we'll need this anyway)
    try:
        exiftool_result = subprocess.run([
            'exiftool', '-j', file_path
        ], capture_output=True, timeout=5, text=True)

        if exiftool_result.returncode != 0:
            raise VerificationError("EXIF not readable")

        json.loads(exiftool_result.stdout)  # Ensure valid JSON

    except Exception as e:
        raise VerificationError(f"EXIF corrupted: {e}")

    return True
```

---

### **4. Large File Cutoff:**

Based on sampling your library:

- **Photos:** 2-10MB typical
- **Videos:** 5-42MB typical
- **Largest seen:** ~42MB

#### **🎯 RECOMMENDATION: 100MB cutoff**

**Rationale:**

- Covers 99%+ of your files (gets backup protection)
- Only extremely rare large files skip backup
- Balance of safety vs performance

**Could also make it configurable:**

```python
# In config or user settings
BACKUP_SIZE_THRESHOLD_MB = 100  # User can adjust
```

---

### **5. UI Text:**

**Keep "Convert This Library" for now.**

Can iterate based on user feedback. Other options if needed:

- "Transform This Library"
- "Prepare This Library"
- "Fix This Library"

---

### **6. Time Estimates:**

Let me check what UI shows currently...

**If UI already has estimates, ensure they're updated for:**

- Scan time: ~60 seconds (always)
- Per-file processing: 0.378s (reading) or 0.720s (writing)
- Backup overhead: +0.1s per file < 100MB

**Estimated durations with backup:**

- Clean Library (500 files need work): 60s + (500 × 0.82s) = 7-8 minutes
- Convert Library (all 64K files): 60s + (64K × 0.82s) = 15 hours

---

## ✅ **FINAL RECOMMENDATIONS:**

1. **Backup:** Use selective (< 100MB cutoff)
2. **Orphaned backups:** Auto-cleanup on startup
3. **Verification:** Multi-level (exists, opens, EXIF readable)
4. **Large file cutoff:** 100MB (configurable)
5. **UI text:** Keep "Convert This Library"
6. **Time estimates:** Update with backup overhead

---

**Confidence: 90%** (ready to implement with these decisions)

**Proceed?**
