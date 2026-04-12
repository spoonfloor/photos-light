"""
Make Library Perfect - Unified Library Operation

This module implements the complete library health operation that:
- Indexes all photos
- Fixes file names and locations
- Bakes rotation (lossless)
- Strips rating=0 tags
- Moves problematic files to trash
- Achieves canonical library health

Based on FINAL_IMPLEMENTATION_SPEC.md
"""

import os
import re
import json
import shutil
import sqlite3
import subprocess
import traceback
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any

# Import existing utilities
from file_operations import (
    extract_exif_date,
    get_dimensions,
    bake_orientation,
    strip_exif_rating,
    get_orientation_flag,
    get_rating_tag
)
from hash_cache import HashCache
from operation_state import OperationStateManager, OperationType


# =====================
# CONSTANTS
# =====================

SUPPORTED_MEDIA_EXTENSIONS = {
    # Photos
    '.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.webp', '.tiff', '.tif',
    '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.pef', '.srw', '.raf',
    
    # Videos
    '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.mpg', '.mpeg', '.mts', '.m2ts'
}

PHOTO_EXTENSIONS = {
    '.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.webp', '.tiff', '.tif',
    '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.pef', '.srw', '.raf'
}

VIDEO_EXTENSIONS = {
    '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.mpg', '.mpeg', '.mts', '.m2ts'
}


# =====================
# HELPER FUNCTIONS
# =====================

def compute_hash(file_path: str) -> str:
    """Compute SHA-256 hash of a file."""
    import hashlib
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()


def is_photo_extension(file_path: str) -> bool:
    """Check if file is a photo."""
    ext = os.path.splitext(file_path)[1].lower()
    return ext in PHOTO_EXTENSIONS


def is_video_extension(file_path: str) -> bool:
    """Check if file is a video."""
    ext = os.path.splitext(file_path)[1].lower()
    return ext in VIDEO_EXTENSIONS


def verify_file_valid(file_path: str) -> bool:
    """Verify file is valid and readable."""
    try:
        ext = os.path.splitext(file_path)[1].lower()
        
        if ext in {'.jpg', '.jpeg'}:
            # Try to open with PIL
            try:
                from PIL import Image
                with Image.open(file_path) as img:
                    img.verify()
                return True
            except:
                return False
        
        elif ext in {'.heic', '.heif'}:
            # Use exiftool to verify
            result = subprocess.run(
                ['exiftool', '-fast', file_path],
                capture_output=True,
                text=True,
                timeout=5
            )
            return result.returncode == 0
        
        elif ext in VIDEO_EXTENSIONS:
            # Use ffprobe to verify
            result = subprocess.run(
                ['ffprobe', '-v', 'error', file_path],
                capture_output=True,
                text=True,
                timeout=5
            )
            return result.returncode == 0
        
        else:
            # Basic check: file exists and has size > 0
            return os.path.getsize(file_path) > 0
    
    except Exception:
        return False


def parse_date_from_filename(filename: str) -> Optional[datetime]:
    """Try to extract date from filename patterns."""
    # Pattern: YYYY-MM-DD HH.MM.SS
    match = re.match(r'^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})', filename)
    if match:
        try:
            year, month, day, hour, minute, second = map(int, match.groups())
            return datetime(year, month, day, hour, minute, second)
        except ValueError:
            pass
    
    # Pattern: YYYYMMDD_HHMMSS
    match = re.match(r'^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})', filename)
    if match:
        try:
            year, month, day, hour, minute, second = map(int, match.groups())
            return datetime(year, month, day, hour, minute, second)
        except ValueError:
            pass
    
    return None


def can_bake_lossless(file_path: str) -> bool:
    """Check if rotation can be baked losslessly."""
    ext = os.path.splitext(file_path)[1].lower()
    return ext in {'.jpg', '.jpeg'}


