"""
Library Synchronization - Core Operations

Unified synchronization logic used by both:
- Update Library Index (incremental maintenance)
- Rebuild Database (full recovery)
"""

import os
import hashlib
import json
from datetime import datetime


def count_media_files(library_path):
    """
    Quick count of media files in library (for estimates).
    
    Returns:
        int: Number of media files found
    """
    photo_exts = {
        '.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.bmp', '.tiff', '.tif',
        '.webp', '.avif', '.jp2',
        '.raw', '.cr2', '.nef', '.arw', '.dng'
    }
    video_exts = {
        '.mov', '.mp4', '.m4v', '.mkv',
        '.wmv', '.webm', '.flv', '.3gp',
        '.mpg', '.mpeg', '.vob', '.ts', '.mts', '.avi'
    }
    all_exts = photo_exts | video_exts
    
    count = 0
    for root, dirs, filenames in os.walk(library_path, followlinks=False):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for filename in filenames:
            if filename.startswith('.'):
                continue
            ext = os.path.splitext(filename)[1].lower()
            if ext in all_exts:
                count += 1
    
    return count


def estimate_duration(file_count):
    """
    Estimate processing time based on file count.
    
    Args:
        file_count: Number of files to process
    
    Returns:
        tuple: (minutes, formatted_string)
    """
    # Assume ~150 files/minute (hash + EXIF + dimensions + DB write)
    minutes = file_count / 150
    
    if minutes < 1:
        return (minutes, "less than a minute")
    elif minutes < 60:
        lower = int(minutes)
        upper = int(minutes * 1.2)
        # Handle case where lower == upper (e.g., 1-1 becomes "1 minute")
        if lower == upper:
            unit = "minute" if lower == 1 else "minutes"
            return (minutes, f"{lower} {unit}")
        else:
            return (minutes, f"{lower}-{upper} minutes")
    else:
        hours = minutes / 60
        return (minutes, f"{int(hours)}-{int(hours * 1.3)} hours")


