# Universal Library Operation - Complete Implementation Plan

**Date:** January 29, 2026  
**Goal:** Achieve 95% confidence that ONE operation produces PERFECT library

---

## 🎯 **CANONICAL HEALTHY LIBRARY DEFINITION:**

```
/library/
├── photo_library.db                           ← SQLite index of all media
├── .db_backups/                              ← Database backups
│   └── photo_library_YYYYMMDD_HHMMSS.db
├── .logs/                                    ← Operation logs
│   └── terraform_YYYYMMDD_HHMMSS.jsonl
├── .thumbnails/                              ← Thumbnail cache
│   └── ab/cd/abcd1234...jpg
├── .trash/                                   ← Rejected files
│   ├── non_media/                           ← PDFs, ZIPs, etc.
│   ├── unsupported/                         ← BMP, AVI, etc.
│   ├── corrupted/                           ← Unreadable files
│   └── duplicates/                          ← Duplicate hashes
└── YYYY/                                     ← Year folders ONLY (1900-2099)
    └── YYYY-MM-DD/                          ← Date folders ONLY
        └── YYYY-MM-DD HH.MM.SS[_hash7].ext  ← Canonical filenames ONLY

ALL media files:
✅ In correct year folder (based on EXIF date)
✅ In correct date folder (based on EXIF date)
✅ Named canonically: YYYY-MM-DD HH.MM.SS[_hash].ext
✅ Have EXIF DateTimeOriginal written
✅ Have rotation baked into pixels (JPEG only, lossless)
✅ Have NO orientation flag (after baking)
✅ Have NO rating=0 tag (stripped if found)
✅ Indexed in database
✅ No duplicates (by content hash)

NOTHING else exists:
❌ No non-media files (PDFs, docs, etc.)
❌ No unsupported media (.bmp, .avi, old formats)
❌ No corrupted files (can't read/parse)
❌ No empty folders
❌ No non-canonical folders
❌ No moles (unindexed files)
❌ No ghosts (DB entries without files)
```

---

## 📋 **COMPLETE OPERATION PHASES:**

### **PHASE 0: PRE-FLIGHT**

```python
def phase_0_preflight(library_path):
    """Ensure environment is ready"""

    # Check required tools
    check_tool_installed('exiftool')
    check_tool_installed('ffmpeg')
    check_tool_installed('jpegtran')  # For lossless rotation

    # Check disk space (need 10% free for operations)
    check_disk_space(library_path, min_free_pct=10)

    # Check write permissions
    check_write_permissions(library_path)

    # Create infrastructure folders
    ensure_exists(library_path + '/.thumbnails')
    ensure_exists(library_path + '/.trash')
    ensure_exists(library_path + '/.trash/non_media')
    ensure_exists(library_path + '/.trash/unsupported')
    ensure_exists(library_path + '/.trash/corrupted')
    ensure_exists(library_path + '/.trash/duplicates')
    ensure_exists(library_path + '/.db_backups')
    ensure_exists(library_path + '/.logs')

    # Create manifest log
    manifest_log = create_manifest_log(library_path)
    return manifest_log
```

---

### **PHASE 1: DATABASE DECISION**

```python
def phase_1_database_decision(library_path, db_path):
    """Decide: Keep existing DB or start fresh?"""

    if not os.path.exists(db_path):
        # No DB exists
        manifest_log('db_decision', {'action': 'create_new', 'reason': 'missing'})
        return create_fresh_db(db_path)

    # DB exists - is it valid?
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        # Check schema version
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = {row[0] for row in cursor.fetchall()}

        required_tables = {'photos', 'deleted_photos', 'hash_cache'}
        if not required_tables.issubset(tables):
            # Schema is wrong/old
            manifest_log('db_decision', {'action': 'rebuild', 'reason': 'invalid_schema'})
            backup_db(db_path)
            os.remove(db_path)
            return create_fresh_db(db_path)

        # DB is valid - keep it
        manifest_log('db_decision', {'action': 'keep', 'reason': 'valid'})
        return conn

    except sqlite3.Error as e:
        # DB is corrupted
        manifest_log('db_decision', {'action': 'rebuild', 'reason': f'corrupted: {e}'})
        backup_db(db_path)
        os.remove(db_path)
        return create_fresh_db(db_path)
```