def is_quick_canonical(full_path: str, filename: str, root: str, library_path: str) -> bool:
    """
    Quick check if file is in canonical location with canonical name.
    Canonical pattern: library/YYYY/YYYY-MM-DD/YYYY-MM-DD HH.MM.SS[_hash].ext
    
    Returns True if file LOOKS canonical (doesn't check EXIF yet)
    """
    # Get path parts
    rel_path = os.path.relpath(root, library_path)
    
    if rel_path == '.':
        return False  # File at root
    
    parts = rel_path.split(os.sep)
    
    # Should be exactly 2 parts: YYYY/YYYY-MM-DD
    if len(parts) != 2:
        return False
    
    year_folder, date_folder = parts
    
    # Year folder must be 4 digits
    if not (year_folder.isdigit() and len(year_folder) == 4):
        return False
    
    # Date folder must be YYYY-MM-DD format
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', date_folder):
        return False
    
    # Year in date folder must match year folder
    if not date_folder.startswith(year_folder):
        return False
    
    # Filename must be YYYY-MM-DD HH.MM.SS[_hash].ext format
    if not re.match(r'^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}(_[a-f0-9]{7})?\.[\w]+$', filename):
        return False
    
    return True


def get_canonical_path(library_path: str, exif_date: datetime, content_hash: str, original_path: str) -> str:
    """
    Get canonical path for a file.
    Pattern: library/YYYY/YYYY-MM-DD/YYYY-MM-DD HH.MM.SS_hash.ext
    """
    ext = os.path.splitext(original_path)[1].lower()
    
    year = exif_date.strftime('%Y')
    date = exif_date.strftime('%Y-%m-%d')
    timestamp = exif_date.strftime('%Y-%m-%d %H.%M.%S')
    
    # Use 7-char hash
    hash_short = content_hash[:7]
    
    filename = f"{timestamp}_{hash_short}{ext}"
    canonical = os.path.join(library_path, year, date, filename)
    
    return canonical


def move_to_trash(file_path: str, library_path: str, category: str, manifest) -> None:
    """
    Move file to appropriate trash folder.
    Categories: non_media, duplicates, unsupported, corrupted
    """
    try:
        rel_path = os.path.relpath(file_path, library_path)
        trash_folder = os.path.join(library_path, '.trash', category)
        trash_path = os.path.join(trash_folder, rel_path)
        
        os.makedirs(os.path.dirname(trash_path), exist_ok=True)
        shutil.move(file_path, trash_path)
        
        manifest.write(json.dumps({
            'timestamp': datetime.now().isoformat(),
            'action': f'trashed_{category}',
            'file': file_path,
            'trash_location': trash_path
        }) + '\n')
    except Exception as e:
        manifest.write(json.dumps({
            'timestamp': datetime.now().isoformat(),
            'action': 'trash_failed',
            'file': file_path,
            'category': category,
            'error': str(e)
        }) + '\n')


# =====================
# MAIN OPERATION CLASS
# =====================