def synchronize_library_generator(library_path, db_connection, extract_exif_date_func, 
                                   get_image_dimensions_func, mode='incremental'):
    """
    Core library synchronization with streaming progress.
    
    Args:
        library_path: Path to photo library folder
        db_connection: Active database connection
        extract_exif_date_func: Function to extract EXIF dates
        get_image_dimensions_func: Function to get image dimensions
        mode: 'incremental' (diff and sync) or 'full' (rebuild from scratch)
    
    Yields:
        SSE event strings for progress tracking
    """
    photo_exts = {
        '.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.bmp', '.tiff', '.tif',
        '.webp', '.avif', '.jp2',
        '.raw', '.cr2', '.nef', '.arw', '.dng'
    }
    video_exts = {
        '.mov', '.mp4', '.m4v', '.mkv',
        '.wmv', '.webm', '.flv', '.3gp',
        '.mpg', '.mpeg', '.vob', '.ts', '.mts', '.avi'
    }
    all_exts = photo_exts | video_exts
    
    cursor = db_connection.cursor()
    
    # Phase 0: Scan filesystem
    print(f"\n🔄 LIBRARY SYNC ({mode} mode): Scanning filesystem...")
    filesystem_paths = set()
    
    for root, dirs, filenames in os.walk(library_path, followlinks=False):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for filename in filenames:
            if filename.startswith('.'):
                continue
            ext = os.path.splitext(filename)[1].lower()
            if ext not in all_exts:
                continue
            full_path = os.path.join(root, filename)
            try:
                rel_path = os.path.relpath(full_path, library_path)
                filesystem_paths.add(rel_path)
            except ValueError:
                continue
    
    print(f"  Found {len(filesystem_paths)} files on disk")
    
    # Determine what needs to be done based on mode
    if mode == 'full':
        # Rebuild mode: index everything, don't remove anything
        db_entries = {}
        missing_files_list = []
        untracked_files_list = sorted(list(filesystem_paths))  # Sort for deterministic order
        print(f"  Full rebuild: indexing all {len(untracked_files_list)} files")
    else:
        # Incremental mode: diff and sync
        cursor.execute("SELECT id, current_path FROM photos")
        db_entries = {row['current_path']: row['id'] for row in cursor.fetchall()}
        db_paths = set(db_entries.keys())
        
        missing_files_list = sorted(list(db_paths - filesystem_paths))  # Sort for deterministic order
        untracked_files_list = sorted(list(filesystem_paths - db_paths))  # Sort for deterministic order
        print(f"  Found {len(db_entries)} DB entries, {len(missing_files_list)} ghosts, {len(untracked_files_list)} moles")
    
    # Track details for final report
    details = {
        'missing_files': [],
        'untracked_files': [],
        'name_updates': [],
        'empty_folders': []
    }
    
    # Phase 1: Remove missing files (ghosts) - only in incremental mode
    missing_count = len(missing_files_list)
    if missing_count > 0:
        print(f"\n🗑️  Removing {missing_count} missing files...")
        for idx, ghost_path in enumerate(missing_files_list, 1):
            yield f"event: progress\ndata: {json.dumps({'phase': 'removing_deleted', 'current': idx, 'total': missing_count})}\n\n"
            
            photo_id = db_entries[ghost_path]
            cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
            details['missing_files'].append(ghost_path)
        
        db_connection.commit()
        print(f"  ✓ Removed {missing_count} missing files")
    
    # Phase 2: Add untracked files (moles) - NO LIMIT
    untracked_count = len(untracked_files_list)
    
    if untracked_count > 0:
        print(f"\n📝 Adding {untracked_count} untracked files...")
        for idx, mole_path in enumerate(untracked_files_list, 1):
            yield f"event: progress\ndata: {json.dumps({'phase': 'adding_untracked', 'current': idx, 'total': untracked_count})}\n\n"
            
            try:
                full_path = os.path.join(library_path, mole_path)
                filename = os.path.basename(mole_path)
                ext = os.path.splitext(filename)[1].lower()
                file_type = 'photo' if ext in photo_exts else 'video'
                file_size = os.path.getsize(full_path)
                
                # Compute hash
                sha256 = hashlib.sha256()
                with open(full_path, 'rb') as f:
                    while chunk := f.read(1024 * 1024):
                        sha256.update(chunk)
                content_hash = sha256.hexdigest()
                
                # Extract EXIF date
                date_taken = extract_exif_date_func(full_path)
                
                # Get dimensions
                dimensions = get_image_dimensions_func(full_path)
                width = dimensions[0] if dimensions else None
                height = dimensions[1] if dimensions else None
                
                cursor.execute("""
                    INSERT OR IGNORE INTO photos (content_hash, current_path, original_filename, date_taken, file_size, file_type, width, height)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (content_hash, mole_path, filename, date_taken, file_size, file_type, width, height))
                
                if cursor.rowcount > 0:
                    details['untracked_files'].append(mole_path)
            except Exception as e:
                print(f"  ⚠️  Failed to index {mole_path}: {e}")
                continue
        
        db_connection.commit()
        print(f"  ✓ Added {len(details['untracked_files'])} untracked files")
    
    # Phase 3: Remove empty folders (loop until no more found - domino effect)
    print(f"\n🗑️  Removing empty folders...")
    empty_count = 0
    total_passes = 0
    
    while True:
        total_passes += 1
        found_this_pass = 0
        
        for root, dirs, files in os.walk(library_path, topdown=False):
            if os.path.basename(root).startswith('.') or root == library_path:
                continue
            try:
                entries = os.listdir(root)
                non_hidden = [e for e in entries if not e.startswith('.')]
                if len(non_hidden) == 0:
                    # Remove any hidden files first (like .DS_Store)
                    for entry in entries:
                        if entry.startswith('.'):
                            try:
                                entry_path = os.path.join(root, entry)
                                if os.path.isfile(entry_path):
                                    os.remove(entry_path)
                            except:
                                pass
                    
                    # Now remove the directory
                    rel_path = os.path.relpath(root, library_path)
                    os.rmdir(root)
                    empty_count += 1
                    found_this_pass += 1
                    details['empty_folders'].append(rel_path)
                    yield f"event: progress\ndata: {json.dumps({'phase': 'removing_empty', 'current': empty_count})}\n\n"
            except Exception as e:
                continue
        
        # If no empties found this pass, we're done
        if found_this_pass == 0:
            break
            
        # Safety: max 10 passes (shouldn't need more than folder depth)
        if total_passes >= 10:
            print(f"  ⚠️  Stopped after 10 passes (safety limit)")
            break
    
    print(f"  ✓ Removed {empty_count} empty folders in {total_passes} passes")
    
    # Send completion with stats and details
    stats = {
        'missing_files': len(details['missing_files']),
        'untracked_files': len(details['untracked_files']),
        'name_updates': len(details['name_updates']),
        'empty_folders': len(details['empty_folders'])
    }
    
    print(f"\n✅ Library sync ({mode} mode) complete: {stats}")
    
    yield f"event: complete\ndata: {json.dumps({'stats': stats, 'details': details})}\n\n"