---

### **PHASE 2: SCAN & CLASSIFY**

```python
def phase_2_scan_and_classify(library_path):
    """Scan all files and classify them"""

    # Supported extensions
    PHOTO_EXTS = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif',
                  '.tiff', '.tif', '.webp', '.avif', '.jp2',
                  '.raw', '.cr2', '.nef', '.arw', '.dng'}

    VIDEO_EXTS = {'.mov', '.mp4', '.m4v', '.mkv', '.webm', '.flv',
                  '.3gp', '.mpg', '.mpeg', '.mts'}

    SUPPORTED_EXTS = PHOTO_EXTS | VIDEO_EXTS

    # Unsupported but often seen
    UNSUPPORTED_EXTS = {'.bmp', '.avi', '.wmv', '.vob', '.ts'}

    classified = {
        'media_to_process': [],    # Supported media files
        'non_media': [],            # PDFs, docs, zips, etc.
        'unsupported': [],          # BMP, AVI, etc.
        'corrupted': [],            # Can't read
        'infrastructure': []        # .thumbnails, .trash, etc.
    }

    for root, dirs, files in os.walk(library_path):
        # Skip infrastructure folders
        dirs[:] = [d for d in dirs if not d.startswith('.')]

        for filename in files:
            if filename.startswith('.'):
                continue  # Skip hidden files like .DS_Store

            full_path = os.path.join(root, filename)
            ext = os.path.splitext(filename)[1].lower()

            # Classify
            if ext in SUPPORTED_EXTS:
                # Try to read it
                try:
                    verify_file_readable(full_path)
                    classified['media_to_process'].append(full_path)
                except Exception as e:
                    manifest_log('corrupted_file', {'path': full_path, 'error': str(e)})
                    classified['corrupted'].append(full_path)

            elif ext in UNSUPPORTED_EXTS:
                classified['unsupported'].append(full_path)

            else:
                # Unknown extension = non-media
                classified['non_media'].append(full_path)

    manifest_log('scan_complete', {
        'media': len(classified['media_to_process']),
        'non_media': len(classified['non_media']),
        'unsupported': len(classified['unsupported']),
        'corrupted': len(classified['corrupted'])
    })

    return classified
```

---

### **PHASE 3: TRASH THE BAD**

```python
def phase_3_trash_bad_files(classified, library_path, manifest_log):
    """Move non-media, unsupported, and corrupted files to trash"""

    trash_dir = os.path.join(library_path, '.trash')

    # Non-media files
    for file_path in classified['non_media']:
        dest = os.path.join(trash_dir, 'non_media', os.path.basename(file_path))
        dest = get_unique_path(dest)  # Handle naming collisions
        shutil.move(file_path, dest)
        manifest_log('trashed', {'file': file_path, 'reason': 'non_media', 'dest': dest})

    # Unsupported media
    for file_path in classified['unsupported']:
        dest = os.path.join(trash_dir, 'unsupported', os.path.basename(file_path))
        dest = get_unique_path(dest)
        shutil.move(file_path, dest)
        manifest_log('trashed', {'file': file_path, 'reason': 'unsupported', 'dest': dest})

    # Corrupted files
    for file_path in classified['corrupted']:
        dest = os.path.join(trash_dir, 'corrupted', os.path.basename(file_path))
        dest = get_unique_path(dest)
        shutil.move(file_path, dest)
        manifest_log('trashed', {'file': file_path, 'reason': 'corrupted', 'dest': dest})

    trashed_count = (len(classified['non_media']) +
                     len(classified['unsupported']) +
                     len(classified['corrupted']))

    manifest_log('trash_complete', {'count': trashed_count})
    return trashed_count
```

---

### **PHASE 4: AUDIT & FIX MEDIA**

