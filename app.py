#!/usr/bin/env python3
"""
Photo Viewer - Flask Server with Database API
"""

from flask import Flask, send_from_directory, jsonify, request, send_file, Response, stream_with_context
from collections import defaultdict
import sqlite3
import traceback
from functools import wraps
from hash_cache import HashCache

def handle_db_corruption(f):
    """
    Decorator to catch database corruption errors and return specific error response.
    
    Catches sqlite3.DatabaseError and checks if it's due to corruption.
    Returns {'error': 'database_corrupted'} for frontend to show rebuild dialog.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        except sqlite3.DatabaseError as e:
            error_str = str(e).lower()
            # Check for specific corruption indicators
            if ('not a database' in error_str or 
                'malformed' in error_str or 
                'corrupt' in error_str):
                app.logger.error(f"Database corruption detected: {e}")
                return jsonify({
                    'error': 'database_corrupted',
                    'message': 'Database appears corrupted. Please rebuild.'
                }), 500
            # Re-raise if not corruption (permission error, etc.)
            raise
    return decorated_function
import os
import queue
import subprocess
import shutil
import threading
import time
import hashlib
import json
import logging
import tempfile
from logging.handlers import RotatingFileHandler
from dataclasses import dataclass
from datetime import datetime
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
from io import BytesIO
from db_health import DBStatus, check_database_health
from db_schema import create_database_schema
from file_operations import (
    extract_exif_date as shared_extract_exif_date,
    extract_exif_rating,
    strip_exif_rating,
)
from library_cleanliness import (
    ALL_MEDIA_EXTENSIONS,
    EXIF_WRITABLE_PHOTO_EXTENSIONS,
    PHOTO_MEDIA_EXTENSIONS,
    VIDEO_MEDIA_EXTENSIONS,
    build_canonical_photo_path,
    is_supported_media_extension,
    media_kind_for_extension,
    parse_metadata_datetime,
)
from library_sync import (
    synchronize_library_generator,
    count_media_files,
    count_media_files_by_type,
    estimate_duration,
)
from library_layout import (
    LIBRARY_METADATA_DIR,
    ROOT_INFRASTRUCTURE_DIRS,
    canonical_db_path,
    db_sidecar_paths,
    detect_existing_db_path,
    library_has_db,
    library_has_openable_db,
    quarantine_unexpected_metadata_entries,
    resolve_db_path,
)
from media_finalization import finalize_mutated_media
from photo_canonicalization import (
    CanonicalizedPhoto,
    canonicalize_photo_file,
    write_photo_date_metadata,
)
from make_library_perfect import _compute_photo_duplicate_key, verify_media_file
from rotation_utils import (
    JPEG_LOSSY_QUALITY,
    ROTATION_SUPPORTED_EXTENSIONS,
    bake_orientation as shared_bake_orientation,
    can_rotate_losslessly,
    get_orientation_flag,
    normalize_rotation_degrees,
    rotate_file_in_place,
)

# Register HEIF/HEIC support for PIL
register_heif_opener()

app = Flask(__name__, static_folder='static')

# Feature flags
app.config['DRY_RUN_DATE_EDIT'] = False  # REAL UPDATES - using test library

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, 'static')

# Library paths - initialized from .config.json on startup
DB_PATH = None
LIBRARY_PATH = None
THUMBNAIL_CACHE_DIR = None
TRASH_DIR = None
DB_BACKUP_DIR = None
IMPORT_TEMP_DIR = None
LOG_DIR = None
# Shared media classification policy
PHOTO_EXTENSIONS = PHOTO_MEDIA_EXTENSIONS
VIDEO_EXTENSIONS = VIDEO_MEDIA_EXTENSIONS

# ============================================================================
# LOGGING CONFIGURATION (Hybrid Approach: print() + persistent logs)
# ============================================================================

# Loggers will be configured after library path is loaded
app.logger.setLevel(logging.INFO)

# Create console-only loggers as fallback
import_logger = logging.getLogger('import')
import_logger.setLevel(logging.INFO)

error_logger = logging.getLogger('errors')
error_logger.setLevel(logging.WARNING)

def get_db_connection():
    """Create database connection with WAL mode enabled"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # Return rows as dictionaries
    
    # Enable Write-Ahead Logging for better concurrency
    conn.execute("PRAGMA journal_mode=WAL")
    
    # Enable foreign keys for data integrity
    conn.execute("PRAGMA foreign_keys=ON")
    
    return conn

def get_image_dimensions(file_path):
    """Get image/video dimensions (width, height) from file"""
    try:
        # Check if it's a video file
        ext = os.path.splitext(file_path)[1].lower()
        if ext in VIDEO_EXTENSIONS:
            # Use ffprobe for videos
            import subprocess
            import json
            
            cmd = [
                'ffprobe',
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                file_path
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0:
                data = json.loads(result.stdout)
                for stream in data.get('streams', []):
                    if stream.get('codec_type') == 'video':
                        width = stream.get('width')
                        height = stream.get('height')
                        if width and height:
                            return (width, height)
        else:
            # Use PIL for images
            with Image.open(file_path) as img:
                # Apply EXIF orientation transpose to get display dimensions
                # (EXIF orientation values 5, 6, 7, 8 swap width/height)
                from PIL import ImageOps
                img_oriented = ImageOps.exif_transpose(img)
                return img_oriented.size  # (width, height) as displayed
    except Exception as e:
        print(f"Error reading dimensions for {file_path}: {e}")
        return None

def compute_hash(file_path):
    """Compute SHA-256 hash of file"""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(1048576), b""):  # 1MB chunks for network efficiency
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()[:7]  # First 7 chars


def compute_full_hash(file_path):
    """Compute the full SHA-256 hash of a file."""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(1048576), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()

def save_and_hash(file_storage, dest_path):
    """
    Save uploaded file while computing hash in a single pass.
    Uses 1MB chunks for network efficiency.
    Returns SHA-256 hash (first 7 chars).
    """
    sha256 = hashlib.sha256()
    
    with open(dest_path, 'wb') as f:
        while True:
            chunk = file_storage.read(1048576)  # 1MB chunks
            if not chunk:
                break
            sha256.update(chunk)
            f.write(chunk)
    
    return sha256.hexdigest()[:7]

def extract_exif_date(file_path):
    """Extract EXIF/metadata date using the shared app-wide helper."""
    return shared_extract_exif_date(file_path)

def convert_to_rgb_properly(img):
    """
    Convert image to RGB mode with proper handling of different color spaces.
    
    Fixes washed-out thumbnails caused by:
    - RGBA/LA: Alpha channel composited over black (makes images darker)
    - I/F: 32-bit integer/float modes without normalization
    - I;16: 16-bit modes from RAW files without proper scaling
    
    Args:
        img: PIL Image object
    
    Returns:
        PIL Image in RGB mode with proper color conversion
    """
    mode = img.mode
    
    # Already RGB - nothing to do
    if mode == 'RGB':
        return img
    
    # Capture ICC profile before any conversions (will restore after)
    icc_profile = img.info.get('icc_profile')
    
    # Modes with alpha channel - composite over white background
    # This prevents dark/muddy thumbnails from transparent PNGs
    if mode in ('RGBA', 'LA', 'PA', 'RGBa', 'La'):
        if mode in ('RGBA', 'RGBa'):
            # Create white background and paste with alpha mask
            background = Image.new('RGB', img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[-1])  # Use alpha channel as mask
            result = background
        elif mode in ('LA', 'La'):
            # Grayscale with alpha
            background = Image.new('L', img.size, 255)
            background.paste(img, mask=img.split()[-1])
            result = background.convert('RGB')
        elif mode == 'PA':
            # Palette with alpha - convert to RGBA first
            img = img.convert('RGBA')
            background = Image.new('RGB', img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[-1])
            result = background
    # High bit-depth modes - need normalization to prevent washed-out appearance
    # These include 32-bit (I, F) and 16-bit (I;16) images
    elif mode in ('I', 'F', 'I;16', 'I;16B', 'I;16L', 'I;16N'):
        import numpy as np
        # Convert to numpy array for normalization
        arr = np.array(img)
        
        # Normalize to 0-255 range
        if arr.size > 0:
            min_val = arr.min()
            max_val = arr.max()
            if max_val > min_val:
                # Scale to 0-255 range
                arr = ((arr - min_val) / (max_val - min_val) * 255).astype(np.uint8)
            else:
                # All pixels same value
                arr = np.zeros_like(arr, dtype=np.uint8)
        
        # Create new image from normalized array
        normalized_img = Image.fromarray(arr, mode='L')
        result = normalized_img.convert('RGB')
    else:
        # All other modes (L, P, CMYK, YCbCr, etc.) - standard conversion works fine
        result = img.convert('RGB')
    
    # Restore ICC profile to converted image
    if icc_profile and result.mode == 'RGB':
        result.info['icc_profile'] = icc_profile
    
    return result

def create_db_backup():
    """Create a timestamped database backup, maintain max 20 backups"""
    try:
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        backup_filename = f"photo_library_{timestamp}.db"
        backup_path = os.path.join(DB_BACKUP_DIR, backup_filename)
        
        # Copy database
        shutil.copy2(DB_PATH, backup_path)
        print(f"✅ Created DB backup: {backup_filename}")
        
        # Clean up old backups (keep max 20)
        backups = sorted([f for f in os.listdir(DB_BACKUP_DIR) if f.endswith('.db')])
        while len(backups) > 20:
            oldest = backups.pop(0)
            os.remove(os.path.join(DB_BACKUP_DIR, oldest))
            print(f"🗑️  Removed old backup: {oldest}")
        
        return backup_path
    except Exception as e:
        print(f"❌ Error creating DB backup: {e}")
        return None

def bake_orientation(file_path):
    return shared_bake_orientation(file_path)


def delete_thumbnail_for_hash(content_hash):
    """Delete a cached thumbnail if it exists."""
    if not content_hash:
        return

    thumbnail_path = os.path.join(
        THUMBNAIL_CACHE_DIR,
        content_hash[:2],
        content_hash[2:4],
        f"{content_hash}.jpg",
    )
    if os.path.exists(thumbnail_path):
        os.remove(thumbnail_path)
        cleanup_empty_thumbnail_folders(thumbnail_path)

def write_photo_exif(file_path, new_date):
    """Write canonical photo date metadata using the shared helper."""
    print(f"🔧 Writing EXIF to: {os.path.basename(file_path)}")
    print(f"   Target date: {new_date}")
    write_photo_date_metadata(file_path, new_date)
    print("   ✅ EXIF write verified")