class LibraryPerfector:
    """Main class for the Make Library Perfect operation."""
    
    def __init__(self, library_path: str):
        self.library_path = library_path
        self.db_path = os.path.join(library_path, 'photos.db')
        self.db_conn = None
        self.hash_cache = None
        self.op_state = None
        self.operation_id = None
        self.manifest = None
        
    def run(self) -> Dict[str, Any]:
        """Execute the complete operation."""
        try:
            # Phase 0: Setup
            context = self.phase_0_setup()
            
            # Phase 1: Classify
            classified = self.phase_1_classify()
            
            # Phase 2: Trash non-media
            self.phase_2_trash_non_media(classified['non_media'])
            
            # Phase 3A: Process canonical files (fast path)
            moved_to_thorough = self.phase_3a_process_canonical_files(classified['canonical_files'])
            
            # Phase 3B: Process files needing work (thorough path)
            all_thorough_files = classified['needs_work'] + moved_to_thorough
            self.phase_3b_process_files_needing_work(all_thorough_files)
            
            # Phase 4: Cleanup
            self.phase_4_cleanup()
            
            # Phase 5: Finalize
            self.phase_5_finalize()
            
            return {'status': 'SUCCESS'}
            
        except Exception as e:
            # Log error
            if self.manifest:
                self.manifest.write(json.dumps({
                    'timestamp': datetime.now().isoformat(),
                    'action': 'operation_failed',
                    'error': str(e),
                    'traceback': traceback.format_exc()
                }) + '\n')
            
            # Mark operation failed
            if self.op_state and self.operation_id:
                self.op_state.fail_operation(self.operation_id, error_message=str(e))
            
            raise
        finally:
            # Cleanup
            if self.manifest:
                self.manifest.close()
            if self.db_conn:
                self.db_conn.close()
    
    def phase_0_setup(self) -> Dict[str, Any]:
        """Setup safety infrastructure."""
        # Create infrastructure folders
        for folder in ['.db_backups', '.logs', '.thumbnails', '.trash/non_media', 
                       '.trash/duplicates', '.trash/unsupported', '.trash/corrupted']:
            os.makedirs(os.path.join(self.library_path, folder), exist_ok=True)
        
        # Backup database
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        backup_path = os.path.join(self.library_path, '.db_backups', f'photos_backup_{timestamp}.db')
        if os.path.exists(self.db_path):
            shutil.copy2(self.db_path, backup_path)
        
        # Create manifest log
        manifest_path = os.path.join(self.library_path, '.logs', f'operation_{timestamp}.jsonl')
        self.manifest = open(manifest_path, 'a')
        self.manifest.write(json.dumps({
            'timestamp': timestamp,
            'action': 'operation_started',
            'library_path': self.library_path
        }) + '\n')
        
        # Initialize hash cache
        self.hash_cache = HashCache(self.db_path)
        
        # Initialize operation state
        self.op_state = OperationStateManager(self.db_path)
        self.operation_id = self.op_state.start_operation(
            operation_type=OperationType.LIBRARY_PERFECT,
            metadata={'library_path': self.library_path}
        )
        
        # Open database connection
        self.db_conn = sqlite3.connect(self.db_path)
        self.db_conn.row_factory = sqlite3.Row
        
        return {}
    
    def phase_1_classify(self) -> Dict[str, List[str]]:
        """Classify files into fast path vs thorough path."""
        canonical_files = []
        needs_work = []
        non_media = []
        
        for root, dirs, files in os.walk(self.library_path):
            # Skip infrastructure folders
            if any(root.startswith(os.path.join(self.library_path, prefix)) 
                   for prefix in ['.db_backups', '.logs', '.thumbnails', '.trash']):
                continue
            
            # Skip hidden folders
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            
            for filename in files:
                # Skip hidden files
                if filename.startswith('.'):
                    continue
                
                # Skip database file
                if filename == 'photos.db':
                    continue
                
                full_path = os.path.join(root, filename)
                ext = os.path.splitext(filename)[1].lower()
                
                # Check if supported extension
                if ext not in SUPPORTED_MEDIA_EXTENSIONS:
                    non_media.append(full_path)
                    continue
                
                # Quick canonical check (no I/O)
                if is_quick_canonical(full_path, filename, root, self.library_path):
                    canonical_files.append(full_path)
                else:
                    needs_work.append(full_path)
        
        self.manifest.write(json.dumps({
            'timestamp': datetime.now().isoformat(),
            'action': 'classification_complete',
            'canonical_count': len(canonical_files),
            'needs_work_count': len(needs_work),
            'non_media_count': len(non_media)
        }) + '\n')
        
        return {
            'canonical_files': canonical_files,
            'needs_work': needs_work,
            'non_media': non_media
        }
    
    def phase_2_trash_non_media(self, non_media_files: List[str]) -> None:
        """Move non-media files to trash."""
        for file_path in non_media_files:
            move_to_trash(file_path, self.library_path, 'non_media', self.manifest)
    
    def phase_3a_process_canonical_files(self, canonical_files: List[str]) -> List[str]:
        """Fast path for files that look canonical."""
        files_moved_to_thorough = []
        
        for file_path in canonical_files:
            try:
                # Check if already indexed
                rel_path = os.path.relpath(file_path, self.library_path)
                cursor = self.db_conn.cursor()
                
                # Get hash
                stat = os.stat(file_path)
                cache_key = (file_path, stat.st_mtime_ns, stat.st_size)
                current_hash, from_cache = self.hash_cache.get(cache_key)
                
                # Check if already indexed with current hash
                cursor.execute("""
                    SELECT id FROM photos 
                    WHERE current_path = ? AND content_hash = ?
                """, (rel_path, current_hash))
                
                if cursor.fetchone():
                    # Already indexed correctly, skip!
                    continue
                
                # Need to verify EXIF
                exif_date = extract_exif_date(file_path)
                orientation = get_orientation_flag(file_path)
                rating = get_rating_tag(file_path)
                
                # Check if needs modification
                if not exif_date or (orientation and orientation != 1) or rating == 0:
                    # Needs work - move to thorough path
                    files_moved_to_thorough.append(file_path)
                    continue
                
                # File is perfect! Just index it
                dimensions = get_dimensions(file_path)
                file_type = 'photo' if is_photo_extension(file_path) else 'video'
                
                cursor.execute("""
                    INSERT OR REPLACE INTO photos
                    (current_path, original_filename, content_hash, date_taken,
                     file_size, file_type, width, height, rating)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    rel_path,
                    os.path.basename(file_path),
                    current_hash,
                    exif_date.isoformat() if exif_date else None,
                    stat.st_size,
                    file_type,
                    dimensions[0] if dimensions else None,
                    dimensions[1] if dimensions else None,
                    rating if rating and rating != 0 else None
                ))
                
                self.db_conn.commit()
                
            except Exception as e:
                self.manifest.write(json.dumps({
                    'timestamp': datetime.now().isoformat(),
                    'action': 'canonical_processing_failed',
                    'file': file_path,
                    'error': str(e)
                }) + '\n')
                files_moved_to_thorough.append(file_path)
        
        return files_moved_to_thorough
    
    def phase_3b_process_files_needing_work(self, files_to_process: List[str]) -> None:
        """Thorough path for files that need fixing (WITH BACKUPS)."""
        for file_path in files_to_process:
            backup_path = None
            
            try:
                # Full audit
                audit_result = self.full_audit_file(file_path)
                
                if 'ERROR' in audit_result:
                    # Corrupted
                    move_to_trash(file_path, self.library_path, 'corrupted', self.manifest)
                    continue
                
                # Check if we need to modify
                will_modify = any([
                    audit_result.get('bake_rotation'),
                    audit_result.get('write_exif_date'),
                    audit_result.get('strip_rating')
                ])
                
                # SAFETY: Create backup if modifying
                if will_modify:
                    backup_path = file_path + '.backup'
                    shutil.copy2(file_path, backup_path)
                
                # Apply modifications
                if audit_result.get('bake_rotation'):
                    success = bake_orientation(file_path)
                    if success:
                        strip_orientation_flag(file_path)
                
                if audit_result.get('write_exif_date'):
                    write_exif_date(file_path, audit_result['write_exif_date'])
                
                if audit_result.get('strip_rating'):
                    strip_exif_rating(file_path)
                
                # SAFETY: Verify after modifications
                if will_modify and not verify_file_valid(file_path):
                    # RESTORE FROM BACKUP
                    shutil.move(backup_path, file_path)
                    move_to_trash(file_path, self.library_path, 'corrupted', self.manifest)
                    continue
                
                # Compute hash
                stat = os.stat(file_path)
                new_hash = compute_hash(file_path)
                cache_key = (file_path, stat.st_mtime_ns, stat.st_size)
                self.hash_cache.set(cache_key, new_hash)
                
                # Check for duplicates
                cursor = self.db_conn.cursor()
                cursor.execute("SELECT current_path FROM photos WHERE content_hash = ?", (new_hash,))
                existing = cursor.fetchone()
                
                if existing and existing[0] != os.path.relpath(file_path, self.library_path):
                    # Duplicate!
                    move_to_trash(file_path, self.library_path, 'duplicates', self.manifest)
                    if backup_path and os.path.exists(backup_path):
                        os.remove(backup_path)
                    continue
                
                # Move to canonical location
                canonical_path = get_canonical_path(
                    self.library_path,
                    audit_result['exif_date'],
                    new_hash,
                    file_path
                )
                
                if canonical_path != file_path:
                    os.makedirs(os.path.dirname(canonical_path), exist_ok=True)
                    shutil.move(file_path, canonical_path)
                    file_path = canonical_path
                
                # Index in database
                rel_path = os.path.relpath(file_path, self.library_path)
                dimensions = get_dimensions(file_path)
                file_type = 'photo' if is_photo_extension(file_path) else 'video'
                
                cursor.execute("""
                    INSERT OR REPLACE INTO photos
                    (current_path, original_filename, content_hash, date_taken,
                     file_size, file_type, width, height, rating)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    rel_path,
                    os.path.basename(file_path),
                    new_hash,
                    audit_result['exif_date'].isoformat() if audit_result['exif_date'] else None,
                    os.path.getsize(file_path),
                    file_type,
                    dimensions[0] if dimensions else None,
                    dimensions[1] if dimensions else None,
                    audit_result.get('rating') if audit_result.get('rating') != 0 else None
                ))
                
                self.db_conn.commit()
                
                # SAFETY: Delete backup after successful index
                if backup_path and os.path.exists(backup_path):
                    os.remove(backup_path)
                
            except Exception as e:
                # SAFETY: Restore from backup on error
                if backup_path and os.path.exists(backup_path):
                    shutil.move(backup_path, file_path)
                
                self.manifest.write(json.dumps({
                    'timestamp': datetime.now().isoformat(),
                    'action': 'processing_error',
                    'file': file_path,
                    'error': str(e)
                }) + '\n')
    
    def full_audit_file(self, file_path: str) -> Dict[str, Any]:
        """Complete audit of a file."""
        try:
            if not os.path.exists(file_path) or not os.access(file_path, os.R_OK):
                return {'ERROR': 'File not accessible'}
            
            if not verify_file_valid(file_path):
                return {'ERROR': 'File corrupted'}
            
            # Extract EXIF
            exif_date = extract_exif_date(file_path)
            orientation = get_orientation_flag(file_path)
            rating = get_rating_tag(file_path)
            
            needs = {
                'exif_date': exif_date,
                'rating': rating
            }
            
            # Need to bake rotation?
            if orientation and orientation != 1 and can_bake_lossless(file_path):
                needs['bake_rotation'] = True
            
            # Need to write EXIF date?
            if not exif_date:
                date_from_filename = parse_date_from_filename(os.path.basename(file_path))
                if date_from_filename:
                    needs['write_exif_date'] = date_from_filename
                    needs['exif_date'] = date_from_filename
            
            # Need to strip rating?
            if rating == 0:
                needs['strip_rating'] = True
            
            return needs
            
        except Exception as e:
            return {'ERROR': str(e)}
    
    def phase_4_cleanup(self) -> None:
        """Remove ghosts, empty folders, non-canonical folders."""
        # Remove ghosts
        cursor = self.db_conn.cursor()
        cursor.execute("SELECT id, current_path FROM photos")
        
        for row in cursor.fetchall():
            photo_id, rel_path = row
            full_path = os.path.join(self.library_path, rel_path)
            
            if not os.path.exists(full_path):
                cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
        
        self.db_conn.commit()
        
        # Remove empty folders
        for root, dirs, files in os.walk(self.library_path, topdown=False):
            if any(root.startswith(os.path.join(self.library_path, prefix))
                   for prefix in ['.db_backups', '.logs', '.thumbnails', '.trash']):
                continue
            
            if root == self.library_path:
                continue
            
            if not os.listdir(root):
                os.rmdir(root)
    
    def phase_5_finalize(self) -> None:
        """Mark operation complete."""
        self.op_state.complete_operation(self.operation_id, final_status='SUCCESS')
        
        self.manifest.write(json.dumps({
            'timestamp': datetime.now().isoformat(),
            'action': 'operation_complete'
        }) + '\n')


def strip_orientation_flag(file_path: str) -> None:
    """Strip orientation flag from file."""
    try:
        subprocess.run(
            ['exiftool', '-Orientation=', '-overwrite_original', file_path],
            capture_output=True,
            timeout=10
        )
    except Exception:
        pass


def write_exif_date(file_path: str, date: datetime) -> None:
    """Write EXIF date to file."""
    try:
        date_str = date.strftime('%Y:%m:%d %H:%M:%S')
        subprocess.run(
            ['exiftool', f'-DateTimeOriginal={date_str}', '-overwrite_original', file_path],
            capture_output=True,
            timeout=10
        )
    except Exception:
        pass


# =====================
# PUBLIC API
# =====================

def make_library_perfect(library_path: str) -> Dict[str, Any]:
    """
    Execute the Make Library Perfect operation.
    
    Returns:
        Dict with status and results
    """
    perfector = LibraryPerfector(library_path)
    return perfector.run()