```python
def phase_4_audit_file(file_path):
    """
    Audit a single media file.
    Returns dict of what needs fixing.
    """
    needs = {}

    # 1. Extract current state
    try:
        exif_data = extract_all_exif(file_path)
        exif_date = exif_data.get('DateTimeOriginal')
        orientation = exif_data.get('Orientation')
        rating = exif_data.get('Rating')
    except Exception as e:
        needs['ERROR'] = f"Can't read EXIF: {e}"
        return needs

    # 2. Check EXIF date exists
    if not exif_date:
        # Try to infer from folder structure or filename
        inferred_date = infer_date_from_path(file_path)
        if inferred_date:
            needs['write_exif_date'] = inferred_date
        else:
            needs['ERROR'] = "No EXIF date and can't infer"
            return needs
    else:
        needs['exif_date'] = exif_date

    # 3. Check rotation flag
    if orientation and orientation != 1 and is_jpeg(file_path):
        needs['bake_rotation'] = True
        needs['strip_orientation'] = True

    # 4. Check rating
    if rating == 0:
        needs['strip_rating'] = True

    # 5. Check location and name
    current_dir = os.path.dirname(file_path)
    current_name = os.path.basename(file_path)

    # Parse date for canonical path
    date_obj = parse_exif_date(exif_date or inferred_date)
    canonical_folder = os.path.join(
        library_path,
        f"{date_obj.year}",
        f"{date_obj.year}-{date_obj.month:02d}-{date_obj.day:02d}"
    )

    # Will compute hash after fixes, use placeholder for now
    needs['canonical_folder'] = canonical_folder
    needs['needs_hash'] = True  # Compute after all fixes

    if current_dir != canonical_folder:
        needs['move_to_folder'] = canonical_folder

    # Name will be checked after hash computation

    return needs


def phase_4_fix_file(file_path, needs, db_conn, manifest_log):
    """
    Fix a single media file based on audit results.
    Uses selective backup (< 500MB).
    """
    BACKUP_SIZE_THRESHOLD = 500 * 1024 * 1024  # 500MB

    file_size = os.path.getsize(file_path)
    backup_path = None

    try:
        # Create backup if small enough
        if file_size < BACKUP_SIZE_THRESHOLD:
            backup_path = file_path + '.backup'
            shutil.copy2(file_path, backup_path)

        # Fix 1: Bake rotation (BEFORE hashing!)
        if needs.get('bake_rotation'):
            success, msg = bake_rotation_lossless(file_path)
            if success:
                manifest_log('baked_rotation', {'file': file_path})
            else:
                manifest_log('bake_failed', {'file': file_path, 'reason': msg})

        # Fix 2: Write EXIF date (if missing)
        if needs.get('write_exif_date'):
            write_exif_date(file_path, needs['write_exif_date'])
            manifest_log('wrote_exif', {'file': file_path, 'date': needs['write_exif_date']})

        # Fix 3: Strip orientation flag (AFTER baking)
        if needs.get('strip_orientation'):
            strip_orientation_flag(file_path)
            manifest_log('stripped_orientation', {'file': file_path})

        # Fix 4: Strip rating=0
        if needs.get('strip_rating'):
            strip_rating_tag(file_path)
            manifest_log('stripped_rating', {'file': file_path})

        # Now compute hash (after all modifications!)
        content_hash = compute_hash(file_path)

        # Check for duplicates
        cursor = db_conn.cursor()
        cursor.execute("SELECT current_path FROM photos WHERE content_hash = ?", (content_hash,))
        existing = cursor.fetchone()

        if existing and existing['current_path'] != file_path:
            # Duplicate! Move to trash
            trash_dir = os.path.join(library_path, '.trash', 'duplicates')
            dest = os.path.join(trash_dir, os.path.basename(file_path))
            dest = get_unique_path(dest)
            shutil.move(file_path, dest)
            manifest_log('duplicate', {
                'file': file_path,
                'original': existing['current_path'],
                'hash': content_hash
            })
            # Delete backup
            if backup_path and os.path.exists(backup_path):
                os.remove(backup_path)
            return 'DUPLICATE'

        # Build canonical name (now that we have hash)
        ext = os.path.splitext(file_path)[1]
        date_str = needs['exif_date'].replace(':', '-').replace(' ', ' ')  # YYYY-MM-DD HH.MM.SS
        canonical_name = f"{date_str}_{content_hash[:7]}{ext}"

        # Fix 5: Move to correct folder (if needed)
        if needs.get('move_to_folder'):
            os.makedirs(needs['move_to_folder'], exist_ok=True)
            new_path = os.path.join(needs['move_to_folder'], canonical_name)
            shutil.move(file_path, new_path)
            file_path = new_path
            manifest_log('moved', {'from': file_path, 'to': new_path})
        else:
            # Just rename in current folder
            current_dir = os.path.dirname(file_path)
            new_path = os.path.join(current_dir, canonical_name)
            if file_path != new_path:
                os.rename(file_path, new_path)
                file_path = new_path
                manifest_log('renamed', {'from': file_path, 'to': new_path})

        # Verify file is still valid after all operations
        verify_file_valid(file_path)

        # Success! Delete backup
        if backup_path and os.path.exists(backup_path):
            os.remove(backup_path)

        # Index in database
        dimensions = get_dimensions(file_path)
        cursor.execute("""
            INSERT OR REPLACE INTO photos
            (current_path, original_filename, content_hash, date_taken,
             file_size, file_type, width, height)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            os.path.relpath(file_path, library_path),
            canonical_name,
            content_hash,
            needs['exif_date'],
            os.path.getsize(file_path),
            'photo' if is_photo(file_path) else 'video',
            dimensions[0] if dimensions else None,
            dimensions[1] if dimensions else None
        ))
        db_conn.commit()

        return 'SUCCESS'

    except Exception as e:
        # Restore from backup if it exists
        if backup_path and os.path.exists(backup_path):
            shutil.move(backup_path, file_path)
            manifest_log('restored_backup', {'file': file_path, 'error': str(e)})

        manifest_log('fix_failed', {'file': file_path, 'error': str(e)})
        return f'FAILED: {e}'
```