def write_video_metadata(file_path, new_date):
    """Write metadata to video using ffmpeg"""
    try:
        # Check if format supports metadata before attempting write
        _, ext = os.path.splitext(file_path)
        ext_lower = ext.lower()
        
        # Formats that don't support embedded metadata reliably
        unsupported_formats = {'.mpg', '.mpeg', '.vob', '.ts', '.mts', '.avi', '.wmv'}
        if ext_lower in unsupported_formats:
            raise Exception(f"Format {ext.upper()} does not support embedded metadata")
        
        # Convert to ISO 8601 format
        iso_date = new_date.replace(':', '-', 2).replace(' ', 'T')
        
        base, ext = os.path.splitext(file_path)
        temp_output = f"{base}_temp{ext}"
        
        cmd = [
            'ffmpeg',
            '-i', file_path,
            '-metadata', f'creation_time={iso_date}',
            '-codec', 'copy',
            '-y',
            temp_output
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        
        if result.returncode != 0:
            if os.path.exists(temp_output):
                os.remove(temp_output)
            raise Exception(f"ffmpeg failed: {result.stderr}")
        
        # Replace original
        os.replace(temp_output, file_path)
            
    except subprocess.TimeoutExpired:
        if os.path.exists(temp_output):
            os.remove(temp_output)
        raise Exception("ffmpeg timeout after 60s")
    except FileNotFoundError:
        raise Exception("ffmpeg not found")


@dataclass
class StagedCanonicalPhoto:
    staged_path: str
    canonical_photo: CanonicalizedPhoto


@dataclass
class DebugFileCountAnalysisResult:
    all_files: list[str]
    file_buckets: list[str]
    unique_media_count: int
    duplicate_media_count: int
    other_file_count: int


def cleanup_staged_file(staged_path):
    """Best-effort cleanup for staged temp files."""
    if not staged_path:
        return
    try:
        if os.path.exists(staged_path):
            os.remove(staged_path)
    except Exception as cleanup_error:
        print(f"   ⚠️  Couldn't delete staged file: {cleanup_error}")


def stage_photo_for_canonicalization(source_path, *, temp_prefix, temp_dir=None):
    """
    Copy a photo into temp space, canonicalize it there, and return final identity.

    This is the shared photo ingest primitive used by import and convert so both
    paths resolve date fallback, metadata writes, canonical bytes, and canonical
    relative path through the same rulebook.
    """
    staging_dir = temp_dir or IMPORT_TEMP_DIR
    if not staging_dir:
        raise RuntimeError("No import temp directory configured for photo staging")
    os.makedirs(staging_dir, exist_ok=True)
    _, ext = os.path.splitext(source_path)
    fd, staged_path = tempfile.mkstemp(
        prefix=temp_prefix,
        suffix=ext.lower(),
        dir=staging_dir,
    )
    os.close(fd)
    shutil.copy2(source_path, staged_path)

    try:
        canonical_photo = canonicalize_photo_file(
            staged_path,
            extract_exif_date=extract_exif_date,
            bake_orientation=bake_orientation,
            get_dimensions=get_image_dimensions,
            compute_hash=compute_full_hash,
            write_photo_exif=write_photo_exif,
            extract_exif_rating=extract_exif_rating,
            strip_exif_rating=strip_exif_rating,
        )
        if not os.path.exists(staged_path):
            raise RuntimeError(f"Canonicalized staged photo disappeared: {staged_path}")
        if not canonical_photo.content_hash:
            raise RuntimeError(f"Failed to compute canonical hash for {source_path}")
        if canonical_photo.width is None or canonical_photo.height is None:
            raise RuntimeError(f"Failed to read canonical dimensions for {source_path}")
        return StagedCanonicalPhoto(staged_path=staged_path, canonical_photo=canonical_photo)
    except Exception:
        cleanup_staged_file(staged_path)
        raise


def iter_debug_file_count_paths(selected_path):
    """Yield every file under the selected path."""
    if os.path.isfile(selected_path):
        yield selected_path
        return

    for root, _, files in os.walk(selected_path):
        for filename in files:
            yield os.path.join(root, filename)


def analyze_debug_media_duplicate_key(file_path):
    """
    Return the cleaner-compatible duplicate identity for a media file without
    mutating the source path.
    """
    valid, _ = verify_media_file(file_path)
    if not valid:
        raise RuntimeError(f"Unreadable media file: {file_path}")

    file_type = media_kind_for_extension(os.path.splitext(file_path)[1].lower())
    if file_type == 'photo':
        staged_photo = stage_photo_for_canonicalization(
            file_path,
            temp_prefix='debug-file-count-',
        )
        try:
            return _compute_photo_duplicate_key(
                staged_photo.staged_path,
                fallback_hash=staged_photo.canonical_photo.content_hash,
            )
        finally:
            cleanup_staged_file(staged_photo.staged_path)

    content_hash = compute_full_hash(file_path)
    if not content_hash:
        raise RuntimeError(f"Failed to hash media file: {file_path}")
    return content_hash


def analyze_debug_file_count_path(selected_path):
    """Compute the debug file-count scorecard without touching source files."""
    if not selected_path:
        raise RuntimeError('No path selected')
    if not os.path.exists(selected_path):
        raise RuntimeError(f'Path not found: {selected_path}')

    all_files: list[str] = []
    path_bucket: dict[str, str] = {}
    key_to_paths: dict[str, list[str]] = defaultdict(list)

    for file_path in iter_debug_file_count_paths(selected_path):
        all_files.append(file_path)
        ext = os.path.splitext(file_path)[1].lower()

        if not is_supported_media_extension(ext):
            path_bucket[file_path] = 'other_files'
            continue

        try:
            duplicate_key = analyze_debug_media_duplicate_key(file_path)
        except Exception as error:
            print(f"  ⚠️  Debug analyzer counted as other file: {file_path} ({error})")
            path_bucket[file_path] = 'other_files'
            continue

        key_to_paths[duplicate_key].append(file_path)

    for paths in key_to_paths.values():
        sorted_paths = sorted(paths)
        path_bucket[sorted_paths[0]] = 'unique_media'
        for extra_path in sorted_paths[1:]:
            path_bucket[extra_path] = 'duplicate_media'

    file_buckets = [path_bucket[p] for p in all_files]

    unique_media_count = sum(1 for b in file_buckets if b == 'unique_media')
    duplicate_media_count = sum(1 for b in file_buckets if b == 'duplicate_media')
    other_file_count = sum(1 for b in file_buckets if b == 'other_files')

    return DebugFileCountAnalysisResult(
        all_files=all_files,
        file_buckets=file_buckets,
        unique_media_count=unique_media_count,
        duplicate_media_count=duplicate_media_count,
        other_file_count=other_file_count,
    )


def insert_canonical_photo_row(conn, *, original_filename, relative_path, canonical_photo):
    cursor = conn.cursor()
    cursor.execute(
        '''
            INSERT INTO photos (current_path, original_filename, content_hash, file_size, file_type, date_taken, width, height)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            relative_path,
            original_filename,
            canonical_photo.content_hash,
            canonical_photo.file_size,
            'photo',
            canonical_photo.date_taken,
            canonical_photo.width,
            canonical_photo.height,
        ),
    )
    conn.commit()
    return cursor.lastrowid


def commit_staged_canonical_photo(
    conn,
    *,
    library_path,
    source_path,
    original_filename,
    staged_photo,
    remove_source_after_commit,
):
    """
    Move a verified staged photo into its canonical location and persist the DB row.
    """
    canonical_photo = staged_photo.canonical_photo
    staged_path = staged_photo.staged_path
    target_path = os.path.join(library_path, canonical_photo.relative_path)
    source_abs = os.path.abspath(source_path)
    target_abs = os.path.abspath(target_path)
    source_matches_target = source_abs == target_abs

    if os.path.exists(target_path) and not source_matches_target:
        raise RuntimeError(
            f"Refusing to overwrite existing file at canonical path {canonical_photo.relative_path}"
        )

    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    if source_matches_target:
        os.replace(staged_path, target_path)
    else:
        shutil.move(staged_path, target_path)
    staged_photo.staged_path = None

    try:
        photo_id = insert_canonical_photo_row(
            conn,
            original_filename=original_filename,
            relative_path=canonical_photo.relative_path,
            canonical_photo=canonical_photo,
        )
    except Exception:
        if not source_matches_target and os.path.exists(target_path):
            os.remove(target_path)
        raise

    if remove_source_after_commit and not source_matches_target and os.path.exists(source_path):
        os.remove(source_path)

    return photo_id, target_path


def move_file_to_category_trash(library_path, trash_dir, source_path, category):
    """Move a file into a categorized trash folder while preserving its relative path."""
    rel_path = os.path.relpath(source_path, library_path)
    target_path = os.path.join(trash_dir, category, rel_path)
    os.makedirs(os.path.dirname(target_path), exist_ok=True)

    candidate = target_path
    counter = 1
    base, ext = os.path.splitext(target_path)
    while os.path.exists(candidate):
        candidate = f"{base}_{counter}{ext}"
        counter += 1

    shutil.move(source_path, candidate)
    return candidate


def categorize_processing_error(error):
    error_str = str(error).lower()
    if 'timeout' in error_str:
        return 'timeout', "Processing timeout (file too large or slow storage)"
    if 'unique constraint' in error_str and 'content_hash' in error_str:
        return 'duplicate', "Duplicate file (detected after processing)"
    if ('not a valid' in error_str or 'corrupt' in error_str or
            'invalid data' in error_str or 'moov atom' in error_str):
        return 'corrupted', "File corrupted or invalid format"
    if 'not found' in error_str and 'exiftool' in error_str:
        return 'missing_tool', "Required tool not installed (exiftool)"
    if 'not found' in error_str and 'ffmpeg' in error_str:
        return 'missing_tool', "Required tool not installed (ffmpeg)"
    if 'permission' in error_str or 'denied' in error_str:
        return 'permission', "Permission denied"
    return 'unsupported', str(error)

def parse_filename(filename):
    """
    Parse img_YYYYMMDD_HASH[_counter].ext format
    Handles collision-resolved filenames like img_20260122_abc12345_2.jpg
    """
    parts = filename.split('_')
    if len(parts) < 3:
        return None, None, None, None
    
    prefix = parts[0]
    date_str = parts[1]
    
    # Everything after date is hash + optional counter + extension
    # Join remaining parts and split off extension
    remainder = '_'.join(parts[2:])
    hash_part, ext = os.path.splitext(remainder)
    
    return prefix, date_str, hash_part, ext

class DateEditTransaction:
    """Track all operations for rollback"""
    def __init__(self):
        self.operations = []
        self.failed_files = []
    
    def log_exif_write(self, file_path, old_date):
        self.operations.append(('exif', {
            'file': file_path,
            'old_date': old_date
        }))
    
    def log_move(self, old_path, new_path):
        self.operations.append(('move', {
            'from': old_path,
            'to': new_path
        }))
    
    def log_failure(self, filename, error):
        self.failed_files.append({
            'filename': filename,
            'error': str(error)
        })
    
    def rollback(self, library_path):
        """Undo all operations in reverse order"""
        print(f"\n🔄 Rolling back {len(self.operations)} operations...")
        
        for action, details in reversed(self.operations):
            try:
                if action == 'move':
                    old_full = os.path.join(library_path, details['from'])
                    new_full = os.path.join(library_path, details['to'])
                    
                    if os.path.exists(new_full):
                        os.makedirs(os.path.dirname(old_full), exist_ok=True)
                        shutil.move(new_full, old_full)
                        print(f"  ↩️  Moved back: {details['to']} -> {details['from']}")
                
                elif action == 'exif':
                    file_path = details['file']
                    old_date = details['old_date']
                    
                    if os.path.exists(file_path):
                        # Determine file type
                        ext = os.path.splitext(file_path)[1].lower()
                        # v223: Use EXIF-writable subset (no RAW, no ambiguous lossy formats)
                        
                        if ext in EXIF_WRITABLE_PHOTO_EXTENSIONS:
                            write_photo_exif(file_path, old_date)
                        else:
                            write_video_metadata(file_path, old_date)
                        
                        print(f"  ↩️  Restored EXIF: {os.path.basename(file_path)}")
            
            except Exception as e:
                print(f"  ⚠️  Rollback error (continuing): {e}")
        
        print(f"✅ Rollback complete")

def cleanup_empty_date_folders(old_full_path):
    """Remove empty date/year folders left behind after a successful move."""
    try:
        old_dir = os.path.dirname(old_full_path)
        if os.path.isdir(old_dir) and not os.listdir(old_dir):
            os.rmdir(old_dir)
            year_dir = os.path.dirname(old_dir)
            if os.path.isdir(year_dir) and not os.listdir(year_dir):
                os.rmdir(year_dir)
    except Exception as e:
        # Folder cleanup is best-effort and should not fail the edit.
        print(f"  ⚠️  Couldn't clean up empty folders: {e}")

def update_photo_date_with_files(photo_id, new_date, conn):
    """
    Update single photo date with full file operations
    Returns: (success, result, transaction)
    """
    cursor = conn.cursor()
    transaction = DateEditTransaction()
    
    try:
        # Get photo info
        cursor.execute(
            "SELECT current_path, date_taken, file_type, content_hash FROM photos WHERE id = ?",
            (photo_id,),
        )
        row = cursor.fetchone()
        if not row:
            return False, {'status': 'error', 'error': 'Photo not found'}, transaction
        
        old_rel_path = row['current_path']
        old_filename = os.path.basename(old_rel_path)
        old_date = row['date_taken']
        file_type = row['file_type']
        old_hash = row['content_hash']
        
        old_full_path = os.path.join(LIBRARY_PATH, old_rel_path)
        
        if not os.path.exists(old_full_path):
            return False, {'status': 'error', 'error': 'File not found on disk'}, transaction
        
        # Phase 0: Bake orientation (before EXIF write to preserve it)
        try:
            print(f"  🔄 Checking orientation...")
            bake_success, bake_message, orient_value = bake_orientation(old_full_path)
            
            if bake_success:
                print(f"  ✅ {bake_message}")
                # Dimensions may have changed - will be updated later if needed
                # Hash will change - will be detected after EXIF write
            else:
                if orient_value is not None:
                    # Orientation exists but couldn't be baked
                    print(f"  ⚠️  {bake_message}")
                # else: No orientation, continue normally
        except Exception as bake_error:
            print(f"  ⚠️  Orientation baking failed: {bake_error}")
            # Continue anyway - not critical for date change operation
        
        # Phase 1: Write EXIF (best effort; shared finalization will reconcile the
        # actual bytes/path state afterward so date-edit doesn't maintain a second
        # post-mutation cleanliness implementation.)
        exif_write_error = None
        try:
            if file_type in ('photo', 'image'):  # Handle both for backward compatibility
                write_photo_exif(old_full_path, new_date)
            elif file_type == 'video':
                write_video_metadata(old_full_path, new_date)
            else:
                raise Exception(f"Unknown file type: {file_type}")
            
            transaction.log_exif_write(old_full_path, old_date)
            
        except Exception as e:
            print(f"  ❌ EXIF write failed: {e}")
            exif_write_error = str(e)

        # Phase 2: Reconcile hash/path/thumbnail/DB through the shared finalizer.
        try:
            finalize_result = finalize_mutated_media(
                conn=conn,
                photo_id=photo_id,
                library_path=LIBRARY_PATH,
                current_rel_path=old_rel_path,
                date_taken=new_date,
                old_hash=old_hash,
                build_canonical_path=build_canonical_photo_path,
                compute_hash=compute_full_hash,
                get_dimensions=get_image_dimensions,
                delete_thumbnail_for_hash=delete_thumbnail_for_hash,
                duplicate_policy='trash',
                duplicate_trash_dir=os.path.join(TRASH_DIR, 'duplicates'),
            )

            if exif_write_error:
                print(
                    "  ⚠️  EXIF write failed; reconciled canonical path/DB using the "
                    f"current on-disk bytes: {exif_write_error}"
                )

            if finalize_result.status == 'duplicate_removed':
                return True, {
                    'status': 'duplicate_removed',
                    'duplicate_photo_id': (
                        finalize_result.duplicate.photo_id if finalize_result.duplicate else None
                    ),
                    'duplicate_path': (
                        finalize_result.duplicate.current_path if finalize_result.duplicate else None
                    ),
                    'duplicate_destination': finalize_result.duplicate_destination,
                }, transaction

            if finalize_result.current_path and finalize_result.current_path != old_rel_path:
                transaction.log_move(old_rel_path, finalize_result.current_path)
                cleanup_empty_date_folders(old_full_path)

            cursor.execute(
                """
                UPDATE photos
                SET date_taken = ?, original_filename = ?
                WHERE id = ?
                """,
                (new_date, os.path.basename(finalize_result.current_path), photo_id),
            )

        except Exception as e:
            transaction.log_failure(old_filename, e)
            raise
        
        return True, {
            'status': 'updated',
            'current_path': finalize_result.current_path,
            'content_hash': finalize_result.content_hash,
        }, transaction
        
    except Exception as e:
        return False, {'status': 'error', 'error': str(e)}, transaction

def generate_thumbnail_for_file(file_path, content_hash, file_type):
    """Generate thumbnail for a file using hash-based sharding"""
    try:
        # Hash-based sharding: ab/cd/abcd1234....jpg
        shard_dir = os.path.join(THUMBNAIL_CACHE_DIR, content_hash[:2], content_hash[2:4])
        thumbnail_path = os.path.join(shard_dir, f"{content_hash}.jpg")
        
        # Skip if already exists
        if os.path.exists(thumbnail_path):
            return True
        
        os.makedirs(shard_dir, exist_ok=True)
        
        if file_type == 'video':
            # Create temp directory on-demand for video frame extraction
            os.makedirs(IMPORT_TEMP_DIR, exist_ok=True)
            
            # Extract video frame - get larger size first for better quality
            temp_frame = os.path.join(IMPORT_TEMP_DIR, f"temp_frame_{content_hash[:16]}.jpg")
            cmd = [
                'ffmpeg',
                '-i', file_path,
                '-vframes', '1',
                '-vf', 'scale=800:-1',  # Get 800px width first
                '-y',
                temp_frame
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0 and os.path.exists(temp_frame):
                with Image.open(temp_frame) as img:
                    # Capture ICC profile before any conversions
                    icc_profile = img.info.get('icc_profile')
                    
                    # Convert to RGB with proper color space handling
                    img = convert_to_rgb_properly(img)
                    
                    # Center-crop to 400x400 square
                    target_size = 400
                    
                    # Resize so smallest dimension is 400px
                    width, height = img.size
                    if width < height:
                        new_width = target_size
                        new_height = int(height * (target_size / width))
                    else:
                        new_height = target_size
                        new_width = int(width * (target_size / height))
                    
                    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
                    
                    # Center crop to square
                    left = (img.width - target_size) // 2
                    top = (img.height - target_size) // 2
                    img = img.crop((left, top, left + target_size, top + target_size))
                    
                    # Save with ICC profile preserved
                    save_kwargs = {'format': 'JPEG', 'quality': 85, 'optimize': True}
                    if icc_profile:
                        save_kwargs['icc_profile'] = icc_profile
                    img.save(thumbnail_path, **save_kwargs)
                os.remove(temp_frame)
                return True
            return False
        else:
            # Generate image thumbnail - center-crop to 400x400 square
            with Image.open(file_path) as img:
                from PIL import ImageOps
                img = ImageOps.exif_transpose(img)
                
                # Capture ICC profile before any conversions (prevents washed-out thumbnails)
                icc_profile = img.info.get('icc_profile')
                
                # Convert to RGB with proper color space handling
                img = convert_to_rgb_properly(img)
                
                target_size = 400
                
                # Resize so smallest dimension is 400px
                width, height = img.size
                if width < height:
                    new_width = target_size
                    new_height = int(height * (target_size / width))
                else:
                    new_height = target_size
                    new_width = int(width * (target_size / height))
                
                img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
                
                # Center crop to square
                left = (img.width - target_size) // 2
                top = (img.height - target_size) // 2
                img = img.crop((left, top, left + target_size, top + target_size))
                
                # Save with ICC profile preserved (critical for color accuracy)
                save_kwargs = {'format': 'JPEG', 'quality': 85, 'optimize': True}
                if icc_profile:
                    save_kwargs['icc_profile'] = icc_profile
                img.save(thumbnail_path, **save_kwargs)
                return True
    except Exception as e:
        print(f"❌ Error generating thumbnail: {e}")
        return False


@app.route('/')
def index():
    """Serve the main page"""
    return send_from_directory(STATIC_DIR, 'index.html')

@app.route('/api/file-counts')
@handle_db_corruption
def get_file_counts():
    """
    Get count of photos and videos in database.
    Handles both 'photo'/'image' for backward compatibility.
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Handle both 'photo' and 'image' for backward compatibility
        cursor.execute("""
            SELECT 
                SUM(CASE WHEN file_type IN ('photo', 'image') THEN 1 ELSE 0 END) as photos,
                SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) as videos
            FROM photos
        """)
        row = cursor.fetchone()
        conn.close()
        
        return jsonify({
            'photo_count': row['photos'] or 0,
            'video_count': row['videos'] or 0
        })
    except Exception as e:
        app.logger.error(f"Error getting file counts: {e}")
        return jsonify({'error': str(e)}), 500


def month_key_for_photo_grid(date_taken, current_path):
    """
    YYYY-MM bucket for the main grid. When EXIF date is missing, infer from canonical
    path (YYYY/YYYY-MM-DD/...) so undated rows still appear.
    """
    if date_taken:
        date_normalized = str(date_taken).replace(':', '-', 2)
        return date_normalized[:7]
    norm = (current_path or '').replace('\\', '/')
    parts = norm.split('/')
    if len(parts) >= 2:
        seg = parts[1]
        if len(seg) >= 7 and seg[4] == '-' and seg[:4].isdigit():
            return seg[:7]
    return 'undated'


@app.route('/api/photos')
@handle_db_corruption
def get_photos():
    """
    Get photos from database
    Query params:
    - limit: number of photos to return (optional - if omitted, returns ALL)
    - offset: pagination offset (default 0)
    - sort: 'newest' or 'oldest' (default 'newest')
    """
    limit = request.args.get('limit', type=int)  # No default - None means ALL
    offset = request.args.get('offset', 0, type=int)
    sort_order = request.args.get('sort', 'newest')
    
    # Sort direction for dated rows; undated rows sort last
    date_sort = 'DESC' if sort_order == 'newest' else 'ASC'
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Lightweight query - just id, date, month, file_type, current_path, width, height, rating for grid structure
        query = f"""
            SELECT 
                id,
                date_taken,
                file_type,
                current_path,
                width,
                height,
                rating
            FROM photos
            ORDER BY (date_taken IS NOT NULL) DESC, date_taken {date_sort}, current_path ASC
        """
        
        # Only add LIMIT if specified
        if limit:
            query += f" LIMIT ? OFFSET ?"
            cursor.execute(query, (limit, offset))
        else:
            cursor.execute(query)
        
        rows = cursor.fetchall()
        
        # Convert to list of dicts
        photos = []
        for row in rows:
            date_str = row['date_taken']
            month = month_key_for_photo_grid(date_str, row['current_path'])
            
            photos.append({
                'id': row['id'],
                'date': date_str,
                'month': month,
                'file_type': row['file_type'],
                'path': row['current_path'],
                'width': row['width'],
                'height': row['height'],
                'rating': row['rating'],  # NULL or 1-5
            })
        
        conn.close()
        return jsonify({'photos': photos, 'count': len(photos)})
    except Exception as e:
        app.logger.error(f"Error fetching photos: {e}")
        return jsonify({'error': str(e)}), 500
        
        conn.close()
        
        return jsonify({
            'photos': photos,
            'count': len(photos),
            'offset': offset,
            'limit': limit
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/photo/<int:photo_id>/dimensions')
@handle_db_corruption
def get_photo_dimensions(photo_id):
    """Get dimensions for a specific photo"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get photo path
        cursor.execute("SELECT current_path FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        conn.close()
        
        if not row:
            return jsonify({'error': 'Photo not found'}), 404
        
        # Get dimensions from file
        full_path = os.path.join(LIBRARY_PATH, row['current_path'])
        dimensions = get_image_dimensions(full_path)
        
        if dimensions:
            return jsonify({
                'id': photo_id,
                'width': dimensions[0],
                'height': dimensions[1]
            })
        else:
            return jsonify({'error': 'Could not read dimensions'}), 500
            
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/photo/<int:photo_id>/thumbnail')
@handle_db_corruption
def get_photo_thumbnail(photo_id):
    """
    Serve thumbnail for a photo (lazy generation + caching)
    - First request: generate 400px height thumbnail, cache to disk
    - Subsequent requests: serve cached version
    - Uses hash-based sharding: .thumbnails/{hash[:2]}/{hash[2:4]}/{hash}.jpg
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get photo path and hash
        cursor.execute("SELECT current_path, file_type, content_hash FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        conn.close()
        
        if not row:
            return jsonify({'error': 'Photo not found'}), 404
        
        relative_path = row['current_path']
        content_hash = row['content_hash']
        
        # Hash-based sharding: ab/cd/abcd1234....jpg
        shard_dir = os.path.join(THUMBNAIL_CACHE_DIR, content_hash[:2], content_hash[2:4])
        thumbnail_path = os.path.join(shard_dir, f"{content_hash}.jpg")
        
        # Serve cached thumbnail if it exists
        if os.path.exists(thumbnail_path):
            return send_file(thumbnail_path, mimetype='image/jpeg')
        
        # Generate thumbnail
        full_path = os.path.join(LIBRARY_PATH, relative_path)
        
        if not os.path.exists(full_path):
            return jsonify({'error': 'File not found on disk'}), 404
        
        # Ensure shard directory exists
        os.makedirs(shard_dir, exist_ok=True)
        
        # Only generate thumbnails for images (not videos for now)
        if row['file_type'] == 'video':
            # Generate video thumbnail using ffmpeg
            import subprocess
            
            # Create temp path for extracted frame
            temp_frame = os.path.join(shard_dir, f"temp_{photo_id}.jpg")
            
            # Extract first frame using ffmpeg - get larger size first
            cmd = [
                'ffmpeg',
                '-i', full_path,
                '-vframes', '1',
                '-vf', 'scale=800:-1',  # Get 800px width
                '-y',
                temp_frame
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode != 0 or not os.path.exists(temp_frame):
                return jsonify({'error': 'Failed to extract video frame'}), 500
            
            # Center-crop to 400x400 square
            with Image.open(temp_frame) as img:
                # Capture ICC profile before any conversions
                icc_profile = img.info.get('icc_profile')
                
                # Convert to RGB with proper color space handling
                img = convert_to_rgb_properly(img)
                
                target_size = 400
                
                # Resize so smallest dimension is 400px
                width, height = img.size
                if width < height:
                    new_width = target_size
                    new_height = int(height * (target_size / width))
                else:
                    new_height = target_size
                    new_width = int(width * (target_size / height))
                
                img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
                
                # Center crop to square
                left = (img.width - target_size) // 2
                top = (img.height - target_size) // 2
                img = img.crop((left, top, left + target_size, top + target_size))
                
                # Save with ICC profile preserved
                save_kwargs = {'format': 'JPEG', 'quality': 85, 'optimize': True}
                if icc_profile:
                    save_kwargs['icc_profile'] = icc_profile
                img.save(thumbnail_path, **save_kwargs)
            
            # Clean up temp file
            os.remove(temp_frame)
            
            return send_file(thumbnail_path, mimetype='image/jpeg')
        
        # Generate thumbnail for images - center-crop to 400x400 square
        with Image.open(full_path) as img:
            # Apply EXIF orientation (fixes rotation issues)
            img = img.copy()  # Make a copy to avoid modifying original
            try:
                # ImageOps.exif_transpose handles all EXIF orientation cases
                from PIL import ImageOps
                img = ImageOps.exif_transpose(img)
            except Exception:
                pass  # If no EXIF or error, continue without rotation fix
            
            # Capture ICC profile BEFORE any conversions (prevents washed-out thumbnails)
            icc_profile = img.info.get('icc_profile')
            
            # Convert to RGB with proper color space handling
            img = convert_to_rgb_properly(img)
            
            target_size = 400
            
            # Resize so smallest dimension is 400px
            width, height = img.size
            if width < height:
                new_width = target_size
                new_height = int(height * (target_size / width))
            else:
                new_height = target_size
                new_width = int(width * (target_size / height))
            
            img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
            
            # Center crop to square
            left = (img.width - target_size) // 2
            top = (img.height - target_size) // 2
            img = img.crop((left, top, left + target_size, top + target_size))
            
            # Save to cache WITH ICC profile preserved (critical for color accuracy)
            save_kwargs = {'format': 'JPEG', 'quality': 85, 'optimize': True}
            if icc_profile:
                save_kwargs['icc_profile'] = icc_profile
            img.save(thumbnail_path, **save_kwargs)
            
            # Serve the newly generated thumbnail
            return send_file(thumbnail_path, mimetype='image/jpeg')
            
    except Exception as e:
        print(f"❌ Error generating thumbnail for photo {photo_id}: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/photo/<int:photo_id>/file')
@handle_db_corruption
def get_photo_file(photo_id):
    """Serve the actual photo/video file (convert HEIC to JPEG on-the-fly)"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get photo path
        cursor.execute("SELECT current_path, file_type FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        conn.close()
        
        if not row:
            return jsonify({'error': 'Photo not found'}), 404
        
        # Get full path
        full_path = os.path.join(LIBRARY_PATH, row['current_path'])
        
        if not os.path.exists(full_path):
            return jsonify({'error': 'File not found on disk'}), 404
        
        # Check if HEIC or TIF - convert to JPEG
        ext = os.path.splitext(full_path)[1].lower()
        if ext in ['.heic', '.heif', '.tif', '.tiff']:
            from io import BytesIO
            from flask import send_file
            
            # Open and convert to JPEG
            with Image.open(full_path) as img:
                # Convert to RGB if needed
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                
                # Save as JPEG to memory
                buffer = BytesIO()
                img.save(buffer, format='JPEG', quality=95)
                buffer.seek(0)
                
                return send_file(buffer, mimetype='image/jpeg')
        
        # For other formats, serve directly
        directory = os.path.dirname(full_path)
        filename = os.path.basename(full_path)
        
        return send_from_directory(directory, filename)
            
    except Exception as e:
        print(f"Error serving photo {photo_id}: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/photo/<int:photo_id>/rotate', methods=['POST'])
@handle_db_corruption
def rotate_photo(photo_id):
    """Rotate a still image 90/180/270 degrees counterclockwise."""
    conn = None
    temp_path = None
    request_started_at = time.perf_counter()

    try:
        payload = request.get_json(silent=True) or {}
        degrees_ccw = normalize_rotation_degrees(int(payload.get('degrees_ccw', 90)))
        commit_lossy = bool(payload.get('commit_lossy', False))
        print(
            f"🔄 Rotate request: photo={photo_id} degrees={degrees_ccw}° CCW "
            f"commit_lossy={commit_lossy}"
        )

        if degrees_ccw == 0:
            print("   ↪ No-op rotate request; skipping")
            return jsonify(
                {
                    'ok': True,
                    'committed': False,
                    'staged': False,
                    'message': 'No rotation needed',
                }
            )

        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, current_path, date_taken, file_type, content_hash, original_filename, width, height
            FROM photos
            WHERE id = ?
            """,
            (photo_id,),
        )
        row = cursor.fetchone()
        if not row:
            return jsonify({'error': 'Photo not found'}), 404

        if row['file_type'] == 'video':
            print("   ❌ Rotation rejected: file is a video")
            return (
                jsonify(
                    {
                        'error': 'Rotation is not available for videos',
                        'reason': 'video',
                    }
                ),
                400,
            )

        full_path = os.path.join(LIBRARY_PATH, row['current_path'])
        if not os.path.exists(full_path):
            return jsonify({'error': 'File not found on disk'}), 404

        ext = os.path.splitext(full_path)[1].lower()
        if ext not in ROTATION_SUPPORTED_EXTENSIONS:
            print(f"   ❌ Rotation rejected: unsupported format {ext}")
            return (
                jsonify(
                    {
                        'error': 'Rotation is not available for this file type',
                        'reason': 'unsupported_format',
                    }
                ),
                400,
            )

        orientation = get_orientation_flag(full_path)
        print(
            f"   📷 Source: path={row['current_path']} ext={ext} "
            f"hash={row['content_hash']} orientation={orientation}"
        )
        if not commit_lossy:
            lossless_check_started_at = time.perf_counter()
            can_commit_losslessly = orientation in (None, 1) and can_rotate_losslessly(
                full_path,
                degrees_ccw,
            )
            lossless_check_elapsed_ms = (
                time.perf_counter() - lossless_check_started_at
            ) * 1000
            print(
                "   ✅ Immediate save path: lossless commit"
                if can_commit_losslessly
                else "   📝 Immediate save path unavailable: staging until lightbox close"
            )
            print(
                f"   ⏱️ Lossless eligibility check: {lossless_check_elapsed_ms:.1f} ms"
            )
        else:
            can_commit_losslessly = False
            print("   💾 Close-lightbox save: skipping staging check and committing now")

        if not can_commit_losslessly and not commit_lossy:
            request_elapsed_ms = (time.perf_counter() - request_started_at) * 1000
            print("   📝 Returning staged response to frontend (lossy fallback deferred)")
            print(f"   ⏱️ Rotate request handled in {request_elapsed_ms:.1f} ms")
            return jsonify(
                {
                    'ok': True,
                    'committed': False,
                    'staged': True,
                    'lossless': False,
                    'reason': 'lossy_fallback_required',
                }
            )

        rotate_started_at = time.perf_counter()
        rotation_result = rotate_file_in_place(
            full_path,
            degrees_ccw,
            allow_lossy_fallback=commit_lossy,
            jpeg_quality=JPEG_LOSSY_QUALITY,
        )
        rotate_elapsed_ms = (time.perf_counter() - rotate_started_at) * 1000
        if not rotation_result.success:
            status_code = 409 if not commit_lossy else 500
            print(f"   ❌ Rotation failed during commit: {rotation_result.message}")
            print(f"   ⏱️ Rotate attempt failed after {rotate_elapsed_ms:.1f} ms")
            return jsonify({'error': rotation_result.message}), status_code
        print(
            f"   💾 Rotation committed via "
            f"{'lossless' if rotation_result.lossless else f'lossy JPEG @ {JPEG_LOSSY_QUALITY}'} path"
        )
        print(f"   ⏱️ File rotation took {rotate_elapsed_ms:.1f} ms")
        old_hash = row['content_hash']
        finalize_result = finalize_mutated_media(
            conn=conn,
            photo_id=photo_id,
            library_path=LIBRARY_PATH,
            current_rel_path=row['current_path'],
            date_taken=row['date_taken'],
            old_hash=old_hash,
            build_canonical_path=build_canonical_photo_path,
            compute_hash=compute_full_hash,
            get_dimensions=get_image_dimensions,
            delete_thumbnail_for_hash=delete_thumbnail_for_hash,
            duplicate_policy='trash',
            duplicate_trash_dir=os.path.join(TRASH_DIR, 'duplicates'),
        )
        conn.commit()
        conn.close()
        conn = None
        request_elapsed_ms = (time.perf_counter() - request_started_at) * 1000
        if finalize_result.status == 'duplicate_removed':
            print(
                f"   ✅ Rotate finalized as duplicate: photo={photo_id} "
                f"matched photo={finalize_result.duplicate.photo_id if finalize_result.duplicate else 'unknown'}"
            )
            print(f"   ⏱️ Rotate request returned in {request_elapsed_ms:.1f} ms")
            return jsonify(
                {
                    'ok': True,
                    'committed': True,
                    'staged': False,
                    'duplicate_removed': True,
                    'message': 'Photo became a duplicate after rotation and was moved to trash',
                }
            )

        print(
            f"   ✅ Rotate complete: photo={photo_id} "
            f"{'immediate lossless save' if rotation_result.lossless else 'saved on leave-lightbox via lossy fallback'}; "
            f"final hash/path committed"
        )
        print(f"   ⏱️ Rotate request returned in {request_elapsed_ms:.1f} ms")

        return jsonify(
            {
                'ok': True,
                'committed': True,
                'staged': False,
                'lossless': rotation_result.lossless,
                'reconcile_pending': False,
                'message': rotation_result.message,
                'photo': {
                    'id': photo_id,
                    'path': finalize_result.current_path,
                    'width': finalize_result.width,
                    'height': finalize_result.height,
                    'content_hash': finalize_result.content_hash,
                },
            }
        )
    except ValueError as e:
        print(f"❌ Rotate request rejected: {e}")
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        print(f"Error rotating photo {photo_id}: {e}")
        if conn:
            conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        if conn:
            conn.close()

def cleanup_empty_folders(file_path, library_root):
    """
    Delete folders that contain no media files, working up the directory tree.
    Non-media files are deleted along with folders (scorched earth approach).
    Stops at library root or when a folder with media is found.
    """
    # v223: Use global constant - was missing .webp/.avif/.jp2/RAW formats (BUG FIX)
    MEDIA_EXTS = ALL_MEDIA_EXTENSIONS
    
    # Start at parent directory of deleted file
    current_dir = os.path.dirname(file_path)
    library_root_abs = os.path.abspath(library_root)
    
    while True:
        current_dir_abs = os.path.abspath(current_dir)
        
        # Safety: never delete library root
        if current_dir_abs == library_root_abs:
            break
            
        # Safety: don't escape library root
        if not current_dir_abs.startswith(library_root_abs):
            break
        
        try:
            # Check if directory still exists (might have been deleted already)
            if not os.path.exists(current_dir):
                break
            
            # Check if any media files exist
            entries = os.listdir(current_dir)
            has_media = False
            
            for entry in entries:
                entry_path = os.path.join(current_dir, entry)
                
                # Skip hidden files/dirs
                if entry.startswith('.'):
                    continue
                    
                # If has subdirectories, keep it (process bottom-up)
                if os.path.isdir(entry_path):
                    has_media = True
                    break
                
                # Check if it's a media file
                if os.path.isfile(entry_path):
                    ext = os.path.splitext(entry)[1].lower()
                    if ext in MEDIA_EXTS:
                        has_media = True
                        break
            
            # If no media (only non-media files or empty), DELETE IT ALL
            if not has_media:
                shutil.rmtree(current_dir)
                rel_path = os.path.relpath(current_dir, library_root)
                print(f"    ✓ Deleted empty folder: {rel_path}")
                
                # Move up to parent and continue
                current_dir = os.path.dirname(current_dir)
            else:
                # Has media or subdirs, stop here
                break
                
        except Exception as e:
            # Don't fail delete operation if cleanup fails
            print(f"    ⚠️  Cleanup failed for {os.path.relpath(current_dir, library_root)}: {e}")
            break

def cleanup_empty_thumbnail_folders(thumbnail_path):
    """
    Delete empty thumbnail shard folders after removing a thumbnail.
    
    Thumbnail structure: .thumbnails/ab/cd/abcd1234.jpg
    After deleting abcd1234.jpg, check if cd/ is empty, then ab/
    
    Args:
        thumbnail_path: Full path to the deleted thumbnail file
    """
    try:
        # Get parent directories (2 levels)
        shard2_dir = os.path.dirname(thumbnail_path)  # .thumbnails/ab/cd/
        shard1_dir = os.path.dirname(shard2_dir)      # .thumbnails/ab/
        
        # Try removing level-2 shard (cd/)
        if os.path.exists(shard2_dir):
            try:
                # Check if empty (no files, no subdirs)
                if len(os.listdir(shard2_dir)) == 0:
                    os.rmdir(shard2_dir)
                    print(f"    ✓ Cleaned up empty thumbnail shard: {os.path.basename(shard2_dir)}/")
            except OSError:
                pass  # Not empty or permission issue, ignore
        
        # Try removing level-1 shard (ab/)
        if os.path.exists(shard1_dir):
            try:
                if len(os.listdir(shard1_dir)) == 0:
                    os.rmdir(shard1_dir)
                    print(f"    ✓ Cleaned up empty thumbnail shard: {os.path.basename(shard1_dir)}/")
            except OSError:
                pass  # Not empty or permission issue, ignore
                
    except Exception as e:
        # Never fail the operation if cleanup fails
        print(f"    ⚠️  Thumbnail folder cleanup failed: {e}")

@app.route('/api/photos/delete', methods=['POST'])
@handle_db_corruption
def delete_photos():
    """Delete photos (move to .trash/ and move DB record to deleted_photos table)"""
    try:
        data = request.get_json()
        photo_ids = data.get('photo_ids', [])
        
        if not photo_ids:
            return jsonify({'error': 'No photo IDs provided'}), 400
        
        # Create backup before deleting photos
        print(f"\n💾 Creating database backup before delete...")
        backup_path = create_db_backup()
        if backup_path:
            print(f"  ✅ Backup created: {os.path.basename(backup_path)}")
        else:
            print(f"  ⚠️  Backup failed, but continuing with delete")
        
        print(f"\n🗑️  DELETE REQUEST: {len(photo_ids)} photos", flush=True)
        print(f"    Photo IDs: {photo_ids}", flush=True)
        app.logger.info(f"Delete request: {len(photo_ids)} photos (IDs: {photo_ids})")
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Ensure deleted_photos table exists (create if missing)
        from db_schema import DELETED_PHOTOS_TABLE_SCHEMA
        cursor.execute(DELETED_PHOTOS_TABLE_SCHEMA)
        
        deleted_count = 0
        errors = []
        trash_dir = TRASH_DIR
        os.makedirs(trash_dir, exist_ok=True)
        
        from datetime import datetime
        import json
        
        print(f"    Starting delete loop for {len(photo_ids)} photos...", flush=True)
        
        for photo_id in photo_ids:
            try:
                print(f"    Processing photo_id: {photo_id}", flush=True)
                # Get full photo record
                cursor.execute("SELECT * FROM photos WHERE id = ?", (photo_id,))
                row = cursor.fetchone()
                
                if not row:
                    print(f"    ❌ Photo {photo_id} NOT FOUND in database")
                    errors.append(f"Photo {photo_id} not found")
                    continue
                
                # Convert row to dict
                photo_data = dict(row)
                current_path = photo_data['current_path']
                full_path = os.path.join(LIBRARY_PATH, current_path)
                
                print(f"  - Photo {photo_id}: {current_path}")
                
                # Move file to .trash/
                trash_filename = None
                if os.path.exists(full_path):
                    filename = os.path.basename(full_path)
                    trash_path = os.path.join(trash_dir, filename)
                    
                    # Handle duplicate filenames in trash
                    counter = 1
                    base_name, ext = os.path.splitext(filename)
                    while os.path.exists(trash_path):
                        trash_filename_candidate = f"{base_name}_{counter}{ext}"
                        trash_path = os.path.join(trash_dir, trash_filename_candidate)
                        counter += 1
                    
                    trash_filename = os.path.basename(trash_path)
                    shutil.move(full_path, trash_path)
                    print(f"    ✓ Moved to: {trash_path}")
                    
                    # Cleanup empty folders after successful delete
                    cleanup_empty_folders(full_path, LIBRARY_PATH)
                else:
                    print(f"    ⚠️  Original file not found: {full_path}")
                    trash_filename = os.path.basename(full_path)  # Store original name
                
                # Delete thumbnail cache (hash-based)
                content_hash = photo_data.get('content_hash')
                if content_hash:
                    shard_dir = os.path.join(THUMBNAIL_CACHE_DIR, content_hash[:2], content_hash[2:4])
                    thumbnail_path = os.path.join(shard_dir, f"{content_hash}.jpg")
                    
                    if os.path.exists(thumbnail_path):
                        os.remove(thumbnail_path)
                        cleanup_empty_thumbnail_folders(thumbnail_path)
                        print(f"    ✓ Deleted thumbnail")
                
                # Move DB record to deleted_photos table
                deleted_at = datetime.now().isoformat()
                cursor.execute("""
                    INSERT INTO deleted_photos (id, original_path, trash_filename, deleted_at, photo_data)
                    VALUES (?, ?, ?, ?, ?)
                """, (photo_id, current_path, trash_filename, deleted_at, json.dumps(photo_data)))
                
                # Remove from photos table
                cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
                deleted_count += 1
                app.logger.info(f"Deleted photo {photo_id}: {current_path}")
                
            except Exception as e:
                errors.append(f"Error deleting photo {photo_id}: {str(e)}")
                print(f"    ❌ Error: {e}")
                error_logger.error(f"Delete failed for photo {photo_id}: {e}")
        
        conn.commit()
        conn.close()
        
        print(f"✅ Deleted {deleted_count} photos\n", flush=True)
        
        response = {
            'deleted': deleted_count,
            'total': len(photo_ids),
        }
        
        if errors:
            response['errors'] = errors
        
        return jsonify(response)
        
    except Exception as e:
        print(f"Delete error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/<path:path>')
def static_files(path):
    """Serve all other static files"""
    return send_from_directory(STATIC_DIR, path)

@app.route('/api/photo/<int:photo_id>/reveal', methods=['POST'])
@handle_db_corruption
def reveal_in_finder(photo_id):
    """Reveal photo in Finder"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT current_path FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        conn.close()

        if not row:
            return jsonify({'error': 'Photo not found'}), 404

        relative_path = row['current_path']
        full_path = os.path.join(LIBRARY_PATH, relative_path)

        if not os.path.exists(full_path):
            return jsonify({'error': 'File not found on disk'}), 404

        # Use macOS 'open -R' to reveal in Finder
        subprocess.run(['open', '-R', full_path], check=True)
        
        return jsonify({'status': 'success'})
    except Exception as e:
        app.logger.error(f"Error revealing file in Finder: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/photo/update_date', methods=['POST'])
@handle_db_corruption
def update_photo_date():
    """Update photo date with full file operations (EXIF + rename + move)"""
    try:
        data = request.get_json()
        photo_id = data.get('photo_id')
        new_date = data.get('new_date')  # Format: YYYY:MM:DD HH:MM:SS
        
        if not photo_id or not new_date:
            return jsonify({'error': 'Missing photo_id or new_date'}), 400
        
        if app.config['DRY_RUN_DATE_EDIT']:
            print(f"\n🔍 DRY RUN - Would update photo {photo_id} date to: {new_date}")
            return jsonify({'status': 'success', 'dry_run': True, 'new_date': new_date})
        
        # Update with full file operations
        conn = get_db_connection()
        success, result, transaction = update_photo_date_with_files(photo_id, new_date, conn)
        
        if success:
            conn.commit()
            conn.close()
            print(f"✅ Updated photo {photo_id} with file operations")
            if result['status'] == 'duplicate_removed':
                return jsonify({
                    'status': 'success',
                    'new_date': new_date,
                    'duplicate_removed': True,
                    'message': 'Photo became a duplicate after updating date and was moved to trash'
                })
            return jsonify({
                'status': 'success',
                'new_date': new_date,
                'photo': {
                    'path': result['current_path'],
                    'content_hash': result['content_hash'],
                },
            })
        else:
            # Rollback transaction
            transaction.rollback(LIBRARY_PATH)
            conn.rollback()
            conn.close()
            
            return jsonify({
                'status': 'error',
                'error': result['error'],
                'failed_files': transaction.failed_files
            }), 500
            
    except Exception as e:
        app.logger.error(f"Error updating photo date: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/photos/bulk_update_date', methods=['POST'])
@handle_db_corruption
def bulk_update_photo_dates():
    """Bulk update photo dates with full file operations"""
    try:
        data = request.get_json()
        photo_ids = data.get('photo_ids', [])
        new_date = data.get('new_date')  # Format: YYYY:MM:DD HH:MM:SS
        mode = data.get('mode', 'shift')  # 'shift', 'same', or 'sequence'
        
        if not photo_ids or not new_date:
            return jsonify({'error': 'Missing photo_ids or new_date'}), 400
        
        if app.config['DRY_RUN_DATE_EDIT']:
            print(f"\n🔍 DRY RUN - Would update {len(photo_ids)} photos in {mode} mode")
            return jsonify({'status': 'success', 'dry_run': True})
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        from datetime import datetime, timedelta
        
        # Calculate target date for each photo based on mode
        photo_date_map = {}  # photo_id -> target_date_str
        
        if mode == 'same':
            # Set all photos to the same date
            for photo_id in photo_ids:
                photo_date_map[photo_id] = new_date
        
        elif mode == 'shift':
            # Shift all photos by the offset from the first photo
            cursor.execute("SELECT date_taken FROM photos WHERE id = ?", (photo_ids[0],))
            row = cursor.fetchone()
            if not row:
                return jsonify({'error': 'First photo not found'}), 404
            
            original_date_str = row['date_taken']
            original_date = datetime.strptime(original_date_str, '%Y:%m:%d %H:%M:%S')
            new_date_obj = datetime.strptime(new_date, '%Y:%m:%d %H:%M:%S')
            offset = new_date_obj - original_date
            
            # Calculate shifted date for each photo
            for photo_id in photo_ids:
                cursor.execute("SELECT date_taken FROM photos WHERE id = ?", (photo_id,))
                row = cursor.fetchone()
                if row:
                    photo_date = datetime.strptime(row['date_taken'], '%Y:%m:%d %H:%M:%S')
                    shifted_date = photo_date + offset
                    photo_date_map[photo_id] = shifted_date.strftime('%Y:%m:%d %H:%M:%S')
        
        elif mode == 'sequence':
            # Sequence photos with interval
            interval_amount = data.get('interval_amount', 5)
            interval_unit = data.get('interval_unit', 'minutes')
            
            # Convert interval to timedelta
            if interval_unit == 'seconds':
                interval = timedelta(seconds=interval_amount)
            elif interval_unit == 'minutes':
                interval = timedelta(minutes=interval_amount)
            elif interval_unit == 'hours':
                interval = timedelta(hours=interval_amount)
            else:
                return jsonify({'error': 'Invalid interval unit'}), 400
            
            # Get all photos with their original dates
            photo_dates = []
            for photo_id in photo_ids:
                cursor.execute("SELECT date_taken FROM photos WHERE id = ?", (photo_id,))
                row = cursor.fetchone()
                if row:
                    original_date = datetime.strptime(row['date_taken'], '%Y:%m:%d %H:%M:%S')
                    photo_dates.append((photo_id, original_date))
            
            # Sort by original date
            photo_dates.sort(key=lambda x: x[1])
            
            # Apply sequence
            base_date = datetime.strptime(new_date, '%Y:%m:%d %H:%M:%S')
            for index, (photo_id, _) in enumerate(photo_dates):
                sequenced_date = base_date + (interval * index)
                photo_date_map[photo_id] = sequenced_date.strftime('%Y:%m:%d %H:%M:%S')
        
        # Now process all photos with file operations
        master_transaction = DateEditTransaction()
        success_count = 0
        duplicate_count = 0
        
        for photo_id, target_date in photo_date_map.items():
            success, result, transaction = update_photo_date_with_files(photo_id, target_date, conn)
            
            if success:
                if result['status'] == 'duplicate_removed':
                    duplicate_count += 1
                else:
                    success_count += 1
                    # Merge this transaction into master
                    master_transaction.operations.extend(transaction.operations)
            else:
                # Log failure
                cursor.execute("SELECT current_path FROM photos WHERE id = ?", (photo_id,))
                row = cursor.fetchone()
                filename = os.path.basename(row['current_path']) if row else f"photo_{photo_id}"
                master_transaction.log_failure(filename, result['error'])
        
        # Check results
        if master_transaction.failed_files:
            # At least one failure - rollback EVERYTHING
            print(f"❌ {len(master_transaction.failed_files)} failures - rolling back all changes")
            master_transaction.rollback(LIBRARY_PATH)
            conn.rollback()
            conn.close()
            
            return jsonify({
                'status': 'error',
                'message': f'Failed to update {len(master_transaction.failed_files)} of {len(photo_ids)} files',
                'failed_count': len(master_transaction.failed_files),
                'total_count': len(photo_ids),
                'failed_files': master_transaction.failed_files
            }), 500
        else:
            # All succeeded - commit
            conn.commit()
            conn.close()
            if duplicate_count > 0:
                print(f"✅ Updated {success_count} photos, {duplicate_count} duplicates moved to trash")
            else:
                print(f"✅ Updated {success_count} photos with file operations")
            return jsonify({
                'status': 'success',
                'updated_count': success_count,
                'duplicate_count': duplicate_count,
            })
            
    except Exception as e:
        app.logger.error(f"Error bulk updating photo dates: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/photo/update_date/execute', methods=['GET'])
@handle_db_corruption
def update_photo_date_execute():
    """Update single photo date with SSE progress streaming"""
    def generate():
        try:
            # Get request data from query parameters (EventSource only supports GET)
            photo_id = int(request.args.get('photo_id'))
            new_date = request.args.get('new_date')  # Format: YYYY:MM:DD HH:MM:SS
            
            if not photo_id or not new_date:
                yield f"event: error\ndata: {json.dumps({'error': 'Missing photo_id or new_date'})}\n\n"
                return
            
            if app.config.get('DRY_RUN_DATE_EDIT'):
                print(f"\n🔍 DRY RUN - Would update photo {photo_id} date to: {new_date}")
                yield f"event: complete\ndata: {json.dumps({'dry_run': True, 'updated_count': 1})}\n\n"
                return
            
            # Send initial progress
            yield f"event: progress\ndata: {json.dumps({'current': 0, 'total': 1, 'phase': 'starting'})}\n\n"
            
            # Update with full file operations
            conn = get_db_connection()
            success, result, transaction = update_photo_date_with_files(photo_id, new_date, conn)
            
            if success:
                conn.commit()
                conn.close()
                print(f"✅ Updated photo {photo_id} with file operations")
                
                # Send completion
                if result['status'] == 'duplicate_removed':
                    yield f"event: complete\ndata: {json.dumps({'updated_count': 0, 'duplicate_count': 1, 'photo_id': photo_id, 'duplicate_removed': True})}\n\n"
                else:
                    yield f"event: complete\ndata: {json.dumps({'updated_count': 1, 'duplicate_count': 0, 'photo_id': photo_id})}\n\n"
            else:
                # Rollback transaction
                transaction.rollback(LIBRARY_PATH)
                conn.rollback()
                conn.close()
                
                yield f"event: error\ndata: {json.dumps({'error': result['error'], 'failed_files': transaction.failed_files})}\n\n"
                
        except Exception as e:
            error_logger.error(f"Error updating photo date: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')

@app.route('/api/photos/bulk_update_date/execute', methods=['GET'])
@handle_db_corruption
def bulk_update_photo_dates_execute():
    """Bulk update photo dates with SSE progress streaming"""
    def generate():
        try:
            # Get request data from query parameters (EventSource only supports GET)
            photo_ids_str = request.args.get('photo_ids')
            new_date = request.args.get('new_date')  # Format: YYYY:MM:DD HH:MM:SS
            mode = request.args.get('mode', 'shift')  # 'shift', 'same', or 'sequence'
            
            if not photo_ids_str or not new_date:
                yield f"event: error\ndata: {json.dumps({'error': 'Missing photo_ids or new_date'})}\n\n"
                return
            
            photo_ids = json.loads(photo_ids_str)
            
            if app.config.get('DRY_RUN_DATE_EDIT'):
                print(f"\n🔍 DRY RUN - Would update {len(photo_ids)} photos in {mode} mode")
                yield f"event: complete\ndata: {json.dumps({'dry_run': True, 'updated_count': len(photo_ids)})}\n\n"
                return
            
            conn = get_db_connection()
            cursor = conn.cursor()
            
            from datetime import datetime, timedelta
            
            # Calculate target date for each photo based on mode
            photo_date_map = {}  # photo_id -> target_date_str
            
            if mode == 'same':
                # Set all photos to the same date
                for photo_id in photo_ids:
                    photo_date_map[photo_id] = new_date
            
            elif mode == 'shift':
                # Shift all photos by the offset from the first photo
                cursor.execute("SELECT date_taken FROM photos WHERE id = ?", (photo_ids[0],))
                row = cursor.fetchone()
                if not row:
                    yield f"event: error\ndata: {json.dumps({'error': 'First photo not found'})}\n\n"
                    return
                
                original_date_str = row['date_taken']
                original_date = datetime.strptime(original_date_str, '%Y:%m:%d %H:%M:%S')
                new_date_obj = datetime.strptime(new_date, '%Y:%m:%d %H:%M:%S')
                offset = new_date_obj - original_date
                
                # Calculate shifted date for each photo
                for photo_id in photo_ids:
                    cursor.execute("SELECT date_taken FROM photos WHERE id = ?", (photo_id,))
                    row = cursor.fetchone()
                    if row:
                        photo_date = datetime.strptime(row['date_taken'], '%Y:%m:%d %H:%M:%S')
                        shifted_date = photo_date + offset
                        photo_date_map[photo_id] = shifted_date.strftime('%Y:%m:%d %H:%M:%S')
            
            elif mode == 'sequence':
                # Sequence photos with interval
                interval_amount = int(request.args.get('interval_amount', 5))
                interval_unit = request.args.get('interval_unit', 'minutes')
                
                # Convert interval to timedelta
                if interval_unit == 'seconds':
                    interval = timedelta(seconds=interval_amount)
                elif interval_unit == 'minutes':
                    interval = timedelta(minutes=interval_amount)
                elif interval_unit == 'hours':
                    interval = timedelta(hours=interval_amount)
                else:
                    yield f"event: error\ndata: {json.dumps({'error': 'Invalid interval unit'})}\n\n"
                    return
                
                # Get all photos with their original dates
                photo_dates = []
                for photo_id in photo_ids:
                    cursor.execute("SELECT date_taken FROM photos WHERE id = ?", (photo_id,))
                    row = cursor.fetchone()
                    if row:
                        original_date = datetime.strptime(row['date_taken'], '%Y:%m:%d %H:%M:%S')
                        photo_dates.append((photo_id, original_date))
                
                # Sort by original date
                photo_dates.sort(key=lambda x: x[1])
                
                # Apply sequence
                base_date = datetime.strptime(new_date, '%Y:%m:%d %H:%M:%S')
                for index, (photo_id, _) in enumerate(photo_dates):
                    sequenced_date = base_date + (interval * index)
                    photo_date_map[photo_id] = sequenced_date.strftime('%Y:%m:%d %H:%M:%S')
            
            # Now process all photos with file operations and stream progress
            master_transaction = DateEditTransaction()
            success_count = 0
            duplicate_count = 0
            total = len(photo_date_map)
            
            print(f"🔍 DEBUG: photo_date_map has {total} entries")
            print(f"🔍 DEBUG: photo_date_map keys type: {type(list(photo_date_map.keys())[0]) if photo_date_map else 'empty'}")
            
            for idx, (photo_id, target_date) in enumerate(photo_date_map.items(), 1):
                print(f"🔍 Processing photo_id: {photo_id} (type: {type(photo_id)}), target_date: {target_date}")
                
                # Send progress update
                yield f"event: progress\ndata: {json.dumps({'current': idx, 'total': total, 'photo_id': photo_id})}\n\n"
                
                success, result, transaction = update_photo_date_with_files(photo_id, target_date, conn)
                
                if success:
                    if result['status'] == 'duplicate_removed':
                        # Photo became a duplicate during date change
                        duplicate_count += 1
                        print(f"  ⏭️  Photo {photo_id} is now a duplicate (moved to trash)")
                    else:
                        # Normal success
                        success_count += 1
                        # Merge this transaction into master
                        master_transaction.operations.extend(transaction.operations)
                else:
                    # Log failure
                    cursor.execute("SELECT current_path FROM photos WHERE id = ?", (photo_id,))
                    row = cursor.fetchone()
                    filename = os.path.basename(row['current_path']) if row else f"photo_{photo_id}"
                    master_transaction.log_failure(filename, result['error'])
            
            # Check results
            if master_transaction.failed_files:
                # At least one failure - rollback EVERYTHING
                print(f"❌ {len(master_transaction.failed_files)} failures - rolling back all changes")
                print(f"🔍 DEBUG: failed_files content: {master_transaction.failed_files}")
                print(f"🔍 DEBUG: failed_files types: {[type(f) for f in master_transaction.failed_files]}")
                
                master_transaction.rollback(LIBRARY_PATH)
                conn.rollback()
                conn.close()
                
                # Try to serialize and catch exact error
                try:
                    error_data = {
                        'error': 'Failed to update some photos', 
                        'failed_count': len(master_transaction.failed_files), 
                        'total_count': total, 
                        'failed_files': master_transaction.failed_files
                    }
                    error_json = json.dumps(error_data)
                    yield f"event: error\ndata: {error_json}\n\n"
                except TypeError as te:
                    print(f"❌ JSON serialization error in failed_files: {te}")
                    print(f"  failed_files: {master_transaction.failed_files}")
                    for i, f in enumerate(master_transaction.failed_files):
                        print(f"  Item {i}: type={type(f)}, value={f}")
                    raise
            else:
                # All succeeded - commit
                conn.commit()
                conn.close()
                
                if duplicate_count > 0:
                    print(f"✅ Updated {success_count} photos, {duplicate_count} duplicates moved to trash")
                else:
                    print(f"✅ Updated {success_count} photos with file operations")
                
                # Send completion - debug the response data
                try:
                    response_data = {'updated_count': success_count, 'duplicate_count': duplicate_count, 'total': total}
                    response_json = json.dumps(response_data)
                    yield f"event: complete\ndata: {response_json}\n\n"
                except TypeError as te:
                    print(f"❌ JSON serialization error: {te}")
                    print(f"  success_count type: {type(success_count)}, value: {success_count}")
                    print(f"  duplicate_count type: {type(duplicate_count)}, value: {duplicate_count}")
                    print(f"  total type: {type(total)}, value: {total}")
                    raise
                
        except Exception as e:
            error_logger.error(f"Error bulk updating photo dates: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')

@app.route('/api/photos/restore', methods=['POST'])
@handle_db_corruption
def restore_photos():
    """Restore photos from trash back to library"""
    try:
        data = request.get_json()
        photo_ids = data.get('photo_ids', [])
        
        if not photo_ids:
            return jsonify({'error': 'No photo IDs provided'}), 400
        
        print(f"\n↩️  RESTORE REQUEST: {len(photo_ids)} photos")
        print(f"    Photo IDs: {photo_ids}")
        app.logger.info(f"Restore request: {len(photo_ids)} photos (IDs: {photo_ids})")
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        restored_count = 0
        errors = []
        trash_dir = TRASH_DIR
        
        import json
        
        for photo_id in photo_ids:
            try:
                # Get deleted photo record
                cursor.execute("SELECT * FROM deleted_photos WHERE id = ?", (photo_id,))
                row = cursor.fetchone()
                
                if not row:
                    print(f"    ❌ Photo {photo_id} not found in trash")
                    errors.append(f"Photo {photo_id} not found in trash")
                    continue
                
                deleted_data = dict(row)
                original_path = deleted_data['original_path']
                trash_filename = deleted_data['trash_filename']
                photo_data = json.loads(deleted_data['photo_data'])
                
                print(f"  - Photo {photo_id}: {original_path}")
                
                # Move file back from trash
                trash_path = os.path.join(trash_dir, trash_filename)
                full_path = os.path.join(LIBRARY_PATH, original_path)
                
                if os.path.exists(trash_path):
                    # Ensure directory exists
                    os.makedirs(os.path.dirname(full_path), exist_ok=True)
                    
                    # Move file back
                    shutil.move(trash_path, full_path)
                    print(f"    ✓ Restored to: {full_path}")
                else:
                    print(f"    ⚠️  File not found in trash: {trash_path}")
                    errors.append(f"Photo {photo_id} file not found in trash")
                    continue
                
                # Restore DB record to photos table
                # Build INSERT statement dynamically from photo_data
                columns = list(photo_data.keys())
                placeholders = ', '.join(['?' for _ in columns])
                values = [photo_data[col] for col in columns]
                
                cursor.execute(f"""
                    INSERT INTO photos ({', '.join(columns)})
                    VALUES ({placeholders})
                """, values)
                
                # Remove from deleted_photos table
                cursor.execute("DELETE FROM deleted_photos WHERE id = ?", (photo_id,))
                restored_count += 1
                app.logger.info(f"Restored photo {photo_id}: {original_path}")
                
            except Exception as e:
                errors.append(f"Error restoring photo {photo_id}: {str(e)}")
                print(f"    ❌ Error: {e}")
                error_logger.error(f"Restore failed for photo {photo_id}: {e}")
        
        conn.commit()
        conn.close()
        
        print(f"✅ Restored {restored_count} photos\n")
        
        response = {
            'restored': restored_count,
            'total': len(photo_ids),
        }
        
        if errors:
            response['errors'] = errors
        
        return jsonify(response)
        
    except Exception as e:
        app.logger.error(f"Restore error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/years')
@handle_db_corruption
def get_years():
    """Get list of all years that have photos"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Extract year from date_taken
        cursor.execute("""
            SELECT DISTINCT substr(date_taken, 1, 4) as year
            FROM photos
            WHERE date_taken IS NOT NULL
            ORDER BY year DESC
        """)
        
        rows = cursor.fetchall()
        years = [int(row['year']) for row in rows]
        
        conn.close()
        
        return jsonify({'years': years})
        
    except Exception as e:
        app.logger.error(f"Error fetching years: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/photos/nearest_month')
@handle_db_corruption
def get_nearest_month():
    """
    Find the nearest month with photos to a target month.
    Uses year-aware + directional landing strategy:
    - Prefers staying in target year if any photos exist in that year
    - Positions user for natural scrolling based on sort order
    """
    try:
        target_month = request.args.get('month')  # Format: YYYY-MM
        sort_order = request.args.get('sort', 'newest')
        
        if not target_month:
            return jsonify({'error': 'month parameter required (format: YYYY-MM)'}), 400
        
        target_year = target_month[:4]
        target_month_num = int(target_month[5:7])
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get all available months
        cursor.execute("""
            SELECT DISTINCT substr(date_taken, 1, 7) as month
            FROM photos
            WHERE date_taken IS NOT NULL
            ORDER BY month
        """)
        all_months = [row['month'] for row in cursor.fetchall()]
        conn.close()
        
        if not all_months:
            return jsonify({'error': 'No photos found in database'}), 404
        
        # Step 1: Check if target year has any photos
        year_months = [m for m in all_months if m[:4] == target_year]
        
        if year_months:
            # Target year exists - find natural entry point based on sort order
            if sort_order == 'newest':
                # For newest first: land at or after target month
                # (so user scrolls down to see earlier months in year)
                candidates = [m for m in year_months if int(m[5:7]) >= target_month_num]
                result = min(candidates) if candidates else max(year_months)
            else:
                # For oldest first: land at or before target month
                # (so user scrolls down to see later months in year)
                candidates = [m for m in year_months if int(m[5:7]) <= target_month_num]
                result = max(candidates) if candidates else min(year_months)
        else:
            # Target year doesn't exist - find closest month overall (ignore sort)
            def month_distance(m):
                m_year = int(m[:4])
                m_month = int(m[5:7])
                return abs((m_year * 12 + m_month) - (int(target_year) * 12 + target_month_num))
            
            result = min(all_months, key=month_distance)
        
        # Normalize month format from YYYY:MM to YYYY-MM
        normalized = result.replace(':', '-')
        return jsonify({'nearest_month': normalized})
        
    except Exception as e:
        app.logger.error(f"Error finding nearest month: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/photos/jump')
@handle_db_corruption
def jump_to_date():
    """Get photos starting from a specific year-month"""
    try:
        target_month = request.args.get('month')  # Format: YYYY-MM
        limit = request.args.get('limit', 500, type=int)
        sort_order = request.args.get('sort', 'newest')
        
        if not target_month:
            return jsonify({'error': 'month parameter required (format: YYYY-MM)'}), 400
        
        order_by = "DESC" if sort_order == 'newest' else "ASC"
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Fetch photos starting from target month
        # For newest first: get photos <= target month
        # For oldest first: get photos >= target month
        if sort_order == 'newest':
            query = f"""
                SELECT 
                    id,
                    current_path,
                    original_filename,
                    date_taken,
                    file_type,
                    width,
                    height
                FROM photos
                WHERE date_taken IS NOT NULL 
                  AND substr(date_taken, 1, 7) <= ?
                ORDER BY date_taken DESC, current_path ASC
                LIMIT ?
            """
        else:
            query = f"""
                SELECT 
                    id,
                    current_path,
                    original_filename,
                    date_taken,
                    file_type,
                    width,
                    height
                FROM photos
                WHERE date_taken IS NOT NULL 
                  AND substr(date_taken, 1, 7) >= ?
                ORDER BY date_taken ASC, current_path ASC
                LIMIT ?
            """
        
        cursor.execute(query, (target_month, limit))
        rows = cursor.fetchall()
        
        photos = []
        for row in rows:
            date_str = row['date_taken']
            if date_str:
                date_normalized = date_str.replace(':', '-', 2)
                month = date_normalized[:7]
            else:
                month = None
            
            photos.append({
                'id': row['id'],
                'path': row['current_path'],
                'filename': row['original_filename'],
                'date': date_str,
                'month': month,
                'file_type': row['file_type'],
                'width': row['width'],
                'height': row['height']
            })
        
        conn.close()
        return jsonify({'photos': photos, 'count': len(photos)})
        
    except Exception as e:
        app.logger.error(f"Error jumping to date: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/import/browse', methods=['POST'])
def browse_import():
    """Open native macOS file/folder picker for import"""
    try:
        data = request.json
        script = data.get('script')
        
        if not script:
            return jsonify({'error': 'No script provided'}), 400
        
        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=300
        )
        
        if result.returncode != 0:
            # User cancelled
            return jsonify({'status': 'cancelled'})
        
        # Parse paths from output
        # Handle both single path (string) and multiple paths (newline-separated)
        output = result.stdout.strip()
        if not output:
            return jsonify({'status': 'cancelled'})
        
        # Split by newlines for multiple selections
        paths = [p.strip() for p in output.split('\n') if p.strip()]
        
        return jsonify({
            'status': 'success',
            'paths': paths
        })
        
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Selection timeout'}), 408
    except Exception as e:
        error_logger.error(f"Browse import failed: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/import/scan-paths', methods=['POST'])
@handle_db_corruption
def scan_import_paths():
    """
    Scan selected paths (files and/or folders) and return list of media files
    Handles mixed selection: individual files + recursive folder scans
    """
    try:
        data = request.json
        paths = data.get('paths', [])
        
        if not paths:
            return jsonify({'error': 'No paths provided'}), 400
        
        print(f"\n🔍 Scanning {len(paths)} path(s)...")
        
        media_files = []
        files_count = 0
        folders_count = 0
        
        for path in paths:
            if not os.path.exists(path):
                print(f"  ⚠️  Path not found: {path}")
                continue
            
            if os.path.isfile(path):
                # Individual file
                _, ext = os.path.splitext(path)
                ext_lower = ext.lower()
                if ext_lower in PHOTO_EXTENSIONS or ext_lower in VIDEO_EXTENSIONS:
                    media_files.append(path)
                    files_count += 1
            
            elif os.path.isdir(path):
                # Folder - scan recursively
                folders_count += 1
                print(f"  📁 Scanning folder: {path}")
                
                for root, dirs, files in os.walk(path):
                    for filename in files:
                        _, ext = os.path.splitext(filename)
                        ext_lower = ext.lower()
                        if ext_lower in PHOTO_EXTENSIONS or ext_lower in VIDEO_EXTENSIONS:
                            full_path = os.path.join(root, filename)
                            media_files.append(full_path)
        
        print(f"  ✅ Found {len(media_files)} media files")
        print(f"     {files_count} direct file(s), {folders_count} folder(s) scanned")
        
        return jsonify({
            'status': 'success',
            'files': media_files,
            'total_count': len(media_files),
            'files_selected': files_count,
            'folders_scanned': folders_count
        })
        
    except Exception as e:
        error_logger.error(f"Scan paths failed: {e}")
        print(f"\n❌ Scan paths failed: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/debug/analyze-file-count', methods=['POST'])
@handle_db_corruption
def analyze_debug_file_count():
    """Analyze a folder for unique media, duplicates, and other files."""
    try:
        data = request.json or {}
        selected_path = data.get('path')

        if not selected_path:
            return jsonify({'error': 'No path provided'}), 400

        print(f"\n🧪 Debug file count analysis: {selected_path}")
        result = analyze_debug_file_count_path(selected_path)

        return jsonify({
            'status': 'success',
            'path': selected_path,
            'files': result.all_files,
            'file_buckets': result.file_buckets,
            'unique_media_count': result.unique_media_count,
            'duplicate_media_count': result.duplicate_media_count,
            'other_file_count': result.other_file_count,
        })
    except Exception as e:
        error_logger.error(f"Debug file count analysis failed: {e}")
        print(f"\n❌ Debug file count analysis failed: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/debug/scan-clean-library', methods=['POST'])
@handle_db_corruption
def debug_scan_clean_library():
    """
    Read-only clean-library scan for an arbitrary directory (dev sandbox).

    Uses the same scan_library_cleanliness rulebook as /api/library/make-perfect/scan,
    with library_path set to the picked folder so DB sidecars under that tree are used
    when present.
    """
    try:
        data = request.json or {}
        selected_path = data.get('path')

        if not selected_path:
            return jsonify({'error': 'No path provided'}), 400

        if not os.path.exists(selected_path):
            return jsonify({'error': 'Path not found'}), 400

        if not os.path.isdir(selected_path):
            return jsonify({'error': 'Path must be a directory'}), 400

        if not os.access(selected_path, os.R_OK | os.X_OK):
            return jsonify({'error': 'Path is not accessible'}), 503

        from make_library_perfect import scan_library_cleanliness

        abs_path = os.path.abspath(selected_path)
        print(f"\n🧪 DEBUG clean-library scan: {abs_path}\n")

        result = scan_library_cleanliness(abs_path, db_path=None)
        return jsonify(result)
    except Exception as e:
        error_logger.error(f"Debug clean-library scan failed: {e}")
        print(f"\n❌ Debug clean-library scan failed: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/photos/import-from-paths', methods=['POST'])
def import_from_paths():
    """
    Import photos from file paths (SSE streaming version with fixes)
    """
    def generate():
        conn = None
        client_disconnected = False

        def emit_event(event_name, payload):
            nonlocal client_disconnected

            if client_disconnected:
                return False

            try:
                yield f"event: {event_name}\ndata: {json.dumps(payload)}\n\n"
                return True
            except (BrokenPipeError, ConnectionError, GeneratorExit):
                client_disconnected = True
                return False

        try:
            data = request.json
            file_paths = data.get('paths', [])
            
            if not file_paths:
                yield from emit_event('error', {'error': 'No paths provided'})
                return
            
            total_files = len(file_paths)
            print(f"\n{'='*60}")
            print(f"📥 IMPORT FROM PATHS: {total_files} file(s)")
            print(f"LIBRARY_PATH: {LIBRARY_PATH}")
            print(f"DB_PATH: {DB_PATH}")
            print(f"{'='*60}\n")
            
            if not (yield from emit_event('start', {'total': total_files})):
                return
            
            # Track results
            imported_count = 0
            duplicate_count = 0
            error_count = 0
            
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # Initialize hash cache for this import
            hash_cache = HashCache(conn)
            
            for file_index, source_path in enumerate(file_paths, 1):
                if client_disconnected:
                    print(f"🛑 Import stream closed after {imported_count} imported file(s)")
                    break

                try:
                    if not os.path.exists(source_path):
                        print(f"{file_index}. ❌ File not found: {source_path}")
                        error_count += 1
                        if not (yield from emit_event('progress', {
                            'imported': imported_count,
                            'duplicates': duplicate_count,
                            'errors': error_count,
                            'current': file_index,
                            'total': total_files
                        })):
                            break
                        continue
                    
                    filename = os.path.basename(source_path)
                    print(f"{file_index}. Processing: {filename}")
                    
                    _, ext = os.path.splitext(filename)
                    file_type = 'video' if ext.lower() in VIDEO_EXTENSIONS else 'photo'

                    if file_type == 'photo':
                        staged_path = None
                        try:
                            staged_photo = stage_photo_for_canonicalization(
                                source_path,
                                temp_prefix='import_photo_',
                            )
                            staged_path = staged_photo.staged_path
                            canonical_photo = staged_photo.canonical_photo
                            print(f"   📦 Staged photo for canonicalization: {os.path.basename(staged_path)}")
                            print(
                                f"   🔎 Canonical photo: date={canonical_photo.date_taken} "
                                f"hash={canonical_photo.content_hash[:16]}... "
                                f"path={canonical_photo.relative_path}"
                            )

                            cursor.execute(
                                "SELECT id, current_path FROM photos WHERE content_hash = ?",
                                (canonical_photo.content_hash,),
                            )
                            existing = cursor.fetchone()
                            print(
                                f"   🔎 Import canonical preflight: source={source_path} "
                                f"final_hash={canonical_photo.content_hash} "
                                f"existing_match={existing['id'] if existing else None} "
                                f"existing_path={existing['current_path'] if existing else None}"
                            )

                            if existing:
                                print(f"   ⏭️  Duplicate (existing ID: {existing['id']})")
                                cleanup_staged_file(staged_path)
                                staged_path = None
                                duplicate_count += 1
                                if not (yield from emit_event('progress', {
                                    'imported': imported_count,
                                    'duplicates': duplicate_count,
                                    'errors': error_count,
                                    'current': file_index,
                                    'total': total_files
                                })):
                                    break
                                continue

                            relative_path = canonical_photo.relative_path
                            target_path = os.path.join(LIBRARY_PATH, relative_path)
                            if os.path.exists(target_path):
                                print(f"   ⏭️  Duplicate canonical path already exists: {relative_path}")
                                cleanup_staged_file(staged_path)
                                staged_path = None
                                duplicate_count += 1
                                if not (yield from emit_event('progress', {
                                    'imported': imported_count,
                                    'duplicates': duplicate_count,
                                    'errors': error_count,
                                    'current': file_index,
                                    'total': total_files
                                })):
                                    break
                                continue

                            photo_id, target_path = commit_staged_canonical_photo(
                                conn,
                                library_path=LIBRARY_PATH,
                                source_path=source_path,
                                original_filename=filename,
                                staged_photo=staged_photo,
                                remove_source_after_commit=False,
                            )
                            staged_path = None
                            print(f"   ✅ Canonical photo stored at: {relative_path}")
                            print(
                                f"   ✅ Imported canonical photo: photo_id={photo_id} "
                                f"path={relative_path} hash={canonical_photo.content_hash[:8]}"
                            )
                        except Exception as exif_error:
                            print(f"   ❌ EXIF write failed: {exif_error}")
                            cleanup_staged_file(staged_path)
                            category, user_message = categorize_processing_error(exif_error)

                            if category == 'duplicate':
                                duplicate_count += 1
                            else:
                                error_count += 1

                            if not (yield from emit_event('rejected', {
                                'file': filename,
                                'source_path': source_path,
                                'reason': user_message,
                                'category': category,
                                'technical_error': str(exif_error)
                            })):
                                break
                            continue
                    else:
                        # Hash the file (with caching)
                        content_hash, cache_hit = hash_cache.get_hash(source_path)
                        if cache_hit:
                            print(f"   Hash: {content_hash[:16]}... (cached)")
                        else:
                            print(f"   Hash: {content_hash[:16]}...")

                        if content_hash is None:
                            print(f"   ❌ Failed to hash file")
                            error_count += 1
                            if not (yield from emit_event('progress', {
                                'imported': imported_count,
                                'duplicates': duplicate_count,
                                'errors': error_count,
                                'current': file_index,
                                'total': total_files
                            })):
                                break
                            continue

                        # Check for duplicates
                        cursor.execute("SELECT id, current_path FROM photos WHERE content_hash = ?", (content_hash,))
                        existing = cursor.fetchone()
                        print(
                            f"   🔎 Import preflight: source={source_path} "
                            f"initial_hash={content_hash} "
                            f"existing_match={existing['id'] if existing else None} "
                            f"existing_path={existing['current_path'] if existing else None}"
                        )

                        if existing:
                            print(f"   ⏭️  Duplicate (existing ID: {existing['id']})")
                            duplicate_count += 1
                            if not (yield from emit_event('progress', {
                                'imported': imported_count,
                                'duplicates': duplicate_count,
                                'errors': error_count,
                                'current': file_index,
                                'total': total_files
                            })):
                                break
                            continue

                        # Determine date_taken
                        date_taken, _ = parse_metadata_datetime(
                            extract_exif_date(source_path),
                            os.path.getmtime(source_path),
                        )
                        print(f"   Date: {date_taken}")

                        # Build target path
                        relative_path, canonical_name = build_canonical_photo_path(date_taken, content_hash, ext)
                        target_path = os.path.join(LIBRARY_PATH, relative_path)
                        target_dir = os.path.dirname(target_path)
                        os.makedirs(target_dir, exist_ok=True)
                        base_name, _ = os.path.splitext(canonical_name)

                        # Handle naming collisions
                        counter = 1
                        while os.path.exists(target_path):
                            canonical_name = f"{base_name}_{counter}{ext.lower()}"
                            relative_path = os.path.join(os.path.dirname(relative_path), canonical_name)
                            target_path = os.path.join(target_dir, canonical_name)
                            counter += 1

                        # Insert into DB FIRST (atomic) - dimensions will be updated after baking
                        file_size = os.path.getsize(source_path)

                        cursor.execute('''
                            INSERT INTO photos (current_path, original_filename, content_hash, file_size, file_type, date_taken, width, height)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ''', (relative_path, filename, content_hash, file_size, file_type, date_taken, None, None))

                        photo_id = cursor.lastrowid
                        conn.commit()
                        print(f"   DB: Inserted ID {photo_id}")

                        # Copy file to library
                        shutil.copy2(source_path, target_path)
                        print(f"   ✅ Copied to: {relative_path}")

                        # Write metadata to file
                        try:
                            print(f"   🔧 Writing EXIF metadata...")
                            write_video_metadata(target_path, date_taken)
                            finalize_result = finalize_mutated_media(
                                conn=conn,
                                photo_id=photo_id,
                                library_path=LIBRARY_PATH,
                                current_rel_path=relative_path,
                                date_taken=date_taken,
                                old_hash=content_hash,
                                build_canonical_path=build_canonical_photo_path,
                                compute_hash=compute_full_hash,
                                get_dimensions=get_image_dimensions,
                                delete_thumbnail_for_hash=delete_thumbnail_for_hash,
                                duplicate_policy='delete',
                            )
                            print(
                                f"   🔎 Import finalize: photo_id={photo_id} "
                                f"status={finalize_result.status} "
                                f"final_hash={finalize_result.content_hash} "
                                f"final_path={finalize_result.current_path} "
                                f"matched_id={finalize_result.duplicate.photo_id if finalize_result.duplicate else None} "
                                f"matched_path={finalize_result.duplicate.current_path if finalize_result.duplicate else None}"
                            )
                            conn.commit()
                            if finalize_result.status == 'duplicate_removed':
                                print("   ⏭️  Duplicate detected after metadata write; removed imported copy")
                                duplicate_count += 1
                                if not (yield from emit_event('progress', {
                                    'imported': imported_count,
                                    'duplicates': duplicate_count,
                                    'errors': error_count,
                                    'current': file_index,
                                    'total': total_files
                                })):
                                    break
                                continue

                            target_path = finalize_result.full_path
                            relative_path = finalize_result.current_path
                            print(
                                f"   ✅ Finalized import path/hash: "
                                f"{finalize_result.current_path} ({finalize_result.content_hash[:8]})"
                            )

                        except Exception as exif_error:
                            # EXIF write failed - rollback this file
                            print(f"   ❌ EXIF write failed: {exif_error}")

                            # Clean up: Delete copied file
                            try:
                                if os.path.exists(target_path):
                                    os.remove(target_path)
                                    print(f"   🗑️  Deleted copied file")
                            except Exception as cleanup_error:
                                print(f"   ⚠️  Couldn't delete file: {cleanup_error}")

                            # Clean up: Delete database record
                            try:
                                cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
                                conn.commit()
                                print(f"   🗑️  Deleted database record (ID: {photo_id})")
                            except Exception as db_error:
                                print(f"   ⚠️  Couldn't delete DB record: {db_error}")

                            # Categorize error
                            error_str = str(exif_error).lower()
                            if 'timeout' in error_str:
                                category = 'timeout'
                                user_message = "Processing timeout (file too large or slow storage)"
                            # Check for duplicate hash collision (UNIQUE constraint during rehash update)
                            elif 'unique constraint' in error_str and 'content_hash' in error_str:
                                category = 'duplicate'
                                user_message = "Duplicate file (detected after processing)"
                            # Check for corruption BEFORE tool detection (avoid false positives)
                            elif ('not a valid' in error_str or 'corrupt' in error_str or
                                  'invalid data' in error_str or 'moov atom' in error_str):
                                category = 'corrupted'
                                user_message = "File corrupted or invalid format"
                            elif 'not found' in error_str and 'ffmpeg' in error_str:
                                category = 'missing_tool'
                                user_message = "Required tool not installed (ffmpeg)"
                            elif 'permission' in error_str or 'denied' in error_str:
                                category = 'permission'
                                user_message = "Permission denied"
                            else:
                                category = 'unsupported'
                                user_message = str(exif_error)

                            # Track rejection count (duplicate vs error)
                            if category == 'duplicate':
                                duplicate_count += 1
                            else:
                                error_count += 1

                            # Yield rejection event (special type of error with extra metadata)
                            if not (yield from emit_event('rejected', {
                                'file': filename,
                                'source_path': source_path,
                                'reason': user_message,
                                'category': category,
                                'technical_error': str(exif_error)
                            })):
                                break

                            # Continue to next file (don't increment imported_count)
                            continue
                    
                    # SUCCESS - file imported with EXIF
                    imported_count += 1
                    
                    if not (yield from emit_event('progress', {
                        'imported': imported_count,
                        'duplicates': duplicate_count,
                        'errors': error_count,
                        'current': file_index,
                        'total': total_files,
                        'photo_id': photo_id
                    })):
                        break
                    
                except Exception as e:
                    error_msg = str(e)
                    print(f"   ❌ Error: {error_msg}")
                    import traceback
                    traceback.print_exc()
                    error_count += 1
                    if not (yield from emit_event('progress', {
                        'imported': imported_count,
                        'duplicates': duplicate_count,
                        'errors': error_count,
                        'current': file_index,
                        'total': total_files,
                        'error': error_msg,
                        'error_file': filename
                    })):
                        break

            if client_disconnected:
                print(f"\n🛑 IMPORT STOPPED BY CLIENT")
                print(f"  Imported: {imported_count}")
                print(f"  Duplicates: {duplicate_count}")
                print(f"  Errors: {error_count}\n")
                return
            
            print(f"\n{'='*60}")
            print(f"IMPORT COMPLETE:")
            print(f"  Imported: {imported_count}")
            print(f"  Duplicates: {duplicate_count}")
            print(f"  Errors: {error_count}")
            print(f"{'='*60}\n")
            
            yield from emit_event('complete', {
                'imported': imported_count,
                'duplicates': duplicate_count,
                'errors': error_count
            })
            
        except GeneratorExit:
            print("🛑 Import stream disconnected")
        except Exception as e:
            if client_disconnected:
                return

            print(f"❌ Import error: {e}")
            import traceback
            traceback.print_exc()
            yield from emit_event('error', {'error': str(e)})
        finally:
            if conn is not None:
                conn.close()
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')


@app.route('/api/import/copy-rejected-files', methods=['POST'])
def copy_rejected_files():
    """Copy rejected import files to user-specified folder with report"""
    try:
        data = request.json
        files = data.get('files', [])
        destination = data.get('destination')
        
        if not files or not destination:
            return jsonify({'error': 'Missing files or destination'}), 400
        
        if not os.path.exists(destination):
            return jsonify({'error': 'Destination folder does not exist'}), 400
        
        # Create timestamped subfolder
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        reject_folder = os.path.join(destination, f'rejected_{timestamp}')
        os.makedirs(reject_folder, exist_ok=True)
        
        # Copy files
        copied = 0
        failed = 0
        for item in files:
            source = item.get('source_path')
            if not source or not os.path.exists(source):
                failed += 1
                continue
            
            try:
                filename = os.path.basename(source)
                dest_path = os.path.join(reject_folder, filename)
                
                # Handle naming collisions
                counter = 1
                base, ext = os.path.splitext(filename)
                while os.path.exists(dest_path):
                    dest_path = os.path.join(reject_folder, f"{base}_{counter}{ext}")
                    counter += 1
                
                shutil.copy2(source, dest_path)
                copied += 1
            except Exception as e:
                print(f"  ⚠️  Failed to copy {source}: {e}")
                failed += 1
        
        # Create report file
        report_path = os.path.join(reject_folder, '_REPORT.txt')
        with open(report_path, 'w') as f:
            f.write(f"Import Rejection Report\n")
            f.write(f"Generated: {datetime.now()}\n\n")
            f.write(f"Total files: {len(files)}\n")
            f.write(f"Successfully copied: {copied}\n")
            f.write(f"Failed to copy: {failed}\n\n")
            f.write("=" * 70 + "\n\n")
            
            # Group by category
            by_category = {}
            for item in files:
                cat = item.get('category', 'unknown')
                if cat not in by_category:
                    by_category[cat] = []
                by_category[cat].append(item)
            
            for category, items in by_category.items():
                f.write(f"\n{category.upper()}\n")
                f.write("-" * 70 + "\n")
                for item in items:
                    f.write(f"\nFile: {item.get('file', 'unknown')}\n")
                    f.write(f"Reason: {item.get('reason', 'unknown')}\n")
                    f.write(f"Source: {item.get('source_path', 'unknown')}\n")
                    if item.get('technical_error'):
                        f.write(f"Technical: {item.get('technical_error')}\n")
        
        print(f"✅ Copied {copied} rejected files to: {reject_folder}")
        
        return jsonify({
            'success': True,
            'copied': copied,
            'failed': failed,
            'folder': reject_folder
        })
        
    except Exception as e:
        print(f"❌ Copy rejected files failed: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def start_background_thumbnail_generation(photo_ids):
    """
    Start background thread to pre-generate thumbnails for recently imported photos.
    This runs AFTER import completes, so it doesn't block the import process.
    """
    import threading
    
    def worker():
        for photo_id in photo_ids:
            try:
                # Fetch photo info including hash
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT current_path, file_type, content_hash FROM photos WHERE id = ?", (photo_id,))
                row = cursor.fetchone()
                conn.close()
                
                if not row:
                    continue
                
                # Generate thumbnail (will be cached)
                full_path = os.path.join(LIBRARY_PATH, row['current_path'])
                if os.path.exists(full_path):
                    # Trigger the lazy generation by calling the function directly
                    # The thumbnail endpoint would do this on first request anyway
                    generate_thumbnail_for_file(full_path, row['content_hash'], row['file_type'])
                    print(f"  🖼️  Background: Generated thumbnail for photo {photo_id}")
            except Exception as e:
                # Don't let thumbnail failures crash the background thread
                error_logger.warning(f"Background thumbnail generation failed for photo {photo_id}: {e}")
                continue
    
    # Start daemon thread (won't prevent app shutdown)
    thread = threading.Thread(target=worker, daemon=True, name="ThumbnailGenerator")
    thread.start()


# ============================================================================
# UTILITIES API
# ============================================================================

@app.route('/api/utilities/update-index/scan')
@handle_db_corruption
def scan_index():
    """
    Update Library Index: Scan library and database to find what needs updating.
    Returns counts without making any changes.
    
    Returns:
    {
      "missing_files": 12,  (ghosts - in DB but not on disk)
      "untracked_files": 45, (moles - on disk but not in DB)
      "name_updates": 3,     (non-standard filenames)
      "empty_folders": 8
    }
    """
    try:
        import sys
        sys.stdout.flush()
        print("\n🔍 UPDATE LIBRARY INDEX: Scanning library...", flush=True)
        
        # Check if database exists
        if not os.path.exists(DB_PATH):
            print(f"  ⚠️  Database not found at: {DB_PATH}")
            # Return that everything needs to be added
            from library_sync import count_media_files
            file_count = count_media_files(LIBRARY_PATH)
            return jsonify({
                'missing_files': 0,
                'untracked_files': file_count,
                'name_updates': 0,
                'empty_folders': 0
            })
        
        # Scan filesystem for all media files
        filesystem_paths = set()
        file_count = 0
        
        # v223: Use global constants - was missing .webp/.avif/.jp2/RAW formats (BUG FIX)
        photo_exts = PHOTO_EXTENSIONS
        video_exts = VIDEO_EXTENSIONS
        all_exts = photo_exts | video_exts
        
        for root, dirs, filenames in os.walk(LIBRARY_PATH, followlinks=False):
            # Skip hidden directories
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            
            for filename in filenames:
                if filename.startswith('.'):
                    continue
                
                ext = os.path.splitext(filename)[1].lower()
                if ext not in all_exts:
                    continue
                
                file_count += 1
                full_path = os.path.join(root, filename)
                
                try:
                    rel_path = os.path.relpath(full_path, LIBRARY_PATH)
                    filesystem_paths.add(rel_path)
                except ValueError:
                    continue
        
        print(f"  Found {file_count} files on disk")
        
        # Load database paths
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT current_path FROM photos")
        db_paths = {row['current_path'] for row in cursor.fetchall()}
        conn.close()
        
        print(f"  Found {len(db_paths)} entries in database")
        
        # Calculate what needs updating
        missing_files = db_paths - filesystem_paths  # In DB but not on disk
        untracked_files = filesystem_paths - db_paths  # On disk but not in DB
        name_updates = 0  # TODO: check for non-standard filenames
        
        # Count empty folders
        empty_folders = 0
        empty_folder_paths = []
        for root, dirs, files in os.walk(LIBRARY_PATH, topdown=False):
            if os.path.basename(root).startswith('.') or root == LIBRARY_PATH:
                continue
            try:
                entries = os.listdir(root)
                non_hidden = [e for e in entries if not e.startswith('.')]
                if len(non_hidden) == 0:
                    empty_folders += 1
                    rel_path = os.path.relpath(root, LIBRARY_PATH)
                    empty_folder_paths.append(rel_path)
            except:
                continue
        
        print(f"  Found {empty_folders} empty folders:", flush=True)
        for path in empty_folder_paths:
            print(f"    • {path}", flush=True)
        
        results = {
            'missing_files': len(missing_files),
            'untracked_files': len(untracked_files),
            'name_updates': name_updates,
            'empty_folders': empty_folders
        }
        
        print(f"  Scan results: {results}")
        return jsonify(results)
        
    except Exception as e:
        app.logger.error(f"Error in Update Library Index scan: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/utilities/update-index/execute', methods=['GET', 'POST'])
def execute_update_index():
    """
    Update Library Index: Execute library cleanup with SSE progress streaming.
    
    Phases:
    1. Remove deleted files (ghosts)
    2. Add untracked files (moles)
    3. Update names (non-standard filenames)
    4. Remove empty folders
    """
    
    def generate():
        try:
            import_logger.info("Update Library Index execute started")
            
            # Create backup before modifying database
            print(f"\n💾 Creating database backup before index update...")
            backup_path = create_db_backup()
            if backup_path:
                print(f"  ✅ Backup created: {os.path.basename(backup_path)}")
            else:
                print(f"  ⚠️  Backup failed, but continuing with index update")
            
            conn = get_db_connection()
            yield from synchronize_library_generator(
                LIBRARY_PATH, 
                conn, 
                extract_exif_date, 
                get_image_dimensions,
                mode='incremental'
            )
            import_logger.info("Update Library Index execute completed")
        except Exception as e:
            error_logger.error(f"Update Library Index execute failed: {e}")
            print(f"\n❌ Update Library Index execute failed: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')


# ============================================================================
# RECOVERY API
# ============================================================================

@app.route('/api/recovery/rebuild-database/scan', methods=['POST'])
def scan_rebuild_database():
    """
    Pre-scan for database rebuild: count files and estimate duration.
    
    Returns:
        {
          "file_count": 62847,
          "estimated_minutes": 419,
          "estimated_display": "6-7 hours",
          "requires_warning": true
        }
    """
    try:
        print("\n🔍 REBUILD DATABASE: Pre-scanning library...")
        
        file_count = count_media_files(LIBRARY_PATH)
        minutes, display = estimate_duration(file_count)
        
        print(f"  Found {file_count} media files")
        print(f"  Estimated duration: {display}")
        
        return jsonify({
            'file_count': file_count,
            'estimated_minutes': int(minutes),
            'estimated_display': display,
            'requires_warning': file_count >= 1000  # Show warning for 1000+ files
        })
    except Exception as e:
        error_logger.error(f"Rebuild database scan failed: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/recovery/rebuild-database/execute', methods=['GET', 'POST'])
def execute_rebuild_database():
    """
    Rebuild database from scratch: Index all media files in library.
    
    This is the recovery mode - treats database as empty and indexes everything.
    """
    
    def generate():
        try:
            import_logger.info("Rebuild Database execute started")
            
            # Create backup before rebuilding (if database exists)
            if os.path.exists(DB_PATH):
                print(f"\n💾 Creating database backup before rebuild...")
                backup_path = create_db_backup()
                if backup_path:
                    print(f"  ✅ Backup created: {os.path.basename(backup_path)}")
                else:
                    print(f"  ⚠️  Backup failed, but continuing with rebuild")
            
            # Remove old database (even if corrupted) and create fresh one
            print(f"\n🗑️  Removing old database...")
            if os.path.exists(DB_PATH):
                os.remove(DB_PATH)
                print(f"  ✅ Removed old database file")
            
            print(f"\n📦 Creating fresh database at: {DB_PATH}")
            os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            create_database_schema(cursor)
            conn.commit()
            conn.close()
            print(f"  ✅ Created fresh database with schema")
            
            # Ensure library directory structure exists (Tier 1: silent auto-fix)
            print(f"📁 Ensuring library directory structure...")
            for directory in [THUMBNAIL_CACHE_DIR, TRASH_DIR, DB_BACKUP_DIR, LOG_DIR]:
                try:
                    os.makedirs(directory, exist_ok=True)
                except (PermissionError, OSError) as e:
                    print(f"⚠️  Warning: Could not create directory {directory}: {e}")
            
            conn = get_db_connection()
            
            yield from synchronize_library_generator(
                LIBRARY_PATH,
                conn,
                extract_exif_date,
                get_image_dimensions,
                mode='full'
            )
            import_logger.info("Rebuild Database execute completed")
        except Exception as e:
            error_logger.error(f"Rebuild Database execute failed: {e}")
            print(f"\n❌ Rebuild Database execute failed: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')


@app.route('/api/utilities/rebuild-thumbnails', methods=['POST'])
def rebuild_thumbnails():
    """
    Rebuild thumbnails: Delete all cached thumbnails.
    They will regenerate automatically via lazy loading as users scroll.

    No in-app menu item as of Apr 2026 (same as removing `.thumbnails/` by hand);
    endpoint kept for support and possible future UI.
    """
    try:
        import shutil
        
        print("\n🗑️  REBUILD THUMBNAILS: Clearing cache...")
        
        # Count existing thumbnails
        thumb_count = 0
        for root, dirs, files in os.walk(THUMBNAIL_CACHE_DIR):
            thumb_count += len([f for f in files if f.endswith('.jpg')])
        
        print(f"  Found {thumb_count} cached thumbnails")
        
        # Nuke everything
        shutil.rmtree(THUMBNAIL_CACHE_DIR)
        os.makedirs(THUMBNAIL_CACHE_DIR, exist_ok=True)
        
        print(f"  ✅ Cleared all thumbnails")
        import_logger.info(f"Rebuild thumbnails: Cleared {thumb_count} thumbnails")
        
        return jsonify({
            'status': 'success',
            'cleared_count': thumb_count,
            'message': 'Thumbnails cleared. They will regenerate as you scroll.'
        })

    except Exception as e:
        print(f"  ❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/utilities/check-thumbnails', methods=['GET'])
def check_thumbnails():
    """
    Check how many thumbnails exist without deleting them.
    """
    try:
        # Count existing thumbnails
        thumb_count = 0
        for root, dirs, files in os.walk(THUMBNAIL_CACHE_DIR):
            thumb_count += len([f for f in files if f.endswith('.jpg')])
        
        return jsonify({
            'status': 'success',
            'thumbnail_count': thumb_count
        })

    except Exception as e:
        print(f"  ❌ Error checking thumbnails: {e}")
        return jsonify({'error': str(e)}), 500
        
    except Exception as e:
        error_logger.error(f"Rebuild thumbnails failed: {e}")
        print(f"\n❌ Rebuild thumbnails failed: {e}")
        return jsonify({'error': str(e)}), 500


# ============================================================================
# LIBRARY SWITCHING
# ============================================================================

CONFIG_FILE = os.path.join(BASE_DIR, '.config.json')

def load_config():
    """Load library configuration from .config.json"""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠️  Failed to load config: {e}")
    return None

def save_config(library_path, db_path):
    """Save library configuration to .config.json"""
    config = {
        'library_path': library_path,
        'db_path': db_path
    }
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)

def delete_config():
    """Delete library configuration file (reset to first-run state)"""
    if os.path.exists(CONFIG_FILE):
        os.remove(CONFIG_FILE)
        print(f"🗑️  Deleted config file: {CONFIG_FILE}")
        return True
    return False

def update_app_paths(library_path, db_path):
    """Update all global path variables"""
    global LIBRARY_PATH, DB_PATH, THUMBNAIL_CACHE_DIR, TRASH_DIR, DB_BACKUP_DIR, IMPORT_TEMP_DIR, LOG_DIR
    
    LIBRARY_PATH = library_path
    DB_PATH = db_path
    THUMBNAIL_CACHE_DIR = os.path.join(LIBRARY_PATH, '.thumbnails')
    TRASH_DIR = os.path.join(LIBRARY_PATH, '.trash')
    DB_BACKUP_DIR = os.path.join(LIBRARY_PATH, '.db_backups')
    IMPORT_TEMP_DIR = os.path.join(LIBRARY_PATH, '.import_temp')
    LOG_DIR = os.path.join(LIBRARY_PATH, '.logs')
    
    # Ensure directories exist (Tier 1: silent auto-fix)
    for directory in [THUMBNAIL_CACHE_DIR, TRASH_DIR, DB_BACKUP_DIR, LOG_DIR]:
        try:
            os.makedirs(directory, exist_ok=True)
        except (PermissionError, OSError) as e:
            print(f"⚠️  Warning: Could not create directory {directory}: {e}")
            print(f"   This may indicate the library is not accessible.")


def build_library_status_payload(library_path, db_path, report):
    """Translate the shared DB health report into library-status API payloads."""
    if report.status == DBStatus.HEALTHY:
        return {
            'status': 'healthy',
            'message': 'Library is ready.',
            'library_path': library_path,
            'db_path': db_path,
            'valid': True,
        }

    if report.status == DBStatus.MISSING:
        return {
            'status': 'db_missing',
            'message': report.get_user_message(),
            'library_path': library_path,
            'db_path': db_path,
            'valid': False,
        }

    if report.status == DBStatus.CORRUPTED:
        return {
            'status': 'db_corrupted',
            'message': report.get_user_message(),
            'library_path': library_path,
            'db_path': db_path,
            'valid': False,
            'error': report.error_message,
        }

    if report.status in [DBStatus.MISSING_COLUMNS, DBStatus.MIXED_SCHEMA]:
        return {
            'status': 'needs_migration',
            'message': report.get_user_message(),
            'library_path': library_path,
            'db_path': db_path,
            'valid': False,
            'missing_columns': report.missing_columns,
            'extra_columns': report.extra_columns,
            'can_continue': report.can_use_anyway,
        }

    if report.status == DBStatus.EXTRA_COLUMNS:
        return {
            'status': 'healthy',
            'message': report.get_user_message(),
            'library_path': library_path,
            'db_path': db_path,
            'valid': True,
            'extra_columns': report.extra_columns,
        }

    return {
        'status': 'db_missing',
        'message': report.get_user_message(),
        'library_path': library_path,
        'db_path': db_path,
        'valid': False,
    }


@app.route('/api/library/current', methods=['GET'])
def get_current_library():
    """Get current library path"""
    return jsonify({
        'library_path': LIBRARY_PATH,
        'db_path': DB_PATH
    })

@app.route('/api/library/status', methods=['GET'])
def library_status():
    """
    Check library health with detailed diagnostics.
    Returns status, message, and paths for frontend decision-making.
    """
    try:
        # Check if config file exists and is valid
        config = load_config()
        if not config:
            return jsonify({
                'status': 'not_configured',
                'message': 'No library configured. Please select a library.',
                'library_path': None,
                'db_path': None,
                'valid': False
            })
        
        library_path = config.get('library_path')
        db_path = config.get('db_path')
        
        if not library_path or not db_path:
            return jsonify({
                'status': 'not_configured',
                'message': 'Library configuration is incomplete.',
                'library_path': library_path,
                'db_path': db_path,
                'valid': False
            })
        
        # Check filesystem access
        try:
            library_exists = os.path.exists(library_path)
        except (OSError, PermissionError) as e:
            return jsonify({
                'status': 'library_inaccessible',
                'message': f'Cannot check library access: {str(e)}',
                'library_path': library_path,
                'db_path': db_path,
                'valid': False
            })
        
        if not library_exists:
            delete_config()  # Clean up stale config
            return jsonify({
                'status': 'not_configured',
                'message': 'Library not found. Please select or create a library.',
                'library_path': None,
                'db_path': None,
                'valid': False
            })
        
        try:
            resolved_db_path = resolve_db_path(library_path, db_path)
        except (OSError, PermissionError) as e:
            return jsonify({
                'status': 'db_inaccessible',
                'message': f'Cannot check database access: {str(e)}',
                'library_path': library_path,
                'db_path': db_path,
                'valid': False
            })

        report = check_database_health(resolved_db_path)
        payload = build_library_status_payload(library_path, resolved_db_path, report)
        if payload['status'] == 'db_missing':
            delete_config()
            return jsonify({
                'status': 'not_configured',
                'message': 'Library not found. Please select or create a library.',
                'library_path': None,
                'db_path': None,
                'valid': False
            })

        return jsonify(payload)
        
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': f'Unexpected error: {str(e)}',
            'library_path': None,
            'db_path': None,
            'valid': False
        }), 500

@app.route('/api/library/current', methods=['GET'])
def library_current():
    """Get current library and database paths"""
    return jsonify({
        'library_path': LIBRARY_PATH,
        'db_path': DB_PATH
    })

@app.route('/api/check-path', methods=['GET'])
def check_path():
    """Check if a file or directory exists"""
    path = request.args.get('path')
    if not path:
        return jsonify({'error': 'path parameter required'}), 400
    
    exists = os.path.exists(path)
    return jsonify({'exists': exists, 'path': path})

@app.route('/api/library/validate', methods=['POST'])
def validate_library_path():
    """Validate a user-provided library path"""
    try:
        data = request.json
        path = data.get('path', '').strip()
        
        if not path:
            return jsonify({'status': 'invalid', 'error': 'No path provided'}), 400
        
        # Expand user home directory shorthand
        path = os.path.expanduser(path)
        
        # Resolve to absolute path
        path = os.path.abspath(path)
        
        # Check if path exists and is a directory
        if not os.path.exists(path):
            return jsonify({'status': 'invalid', 'error': 'Path does not exist'}), 400
        
        if not os.path.isdir(path):
            return jsonify({'status': 'invalid', 'error': 'Path is not a directory'}), 400
        
        existing_db_path = detect_existing_db_path(path)
        
        if existing_db_path:
            # Valid existing library
            return jsonify({
                'status': 'exists',
                'library_path': path,
                'db_path': existing_db_path
            })
        else:
            # New library needs initialization
            return jsonify({
                'status': 'needs_init',
                'library_path': path,
                'db_path': canonical_db_path(path)
            })
            
    except Exception as e:
        error_logger.error(f"Library path validation failed: {e}")
        return jsonify({'status': 'invalid', 'error': str(e)}), 500


@app.route('/api/library/probe', methods=['POST'])
def probe_library_path():
    """Return a lightweight good-faith estimate of whether a library can open."""
    try:
        data = request.json
        library_path = data.get('library_path', '').strip()

        if not library_path:
            return jsonify({'error': 'Missing library_path'}), 400

        if not os.path.exists(library_path):
            return jsonify({'error': 'Path does not exist', 'code': 'path_not_found'}), 400

        if not os.path.isdir(library_path):
            return jsonify({'error': 'Path is not a directory'}), 400

        return jsonify(inspect_library_path(library_path))
    except Exception as e:
        error_logger.error(f"Library path probe failed: {e}")
        return jsonify({'error': str(e)}), 500

# ============================================================================
# FILESYSTEM API - Custom Folder Picker Backend
# ============================================================================

@app.route('/api/filesystem/list-directory', methods=['POST'])
def list_directory():
    """List folders and files in a directory for custom picker"""
    
    try:
        data = request.json
        path = data.get('path', '/')
        include_files = data.get('include_files', False)  # New parameter for photo picker
        
        # Validate path exists and is accessible (400 — not 404 — so clients
        # don't confuse missing paths with "API route not registered".)
        if not os.path.exists(path):
            return jsonify({'error': 'Path does not exist', 'code': 'path_not_found'}), 400
        
        if not os.path.isdir(path):
            return jsonify({'error': 'Path is not a directory'}), 400
        
        # List directory contents
        try:
            items = os.listdir(path)
        except PermissionError:
            return jsonify({'error': 'Permission denied'}), 403
        
        # Filter and categorize items
        folders = []
        files = []
        has_db = library_has_db(path)
        has_openable_db = library_has_openable_db(path)
        
        for item in items:
            if item == LIBRARY_METADATA_DIR:
                continue

            if item == 'photo_library.db':
                has_db = True
                continue

            # Skip hidden files/folders (starting with .)
            if item.startswith('.'):
                continue
            
            # Skip backup and archive folders
            item_lower = item.lower()
            backup_patterns = ['backup', 'backups', 'archive', 'archives', 'time machine', 'time_machine']
            if any(pattern in item_lower for pattern in backup_patterns):
                continue

            item_path = os.path.join(path, item)
            try:
                if os.path.isdir(item_path):
                    # Just return folder info, no counting (picker handles selection counting)
                    folders.append({
                        'name': item
                    })
                elif os.path.isfile(item_path) and include_files:
                    # Only include media files
                    ext = os.path.splitext(item)[1].lower()
                    if ext in ALL_MEDIA_EXTENSIONS:
                        file_type = 'video' if ext in VIDEO_EXTENSIONS else 'photo'
                        
                        file_info = {
                            'name': item,
                            'type': file_type,
                            'size': os.path.getsize(item_path)
                        }
                        
                        # Skip dimension extraction - it blocks on NAS
                        # Dimensions not critical for picker UX
                        file_info['dimensions'] = None
                        
                        files.append(file_info)
            except (PermissionError, OSError):
                # Skip items we can't access
                continue
        
        # Sort alphabetically
        folders.sort(key=lambda x: x['name'] if isinstance(x, dict) else x)
        if include_files:
            files.sort(key=lambda x: x['name'])
        
        response = {
            'current_path': path,
            'has_db': has_db,
            'has_openable_db': has_openable_db,
        }
        
        # Return format depends on mode
        if include_files:
            response['folders'] = folders
            response['files'] = files
        else:
            # Legacy format for folder picker (just folder names)
            response['folders'] = [f['name'] if isinstance(f, dict) else f for f in folders]
        
        return jsonify(response)
        
    except Exception as e:
        app.logger.error(f"Error listing directory: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/filesystem/preview-thumbnail', methods=['POST'])
def preview_thumbnail():
    """
    Generate quick preview thumbnail (80x80px for 2x retina display at 40x40)
    Returns JPEG binary data or error
    """
    try:
        data = request.json
        path = data.get('path')
        
        # Validate path
        if not path or not os.path.exists(path):
            return jsonify({'error': 'File not found'}), 404
        
        # Security: Ensure path is absolute and exists
        path = os.path.abspath(path)
        
        if not os.path.isfile(path):
            return jsonify({'error': 'Not a file'}), 400
        
        # Determine file type
        ext = os.path.splitext(path)[1].lower()
        
        # v223: Use global constants instead of duplicating extension lists
        photo_exts = PHOTO_EXTENSIONS
        video_exts = VIDEO_EXTENSIONS
        
        if ext in photo_exts:
            return generate_photo_preview(path)
        elif ext in video_exts:
            return generate_video_preview(path)
        else:
            return jsonify({'error': 'Unsupported file type'}), 400
            
    except Exception as e:
        print(f"❌ Preview thumbnail error: {e}")
        return jsonify({'error': str(e)}), 500


def generate_photo_preview(file_path):
    """Generate photo thumbnail (80x80px for 2x retina display at 40x40)"""
    try:
        with Image.open(file_path) as img:
            # Apply EXIF orientation
            from PIL import ImageOps
            img = ImageOps.exif_transpose(img)
            
            # Convert to RGB if needed
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
            # Create thumbnail (maintains aspect ratio)
            img.thumbnail((80, 80), Image.Resampling.LANCZOS)
            
            # Save to memory buffer
            from io import BytesIO
            buffer = BytesIO()
            img.save(buffer, format='JPEG', quality=75)
            buffer.seek(0)
            
            return send_file(buffer, mimetype='image/jpeg')
            
    except Exception as e:
        print(f"❌ Photo preview error: {e}")
        return jsonify({'error': str(e)}), 500


def generate_video_preview(file_path):
    """Generate video thumbnail (80x80px for 2x retina display at 40x40)"""
    try:
        import uuid
        temp_file = f"/tmp/preview_{uuid.uuid4()}.jpg"
        
        # Extract first frame at 80px max dimension
        cmd = [
            'ffmpeg', '-i', file_path,
            '-vf', 'scale=80:80:force_original_aspect_ratio=decrease',
            '-vframes', '1', '-y', temp_file
        ]
        
        result = subprocess.run(
            cmd, 
            capture_output=True, 
            timeout=10  # 10 second timeout
        )
        
        if result.returncode == 0 and os.path.exists(temp_file):
            response = send_file(temp_file, mimetype='image/jpeg')
            
            # Clean up temp file after sending
            @response.call_on_close
            def cleanup():
                try:
                    if os.path.exists(temp_file):
                        os.remove(temp_file)
                except:
                    pass
            
            return response
        else:
            return jsonify({'error': 'Video preview failed'}), 500
            
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Video preview timeout'}), 500
    except Exception as e:
        print(f"❌ Video preview error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/filesystem/get-locations', methods=['GET'])
def get_locations():
    """Get curated list of top-level locations for folder picker"""
    try:
        locations = []
        
        # Add current user
        home_dir = os.path.expanduser('~')
        username = os.path.basename(home_dir)
        locations.append({
            'name': username,
            'path': home_dir
        })
        
        # Add Shared folder if exists
        shared_path = '/Users/Shared'
        if os.path.exists(shared_path):
            locations.append({
                'name': 'Shared',
                'path': shared_path
            })
        
        # Add mounted volumes
        volumes_path = '/Volumes'
        if os.path.exists(volumes_path):
            try:
                volumes = os.listdir(volumes_path)
                for volume in volumes:
                    # Skip hidden volumes
                    if volume.startswith('.'):
                        continue
                    
                    # Skip system volumes
                    system_volumes = ['Macintosh HD', 'Macintosh SSD', 'Data', 'Preboot', 'Recovery', 'VM']
                    if volume in system_volumes:
                        continue
                    
                    # Skip backup volumes
                    volume_lower = volume.lower()
                    if volume.startswith('Backups of') or 'backup' in volume_lower or 'time machine' in volume_lower:
                        continue
                    
                    volume_path = os.path.join(volumes_path, volume)
                    # Skip symlinks (like Macintosh HD -> /)
                    if os.path.islink(volume_path):
                        continue
                    
                    if os.path.isdir(volume_path):
                        locations.append({
                            'name': volume,
                            'path': volume_path
                        })
            except (PermissionError, OSError):
                # If we can't read /Volumes, skip it
                pass
        
        return jsonify({'locations': locations})
        
    except Exception as e:
        app.logger.error(f"Error getting locations: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/library/browse', methods=['POST'])
def browse_library():
    """Open native macOS folder picker for library selection"""
    # Test comment to trigger reload
    try:
        data = request.json
        script = data.get('script')
        
        if not script:
            return jsonify({'error': 'No script provided'}), 400
        
        # Debug: Print environment info
        import os
        print(f"\n=== DEBUG INFO ===")
        print(f"USER: {os.environ.get('USER', 'NOT SET')}")
        print(f"HOME: {os.environ.get('HOME', 'NOT SET')}")
        print(f"DISPLAY: {os.environ.get('DISPLAY', 'NOT SET')}")
        print(f"Running as PID: {os.getpid()}")
        print(f"Script: {script}")
        print("==================\n")
        
        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=300
        )
        
        if result.returncode != 0:
            # User cancelled or error
            # Temporarily return stderr for debugging
            return jsonify({
                'status': 'cancelled',
                'debug_returncode': result.returncode,
                'debug_stderr': result.stderr,
                'debug_stdout': result.stdout
            })
        
        selected_path = result.stdout.strip()
        
        if not selected_path:
            return jsonify({'status': 'cancelled'})
        
        existing_db_path = detect_existing_db_path(selected_path)
        
        if existing_db_path:
            # Valid existing library
            return jsonify({
                'status': 'exists',
                'library_path': selected_path,
                'db_path': existing_db_path
            })
        else:
            # New library needs initialization
            return jsonify({
                'status': 'needs_init',
                'library_path': selected_path,
                'db_path': canonical_db_path(selected_path)
            })
            
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Selection timeout'}), 408
    except Exception as e:
        error_logger.error(f"Browse library failed: {e}")
        return jsonify({'error': str(e)}), 500


DESKTOP_WARNING_FILE_EXTENSIONS = {
    '.app',
    '.csv',
    '.doc',
    '.docx',
    '.dmg',
    '.key',
    '.md',
    '.numbers',
    '.pages',
    '.pdf',
    '.ppt',
    '.pptx',
    '.rtf',
    '.txt',
    '.xls',
    '.xlsx',
    '.zip',
}
DESKTOP_WARNING_FOLDER_NAMES = {
    'applications',
    'desktop',
    'documents',
    'downloads',
    'movies',
    'music',
    'notes',
    'projects',
    'work',
    'workspace',
}


def ensure_library_support_dirs(library_path):
    """Create the hidden support folders required for a usable library."""
    abs_library_path = os.path.abspath(library_path)
    metadata_dir = os.path.join(abs_library_path, LIBRARY_METADATA_DIR)
    support_dirs = [
        metadata_dir,
        os.path.join(abs_library_path, '.thumbnails'),
        os.path.join(abs_library_path, '.trash'),
        os.path.join(abs_library_path, '.db_backups'),
        os.path.join(abs_library_path, '.logs'),
        os.path.join(abs_library_path, '.import_temp'),
    ]

    for directory in support_dirs:
        os.makedirs(directory, exist_ok=True)

    return canonical_db_path(abs_library_path)


def initialize_library_database(db_path):
    """Create an empty usable database at the requested path."""
    conn = sqlite3.connect(db_path)
    try:
        cursor = conn.cursor()
        create_database_schema(cursor)
        conn.commit()
    finally:
        conn.close()


def quarantine_recovery_db(existing_db_path, library_path):
    """Preserve a non-openable DB before writing a recovered replacement."""
    if not existing_db_path or not os.path.exists(existing_db_path):
        return []

    backup_dir = os.path.join(os.path.abspath(library_path), '.db_backups')
    os.makedirs(backup_dir, exist_ok=True)

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    stem = os.path.splitext(os.path.basename(existing_db_path))[0]
    quarantined_paths = []

    for source_path in [existing_db_path, *db_sidecar_paths(existing_db_path)]:
        if not os.path.exists(source_path):
            continue

        suffix = source_path[len(existing_db_path):]
        backup_name = f'{stem}_recovery_backup_{timestamp}{suffix}'
        backup_path = os.path.join(backup_dir, backup_name)
        shutil.move(source_path, backup_path)
        quarantined_paths.append(backup_path)

    return quarantined_paths


def analyze_general_purpose_folder(library_path, media_count):
    """Cheap, explainable warning heuristic for desktop/workspace folders."""
    try:
        root_entries = [
            entry for entry in os.listdir(library_path)
            if entry and not entry.startswith('.')
        ]
    except (PermissionError, OSError):
        return {
            'show': False,
            'non_media_count': 0,
            'visible_root_items': 0,
            'visible_folder_count': 0,
            'visible_file_count': 0,
            'obvious_signals_present': False,
            'reasons': [],
        }

    visible_file_count = 0
    visible_folder_count = 0
    non_media_count = 0
    obvious_signals_present = False

    for entry in root_entries:
        entry_path = os.path.join(library_path, entry)
        entry_lower = entry.lower()

        if os.path.isdir(entry_path):
            visible_folder_count += 1
            if entry_lower in DESKTOP_WARNING_FOLDER_NAMES:
                obvious_signals_present = True
            continue

        if not os.path.isfile(entry_path):
            continue

        visible_file_count += 1
        ext = os.path.splitext(entry_lower)[1]
        if ext not in ALL_MEDIA_EXTENSIONS:
            non_media_count += 1
            if ext in DESKTOP_WARNING_FILE_EXTENSIONS:
                obvious_signals_present = True

    visible_root_items = visible_file_count + visible_folder_count
    mixed_file_types_and_folders = visible_root_items >= 15 and visible_file_count > 0 and visible_folder_count > 0

    reasons = []
    if non_media_count >= 20:
        reasons.append('many_non_media_files')
    if media_count >= 0 and non_media_count > media_count * 2:
        reasons.append('non_media_outnumbers_media')
    if mixed_file_types_and_folders:
        reasons.append('busy_mixed_root')
    if obvious_signals_present:
        reasons.append('desktop_like_contents')

    return {
        'show': bool(reasons),
        'non_media_count': non_media_count,
        'visible_root_items': visible_root_items,
        'visible_folder_count': visible_folder_count,
        'visible_file_count': visible_file_count,
        'obvious_signals_present': obvious_signals_present,
        'reasons': reasons,
    }


def inspect_library_path(library_path):
    """Shared open-library probe used by both picker UX and recovery flow."""
    abs_library_path = os.path.abspath(library_path)
    existing_db_path = detect_existing_db_path(abs_library_path)
    db_path = existing_db_path or canonical_db_path(abs_library_path)
    db_report = check_database_health(db_path)

    try:
        counts = count_media_files_by_type(abs_library_path)
    except Exception as e:
        print(f"  ⚠️  Error counting media files: {e}")
        counts = {'photo_count': 0, 'video_count': 0, 'total_count': 0}

    media_count = counts['total_count']
    _, media_eta = estimate_duration(media_count)
    folder_warning = analyze_general_purpose_folder(abs_library_path, media_count)

    has_openable_db = library_has_openable_db(abs_library_path)
    return {
        'exists': has_openable_db,
        'has_db': existing_db_path is not None,
        'has_openable_db': has_openable_db,
        'db_path': db_path,
        'db_status': db_report.status.value,
        'db_message': db_report.get_user_message(),
        'has_media': media_count > 0,
        'media_count': media_count,
        'photo_count': counts['photo_count'],
        'video_count': counts['video_count'],
        'media_eta': media_eta,
        'folder_warning': folder_warning,
        'library_path': abs_library_path,
    }


@app.route('/api/library/check', methods=['POST'])
def check_library():
    """Check whether a folder is directly openable and whether recovery is needed."""
    try:
        data = request.json
        library_path = data.get('library_path')
        
        if not library_path:
            return jsonify({'error': 'Missing library_path'}), 400
        
        # Check if path exists
        if not os.path.exists(library_path):
            return jsonify({
                'exists': False,
                'has_db': False,
                'has_openable_db': False,
                'has_media': False,
                'media_count': 0,
                'library_path': library_path,
                'db_path': None,
                'db_status': DBStatus.MISSING.value,
                'db_message': 'No library database found.',
                'media_eta': 'less than a minute',
                'folder_warning': {
                    'show': False,
                    'non_media_count': 0,
                    'visible_root_items': 0,
                    'visible_folder_count': 0,
                    'visible_file_count': 0,
                    'obvious_signals_present': False,
                    'reasons': [],
                },
            })

        return jsonify(inspect_library_path(library_path))
        
    except Exception as e:
        app.logger.error(f"Error checking library: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/library/create', methods=['POST'])
def create_library():
    """Create new library structure at specified path"""
    try:
        data = request.json
        library_path = data.get('library_path')
        if not library_path:
            return jsonify({'error': 'Missing library_path'}), 400

        print(f"\n📦 Creating new library at: {library_path}")
        
        # Check if library already exists
        if os.path.exists(library_path):
            return jsonify({'error': f'A folder already exists at this location. Please choose a different name or location.'}), 400
        
        # Create directory structure
        # Let OS errors pass through with accurate error messages
        os.makedirs(library_path, exist_ok=False)
        print(f"  ✅ Created: {library_path}")

        db_path = ensure_library_support_dirs(library_path)
        initialize_library_database(db_path)
        
        print(f"  ✅ Created database: {db_path}")
        print(f"  ✅ Created directory structure")
        
        return jsonify({
            'status': 'created',
            'library_path': library_path,
            'db_path': db_path
        })
        
    except Exception as e:
        error_logger.error(f"Create library failed: {e}")
        print(f"\n❌ Create library failed: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/library/recover-database', methods=['POST'])
def recover_library_database():
    """Recover a usable canonical DB in an existing folder without destroying evidence."""
    try:
        data = request.json
        library_path = (data.get('library_path') or '').strip()

        if not library_path:
            return jsonify({'error': 'Missing library_path'}), 400

        if not os.path.exists(library_path):
            return jsonify({'error': 'Path does not exist', 'code': 'path_not_found'}), 400

        if not os.path.isdir(library_path):
            return jsonify({'error': 'Path is not a directory'}), 400

        abs_library_path = os.path.abspath(library_path)
        existing_db_path = detect_existing_db_path(abs_library_path)
        db_report = check_database_health(existing_db_path or canonical_db_path(abs_library_path))

        quarantined_paths = []
        if existing_db_path and db_report.status == DBStatus.CORRUPTED:
            quarantined_paths = quarantine_recovery_db(existing_db_path, abs_library_path)

        db_path = ensure_library_support_dirs(abs_library_path)
        quarantined_paths.extend(
            quarantine_unexpected_metadata_entries(
                abs_library_path,
                reason='recovery',
            )
        )
        initialize_library_database(db_path)

        verification = check_database_health(db_path)
        if verification.status == DBStatus.CORRUPTED:
            raise RuntimeError(verification.error_message or 'Recovered database is still corrupted')

        return jsonify({
            'status': 'recovered',
            'library_path': abs_library_path,
            'db_path': db_path,
            'db_status': verification.status.value,
            'quarantined_paths': quarantined_paths,
        })
    except Exception as e:
        error_logger.error(f"Recover database failed: {e}")
        print(f"\n❌ Recover database failed: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/library/switch', methods=['POST'])
def switch_library():
    """Switch to a different library with health check"""
    try:
        data = request.json
        library_path = data.get('library_path')
        db_path = data.get('db_path')
        
        if not library_path:
            return jsonify({'error': 'Missing library_path'}), 400

        db_path = resolve_db_path(library_path, db_path)
        
        print(f"\n🔄 Switching to library: {library_path}")
        
        # Health check before switching
        from db_health import check_database_health, DBStatus
        
        report = check_database_health(db_path)
        print(f"  🏥 Health check: {report.status.value}")
        
        # Handle different health statuses
        if report.status == DBStatus.MISSING:
            return jsonify({
                'status': 'needs_action',
                'action': 'create_new',
                'message': report.get_user_message()
            }), 400
        
        if report.status == DBStatus.CORRUPTED:
            return jsonify({
                'status': 'needs_action',
                'action': 'rebuild',
                'message': report.get_user_message(),
                'error': report.error_message
            }), 400
        
        if report.status in [DBStatus.MISSING_COLUMNS, DBStatus.MIXED_SCHEMA]:
            return jsonify({
                'status': 'needs_migration',
                'action': 'migrate',
                'message': report.get_user_message(),
                'missing_columns': report.missing_columns,
                'can_continue': report.can_use_anyway
            }), 400
        
        if report.status == DBStatus.EXTRA_COLUMNS:
            # Extra columns are harmless - warn but allow
            print(f"  ⚠️  Extra columns found: {', '.join(report.extra_columns)}")
            print(f"  ➡️  Continuing anyway...")
        
        # Healthy or acceptable - proceed with switch
        update_app_paths(library_path, db_path)
        save_config(library_path, db_path)
        
        print(f"  ✅ Switched to: {library_path}")
        print(f"  💾 Database: {db_path}")
        
        return jsonify({
            'status': 'success',
            'library_path': LIBRARY_PATH,
            'db_path': DB_PATH
        })
        
    except Exception as e:
        error_logger.error(f"Switch library failed: {e}")
        print(f"\n❌ Switch library failed: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/library/reset', methods=['DELETE'])
def reset_library():
    """Reset library configuration to first-run state (debug feature)"""
    try:
        deleted = delete_config()
        
        if deleted:
            print("\n🔄 Library configuration reset - returning to first-run state")
            return jsonify({
                'status': 'success',
                'message': 'Configuration reset. Reload page to start fresh.'
            })
        else:
            return jsonify({
                'status': 'success',
                'message': 'No configuration to reset.'
            })
            
    except Exception as e:
        error_logger.error(f"Reset library failed: {e}")
        print(f"\n❌ Reset library failed: {e}")
        return jsonify({'error': str(e)}), 500


def cleanup_terraform_folders(library_path):
    """
    Remove ALL folders after terraform except:
    - Infrastructure folders at root: .thumbnails, .logs, .trash, .db_backups
    - Year folders at root: YYYY/ (4-digit folders)
    - Date folders inside year folders: YYYY-MM-DD/
    
    This is a whitelist approach - anything not explicitly allowed is deleted.
    """
    removed_count = 0
    
    # Get all items in library root
    try:
        root_items = os.listdir(library_path)
    except Exception as e:
        print(f"⚠️  Could not list library path: {e}")
        return 0
    
    # Whitelist: allowed folder names at root level
    INFRASTRUCTURE_FOLDERS = set(ROOT_INFRASTRUCTURE_DIRS)
    ignored_entries = {'.DS_Store'}
    
    for item in root_items:
        item_path = os.path.join(library_path, item)
        
        # Skip files (like photo_library.db)
        if not os.path.isdir(item_path):
            continue
        
        # Check if this is an allowed infrastructure folder
        if item in INFRASTRUCTURE_FOLDERS:
            continue
        
        # Check if this is a year folder (YYYY - 4 digits)
        if len(item) == 4 and item.isdigit():
            # Year folder is allowed - but clean up its contents
            # Only YYYY-MM-DD subfolders should remain
            try:
                year_items = os.listdir(item_path)
                for year_item in year_items:
                    year_item_path = os.path.join(item_path, year_item)
                    
                    if not os.path.isdir(year_item_path):
                        # Preserve non-directory entries so failed converts never
                        # lose the only remaining copy of a media file.
                        print(f"    ⚠️  Preserving file during cleanup: {os.path.relpath(year_item_path, library_path)}")
                        continue
                    
                    # Check if this is a valid date folder (YYYY-MM-DD)
                    is_valid_date_folder = (
                        len(year_item) == 10 and
                        year_item[4] == '-' and
                        year_item[7] == '-' and
                        year_item[:4].isdigit() and
                        year_item[5:7].isdigit() and
                        year_item[8:10].isdigit()
                    )
                    
                    if not is_valid_date_folder:
                        visible_entries = [entry for entry in os.listdir(year_item_path) if entry not in ignored_entries]
                        if visible_entries:
                            print(
                                f"    ⚠️  Preserving noncanonical folder with remaining files: "
                                f"{os.path.relpath(year_item_path, library_path)}"
                            )
                            continue

                        # Not a valid date folder - delete it if now empty/noise-only
                        try:
                            for ignored_entry in os.listdir(year_item_path):
                                if ignored_entry in ignored_entries:
                                    ignored_path = os.path.join(year_item_path, ignored_entry)
                                    if os.path.isfile(ignored_path):
                                        os.remove(ignored_path)
                            shutil.rmtree(year_item_path)
                            print(f"    🗑️  Removed folder: {os.path.relpath(year_item_path, library_path)}")
                            removed_count += 1
                        except Exception as e:
                            print(f"    ⚠️  Could not remove {year_item_path}: {e}")
            except Exception as e:
                print(f"    ⚠️  Could not clean year folder {item}: {e}")
            
            continue
        
        # Not infrastructure, not a year folder - DELETE IT
        try:
            visible_entries = [entry for entry in os.listdir(item_path) if entry not in ignored_entries]
            if visible_entries:
                print(f"    ⚠️  Preserving noncanonical folder with remaining files: {os.path.relpath(item_path, library_path)}")
                continue
            for ignored_entry in os.listdir(item_path):
                if ignored_entry in ignored_entries:
                    ignored_path = os.path.join(item_path, ignored_entry)
                    if os.path.isfile(ignored_path):
                        os.remove(ignored_path)
            shutil.rmtree(item_path)
            print(f"    🗑️  Removed folder: {os.path.relpath(item_path, library_path)}")
            removed_count += 1
        except Exception as e:
            print(f"    ⚠️  Could not remove {item_path}: {e}")
    
    return removed_count


def cleanup_empty_folders_recursive(root_path):
    """
    Recursively remove empty directories from a library after terraform.
    Walks bottom-up to ensure deepest directories are checked first.
    Skips hidden directories (.trash, .thumbnails, etc).
    
    NOTE: This function is deprecated for terraform and kept only for backward compatibility
    with other operations (import, date change, etc.). Use cleanup_terraform_folders() instead.
    """
    # v223: Use global constant - was missing .webp/.avif/.jp2, some videos (BUG FIX)
    # Note: Had extra RAW formats (.raf/.orf/.rw2) not in PHOTO_EXTENSIONS, now removed
    MEDIA_EXTS = ALL_MEDIA_EXTENSIONS
    
    removed_count = 0
    
    # Walk bottom-up (topdown=False) so we process leaf directories first
    for dirpath, dirnames, filenames in os.walk(root_path, topdown=False):
        # Skip hidden directories
        if any(part.startswith('.') for part in dirpath.split(os.sep)):
            continue
        
        # Don't delete root
        if os.path.abspath(dirpath) == os.path.abspath(root_path):
            continue
        
        # Check if directory is empty or contains only non-media files
        has_media = False
        
        for filename in filenames:
            _, ext = os.path.splitext(filename)
            if ext.lower() in MEDIA_EXTS:
                has_media = True
                break
        
        # If no media files and no subdirectories, delete the folder
        if not has_media:
            try:
                # Remove any non-media files first
                for filename in filenames:
                    file_path = os.path.join(dirpath, filename)
                    try:
                        os.remove(file_path)
                    except Exception:
                        pass
                
                # Try to remove directory
                os.rmdir(dirpath)
                removed_count += 1
                print(f"    🗑️  Removed empty folder: {os.path.relpath(dirpath, root_path)}")
            except OSError as e:
                # Folder not empty (has subdirs) or permission error
                pass
    
    return removed_count


def cleanup_terraform_source_folders(source_folders, library_path):
    """
    DEPRECATED: This function is no longer used by terraform.
    Use cleanup_terraform_folders() instead.
    
    Aggressively remove source folders after terraform completes.
    Uses shutil.rmtree to delete entire directory trees, including hidden folders.
    Only deletes if no media files remain.
    
    Args:
        source_folders: Set of folder paths that contained media before terraform
        library_path: Root library path (never deleted)
    
    Returns:
        Number of folders deleted
    """
    # v223: Use global constant - was missing .webp/.avif/.jp2, some videos (BUG FIX)
    # Note: Had extra RAW formats (.raf/.orf/.rw2) not in PHOTO_EXTENSIONS, now removed
    MEDIA_EXTS = ALL_MEDIA_EXTENSIONS
    
    removed_count = 0
    
    for folder in sorted(source_folders, reverse=True):  # Process deepest first
        # Safety check - never delete root
        if os.path.abspath(folder) == os.path.abspath(library_path):
            continue
        
        # Safety check - folder must still exist
        if not os.path.exists(folder):
            continue
        
        # Check if any media files remain in this tree
        media_remaining = []
        try:
            for root, dirs, files in os.walk(folder):
                for filename in files:
                    _, ext = os.path.splitext(filename)
                    if ext.lower() in MEDIA_EXTS:
                        media_remaining.append(os.path.join(root, filename))
        except Exception as e:
            print(f"    ⚠️  Error checking {folder}: {e}")
            continue
        
        # If no media remains, delete entire tree
        if not media_remaining:
            try:
                shutil.rmtree(folder)
                removed_count += 1
                print(f"    🗑️  Removed source folder: {os.path.relpath(folder, library_path)}")
            except Exception as e:
                print(f"    ⚠️  Could not remove {folder}: {e}")
        else:
            print(f"    ⚠️  Skipped {folder} - {len(media_remaining)} media file(s) remain")
    
    return removed_count


@app.route('/api/library/terraform', methods=['POST'])
def terraform_library():
    """
    Terraform an existing photo collection into app-compliant structure (SSE streaming)
    - Moves files in-place (no copying)
    - Writes EXIF to all files
    - Renames to canonical format
    - Organizes into YYYY/YYYY-MM-DD structure
    - Moves duplicates and errors to .trash/
    """
    def generate():
        try:
            data = request.json
            library_path = data.get('library_path')
            
            if not library_path or not os.path.exists(library_path):
                yield f"event: error\ndata: {json.dumps({'error': 'Invalid library path'})}\n\n"
                return
            
            print(f"\n{'='*60}")
            print(f"🔄 TERRAFORM LIBRARY: {library_path}")
            print(f"{'='*60}\n")
            
            # PRE-FLIGHT CHECKS
            print("🔍 Running pre-flight checks...")
            
            # Check for required tools
            try:
                subprocess.run(['exiftool', '-ver'], check=True, capture_output=True, timeout=5)
                print("  ✅ exiftool available")
            except (FileNotFoundError, subprocess.CalledProcessError):
                yield f"event: error\ndata: {json.dumps({'error': 'exiftool not installed. Install via: brew install exiftool'})}\n\n"
                return
            
            try:
                subprocess.run(['ffmpeg', '-version'], check=True, capture_output=True, timeout=5)
                print("  ✅ ffmpeg available")
            except (FileNotFoundError, subprocess.CalledProcessError):
                yield f"event: error\ndata: {json.dumps({'error': 'ffmpeg not installed. Install via: brew install ffmpeg'})}\n\n"
                return
            
            # Check disk space (require at least 10% free)
            stat = os.statvfs(library_path)
            free_space = stat.f_bavail * stat.f_frsize
            total_space = stat.f_blocks * stat.f_frsize
            free_pct = (free_space / total_space) * 100
            
            print(f"  💾 Disk space: {free_pct:.1f}% free")
            if free_pct < 10:
                yield f"event: error\ndata: {json.dumps({'error': f'Low disk space: {free_pct:.1f}% free. Need at least 10%.'})}\n\n"
                return
            print("  ✅ Disk space OK")
            
            # Check write permissions
            test_file = os.path.join(library_path, '.terraform_test')
            try:
                with open(test_file, 'w') as f:
                    f.write('test')
                os.remove(test_file)
                print("  ✅ Write permissions OK")
            except (PermissionError, OSError) as e:
                yield f"event: error\ndata: {json.dumps({'error': f'No write permission: {str(e)}'})}\n\n"
                return
            
            print("✅ Pre-flight checks passed\n")
            
            # Create hidden directories
            library_meta_dir = os.path.join(library_path, LIBRARY_METADATA_DIR)
            trash_dir = os.path.join(library_path, '.trash')
            thumbnails_dir = os.path.join(library_path, '.thumbnails')
            db_backups_dir = os.path.join(library_path, '.db_backups')
            logs_dir = os.path.join(library_path, '.logs')
            import_temp_dir = os.path.join(library_path, '.import_temp')
            
            for directory in [library_meta_dir, trash_dir, thumbnails_dir, db_backups_dir, logs_dir, import_temp_dir]:
                os.makedirs(directory, exist_ok=True)
            
            # Create manifest log
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            log_filename = f"terraform_{timestamp}.jsonl"
            log_path = os.path.join(logs_dir, log_filename)
            log_file = open(log_path, 'w')
            
            def log_manifest(event_type, data):
                entry = {
                    'timestamp': datetime.now().isoformat(),
                    'event': event_type,
                    **data
                }
                log_file.write(json.dumps(entry) + '\n')
                log_file.flush()
            
            log_manifest('start', {'library_path': library_path})
            
            # SCAN for all files recursively
            print("📂 Scanning for files...")
            media_files = []
            non_media_files = []
            
            for root, dirs, files in os.walk(library_path):
                # Skip hidden directories
                dirs[:] = [d for d in dirs if not d.startswith('.')]
                
                for filename in files:
                    # Skip .DS_Store and other system files
                    if filename.startswith('.'):
                        continue
                    
                    full_path = os.path.join(root, filename)
                    _, ext = os.path.splitext(filename)
                    ext_lower = ext.lower()
                    
                    if ext_lower in PHOTO_EXTENSIONS or ext_lower in VIDEO_EXTENSIONS:
                        media_files.append(full_path)
                    else:
                        # Non-media file - will be moved to trash
                        non_media_files.append(full_path)
            
            total_files = len(media_files)
            print(f"✅ Found {total_files} media files")
            print(f"✅ Found {len(non_media_files)} non-media files (will be moved to trash)\n")
            
            log_manifest('scan_complete', {'total_files': total_files, 'non_media_files': len(non_media_files)})
            
            # Move non-media files to trash immediately
            if non_media_files:
                print("🗑️  Moving non-media files to trash...")
                error_dir = os.path.join(trash_dir, 'errors')
                os.makedirs(error_dir, exist_ok=True)
                
                for non_media_path in non_media_files:
                    try:
                        trash_path = move_file_to_category_trash(
                            library_path,
                            trash_dir,
                            non_media_path,
                            'errors',
                        )
                        log_manifest('non_media', {'original': non_media_path, 'moved_to': trash_path})
                        print(f"   🗑️  {os.path.relpath(non_media_path, library_path)} → trash")
                    except Exception as e:
                        print(f"   ⚠️  Could not move {non_media_path}: {e}")
                
                print(f"✅ Moved {len(non_media_files)} non-media files to trash\n")
            
            yield f"event: start\ndata: {json.dumps({'total': total_files})}\n\n"
            
            # Create database
            db_path = canonical_db_path(library_path)
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row  # Return rows as dictionaries
            cursor = conn.cursor()
            hash_cache = HashCache(conn)
            
            # Create schema
            from db_schema import create_database_schema
            create_database_schema(cursor)
            conn.commit()
            print("✅ Database created\n")
            
            # Track results
            processed_count = 0
            duplicate_count = 0
            error_count = 0
            
            # PROCESS each file
            for file_index, source_path in enumerate(media_files, 1):
                try:
                    filename = os.path.basename(source_path)
                    print(f"{file_index}/{total_files}. Processing: {filename}")
                    
                    _, ext = os.path.splitext(filename)
                    file_type = 'video' if ext.lower() in VIDEO_EXTENSIONS else 'photo'
                    log_manifest('processing', {'file': source_path, 'file_type': file_type})

                    if file_type == 'photo':
                        staged_path = None
                        try:
                            staged_photo = stage_photo_for_canonicalization(
                                source_path,
                                temp_prefix='convert_photo_',
                                temp_dir=import_temp_dir,
                            )
                            staged_path = staged_photo.staged_path
                            canonical_photo = staged_photo.canonical_photo
                            print(
                                f"   📦 Canonical photo staged: {os.path.basename(staged_path)} "
                                f"→ {canonical_photo.relative_path}"
                            )

                            cursor.execute(
                                "SELECT id, current_path FROM photos WHERE content_hash = ?",
                                (canonical_photo.content_hash,),
                            )
                            existing = cursor.fetchone()
                            if existing:
                                dup_path = move_file_to_category_trash(
                                    library_path,
                                    trash_dir,
                                    source_path,
                                    'duplicates',
                                )
                                cleanup_staged_file(staged_path)
                                staged_path = None
                                print(f"   ⏭️  Duplicate canonical photo -> {os.path.relpath(dup_path, library_path)}")
                                log_manifest(
                                    'duplicate',
                                    {
                                        'original': source_path,
                                        'staged': staged_path,
                                        'moved_to': dup_path,
                                        'hash': canonical_photo.content_hash,
                                        'canonical_path': canonical_photo.relative_path,
                                        'existing_id': existing['id'],
                                        'existing_path': existing['current_path'],
                                    },
                                )
                                duplicate_count += 1
                                yield f"event: progress\ndata: {json.dumps({'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': file_index, 'total': total_files})}\n\n"
                                continue

                            photo_id, target_path = commit_staged_canonical_photo(
                                conn,
                                library_path=library_path,
                                source_path=source_path,
                                original_filename=filename,
                                staged_photo=staged_photo,
                                remove_source_after_commit=True,
                            )
                            staged_path = None
                            print(f"   ✅ Canonical photo committed: {canonical_photo.relative_path}")
                            log_manifest(
                                'success',
                                {
                                    'original': source_path,
                                    'canonical_path': canonical_photo.relative_path,
                                    'new': target_path,
                                    'hash': canonical_photo.content_hash,
                                    'id': photo_id,
                                    'file_type': 'photo',
                                    'date_taken': canonical_photo.date_taken,
                                },
                            )

                            processed_count += 1
                            yield f"event: progress\ndata: {json.dumps({'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': file_index, 'total': total_files})}\n\n"
                            continue
                        except Exception as photo_error:
                            print(f"   ❌ Photo convert failed: {photo_error}")
                            cleanup_staged_file(staged_path)
                            category, user_message = categorize_processing_error(photo_error)
                            log_manifest(
                                'failed',
                                {
                                    'file': source_path,
                                    'staged': staged_path,
                                    'reason': str(photo_error),
                                    'category': category,
                                    'preserved_original': os.path.exists(source_path),
                                },
                            )

                            if category == 'duplicate':
                                duplicate_count += 1
                            else:
                                error_count += 1
                            yield f"event: progress\ndata: {json.dumps({'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': file_index, 'total': total_files})}\n\n"
                            yield f"event: rejected\ndata: {json.dumps({'file': filename, 'source_path': source_path, 'reason': user_message, 'category': category, 'technical_error': str(photo_error)})}\n\n"
                            continue

                    content_hash, cache_hit = hash_cache.get_hash(source_path)
                    if cache_hit:
                        print(f"   Hash: {content_hash[:16]}... (cached)")
                    else:
                        print(f"   Hash: {content_hash[:16]}...")

                    if content_hash is None:
                        raise RuntimeError("Failed to hash file")

                    cursor.execute("SELECT id, current_path FROM photos WHERE content_hash = ?", (content_hash,))
                    existing = cursor.fetchone()
                    if existing:
                        dup_path = move_file_to_category_trash(
                            library_path,
                            trash_dir,
                            source_path,
                            'duplicates',
                        )
                        print(f"   ⏭️  Duplicate video -> {os.path.relpath(dup_path, library_path)}")
                        log_manifest('duplicate', {'original': source_path, 'moved_to': dup_path, 'hash': content_hash})
                        duplicate_count += 1
                        yield f"event: progress\ndata: {json.dumps({'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': file_index, 'total': total_files})}\n\n"
                        continue

                    date_taken, _ = parse_metadata_datetime(
                        extract_exif_date(source_path),
                        os.path.getmtime(source_path),
                    )
                    print(f"   Date: {date_taken}")

                    dimensions = get_image_dimensions(source_path)
                    width = dimensions[0] if dimensions else None
                    height = dimensions[1] if dimensions else None

                    print("   🔧 Writing video metadata...")
                    write_video_metadata(source_path, date_taken)

                    content_hash = compute_full_hash(source_path)
                    if not content_hash:
                        raise RuntimeError("Failed to compute canonical video hash after metadata write")

                    cursor.execute("SELECT id, current_path FROM photos WHERE content_hash = ?", (content_hash,))
                    existing = cursor.fetchone()
                    if existing:
                        dup_path = move_file_to_category_trash(
                            library_path,
                            trash_dir,
                            source_path,
                            'duplicates',
                        )
                        print(f"   ⏭️  Duplicate video after metadata write -> {os.path.relpath(dup_path, library_path)}")
                        log_manifest('duplicate', {'original': source_path, 'moved_to': dup_path, 'hash': content_hash})
                        duplicate_count += 1
                        yield f"event: progress\ndata: {json.dumps({'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': file_index, 'total': total_files})}\n\n"
                        continue

                    relative_path, _ = build_canonical_photo_path(date_taken, content_hash, ext)
                    target_path = os.path.join(library_path, relative_path)
                    if os.path.exists(target_path) and os.path.abspath(target_path) != os.path.abspath(source_path):
                        raise RuntimeError(
                            f"Refusing to overwrite existing file at canonical path {relative_path}"
                        )

                    if os.path.abspath(target_path) != os.path.abspath(source_path):
                        os.makedirs(os.path.dirname(target_path), exist_ok=True)
                        shutil.move(source_path, target_path)

                    file_size = os.path.getsize(target_path)
                    cursor.execute(
                        '''
                            INSERT INTO photos (current_path, original_filename, content_hash, file_size, file_type, date_taken, width, height)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ''',
                        (relative_path, filename, content_hash, file_size, file_type, date_taken, width, height),
                    )
                    photo_id = cursor.lastrowid
                    conn.commit()

                    log_manifest(
                        'success',
                        {
                            'original': source_path,
                            'new': target_path,
                            'canonical_path': relative_path,
                            'hash': content_hash,
                            'id': photo_id,
                            'file_type': file_type,
                            'date_taken': date_taken,
                        },
                    )

                    processed_count += 1
                    yield f"event: progress\ndata: {json.dumps({'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': file_index, 'total': total_files})}\n\n"
                    
                except Exception as e:
                    print(f"   ❌ Error: {e}")
                    category, user_message = categorize_processing_error(e)
                    log_manifest(
                        'failed',
                        {
                            'file': source_path,
                            'reason': str(e),
                            'category': category,
                            'preserved_original': os.path.exists(source_path),
                        },
                    )
                    error_count += 1
                    yield f"event: progress\ndata: {json.dumps({'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': file_index, 'total': total_files})}\n\n"
                    yield f"event: rejected\ndata: {json.dumps({'file': filename, 'source_path': source_path, 'reason': user_message, 'category': category, 'technical_error': str(e)})}\n\n"
            
            # Cleanup ALL folders except allowed ones
            print("\n🧹 Cleaning up folders...")
            
            removed_count = cleanup_terraform_folders(library_path)
            print(f"✅ Cleanup complete - removed {removed_count} folder(s)\n")
            
            # Close DB
            conn.close()
            
            # Log completion
            log_manifest('complete', {'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count})
            log_file.close()
            
            print(f"\n{'='*60}")
            print(f"✅ TERRAFORM COMPLETE")
            print(f"   Processed: {processed_count}")
            print(f"   Duplicates: {duplicate_count}")
            print(f"   Errors: {error_count}")
            print(f"   Log: {os.path.relpath(log_path, library_path)}")
            print(f"{'='*60}\n")
            
            yield f"event: complete\ndata: {json.dumps({'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count, 'log_path': os.path.relpath(log_path, library_path), 'db_path': db_path})}\n\n"
            
        except Exception as e:
            error_logger.error(f"Terraform failed: {e}")
            print(f"\n❌ Terraform failed: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')


# ============================================================================
# FAVORITES / RATING API
# ============================================================================

@app.route('/api/photo/<int:photo_id>/favorite', methods=['POST'])
@handle_db_corruption
def toggle_favorite(photo_id):
    """
    Toggle favorite status for a photo (NULL/5 rating).
    
    POST body (optional):
        {
            "rating": 5  // Explicit rating (0-5), default toggles NULL↔5
        }
    
    Returns:
        {
            "photo_id": int,
            "rating": int or null,  // New rating (NULL or 5)
            "favorited": bool  // true if now favorited
        }
    """
    from file_operations import extract_exif_rating, write_exif_rating, strip_exif_rating
    
    try:
        data = request.get_json(silent=True) or {}
        explicit_rating = data.get('rating')
        
        # Get photo path and current cleanliness state
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT current_path, content_hash, date_taken FROM photos WHERE id = ?",
            (photo_id,),
        )
        row = cursor.fetchone()
        
        if not row:
            return jsonify({'error': 'Photo not found'}), 404
        
        rel_path = row['current_path']
        full_path = os.path.join(LIBRARY_PATH, rel_path)
        
        if not os.path.exists(full_path):
            return jsonify({'error': 'File not found on disk'}), 404
        
        # Get current rating
        current_rating = extract_exif_rating(full_path)
        # Treat None and 0 as equivalent (not starred)
        if current_rating is None or current_rating == 0:
            current_rating = 0
        
        print(f"⭐ Photo {photo_id}: current rating = {current_rating}, toggling...")
        
        # Determine new rating
        if explicit_rating is not None:
            # Use explicit rating
            new_rating = int(explicit_rating)
            if not 0 <= new_rating <= 5:
                return jsonify({'error': 'Rating must be 0-5'}), 400
        else:
            # Toggle: 0 ↔ 5
            new_rating = 0 if current_rating == 5 else 5
        
        # Write or strip EXIF rating
        if new_rating == 0:
            # Strip rating tags completely (cleaner than writing 0)
            print(f"   → Stripping rating from {os.path.basename(full_path)}")
            success = strip_exif_rating(full_path)
            db_rating = None  # Store NULL in database
        else:
            # Write rating
            print(f"   → Writing rating {new_rating} to {os.path.basename(full_path)}")
            success = write_exif_rating(full_path, new_rating)
            db_rating = new_rating
        
        print(f"   → EXIF update success: {success}")
        
        if not success:
            error_logger.error(f"Failed to update EXIF rating for photo {photo_id}: {full_path}")
            return jsonify({'error': 'Failed to update EXIF rating'}), 500

        finalize_result = finalize_mutated_media(
            conn=conn,
            photo_id=photo_id,
            library_path=LIBRARY_PATH,
            current_rel_path=rel_path,
            date_taken=row['date_taken'],
            old_hash=row['content_hash'],
            build_canonical_path=build_canonical_photo_path,
            compute_hash=compute_full_hash,
            get_dimensions=get_image_dimensions,
            delete_thumbnail_for_hash=delete_thumbnail_for_hash,
            duplicate_policy='trash',
            duplicate_trash_dir=os.path.join(TRASH_DIR, 'duplicates'),
        )
        print(
            f"   🔎 Favorite finalize: photo_id={photo_id} "
            f"old_hash={row['content_hash']} "
            f"final_status={finalize_result.status} "
            f"final_hash={finalize_result.content_hash} "
            f"final_path={finalize_result.current_path} "
            f"matched_id={finalize_result.duplicate.photo_id if finalize_result.duplicate else None} "
            f"matched_path={finalize_result.duplicate.current_path if finalize_result.duplicate else None}"
        )

        if finalize_result.status == 'duplicate_removed':
            conn.commit()
            conn.close()
            print(
                f"⭐ Photo {photo_id}: favorite update made file a duplicate of "
                f"{finalize_result.duplicate.photo_id if finalize_result.duplicate else 'unknown'}"
            )
            return jsonify({
                'photo_id': photo_id,
                'duplicate_removed': True,
                'message': 'Photo became a duplicate after updating favorite and was moved to trash'
            })

        # Update database rating after final hash/path reconciliation.
        cursor.execute("UPDATE photos SET rating = ? WHERE id = ?", (db_rating, photo_id))
        conn.commit()
        conn.close()
        
        print(f"⭐ Photo {photo_id}: rating {current_rating} → {new_rating if new_rating != 0 else 'NULL'}")
        
        return jsonify({
            'photo_id': photo_id,
            'rating': db_rating,
            'favorited': new_rating == 5,
            'photo': {
                'id': photo_id,
                'path': finalize_result.current_path,
                'content_hash': finalize_result.content_hash,
                'width': finalize_result.width,
                'height': finalize_result.height,
            }
        })
    
    except Exception as e:
        error_logger.error(f"Error toggling favorite for photo {photo_id}: {e}")
        import traceback
        error_logger.error(traceback.format_exc())
        return jsonify({'error': str(e)}), 500


@app.route('/api/photos/favorites', methods=['GET'])
@handle_db_corruption
def get_favorites():
    """
    Get all favorited photos (rating = 5).
    
    Returns:
        {
            "photos": [
                {
                    "id": int,
                    "current_path": str,
                    "date_taken": str,
                    "rating": int
                },
                ...
            ],
            "count": int
        }
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT id, current_path, date_taken, rating
            FROM photos
            WHERE rating = 5
            ORDER BY date_taken DESC
        """)
        
        photos = []
        for row in cursor.fetchall():
            photos.append({
                'id': row['id'],
                'current_path': row['current_path'],
                'date_taken': row['date_taken'],
                'rating': row['rating']
            })
        
        conn.close()
        
        return jsonify({
            'photos': photos,
            'count': len(photos)
        })
    
    except Exception as e:
        error_logger.error(f"Error getting favorites: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/library/make-perfect', methods=['POST'])
def api_make_library_perfect():
    """
    Execute Clean library operation via the DB normalization engine.
    """
    try:
        from make_library_perfect import run_db_normalization_engine

        if not LIBRARY_PATH:
            return jsonify({'error': 'No library configured'}), 400

        if not os.path.isdir(LIBRARY_PATH):
            return jsonify({'error': 'Configured library path is missing or invalid'}), 400

        if not os.access(LIBRARY_PATH, os.R_OK | os.X_OK):
            return jsonify({'error': 'Configured library path is not accessible'}), 503

        if not DB_PATH:
            return jsonify({'error': 'No database configured'}), 400

        db_dir = os.path.dirname(DB_PATH) or '.'
        if not os.path.isdir(db_dir):
            return jsonify({'error': 'Configured database path is invalid'}), 400
        
        print(f"\n{'='*60}")
        print(f"🔧 MAKE LIBRARY PERFECT: {LIBRARY_PATH}")
        print(f"{'='*60}\n")
        
        # Execute the operation against the configured DB path.
        result = run_db_normalization_engine(LIBRARY_PATH, db_path=DB_PATH)
        
        print(f"\n✅ Make Library Perfect completed successfully")
        
        return jsonify(result)
        
    except Exception as e:
        print(f"\n❌ Make Library Perfect failed: {str(e)}")
        error_logger.error(f"Make Library Perfect failed: {e}")
        error_logger.error(traceback.format_exc())
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/library/make-perfect/stream', methods=['POST'])
def api_make_library_perfect_stream():
    """
    Same engine as POST /api/library/make-perfect, but streams JSON events (SSE)
    for live processed/total progress. Final event: {"type":"complete","result":...}
    or {"type":"error","error":"..."}.
    """
    if not LIBRARY_PATH:
        return jsonify({'error': 'No library configured'}), 400

    if not os.path.isdir(LIBRARY_PATH):
        return jsonify({'error': 'Configured library path is missing or invalid'}), 400

    if not os.access(LIBRARY_PATH, os.R_OK | os.X_OK):
        return jsonify({'error': 'Configured library path is not accessible'}), 503

    if not DB_PATH:
        return jsonify({'error': 'No database configured'}), 400

    db_dir = os.path.dirname(DB_PATH) or '.'
    if not os.path.isdir(db_dir):
        return jsonify({'error': 'Configured database path is invalid'}), 400

    from make_library_perfect import run_db_normalization_engine

    event_queue: queue.Queue = queue.Queue()

    def run_op():
        try:

            def progress_callback(ev):
                event_queue.put(('evt', ev))

            result = run_db_normalization_engine(
                LIBRARY_PATH,
                db_path=DB_PATH,
                progress_callback=progress_callback,
            )
            event_queue.put(('done', result))
        except Exception as e:
            error_logger.error(f"Make Library Perfect stream failed: {e}")
            error_logger.error(traceback.format_exc())
            event_queue.put(('err', str(e)))

    threading.Thread(target=run_op, daemon=True).start()

    @stream_with_context
    def generate():
        while True:
            try:
                kind, payload = event_queue.get(timeout=600)
            except queue.Empty:
                yield f"data: {json.dumps({'type': 'error', 'error': 'Timed out waiting for progress'})}\n\n"
                break
            if kind == 'evt':
                yield f"data: {json.dumps(payload)}\n\n"
            elif kind == 'done':
                yield f"data: {json.dumps({'type': 'complete', 'result': payload})}\n\n"
                break
            elif kind == 'err':
                yield f"data: {json.dumps({'type': 'error', 'error': payload})}\n\n"
                break

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    )


@app.route('/api/library/make-perfect/scan', methods=['GET'])
def api_scan_make_library_perfect():
    """
    Preflight scan for Clean library using the DB normalization engine's audit rulebook.
    """
    try:
        from make_library_perfect import scan_library_cleanliness

        if not LIBRARY_PATH:
            return jsonify({'error': 'No library configured'}), 400

        if not os.path.isdir(LIBRARY_PATH):
            return jsonify({'error': 'Configured library path is missing or invalid'}), 400

        if not os.access(LIBRARY_PATH, os.R_OK | os.X_OK):
            return jsonify({'error': 'Configured library path is not accessible'}), 503

        print(f"\n{'='*60}")
        print(f"🔎 CLEAN LIBRARY SCAN: {LIBRARY_PATH}")
        print(f"{'='*60}\n")

        result = scan_library_cleanliness(LIBRARY_PATH, db_path=DB_PATH)
        return jsonify(result)

    except Exception as e:
        print(f"\n❌ Clean library scan failed: {str(e)}")
        error_logger.error(f"Clean library scan failed: {e}")
        error_logger.error(traceback.format_exc())
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/photos/bulk-favorite', methods=['POST'])
@handle_db_corruption
def bulk_favorite():
    """
    Set favorite status for multiple photos.
    
    POST body:
        {
            "photo_ids": [1, 2, 3],
            "rating": 5  // 0-5 (5 = favorite, 0 = unfavorite)
        }
    
    Returns:
        {
            "success_count": int,
            "error_count": int,
            "errors": [{"photo_id": int, "error": str}, ...]
        }
    """
    from file_operations import write_exif_rating
    
    try:
        data = request.json
        photo_ids = data.get('photo_ids', [])
        rating = int(data.get('rating', 5))
        
        if not 0 <= rating <= 5:
            return jsonify({'error': 'Rating must be 0-5'}), 400
        
        if not photo_ids:
            return jsonify({'error': 'No photo_ids provided'}), 400
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        success_count = 0
        error_count = 0
        errors = []
        
        for photo_id in photo_ids:
            try:
                # Get photo path
                cursor.execute("SELECT current_path FROM photos WHERE id = ?", (photo_id,))
                row = cursor.fetchone()
                
                if not row:
                    errors.append({'photo_id': photo_id, 'error': 'Photo not found'})
                    error_count += 1
                    continue
                
                rel_path = row['current_path']
                full_path = os.path.join(LIBRARY_PATH, rel_path)
                
                if not os.path.exists(full_path):
                    errors.append({'photo_id': photo_id, 'error': 'File not found on disk'})
                    error_count += 1
                    continue
                
                # Write EXIF rating
                success = write_exif_rating(full_path, rating)
                
                if not success:
                    errors.append({'photo_id': photo_id, 'error': 'Failed to write EXIF'})
                    error_count += 1
                    continue
                
                # Update database
                cursor.execute("UPDATE photos SET rating = ? WHERE id = ?", (rating, photo_id))
                success_count += 1
            
            except Exception as e:
                errors.append({'photo_id': photo_id, 'error': str(e)})
                error_count += 1
        
        conn.commit()
        conn.close()
        
        print(f"⭐ Bulk favorite: {success_count} success, {error_count} errors")
        
        return jsonify({
            'success_count': success_count,
            'error_count': error_count,
            'errors': errors
        })
    
    except Exception as e:
        error_logger.error(f"Error in bulk favorite: {e}")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print("\n🖼️  Photos Light Starting...")
    print(f"📁 Static files: {STATIC_DIR}")
    
    # Load config on startup
    config = load_config()
    if config:
        library_path = config.get('library_path')
        db_path = config.get('db_path')
        
        # Validate paths still exist
        if library_path and db_path and os.path.exists(library_path) and os.path.exists(db_path):
            print(f"✅ Loading library: {library_path}")
            update_app_paths(library_path, db_path)
            
            # Auto-migrate database to latest schema
            print(f"🔍 Checking database schema...")
            try:
                from migrate_db import check_and_migrate_schema
                check_and_migrate_schema(db_path)
            except Exception as e:
                print(f"⚠️  Migration check failed: {e}")
                print(f"   Database may need manual migration")
        else:
            print(f"⚠️  Saved library not found - user will be prompted")
            delete_config()  # Clean up stale config
    else:
        print(f"⚠️  No library configured - user will be prompted")
    
    print(f"🌐 Open: http://localhost:5001\n")
    
    # Run a single backend process to avoid transient route drift from the
    # Werkzeug debug reloader serving newer frontend files against stale routes.
    app.run(debug=True, use_reloader=False, port=5001, host='0.0.0.0')