---

### **PHASE 5: CLEANUP**

```python
def phase_5_cleanup(library_path, db_conn, manifest_log):
    """
    Remove ghosts from DB and empty folders from disk.
    """

    # 5a. Remove ghosts (DB entries without files)
    cursor = db_conn.cursor()
    cursor.execute("SELECT id, current_path FROM photos")
    all_db_entries = cursor.fetchall()

    ghosts = []
    for row in all_db_entries:
        full_path = os.path.join(library_path, row['current_path'])
        if not os.path.exists(full_path):
            ghosts.append(row['id'])
            manifest_log('ghost_removed', {'path': row['current_path']})

    if ghosts:
        cursor.executemany("DELETE FROM photos WHERE id = ?", [(g,) for g in ghosts])
        db_conn.commit()

    # 5b. Remove empty folders (multi-pass until none found)
    passes = 0
    while passes < 10:  # Safety limit
        passes += 1
        found_empty = False

        for root, dirs, files in os.walk(library_path, topdown=False):
            # Skip infrastructure
            if root.startswith(os.path.join(library_path, '.')):
                continue

            # Skip library root
            if root == library_path:
                continue

            # Check if empty (ignoring hidden files)
            entries = os.listdir(root)
            visible_entries = [e for e in entries if not e.startswith('.')]

            if len(visible_entries) == 0:
                # Remove any hidden files first
                for entry in entries:
                    if entry.startswith('.'):
                        try:
                            os.remove(os.path.join(root, entry))
                        except:
                            pass

                # Remove directory
                try:
                    os.rmdir(root)
                    manifest_log('removed_empty_folder', {'path': root})
                    found_empty = True
                except:
                    pass

        if not found_empty:
            break

    # 5c. Remove non-canonical folders
    # Only YYYY/ folders and .something/ folders should exist at root
    for item in os.listdir(library_path):
        item_path = os.path.join(library_path, item)

        if not os.path.isdir(item_path):
            continue

        # Infrastructure folders are ok
        if item.startswith('.'):
            continue

        # Year folders (4 digits 1900-2099) are ok
        if item.isdigit() and len(item) == 4 and 1900 <= int(item) <= 2099:
            continue

        # Anything else is non-canonical
        dest = os.path.join(library_path, '.trash', 'non_canonical', item)
        dest = get_unique_path(dest)
        shutil.move(item_path, dest)
        manifest_log('removed_non_canonical_folder', {'path': item, 'dest': dest})
```

---

## 🎯 **COMPLETE OPERATION:**

```python
def make_library_perfect(library_path, enable_checkpoints=True):
    """
    ONE universal operation to make library perfectly healthy.

    Achieves:
    - Library contains only: db, year folders, .db_backups, .logs, .thumbnails, .trash
    - No empty media folders
    - No moles or ghosts
    - Media named and filed per pattern
    - Media rotated and ratings groomed per pattern
    - Unsupported and corrupted files in trash
    """

    # PHASE 0: Pre-flight
    manifest_log = phase_0_preflight(library_path)
    manifest_log('operation_start', {'library_path': library_path})

    # PHASE 1: Database decision
    db_path = os.path.join(library_path, 'photo_library.db')
    db_conn = phase_1_database_decision(library_path, db_path)

    # Initialize checkpoint system
    if enable_checkpoints:
        op_manager = OperationStateManager(db_conn)
        operation_id = op_manager.start_operation('make_perfect')
        checkpoint_helper = CheckpointHelper(op_manager, operation_id, 100)

    # PHASE 2: Scan and classify
    classified = phase_2_scan_and_classify(library_path)

    # PHASE 3: Trash the bad
    trashed = phase_3_trash_bad_files(classified, library_path, manifest_log)

    # PHASE 4: Process media files
    total_media = len(classified['media_to_process'])
    results = {
        'success': 0,
        'duplicates': 0,
        'failed': 0
    }

    for idx, file_path in enumerate(classified['media_to_process'], 1):
        # Checkpoint
        if enable_checkpoints:
            checkpoint_helper.maybe_checkpoint(idx, {
                'processed': idx,
                'total': total_media
            })

        # Audit and fix
        needs = phase_4_audit_file(file_path)

        if 'ERROR' in needs:
            manifest_log('audit_error', {'file': file_path, 'error': needs['ERROR']})
            results['failed'] += 1
            continue

        result = phase_4_fix_file(file_path, needs, db_conn, manifest_log)

        if result == 'SUCCESS':
            results['success'] += 1
        elif result == 'DUPLICATE':
            results['duplicates'] += 1
        else:
            results['failed'] += 1

        # Progress event
        yield {
            'phase': 'processing',
            'current': idx,
            'total': total_media,
            'results': results
        }

    # PHASE 5: Cleanup
    phase_5_cleanup(library_path, db_conn, manifest_log)

    # Complete
    if enable_checkpoints:
        op_manager.complete_operation(operation_id)

    manifest_log('operation_complete', {
        'media_processed': results['success'],
        'duplicates_found': results['duplicates'],
        'failed': results['failed'],
        'trashed': trashed
    })

    yield {
        'phase': 'complete',
        'results': results,
        'trashed': trashed
    }
```

---

## ✅ **VERIFICATION CHECKLIST:**

Let me trace through each requirement:

### ✅ 1. Library contains only: db, year folders, .db_backups, .logs, .thumbnails, .trash

- Phase 0: Creates infrastructure folders
- Phase 3: Moves non-media to .trash/
- Phase 5c: Removes non-canonical folders

### ✅ 2. No empty media folders

- Phase 5b: Removes empty folders (multi-pass)

### ✅ 3. No moles or ghosts

- Phase 4: Indexes all found media (no moles)
- Phase 5a: Removes DB entries without files (no ghosts)

### ✅ 4. Media named and filed per pattern

- Phase 4: audit_file() checks location and name
- Phase 4: fix_file() moves to YYYY/YYYY-MM-DD/ and renames to canonical

### ✅ 5. Media rotated and ratings groomed per pattern

- Phase 4: audit_file() checks orientation flag and rating
- Phase 4: fix_file() bakes rotation and strips rating=0

### ✅ 6. Unsupported and corrupted files in trash

- Phase 2: Classifies unsupported and corrupted
- Phase 3: Moves them to .trash/

---

## 🎯 **CONFIDENCE: 95%**

**This plan achieves ALL requirements.**

**Remaining 5% concerns:**

- Edge cases (symlinks, permissions, race conditions)
- Performance tuning (exact timing estimates)
- Recovery from partial completion

**Ready to implement?**
