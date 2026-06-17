#!/usr/bin/env python3
"""
Photo Viewer - Flask Server with Database API
"""

from flask import Flask, send_from_directory, jsonify, request, send_file, Response, stream_with_context
from collections import defaultdict
import base64
import sqlite3
import traceback
from functools import wraps
from hash_cache import HashCache
from runtime_paths import get_base_dir, get_config_file, get_static_dir

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
    get_dimensions as shared_get_dimensions,
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
from clean_library_inventory import (
    estimate_clean_duration_seconds,
    estimate_convert_duration_seconds,
    format_about_duration,
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
from media_finalization import (
    apply_pending_thumbnail_cleanup,
    finalize_mutated_media,
    rollback_finalize_mutated_media,
)
from media_dates import write_and_verify_media_date
from library_filesystem import (
    ensure_blocking_audit_prep,
    iter_layout_cleanup_passes,
    move_file_to_category_trash,
    quarantine_root_hidden,
    remove_noncanonical_trees,
)
from normalization_convert import (
    ConvertDependencies,
    iter_convert_events,
    scan_convert_library,
)
from normalization_ingest import IngestDependencies, iter_ingest_events
from photo_canonicalization import (
    CanonicalizedPhoto,
    canonicalize_photo_file,
)
from picker_sort import sort_picker_items
from make_library_perfect import _compute_photo_duplicate_key, verify_media_file
from trash_catalog import (
    archive_live_photo_to_user_trash,
    ensure_user_deleted_trash_dir,
    fetch_deleted_photos_anchored_at_month,
    fetch_deleted_photos_for_grid_month,
    fetch_deleted_photos_page,
    fetch_trash_nearest_month,
    fetch_trash_years,
    get_cached_trash_month_index,
    invalidate_trash_grid_caches,
    parse_deleted_photo_data,
    restore_or_merge_deleted_photo,
    resolve_user_deleted_trash_path,
)
from rotation_utils import (
    HEIC_ROTATION_EXTENSIONS,
    JPEG_LOSSY_QUALITY,
    ROTATION_SUPPORTED_EXTENSIONS,
    bake_orientation as shared_bake_orientation,
    can_rotate_losslessly,
    get_orientation_flag,
    normalize_rotation_degrees,
    rotate_file_in_place,
)
from image_pixels import (
    BROWSER_CONVERT_EXTENSIONS,
    generate_preview_jpeg_buffer,
    generate_still_square_thumbnail,
    generate_video_square_thumbnail,
    needs_browser_video_proxy,
    preview_decode_error_message,
    still_image_to_jpeg_buffer,
    thumbnail_cache_path,
    video_mimetype_for_extension,
    video_playback_error_message,
    video_to_browser_mp4_buffer,
)

# Register HEIF/HEIC support for PIL
register_heif_opener()

# Paths (resolved before Flask init so bundled static assets work)
BASE_DIR = get_base_dir()
STATIC_DIR = get_static_dir()

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path='/static')

# Feature flags
app.config['DRY_RUN_DATE_EDIT'] = False  # REAL UPDATES - using test library

# Library paths - set when the user opens or creates a library this session
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
    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.row_factory = sqlite3.Row  # Return rows as dictionaries
    
    # Enable Write-Ahead Logging for better concurrency
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=60000")
    
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
            width, height = shared_get_dimensions(file_path)
            if width and height:
                return (width, height)
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

    thumbnail_path = thumbnail_cache_path(THUMBNAIL_CACHE_DIR, content_hash)
    if os.path.exists(thumbnail_path):
        os.remove(thumbnail_path)
        cleanup_empty_thumbnail_folders(thumbnail_path)

def write_photo_exif(file_path, new_date):
    """Write canonical photo date metadata using the shared helper."""
    print(f"🔧 Writing EXIF to: {os.path.basename(file_path)}")
    print(f"   Target date: {new_date}")
    write_and_verify_media_date(file_path, new_date)
    print("   ✅ EXIF write verified")

def write_video_metadata(file_path, new_date):
    """Write and verify video metadata using the shared fail-closed policy."""
    write_and_verify_media_date(file_path, new_date)


@dataclass
class StagedCanonicalPhoto:
    staged_path: str
    canonical_photo: CanonicalizedPhoto


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
                        write_and_verify_media_date(file_path, old_date)
                        print(f"  ↩️  Restored EXIF: {os.path.basename(file_path)}")
            
            except Exception as e:
                print(f"  ⚠️  Rollback error (continuing): {e}")
        
        print(f"✅ Rollback complete")

def cleanup_empty_date_folders(old_full_path):
    """Remove empty date/year folders left behind after a successful move."""
    try:
        from quicktime_date_atoms import (
            cleanup_orphan_patch_artifacts_in_dir,
            remove_quicktime_patch_artifacts,
        )

        old_dir = os.path.dirname(old_full_path)
        remove_quicktime_patch_artifacts(old_full_path)
        cleanup_orphan_patch_artifacts_in_dir(old_dir)
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
        
        # Phase 1: write and verify embedded metadata. Date edits fail closed:
        # do not update DB/path when supported metadata could not be written.
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
            transaction.log_failure(old_filename, e)
            raise

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
        thumbnail_path = thumbnail_cache_path(THUMBNAIL_CACHE_DIR, content_hash, mkdir=True)

        # Skip if already exists
        if os.path.exists(thumbnail_path):
            return True

        if file_type == 'video':
            os.makedirs(IMPORT_TEMP_DIR, exist_ok=True)
            temp_frame = os.path.join(IMPORT_TEMP_DIR, f"temp_frame_{content_hash[:16]}.jpg")
            generate_video_square_thumbnail(
                file_path,
                thumbnail_path,
                temp_frame_path=temp_frame,
                to_rgb=convert_to_rgb_properly,
            )
            return True

        generate_still_square_thumbnail(
            file_path,
            thumbnail_path,
            to_rgb=convert_to_rgb_properly,
        )
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


def infer_date_taken_from_canonical_path(current_path):
    """Infer YYYY:MM:DD HH:MM:SS from canonical library path when DB date is missing."""
    norm = (current_path or '').replace('\\', '/')
    parts = norm.split('/')
    if len(parts) >= 2:
        seg = parts[1]
        if len(seg) >= 10 and seg[4] == '-' and seg[7] == '-' and seg[:4].isdigit():
            try:
                date_obj = datetime.strptime(seg[:10], '%Y-%m-%d')
                return date_obj.strftime('%Y:%m:%d %H:%M:%S')
            except ValueError:
                pass
    return None


def effective_date_taken_for_edit(date_taken, current_path):
    """Resolve a date for editing when DB date may be null or the unknown placeholder."""
    if date_taken:
        normalized = str(date_taken)
        if not normalized.startswith('1900:01:01'):
            return normalized
    inferred = infer_date_taken_from_canonical_path(current_path)
    if inferred:
        return inferred
    return str(date_taken) if date_taken else None


def month_key_for_photo_grid(date_taken, current_path):
    """
    YYYY-MM bucket for the main grid. When EXIF date is missing, infer from canonical
    path (YYYY/YYYY-MM-DD/...) so undated rows still appear.
    """
    effective_date = effective_date_taken_for_edit(date_taken, current_path)
    if effective_date:
        date_normalized = effective_date.replace(':', '-', 2)
        return date_normalized[:7]
    return 'undated'


PHOTO_GRID_SELECT = """
    SELECT id, date_taken, file_type, current_path, width, height, rating
    FROM photos
"""

# Monotonic catalog generation for grid read caches. Bumped on library switch and
# structural catalog changes (photos table rebuild, full DB re-index). Row-level
# mutations invalidate histogram caches without bumping revision.
LIBRARY_CATALOG_REVISION = 0
PHOTO_TOTAL_COUNT_CACHE = None
PHOTO_TOTAL_COUNT_CACHE_REVISION = None
MONTH_INDEX_CACHE = {}
MONTH_INDEX_CACHE_REVISION = None


def get_library_catalog_revision():
    """Return current server catalog revision exposed to the grid client."""
    return LIBRARY_CATALOG_REVISION


def attach_catalog_revision(payload):
    """Attach catalog_revision to a grid API JSON payload."""
    if isinstance(payload, dict):
        payload = dict(payload)
        payload['catalog_revision'] = LIBRARY_CATALOG_REVISION
    return payload


def bump_library_catalog_revision():
    """Bump catalog revision after structural library/catalog changes."""
    global LIBRARY_CATALOG_REVISION
    LIBRARY_CATALOG_REVISION += 1
    invalidate_grid_read_caches()


def invalidate_grid_read_caches():
    """Drop cached month histogram and total count after row/histogram mutations."""
    invalidate_photo_total_count_cache()
    invalidate_month_index_cache()
    invalidate_trash_grid_caches()


def commit_row_mutation(conn, *, invalidate_histogram=True):
    """Commit a row mutation and invalidate grid read caches on success."""
    conn.commit()
    if invalidate_histogram:
        invalidate_grid_read_caches()


def invalidate_photo_total_count_cache():
    """Drop cached library row count for the current catalog revision."""
    global PHOTO_TOTAL_COUNT_CACHE, PHOTO_TOTAL_COUNT_CACHE_REVISION
    PHOTO_TOTAL_COUNT_CACHE = None
    PHOTO_TOTAL_COUNT_CACHE_REVISION = None


def invalidate_month_index_cache():
    """Drop cached per-sort month histogram for the current catalog revision."""
    global MONTH_INDEX_CACHE
    MONTH_INDEX_CACHE = {}


def notify_catalog_reset_from_make_perfect(result):
    """Bump catalog revision after a successful make-perfect (Clean) run."""
    if result and result.get('status') == 'SUCCESS':
        bump_library_catalog_revision()


def ensure_photo_grid_indices(db_path=None):
    """Create keyset pagination indices if missing (idempotent)."""
    target_db = db_path or DB_PATH
    if not target_db or not os.path.exists(target_db):
        return
    from db_schema import PHOTOS_INDICES

    conn = sqlite3.connect(target_db)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='photos'")
    if not cursor.fetchone():
        conn.close()
        return
    cursor.execute("PRAGMA table_info(photos)")
    columns = {row[1] for row in cursor.fetchall()}
    required_columns = {
        'id',
        'content_hash',
        'date_taken',
        'file_type',
        'rating',
        'current_path',
    }
    if not required_columns.issubset(columns):
        conn.close()
        return

    cursor.execute("SELECT name FROM sqlite_master WHERE type='index'")
    existing = {row[0] for row in cursor.fetchall()}
    for index_sql in PHOTOS_INDICES:
        index_name = index_sql.split("INDEX IF NOT EXISTS ")[1].split(" ")[0]
        if index_name not in existing:
            cursor.execute(index_sql)
    conn.commit()
    conn.close()


def get_photo_total_count(cursor):
    """Return total photos row count; cached per catalog revision."""
    global PHOTO_TOTAL_COUNT_CACHE, PHOTO_TOTAL_COUNT_CACHE_REVISION
    if PHOTO_TOTAL_COUNT_CACHE_REVISION != LIBRARY_CATALOG_REVISION:
        PHOTO_TOTAL_COUNT_CACHE = cursor.execute('SELECT COUNT(*) FROM photos').fetchone()[0]
        PHOTO_TOTAL_COUNT_CACHE_REVISION = LIBRARY_CATALOG_REVISION
    return PHOTO_TOTAL_COUNT_CACHE


def normalize_month_for_sql(month_str):
    """Map UI month YYYY-MM to DB substr(date_taken,1,7) form YYYY:MM."""
    if not month_str or len(month_str) < 7:
        return month_str
    return f"{month_str[:4]}:{month_str[5:7]}"


def month_bounds_for_sql(month_str):
    """Return inclusive lower and exclusive upper date_taken bounds for a YYYY-MM month."""
    month_sql = normalize_month_for_sql(month_str)
    year = int(month_sql[:4])
    month = int(month_sql[5:7])
    lower = f"{year}:{month:02d}:01 00:00:00"
    if month == 12:
        upper = f"{year + 1}:01:01 00:00:00"
    else:
        upper = f"{year}:{month + 1:02d}:01 00:00:00"
    return lower, upper


def photo_row_to_grid_dict(row):
    """Serialize a photos table row for the main grid API."""
    date_str = row['date_taken']
    return {
        'id': row['id'],
        'date': date_str,
        'month': month_key_for_photo_grid(date_str, row['current_path']),
        'file_type': row['file_type'],
        'path': row['current_path'],
        'width': row['width'],
        'height': row['height'],
        'rating': row['rating'],
    }


def encode_photos_cursor(section, *, date_taken=None, current_path=None, photo_id=None):
    """Opaque cursor for keyset pagination (dated or undated section)."""
    if section == 'dated':
        raw = f"dated|{date_taken or ''}|{current_path or ''}|{photo_id or ''}"
    else:
        raw = f"undated|{current_path or ''}|{photo_id or ''}"
    return base64.urlsafe_b64encode(raw.encode('utf-8')).decode('ascii')


def decode_photos_cursor(cursor_str):
    """Parse cursor from query param; returns dict or None."""
    if not cursor_str:
        return None
    try:
        raw = base64.urlsafe_b64decode(cursor_str.encode('ascii')).decode('utf-8')
        parts = raw.split('|')
        if parts[0] == 'dated' and len(parts) >= 4:
            return {
                'section': 'dated',
                'date_taken': parts[1] or None,
                'current_path': parts[2] or None,
                'photo_id': int(parts[3]) if parts[3] else None,
            }
        if parts[0] == 'undated' and len(parts) >= 3:
            return {
                'section': 'undated',
                'current_path': parts[1] or None,
                'photo_id': int(parts[2]) if parts[2] else None,
            }
    except (ValueError, UnicodeDecodeError):
        return None
    return None


def cursor_from_row(row, section):
    """Build next_cursor from the last row in a page."""
    if section == 'dated':
        return encode_photos_cursor(
            'dated',
            date_taken=row['date_taken'],
            current_path=row['current_path'],
            photo_id=row['id'],
        )
    return encode_photos_cursor(
        'undated',
        current_path=row['current_path'],
        photo_id=row['id'],
    )


def fetch_photo_grid_row_by_id(cursor, photo_id):
    """Load one grid row after a mutation."""
    row = cursor.execute(
        f"{PHOTO_GRID_SELECT} WHERE id = ?",
        (photo_id,),
    ).fetchone()
    return photo_row_to_grid_dict(row) if row else None


def _hydrate_photo_rows_by_id(cursor, id_rows):
    """Load full grid columns for id rows, preserving keyset order."""
    if not id_rows:
        return []
    ids = [row['id'] if hasattr(row, 'keys') else row[0] for row in id_rows]
    placeholders = ','.join('?' * len(ids))
    rows = cursor.execute(
        f"{PHOTO_GRID_SELECT} WHERE id IN ({placeholders})",
        ids,
    ).fetchall()
    by_id = {row['id']: row for row in rows}
    return [by_id[photo_id] for photo_id in ids if photo_id in by_id]


def _fetch_dated_photo_page(cursor, limit, sort_order, after=None):
    """Index-friendly dated page using keyset pagination."""
    if sort_order == 'newest':
        order_clause = 'ORDER BY date_taken DESC, current_path ASC, id ASC'
        if after:
            where = """
                WHERE date_taken IS NOT NULL
                  AND (
                    date_taken < ? OR
                    (date_taken = ? AND current_path > ?) OR
                    (date_taken = ? AND current_path = ? AND id > ?)
                  )
            """
            params = (
                after['date_taken'], after['date_taken'], after['current_path'],
                after['date_taken'], after['current_path'], after['photo_id'],
                limit,
            )
        else:
            where = 'WHERE date_taken IS NOT NULL'
            params = (limit,)
    else:
        order_clause = 'ORDER BY date_taken ASC, current_path ASC, id ASC'
        if after:
            where = """
                WHERE date_taken IS NOT NULL
                  AND (
                    date_taken > ? OR
                    (date_taken = ? AND current_path > ?) OR
                    (date_taken = ? AND current_path = ? AND id > ?)
                  )
            """
            params = (
                after['date_taken'], after['date_taken'], after['current_path'],
                after['date_taken'], after['current_path'], after['photo_id'],
                limit,
            )
        else:
            where = 'WHERE date_taken IS NOT NULL'
            params = (limit,)

    id_rows = cursor.execute(
        f"SELECT id FROM photos {where} {order_clause} LIMIT ?",
        params,
    ).fetchall()
    return _hydrate_photo_rows_by_id(cursor, id_rows)


def _fetch_undated_photo_page(cursor, limit, after=None):
    """Undated rows always sort after dated rows, ordered by path then id."""
    if after:
        where = """
            WHERE date_taken IS NULL
              AND (
                current_path > ? OR
                (current_path = ? AND id > ?)
              )
        """
        params = (after['current_path'], after['current_path'], after['photo_id'], limit)
    else:
        where = 'WHERE date_taken IS NULL'
        params = (limit,)

    id_rows = cursor.execute(
        f"SELECT id FROM photos {where} ORDER BY current_path ASC, id ASC LIMIT ?",
        params,
    ).fetchall()
    return _hydrate_photo_rows_by_id(cursor, id_rows)


def fetch_all_photos_for_grid(cursor, sort_order):
    """Return full library in grid order without a global sort temp table."""
    dated_rows = _fetch_dated_photo_page(cursor, limit=10**9, sort_order=sort_order)
    undated_rows = _fetch_undated_photo_page(cursor, limit=10**9)
    return list(dated_rows) + list(undated_rows)


def fetch_photos_page(cursor, limit, sort_order, cursor_str=None):
    """
    Paginate photos in grid order: dated rows first, undated last.
    Uses keyset cursors instead of OFFSET.
    """
    parsed = decode_photos_cursor(cursor_str)
    photos = []
    section = parsed['section'] if parsed else 'dated'
    after = parsed

    if section == 'dated':
        dated_rows = _fetch_dated_photo_page(
            cursor, limit, sort_order, after=after if parsed else None,
        )
        photos.extend(dated_rows)
        remaining = limit - len(photos)
        if remaining > 0:
            undated_rows = _fetch_undated_photo_page(cursor, remaining)
            photos.extend(undated_rows)
            if undated_rows:
                section = 'undated'
                after = {
                    'section': 'undated',
                    'current_path': undated_rows[-1]['current_path'],
                    'photo_id': undated_rows[-1]['id'],
                }
            elif dated_rows:
                section = 'dated'
                after = {
                    'section': 'dated',
                    'date_taken': dated_rows[-1]['date_taken'],
                    'current_path': dated_rows[-1]['current_path'],
                    'photo_id': dated_rows[-1]['id'],
                }
        elif dated_rows:
            section = 'dated'
            after = {
                'section': 'dated',
                'date_taken': dated_rows[-1]['date_taken'],
                'current_path': dated_rows[-1]['current_path'],
                'photo_id': dated_rows[-1]['id'],
            }
    else:
        undated_rows = _fetch_undated_photo_page(
            cursor, limit, after=after if parsed else None,
        )
        photos.extend(undated_rows)
        if undated_rows:
            section = 'undated'
            after = {
                'section': 'undated',
                'current_path': undated_rows[-1]['current_path'],
                'photo_id': undated_rows[-1]['id'],
            }

    next_cursor = None
    if photos:
        next_cursor = cursor_from_row(photos[-1], section)

    total = get_photo_total_count(cursor)
    has_more = len(photos) == limit

    return {
        'photos': [photo_row_to_grid_dict(row) for row in photos],
        'count': len(photos),
        'total': total,
        'limit': limit,
        'next_cursor': next_cursor,
        'has_more': has_more,
    }


def fetch_photos_anchored_at_month(cursor, target_month, limit, sort_order):
    """Load a viewport window anchored at a year-month (date picker jump)."""
    lower, upper = month_bounds_for_sql(target_month)
    if sort_order == 'newest':
        id_rows = cursor.execute(
            """
            SELECT id FROM photos
            WHERE date_taken IS NOT NULL
              AND date_taken < ?
            ORDER BY date_taken DESC, current_path ASC, id ASC
            LIMIT ?
            """,
            (upper, limit),
        ).fetchall()
    else:
        id_rows = cursor.execute(
            """
            SELECT id FROM photos
            WHERE date_taken IS NOT NULL
              AND date_taken >= ?
            ORDER BY date_taken ASC, current_path ASC, id ASC
            LIMIT ?
            """,
            (lower, limit),
        ).fetchall()
    rows = _hydrate_photo_rows_by_id(cursor, id_rows)

    section = 'dated' if rows else None
    next_cursor = cursor_from_row(rows[-1], section) if rows else None
    total = get_photo_total_count(cursor)
    return {
        'photos': [photo_row_to_grid_dict(row) for row in rows],
        'count': len(rows),
        'total': total,
        'limit': limit,
        'next_cursor': next_cursor,
        'has_more': len(rows) == limit,
        'anchor_month': target_month,
    }


@app.route('/api/photos')
@handle_db_corruption
def get_photos():
    """
    Get photos from database
    Query params:
    - limit: number of photos to return (optional - if omitted, returns ALL)
    - cursor: keyset pagination cursor from prior response next_cursor
    - offset: legacy pagination offset (avoid on large libraries)
    - sort: 'newest' or 'oldest' (default 'newest')
    """
    limit = request.args.get('limit', type=int)
    cursor_str = request.args.get('cursor')
    offset = request.args.get('offset', 0, type=int)
    sort_order = request.args.get('sort', 'newest')

    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        if limit is None:
            rows = fetch_all_photos_for_grid(cursor, sort_order)
            photos = [photo_row_to_grid_dict(row) for row in rows]
            conn.close()
            return jsonify(attach_catalog_revision({'photos': photos, 'count': len(photos)}))

        if cursor_str:
            payload = fetch_photos_page(cursor, limit, sort_order, cursor_str=cursor_str)
        else:
            payload = fetch_photos_page(cursor, limit, sort_order)

        conn.close()
        payload['offset'] = offset
        return jsonify(attach_catalog_revision(payload))
    except Exception as e:
        app.logger.error(f"Error fetching photos: {e}")
        return jsonify({'error': str(e)}), 500


def _sort_grid_month_keys(month_counts, sort_order):
    """Order month buckets for the main grid (undated always last)."""
    dated = [month for month in month_counts.keys() if month != 'undated']
    dated.sort(reverse=(sort_order == 'newest'))
    ordered = dated
    if 'undated' in month_counts:
        ordered = ordered + ['undated']
    return ordered


def _month_index_cache_key(sort_order, starred=False, video=False):
    flags = []
    if starred:
        flags.append('starred')
    if video:
        flags.append('video')
    suffix = ','.join(flags) if flags else 'all'
    return f'{sort_order}|{suffix}'


def _parse_grid_filter_query_args(starred_arg=None, video_arg=None):
    """Parse starred/video filter flags from request strings or booleans."""
    if isinstance(starred_arg, bool):
        starred = starred_arg
    else:
        starred = str(starred_arg or '').lower() in ('1', 'true', 'yes')
    if isinstance(video_arg, bool):
        video = video_arg
    else:
        video = str(video_arg or '').lower() in ('1', 'true', 'yes')
    return starred, video


def build_month_index(cursor, sort_order='newest', *, starred=False, video=False):
    """Aggregate photo counts per grid month bucket, optionally filtered."""
    query = 'SELECT date_taken, current_path FROM photos WHERE 1=1'
    params = []
    if starred:
        query += ' AND rating = 5'
    if video:
        query += ' AND file_type = ?'
        params.append('video')
    rows = cursor.execute(query, params).fetchall()
    month_counts = defaultdict(int)
    for row in rows:
        month = month_key_for_photo_grid(row['date_taken'], row['current_path'])
        month_counts[month] += 1

    ordered = _sort_grid_month_keys(month_counts, sort_order)
    months = [{'month': month, 'count': month_counts[month]} for month in ordered]
    total = sum(month_counts.values())
    undated_count = month_counts.get('undated', 0)
    return {
        'months': months,
        'total': total,
        'undated_count': undated_count,
        'sort': sort_order,
        'starred': starred,
        'video': video,
        'filtered': bool(starred or video),
    }


def get_cached_month_index(cursor, sort_order='newest', *, starred=False, video=False):
    """Return month histogram; cached per sort + filter for the current catalog revision."""
    global MONTH_INDEX_CACHE, MONTH_INDEX_CACHE_REVISION
    if MONTH_INDEX_CACHE_REVISION != LIBRARY_CATALOG_REVISION:
        MONTH_INDEX_CACHE = {}
        MONTH_INDEX_CACHE_REVISION = LIBRARY_CATALOG_REVISION
    cache_key = _month_index_cache_key(sort_order, starred, video)
    if cache_key not in MONTH_INDEX_CACHE:
        MONTH_INDEX_CACHE[cache_key] = build_month_index(
            cursor,
            sort_order,
            starred=starred,
            video=video,
        )
    return MONTH_INDEX_CACHE[cache_key]


def fetch_photos_for_grid_month(cursor, month_key, sort_order='newest'):
    """Load all photos belonging to one grid month bucket."""
    if month_key == 'undated':
        rows = cursor.execute(
            f"{PHOTO_GRID_SELECT} WHERE date_taken IS NULL ORDER BY current_path ASC, id ASC",
        ).fetchall()
        rows = [
            row for row in rows
            if month_key_for_photo_grid(row['date_taken'], row['current_path']) == 'undated'
        ]
    else:
        lower, upper = month_bounds_for_sql(month_key)
        year = month_key[:4]
        month_num = month_key[5:7]
        path_prefix = f"{year}/{year}-{month_num}-%"
        dated_rows = cursor.execute(
            f"""
            {PHOTO_GRID_SELECT}
            WHERE date_taken IS NOT NULL
              AND date_taken >= ?
              AND date_taken < ?
            """,
            (lower, upper),
        ).fetchall()
        path_rows = cursor.execute(
            f"""
            {PHOTO_GRID_SELECT}
            WHERE date_taken IS NULL
              AND current_path LIKE ?
            """,
            (path_prefix + '%',),
        ).fetchall()
        rows = list(dated_rows) + list(path_rows)

    dated = [row for row in rows if row['date_taken']]
    undated = [row for row in rows if not row['date_taken']]
    if sort_order == 'newest':
        dated.sort(
            key=lambda row: (row['date_taken'], row['current_path'], row['id']),
            reverse=True,
        )
    else:
        dated.sort(key=lambda row: (row['date_taken'], row['current_path'], row['id']))
    undated.sort(key=lambda row: (row['current_path'], row['id']))
    rows = dated + undated

    return [photo_row_to_grid_dict(row) for row in rows]


@app.route('/api/photos/month_index')
@handle_db_corruption
def get_photos_month_index():
    """Month histogram for virtual grid layout (counts per YYYY-MM bucket)."""
    try:
        sort_order = request.args.get('sort', 'newest')
        starred, video = _parse_grid_filter_query_args(
            request.args.get('starred'),
            request.args.get('video'),
        )
        conn = get_db_connection()
        cursor = conn.cursor()
        payload = get_cached_month_index(
            cursor,
            sort_order,
            starred=starred,
            video=video,
        )
        conn.close()
        return jsonify(attach_catalog_revision(payload))
    except Exception as e:
        app.logger.error(f"Error fetching month index: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/photos/month')
@handle_db_corruption
def get_photos_for_month():
    """All photos in one grid month bucket."""
    try:
        month_key = request.args.get('month')
        sort_order = request.args.get('sort', 'newest')
        if not month_key:
            return jsonify({'error': 'month parameter required (format: YYYY-MM or undated)'}), 400

        conn = get_db_connection()
        cursor = conn.cursor()
        photos = fetch_photos_for_grid_month(cursor, month_key, sort_order)
        conn.close()
        return jsonify({
            'month': month_key,
            'photos': photos,
            'count': len(photos),
            'sort': sort_order,
        })
    except Exception as e:
        app.logger.error(f"Error fetching month photos: {e}")
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
    - Uses hash-based sharding: .thumbnails/{hash[:2]}/{hash[2:4]}/{hash}.v2.jpg
    """
    if not LIBRARY_PATH or not THUMBNAIL_CACHE_DIR or not DB_PATH:
        return jsonify({'error': 'Library not configured'}), 503

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

        if not relative_path:
            return jsonify({'error': 'Photo missing file path'}), 404

        if not content_hash:
            return jsonify({'error': 'Photo missing content hash'}), 404
        
        thumbnail_path = thumbnail_cache_path(THUMBNAIL_CACHE_DIR, content_hash)

        # Serve cached thumbnail if it exists
        if os.path.exists(thumbnail_path):
            return send_file(thumbnail_path, mimetype='image/jpeg')

        full_path = os.path.join(LIBRARY_PATH, relative_path)

        if not os.path.exists(full_path):
            return jsonify({'error': 'File not found on disk'}), 404

        thumbnail_path = thumbnail_cache_path(THUMBNAIL_CACHE_DIR, content_hash, mkdir=True)

        if row['file_type'] == 'video':
            temp_frame = os.path.join(os.path.dirname(thumbnail_path), f"temp_{photo_id}.jpg")
            try:
                generate_video_square_thumbnail(
                    full_path,
                    thumbnail_path,
                    temp_frame_path=temp_frame,
                    to_rgb=convert_to_rgb_properly,
                )
            except Exception as video_error:
                return jsonify({'error': str(video_error)}), 500
            return send_file(thumbnail_path, mimetype='image/jpeg')

        generate_still_square_thumbnail(
            full_path,
            thumbnail_path,
            to_rgb=convert_to_rgb_properly,
        )
        return send_file(thumbnail_path, mimetype='image/jpeg')
            
    except Exception as e:
        print(f"❌ Error generating thumbnail for photo {photo_id}: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/photo/<int:photo_id>/file')
@handle_db_corruption
def get_photo_file(photo_id):
    """Serve photo/video for lightbox (on-the-fly JPEG for stills, MP4 proxy for videos)."""
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
        
        ext = os.path.splitext(full_path)[1].lower()
        if ext in BROWSER_CONVERT_EXTENSIONS:
            buffer = still_image_to_jpeg_buffer(
                full_path,
                quality=95,
                to_rgb=convert_to_rgb_properly,
            )
            return send_file(buffer, mimetype='image/jpeg')

        if ext in VIDEO_EXTENSIONS:
            if needs_browser_video_proxy(full_path):
                try:
                    buffer = video_to_browser_mp4_buffer(full_path)
                except Exception as e:
                    print(f"Error preparing browser video for photo {photo_id}: {e}")
                    return jsonify({'error': video_playback_error_message(full_path, e)}), 422
                return send_file(buffer, mimetype='video/mp4')
            return send_file(full_path, mimetype=video_mimetype_for_extension(ext))
        
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
            staged_reason = (
                'heic_conversion_deferred'
                if ext in HEIC_ROTATION_EXTENSIONS
                else 'lossy_fallback_required'
            )
            print(
                "   📝 Returning staged response to frontend "
                f"({staged_reason})"
            )
            print(f"   ⏱️ Rotate request handled in {request_elapsed_ms:.1f} ms")
            return jsonify(
                {
                    'ok': True,
                    'committed': False,
                    'staged': True,
                    'lossless': False,
                    'reason': staged_reason,
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
        if ext in HEIC_ROTATION_EXTENSIONS:
            commit_path = "HEIC to TIFF conversion"
        elif rotation_result.lossless:
            commit_path = "lossless"
        else:
            commit_path = f"lossy JPEG @ {JPEG_LOSSY_QUALITY}"
        print(f"   💾 Rotation committed via {commit_path} path")
        print(f"   ⏱️ File rotation took {rotate_elapsed_ms:.1f} ms")
        old_hash = row['content_hash']
        source_heic_rel_path = row['current_path'] if ext in HEIC_ROTATION_EXTENSIONS else None
        rel_path_for_finalize = row['current_path']
        if rotation_result.output_path:
            rel_path_for_finalize = os.path.relpath(
                rotation_result.output_path,
                LIBRARY_PATH,
            )
        finalize_result = finalize_mutated_media(
            conn=conn,
            photo_id=photo_id,
            library_path=LIBRARY_PATH,
            current_rel_path=rel_path_for_finalize,
            date_taken=row['date_taken'],
            old_hash=old_hash,
            build_canonical_path=build_canonical_photo_path,
            compute_hash=compute_full_hash,
            get_dimensions=get_image_dimensions,
            delete_thumbnail_for_hash=delete_thumbnail_for_hash,
            duplicate_policy='trash',
            duplicate_trash_dir=os.path.join(TRASH_DIR, 'duplicates'),
            defer_thumbnail_cleanup=True,
        )
        if source_heic_rel_path:
            source_heic_full_path = os.path.join(LIBRARY_PATH, source_heic_rel_path)
            if os.path.exists(source_heic_full_path):
                if (
                    finalize_result.full_path
                    and os.path.abspath(source_heic_full_path)
                    != os.path.abspath(finalize_result.full_path)
                ):
                    os.remove(source_heic_full_path)
                    print(
                        f"   🗑️ Removed source HEIC after conversion: {source_heic_rel_path}"
                    )
        try:
            commit_row_mutation(conn)
            apply_pending_thumbnail_cleanup(
                finalize_result,
                delete_thumbnail_for_hash,
            )
        except Exception:
            conn.rollback()
            rollback_finalize_mutated_media(finalize_result)
            raise
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

def _delete_photo_id(cursor, photo_id, trash_dir):
    """Move one library photo to user trash and archive its DB row."""
    moved_to_trash = None
    original_full_path = None
    merge_duplicate = False
    try:
        print(f"    Processing photo_id: {photo_id}", flush=True)
        cursor.execute("SELECT * FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()

        if not row:
            print(f"    ❌ Photo {photo_id} NOT FOUND in database")
            return False, f"Photo {photo_id} not found"

        photo_data = dict(row)
        current_path = photo_data['current_path']
        original_full_path = os.path.join(LIBRARY_PATH, current_path)

        print(f"  - Photo {photo_id}: {current_path}")

        deleted_at = datetime.now().isoformat()
        outcome, trash_filename, error = archive_live_photo_to_user_trash(
            cursor,
            photo_id=photo_id,
            photo_data=photo_data,
            current_path=current_path,
            library_path=LIBRARY_PATH,
            trash_dir=trash_dir,
            deleted_at=deleted_at,
        )
        if error:
            print(f"    ❌ {error}")
            return False, error

        if outcome == 'merged_duplicate':
            merge_duplicate = True
            print(
                f"    ✓ Merged with existing trash copy (hash "
                f"{photo_data.get('content_hash', '')[:8]})",
                flush=True,
            )
        else:
            moved_to_trash = resolve_user_deleted_trash_path(trash_dir, trash_filename)
            print(f"    ✓ Moved to: {moved_to_trash}", flush=True)

        cleanup_empty_folders(original_full_path, LIBRARY_PATH)

        content_hash = photo_data.get('content_hash')
        if content_hash:
            thumbnail_path = thumbnail_cache_path(THUMBNAIL_CACHE_DIR, content_hash)
            if os.path.exists(thumbnail_path):
                os.remove(thumbnail_path)
                cleanup_empty_thumbnail_folders(thumbnail_path)
                print(f"    ✓ Deleted thumbnail")

        app.logger.info(f"Deleted photo {photo_id}: {current_path}")
        return True, None

    except Exception as e:
        if (
            not merge_duplicate
            and moved_to_trash
            and original_full_path
            and os.path.exists(moved_to_trash)
        ):
            try:
                os.makedirs(os.path.dirname(original_full_path), exist_ok=True)
                shutil.move(moved_to_trash, original_full_path)
            except Exception as rollback_error:
                error_logger.error(
                    f"Delete rollback failed for photo {photo_id}: {rollback_error}"
                )
        print(f"    ❌ Error: {e}")
        error_logger.error(f"Delete failed for photo {photo_id}: {e}")
        return False, f"Error deleting photo {photo_id}: {str(e)}"


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
        ensure_user_deleted_trash_dir(trash_dir)
        
        print(f"    Starting delete loop for {len(photo_ids)} photos...", flush=True)
        
        for photo_id in photo_ids:
            deleted, error = _delete_photo_id(cursor, photo_id, trash_dir)
            if deleted:
                deleted_count += 1
            elif error:
                errors.append(error)
        
        if deleted_count > 0:
            commit_row_mutation(conn)
        else:
            conn.rollback()
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
            commit_row_mutation(conn)
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
            cursor.execute(
                "SELECT date_taken, current_path FROM photos WHERE id = ?",
                (photo_ids[0],),
            )
            row = cursor.fetchone()
            if not row:
                return jsonify({'error': 'First photo not found'}), 404

            original_date_str = effective_date_taken_for_edit(
                row['date_taken'],
                row['current_path'],
            )
            if not original_date_str:
                return jsonify({'error': 'First photo has no usable date to shift from'}), 400

            original_date = datetime.strptime(original_date_str, '%Y:%m:%d %H:%M:%S')
            new_date_obj = datetime.strptime(new_date, '%Y:%m:%d %H:%M:%S')
            offset = new_date_obj - original_date

            # Calculate shifted date for each photo
            for photo_id in photo_ids:
                cursor.execute(
                    "SELECT date_taken, current_path FROM photos WHERE id = ?",
                    (photo_id,),
                )
                row = cursor.fetchone()
                if row:
                    photo_date_str = effective_date_taken_for_edit(
                        row['date_taken'],
                        row['current_path'],
                    )
                    if not photo_date_str:
                        return jsonify({
                            'error': f'Photo {photo_id} has no usable date to shift from',
                        }), 400
                    photo_date = datetime.strptime(photo_date_str, '%Y:%m:%d %H:%M:%S')
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
                cursor.execute(
                    "SELECT date_taken, current_path FROM photos WHERE id = ?",
                    (photo_id,),
                )
                row = cursor.fetchone()
                if row:
                    photo_date_str = effective_date_taken_for_edit(
                        row['date_taken'],
                        row['current_path'],
                    )
                    if not photo_date_str:
                        return jsonify({
                            'error': f'Photo {photo_id} has no usable date to sequence from',
                        }), 400
                    original_date = datetime.strptime(photo_date_str, '%Y:%m:%d %H:%M:%S')
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
            commit_row_mutation(conn)
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
            db_cursor = conn.cursor()
            success, result, transaction = update_photo_date_with_files(photo_id, new_date, conn)

            if success:
                commit_row_mutation(conn)
                print(f"✅ Updated photo {photo_id} with file operations")

                if result['status'] == 'duplicate_removed':
                    complete_payload = {
                        'updated_count': 0,
                        'duplicate_count': 1,
                        'photo_id': photo_id,
                        'duplicate_removed': True,
                    }
                else:
                    photo_row = fetch_photo_grid_row_by_id(db_cursor, photo_id)
                    complete_payload = {
                        'updated_count': 1,
                        'duplicate_count': 0,
                        'photo_id': photo_id,
                        'photo': photo_row,
                    }
                conn.close()
                yield f"event: complete\ndata: {json.dumps(complete_payload)}\n\n"
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
                cursor.execute(
                    "SELECT date_taken, current_path FROM photos WHERE id = ?",
                    (photo_ids[0],),
                )
                row = cursor.fetchone()
                if not row:
                    yield f"event: error\ndata: {json.dumps({'error': 'First photo not found'})}\n\n"
                    return

                original_date_str = effective_date_taken_for_edit(
                    row['date_taken'],
                    row['current_path'],
                )
                if not original_date_str:
                    yield f"event: error\ndata: {json.dumps({'error': 'First photo has no usable date to shift from'})}\n\n"
                    return

                original_date = datetime.strptime(original_date_str, '%Y:%m:%d %H:%M:%S')
                new_date_obj = datetime.strptime(new_date, '%Y:%m:%d %H:%M:%S')
                offset = new_date_obj - original_date

                # Calculate shifted date for each photo
                for photo_id in photo_ids:
                    cursor.execute(
                        "SELECT date_taken, current_path FROM photos WHERE id = ?",
                        (photo_id,),
                    )
                    row = cursor.fetchone()
                    if row:
                        photo_date_str = effective_date_taken_for_edit(
                            row['date_taken'],
                            row['current_path'],
                        )
                        if not photo_date_str:
                            yield f"event: error\ndata: {json.dumps({'error': f'Photo {photo_id} has no usable date to shift from'})}\n\n"
                            return
                        photo_date = datetime.strptime(photo_date_str, '%Y:%m:%d %H:%M:%S')
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
                    cursor.execute(
                        "SELECT date_taken, current_path FROM photos WHERE id = ?",
                        (photo_id,),
                    )
                    row = cursor.fetchone()
                    if row:
                        photo_date_str = effective_date_taken_for_edit(
                            row['date_taken'],
                            row['current_path'],
                        )
                        if not photo_date_str:
                            yield f"event: error\ndata: {json.dumps({'error': f'Photo {photo_id} has no usable date to sequence from'})}\n\n"
                            return
                        original_date = datetime.strptime(photo_date_str, '%Y:%m:%d %H:%M:%S')
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
                
                success, result, transaction = update_photo_date_with_files(photo_id, target_date, conn)
                
                if success:
                    if result['status'] == 'duplicate_removed':
                        duplicate_count += 1
                        print(f"  ⏭️  Photo {photo_id} is now a duplicate (moved to trash)")
                        yield f"event: progress\ndata: {json.dumps({'current': idx, 'total': total, 'photo_id': photo_id, 'duplicate_removed': True})}\n\n"
                    else:
                        success_count += 1
                        master_transaction.operations.extend(transaction.operations)
                        photo_row = fetch_photo_grid_row_by_id(cursor, photo_id)
                        yield f"event: progress\ndata: {json.dumps({'current': idx, 'total': total, 'photo_id': photo_id, 'photo': photo_row})}\n\n"
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
                commit_row_mutation(conn)
                conn.close()

                if duplicate_count > 0:
                    print(f"✅ Updated {success_count} photos, {duplicate_count} duplicates moved to trash")
                else:
                    print(f"✅ Updated {success_count} photos with file operations")

                try:
                    response_data = {
                        'updated_count': success_count,
                        'duplicate_count': duplicate_count,
                        'total': total,
                    }
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

def _restore_photo_ids(cursor, photo_ids, trash_dir):
    """Restore deleted photos from user trash back to the library index."""
    restored_count = 0
    merged_count = 0
    processed_ids = []
    errors = []

    for photo_id in photo_ids:
        try:
            print(f"  - Photo {photo_id}")
            outcome, live_photo_id, error = restore_or_merge_deleted_photo(
                cursor,
                photo_id=photo_id,
                trash_dir=trash_dir,
                library_path=LIBRARY_PATH,
            )
            if outcome == 'error':
                print(f"    ❌ {error}")
                errors.append(error)
                continue

            processed_ids.append(photo_id)
            restored_count += 1
            if outcome == 'merged':
                merged_count += 1
                print(
                    f"    ✓ Merged with live photo {live_photo_id}",
                    flush=True,
                )
                app.logger.info(
                    f"Merged trash photo {photo_id} with live photo {live_photo_id}",
                )
            else:
                print(f"    ✓ Restored photo {photo_id}", flush=True)
                app.logger.info(f"Restored photo {photo_id}")

        except Exception as e:
            errors.append(f"Error restoring photo {photo_id}: {str(e)}")
            print(f"    ❌ Error: {e}")
            error_logger.error(f"Restore failed for photo {photo_id}: {e}")

    return restored_count, merged_count, processed_ids, errors


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
        restored_count, merged_count, processed_ids, errors = _restore_photo_ids(cursor, photo_ids, TRASH_DIR)
        
        if restored_count > 0:
            commit_row_mutation(conn)
        else:
            conn.rollback()
        conn.close()
        
        print(f"✅ Restored {restored_count} photos ({merged_count} merged)\n")
        
        response = {
            'restored': restored_count,
            'merged': merged_count,
            'processed_ids': processed_ids,
            'total': len(photo_ids),
        }

        if errors:
            response['errors'] = errors

        return jsonify(response)

    except Exception as e:
        app.logger.error(f"Restore error: {e}")
        return jsonify({'error': str(e)}), 500


def _trash_grid_helpers():
    return {
        'month_key_for_photo_grid': month_key_for_photo_grid,
        'sort_grid_month_keys': _sort_grid_month_keys,
        'month_bounds_for_sql': month_bounds_for_sql,
        'decode_photos_cursor': decode_photos_cursor,
        'cursor_from_row': cursor_from_row,
        'catalog_revision': LIBRARY_CATALOG_REVISION,
    }


def _fetch_deleted_row(cursor, photo_id):
    row = cursor.execute(
        "SELECT * FROM deleted_photos WHERE id = ?",
        (photo_id,),
    ).fetchone()
    return dict(row) if row else None


def _deleted_media_full_path(trash_dir, deleted_row):
    trash_path = resolve_user_deleted_trash_path(trash_dir, deleted_row['trash_filename'])
    return trash_path if trash_path and os.path.exists(trash_path) else None


@app.route('/api/trash/photos')
@handle_db_corruption
def get_trash_photos():
    """Paginated trash grid rows sourced from deleted_photos."""
    limit = request.args.get('limit', type=int)
    cursor_str = request.args.get('cursor')
    sort_order = request.args.get('sort', 'newest')
    helpers = _trash_grid_helpers()

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        if limit is None:
            payload = fetch_deleted_photos_page(
                cursor,
                10**9,
                sort_order,
                cursor_str=None,
                catalog_revision=helpers['catalog_revision'],
                month_key_for_photo_grid=helpers['month_key_for_photo_grid'],
                decode_photos_cursor=helpers['decode_photos_cursor'],
                cursor_from_row=helpers['cursor_from_row'],
            )
            conn.close()
            return jsonify(attach_catalog_revision({
                'photos': payload['photos'],
                'count': payload['count'],
            }))

        payload = fetch_deleted_photos_page(
            cursor,
            limit,
            sort_order,
            cursor_str=cursor_str,
            catalog_revision=helpers['catalog_revision'],
            month_key_for_photo_grid=helpers['month_key_for_photo_grid'],
            decode_photos_cursor=helpers['decode_photos_cursor'],
            cursor_from_row=helpers['cursor_from_row'],
        )
        conn.close()
        return jsonify(attach_catalog_revision(payload))
    except Exception as e:
        app.logger.error(f"Error fetching trash photos: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/trash/month_index')
@handle_db_corruption
def get_trash_month_index():
    try:
        sort_order = request.args.get('sort', 'newest')
        starred, video = _parse_grid_filter_query_args(
            request.args.get('starred'),
            request.args.get('video'),
        )
        helpers = _trash_grid_helpers()
        conn = get_db_connection()
        cursor = conn.cursor()
        payload = get_cached_trash_month_index(
            cursor,
            sort_order,
            starred=starred,
            video=video,
            month_key_for_photo_grid=helpers['month_key_for_photo_grid'],
            sort_grid_month_keys=helpers['sort_grid_month_keys'],
            catalog_revision=helpers['catalog_revision'],
        )
        conn.close()
        return jsonify(attach_catalog_revision(payload))
    except Exception as e:
        app.logger.error(f"Error fetching trash month index: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/trash/month')
@handle_db_corruption
def get_trash_month_photos():
    try:
        month_key = request.args.get('month')
        sort_order = request.args.get('sort', 'newest')
        if not month_key:
            return jsonify({'error': 'month parameter required (format: YYYY-MM)'}), 400
        helpers = _trash_grid_helpers()
        conn = get_db_connection()
        cursor = conn.cursor()
        photos = fetch_deleted_photos_for_grid_month(
            cursor,
            month_key,
            sort_order,
            month_key_for_photo_grid=helpers['month_key_for_photo_grid'],
            month_bounds_for_sql=helpers['month_bounds_for_sql'],
        )
        conn.close()
        return jsonify(attach_catalog_revision({
            'photos': photos,
            'count': len(photos),
            'month': month_key,
        }))
    except Exception as e:
        app.logger.error(f"Error fetching trash month photos: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/trash/jump')
@handle_db_corruption
def jump_to_trash_month():
    try:
        target_month = request.args.get('month')
        limit = request.args.get('limit', 500, type=int)
        sort_order = request.args.get('sort', 'newest')
        if not target_month:
            return jsonify({'error': 'month parameter required (format: YYYY-MM)'}), 400
        helpers = _trash_grid_helpers()
        conn = get_db_connection()
        cursor = conn.cursor()
        payload = fetch_deleted_photos_anchored_at_month(
            cursor,
            target_month,
            limit,
            sort_order,
            catalog_revision=helpers['catalog_revision'],
            month_bounds_for_sql=helpers['month_bounds_for_sql'],
            month_key_for_photo_grid=helpers['month_key_for_photo_grid'],
            cursor_from_row=helpers['cursor_from_row'],
        )
        conn.close()
        return jsonify(attach_catalog_revision(payload))
    except Exception as e:
        app.logger.error(f"Error jumping to trash month: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/trash/nearest_month')
@handle_db_corruption
def get_trash_nearest_month():
    try:
        target_month = request.args.get('month')
        sort_order = request.args.get('sort', 'newest')
        if not target_month:
            return jsonify({'error': 'month parameter required (format: YYYY-MM)'}), 400
        conn = get_db_connection()
        cursor = conn.cursor()
        nearest = fetch_trash_nearest_month(cursor, target_month, sort_order)
        conn.close()
        if not nearest:
            return jsonify({'error': 'No photos found in trash'}), 404
        return jsonify({'nearest_month': nearest})
    except Exception as e:
        app.logger.error(f"Error finding nearest trash month: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/trash/years')
@handle_db_corruption
def get_trash_years():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        years = sort_picker_items(fetch_trash_years(cursor), key=str)
        conn.close()
        return jsonify({'years': years})
    except Exception as e:
        app.logger.error(f"Error fetching trash years: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/trash/photo/<int:photo_id>/thumbnail')
@handle_db_corruption
def get_trash_photo_thumbnail(photo_id):
    if not LIBRARY_PATH or not THUMBNAIL_CACHE_DIR or not DB_PATH:
        return jsonify({'error': 'Library not configured'}), 503
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        deleted_row = _fetch_deleted_row(cursor, photo_id)
        conn.close()
        if not deleted_row:
            return jsonify({'error': 'Photo not found in trash'}), 404

        photo_data = parse_deleted_photo_data(deleted_row)
        content_hash = photo_data.get('content_hash')
        file_type = photo_data.get('file_type')
        if not content_hash:
            return jsonify({'error': 'Photo missing content hash'}), 404

        thumbnail_path = thumbnail_cache_path(THUMBNAIL_CACHE_DIR, content_hash)
        if os.path.exists(thumbnail_path):
            return send_file(thumbnail_path, mimetype='image/jpeg')

        full_path = _deleted_media_full_path(TRASH_DIR, deleted_row)
        if not full_path:
            return jsonify({'error': 'File not found in trash'}), 404

        thumbnail_path = thumbnail_cache_path(THUMBNAIL_CACHE_DIR, content_hash, mkdir=True)
        if file_type == 'video':
            temp_frame = os.path.join(os.path.dirname(thumbnail_path), f"temp_trash_{photo_id}.jpg")
            try:
                generate_video_square_thumbnail(
                    full_path,
                    thumbnail_path,
                    temp_frame_path=temp_frame,
                    to_rgb=convert_to_rgb_properly,
                )
            except Exception as video_error:
                return jsonify({'error': str(video_error)}), 500
            return send_file(thumbnail_path, mimetype='image/jpeg')

        generate_still_square_thumbnail(
            full_path,
            thumbnail_path,
            to_rgb=convert_to_rgb_properly,
        )
        return send_file(thumbnail_path, mimetype='image/jpeg')
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/trash/photo/<int:photo_id>/file')
@handle_db_corruption
def get_trash_photo_file(photo_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        deleted_row = _fetch_deleted_row(cursor, photo_id)
        conn.close()
        if not deleted_row:
            return jsonify({'error': 'Photo not found in trash'}), 404

        full_path = _deleted_media_full_path(TRASH_DIR, deleted_row)
        if not full_path:
            return jsonify({'error': 'File not found in trash'}), 404

        photo_data = parse_deleted_photo_data(deleted_row)
        file_type = photo_data.get('file_type')
        ext = os.path.splitext(full_path)[1].lower()
        if file_type == 'video':
            if needs_browser_video_proxy(ext):
                buffer = video_to_browser_mp4_buffer(full_path)
                return send_file(
                    BytesIO(buffer),
                    mimetype='video/mp4',
                    download_name=os.path.basename(full_path),
                )
            return send_file(full_path, mimetype=video_mimetype_for_extension(ext))
        return send_file(full_path)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/trash/purge', methods=['POST'])
@handle_db_corruption
def purge_trash_photos():
    """Permanently delete photos from user trash."""
    try:
        data = request.get_json() or {}
        photo_ids = data.get('photo_ids') or []
        purge_all = bool(data.get('all'))

        conn = get_db_connection()
        cursor = conn.cursor()

        if purge_all:
            cursor.execute("SELECT id FROM deleted_photos")
            photo_ids = [row['id'] for row in cursor.fetchall()]

        if not photo_ids:
            conn.close()
            return jsonify({'purged': 0, 'total': 0})

        purged_count = 0
        errors = []
        trash_dir = TRASH_DIR

        for photo_id in photo_ids:
            try:
                deleted_row = _fetch_deleted_row(cursor, photo_id)
                if not deleted_row:
                    errors.append(f"Photo {photo_id} not found in trash")
                    continue
                trash_path = resolve_user_deleted_trash_path(
                    trash_dir,
                    deleted_row['trash_filename'],
                )
                if os.path.exists(trash_path):
                    os.remove(trash_path)
                cursor.execute("DELETE FROM deleted_photos WHERE id = ?", (photo_id,))
                purged_count += 1
            except Exception as exc:
                errors.append(f"Error purging photo {photo_id}: {exc}")

        if purged_count > 0:
            commit_row_mutation(conn)
        else:
            conn.rollback()
        conn.close()

        response = {'purged': purged_count, 'total': len(photo_ids)}
        if errors:
            response['errors'] = errors
        return jsonify(response)
    except Exception as e:
        app.logger.error(f"Purge trash error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/trash/restore-all', methods=['POST'])
@handle_db_corruption
def restore_all_trash_photos():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM deleted_photos")
        photo_ids = [row['id'] for row in cursor.fetchall()]
        if not photo_ids:
            conn.close()
            return jsonify({'restored': 0, 'total': 0})

        print(f"\n↩️  RESTORE ALL REQUEST: {len(photo_ids)} photos")
        restored_count, merged_count, processed_ids, errors = _restore_photo_ids(cursor, photo_ids, TRASH_DIR)
        if restored_count > 0:
            commit_row_mutation(conn)
        else:
            conn.rollback()
        conn.close()

        response = {
            'restored': restored_count,
            'merged': merged_count,
            'processed_ids': processed_ids,
            'total': len(photo_ids),
        }
        if errors:
            response['errors'] = errors
        return jsonify(response)
    except Exception as e:
        app.logger.error(f"Restore all trash error: {e}")
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
            ORDER BY year ASC
        """)
        
        rows = cursor.fetchall()
        years = sort_picker_items(
            [int(row['year']) for row in rows],
            key=str,
        )
        
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
    """Replace the grid window with photos anchored at a year-month."""
    try:
        target_month = request.args.get('month')  # Format: YYYY-MM
        limit = request.args.get('limit', 500, type=int)
        sort_order = request.args.get('sort', 'newest')

        if not target_month:
            return jsonify({'error': 'month parameter required (format: YYYY-MM)'}), 400

        conn = get_db_connection()
        cursor = conn.cursor()
        payload = fetch_photos_anchored_at_month(
            cursor, target_month, limit, sort_order,
        )
        conn.close()
        return jsonify(payload)

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
        photo_count = 0
        video_count = 0
        photo_bytes = 0
        video_bytes = 0

        def path_is_hidden(location):
            for component in os.path.normpath(location).split(os.sep):
                if component and component not in ('.', '..') and component.startswith('.'):
                    return True
            return False

        def add_media_file(full_path):
            nonlocal photo_count, video_count, photo_bytes, video_bytes

            if path_is_hidden(full_path):
                return False

            _, ext = os.path.splitext(full_path)
            ext_lower = ext.lower()
            if ext_lower not in PHOTO_EXTENSIONS and ext_lower not in VIDEO_EXTENSIONS:
                return False

            media_files.append(full_path)
            try:
                size_bytes = os.path.getsize(full_path)
            except OSError:
                size_bytes = 0

            if ext_lower in VIDEO_EXTENSIONS:
                video_count += 1
                video_bytes += size_bytes
            else:
                photo_count += 1
                photo_bytes += size_bytes
            return True
        
        for path in paths:
            if not os.path.exists(path):
                print(f"  ⚠️  Path not found: {path}")
                continue
            
            if os.path.isfile(path):
                # Individual file
                if add_media_file(path):
                    files_count += 1
            
            elif os.path.isdir(path):
                if path_is_hidden(path):
                    print(f"  ⏭️  Skipping hidden folder: {path}")
                    continue

                # Folder - scan recursively
                folders_count += 1
                print(f"  📁 Scanning folder: {path}")
                
                for root, dirs, files in os.walk(path, followlinks=False):
                    dirs[:] = [d for d in dirs if not d.startswith('.')]
                    for filename in files:
                        if filename.startswith('.'):
                            continue
                        full_path = os.path.join(root, filename)
                        add_media_file(full_path)
        
        print(f"  ✅ Found {len(media_files)} media files")
        print(f"     {files_count} direct file(s), {folders_count} folder(s) scanned")

        estimated_seconds = estimate_clean_duration_seconds(
            photo_count=photo_count,
            video_count=video_count,
            photo_bytes=photo_bytes,
            video_bytes=video_bytes,
        )
        _seconds, estimated_display = format_about_duration(estimated_seconds)
        
        return jsonify({
            'status': 'success',
            'files': media_files,
            'total_count': len(media_files),
            'photo_count': photo_count,
            'video_count': video_count,
            'photo_bytes': photo_bytes,
            'video_bytes': video_bytes,
            'total_bytes': photo_bytes + video_bytes,
            'estimated_seconds': round(estimated_seconds, 1),
            'estimated_display': estimated_display,
            'files_selected': files_count,
            'folders_scanned': folders_count
        })
        
    except Exception as e:
        error_logger.error(f"Scan paths failed: {e}")
        print(f"\n❌ Scan paths failed: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/photos/import-from-paths', methods=['POST'])
def import_from_paths():
    """
    Import photos from file paths (SSE streaming version with fixes)
    """
    data = request.get_json(silent=True) or {}
    file_paths = data.get('paths', [])

    def generate():
        conn = None
        client_disconnected = False
        grid_read_caches_invalidated = False

        def invalidate_import_grid_caches():
            nonlocal grid_read_caches_invalidated
            if grid_read_caches_invalidated:
                return
            invalidate_grid_read_caches()
            grid_read_caches_invalidated = True

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
            if not file_paths:
                yield from emit_event('error', {'error': 'No paths provided'})
                return

            if not LIBRARY_PATH or not DB_PATH:
                yield from emit_event('error', {'error': 'No library configured'})
                return
            
            total_files = len(file_paths)
            print(f"\n{'='*60}")
            print(f"📥 IMPORT FROM PATHS: {total_files} file(s)")
            print(f"LIBRARY_PATH: {LIBRARY_PATH}")
            print(f"DB_PATH: {DB_PATH}")
            print(f"{'='*60}\n")
            
            if not (yield from emit_event('start', {'total': total_files})):
                return

            logs_dir = os.path.join(LIBRARY_PATH, '.logs')
            os.makedirs(logs_dir, exist_ok=True)
            log_filename = f"import_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsonl"
            log_path_abs = os.path.join(logs_dir, log_filename)
            log_path_rel = os.path.relpath(log_path_abs, LIBRARY_PATH)
            log_file = open(log_path_abs, 'w')

            def log_import_entry(event_type, data):
                entry = {
                    'timestamp': datetime.now().isoformat(),
                    'event': event_type,
                    **data,
                }
                log_file.write(json.dumps(entry) + '\n')
                log_file.flush()

            conn = get_db_connection()
            ingest_deps = IngestDependencies(
                library_path=LIBRARY_PATH,
                hash_cache=HashCache(conn),
                stage_photo_for_canonicalization=stage_photo_for_canonicalization,
                cleanup_staged_file=cleanup_staged_file,
                commit_staged_canonical_photo=commit_staged_canonical_photo,
                categorize_processing_error=categorize_processing_error,
                extract_exif_date=extract_exif_date,
                write_video_metadata=write_video_metadata,
                finalize_mutated_media=finalize_mutated_media,
                compute_hash=compute_full_hash,
                get_dimensions=get_image_dimensions,
                delete_thumbnail_for_hash=delete_thumbnail_for_hash,
                remove_source_after_commit=False,
            )

            imported_so_far = 0
            library_mutations_so_far = 0

            try:
                for event_name, payload in iter_ingest_events(
                    conn,
                    file_paths,
                    ingest_deps,
                    stop_check=lambda: client_disconnected,
                    log_entry=log_import_entry,
                ):
                    if event_name == 'progress':
                        imported_so_far = max(
                            imported_so_far,
                            int(payload.get('imported') or 0),
                        )
                        library_mutations_so_far = max(
                            library_mutations_so_far,
                            int(payload.get('imported') or 0),
                        )
                    elif event_name == 'complete':
                        imported_so_far = max(
                            imported_so_far,
                            int(payload.get('imported') or 0),
                        )
                        library_mutations_so_far = max(
                            library_mutations_so_far,
                            int(payload.get('imported') or 0),
                        )
                        print(f"\n{'='*60}")
                        print("IMPORT COMPLETE:")
                        print(f"  Imported: {payload.get('imported', 0)}")
                        print(f"  Duplicates: {payload.get('duplicates', 0)}")
                        print(f"  Errors: {payload.get('errors', 0)}")
                        print(f"  Log: {log_path_rel}")
                        print(f"{'='*60}\n")
                        payload = dict(payload)
                        payload['log_path'] = log_path_rel
                        if library_mutations_so_far > 0:
                            invalidate_import_grid_caches()

                    if not (yield from emit_event(event_name, payload)):
                        break

                if client_disconnected:
                    print("\n🛑 IMPORT STOPPED BY CLIENT\n")
                    return
            finally:
                log_file.close()
                if library_mutations_so_far > 0:
                    invalidate_import_grid_caches()
            
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
    
    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        },
    )


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
            
            for event in synchronize_library_generator(
                LIBRARY_PATH,
                conn,
                get_image_dimensions,
                mode='full',
            ):
                if event.startswith('event: complete'):
                    bump_library_catalog_revision()
                yield event
            import_logger.info("Rebuild Database execute completed")
        except Exception as e:
            error_logger.error(f"Rebuild Database execute failed: {e}")
            print(f"\n❌ Rebuild Database execute failed: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')


# ============================================================================
# LIBRARY SWITCHING
# ============================================================================

CONFIG_FILE = get_config_file()

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

def clear_library_session():
    """Drop in-memory library paths so status returns not_configured."""
    global LIBRARY_PATH, DB_PATH, THUMBNAIL_CACHE_DIR, TRASH_DIR, DB_BACKUP_DIR, IMPORT_TEMP_DIR, LOG_DIR

    LIBRARY_PATH = None
    DB_PATH = None
    THUMBNAIL_CACHE_DIR = None
    TRASH_DIR = None
    DB_BACKUP_DIR = None
    IMPORT_TEMP_DIR = None
    LOG_DIR = None


def reset_to_welcome_state():
    """Clear session and saved config — first-run / welcome screen."""
    delete_config()
    clear_library_session()
    invalidate_grid_read_caches()

def update_app_paths(library_path, db_path):
    """Update all global path variables"""
    global LIBRARY_PATH, DB_PATH, THUMBNAIL_CACHE_DIR, TRASH_DIR, DB_BACKUP_DIR, IMPORT_TEMP_DIR, LOG_DIR

    bump_library_catalog_revision()
    LIBRARY_PATH = library_path
    DB_PATH = db_path
    ensure_photo_grid_indices(db_path)
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
    if TRASH_DIR:
        ensure_user_deleted_trash_dir(TRASH_DIR)


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
    return jsonify(attach_catalog_revision({
        'library_path': LIBRARY_PATH,
        'db_path': DB_PATH
    }))


@app.route('/api/library/last-used', methods=['GET'])
def library_last_used():
    """Return the last library path from saved config (picker default only)."""
    config = load_config()
    if not config:
        return jsonify({'library_path': None})

    library_path = config.get('library_path')
    if not library_path:
        return jsonify({'library_path': None})

    try:
        if os.path.isdir(library_path):
            return jsonify({'library_path': library_path})
    except (OSError, PermissionError):
        pass

    return jsonify({'library_path': None})

@app.route('/api/library/status', methods=['GET'])
def library_status():
    """
    Check library health with detailed diagnostics.
    Returns status, message, and paths for frontend decision-making.
    """
    try:
        if not LIBRARY_PATH or not DB_PATH:
            return jsonify({
                'status': 'not_configured',
                'message': 'No library configured. Please select a library.',
                'library_path': None,
                'db_path': None,
                'valid': False
            })

        library_path = LIBRARY_PATH
        db_path = DB_PATH

        # Check filesystem access
        try:
            library_exists = os.path.exists(library_path)
        except (OSError, PermissionError) as e:
            print(f"⚠️  Library inaccessible — returning to welcome: {library_path} ({e})")
            reset_to_welcome_state()
            return jsonify({
                'status': 'not_configured',
                'message': 'No library configured. Please select a library.',
                'library_path': None,
                'db_path': None,
                'valid': False
            })

        if not library_exists:
            print(f"⚠️  Library folder missing — returning to welcome: {library_path}")
            reset_to_welcome_state()
            return jsonify({
                'status': 'not_configured',
                'message': 'No library configured. Please select a library.',
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

        if payload['valid'] and resolved_db_path != db_path:
            update_app_paths(library_path, resolved_db_path)
            save_config(library_path, resolved_db_path)

        return jsonify(payload)
        
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': f'Unexpected error: {str(e)}',
            'library_path': None,
            'db_path': None,
            'valid': False
        }), 500

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

        fast = bool(data.get('fast'))
        return jsonify(inspect_library_path(library_path, fast=fast))
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
            
            # Skip Time Machine and backup volumes
            item_lower = item.lower()
            if item.startswith('Backups of '):
                continue
            if 'time machine' in item_lower or 'time_machine' in item_lower:
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
        
        folders = sort_picker_items(
            folders,
            key=lambda folder: folder['name'] if isinstance(folder, dict) else folder,
        )
        if include_files:
            files = sort_picker_items(files, key=lambda file_info: file_info['name'])
        
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
        buffer = generate_preview_jpeg_buffer(
            file_path,
            to_rgb=convert_to_rgb_properly,
        )
        return send_file(buffer, mimetype='image/jpeg')
    except Exception as e:
        print(f"❌ Photo preview error: {e}")
        return jsonify({'error': preview_decode_error_message(file_path, e)}), 422


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
                    if volume in ('Macintosh HD', 'Macintosh SSD'):
                        continue
                    
                    volume_lower = volume.lower()
                    if volume.startswith('Backups of '):
                        continue
                    if 'time machine' in volume_lower or 'time_machine' in volume_lower:
                        continue
                    
                    volume_path = os.path.join(volumes_path, volume)
                    if os.path.isdir(volume_path):
                        locations.append({
                            'name': volume,
                            'path': volume_path
                        })
            except (PermissionError, OSError):
                # If we can't read /Volumes, skip it
                pass

        locations = sort_picker_items(locations, key=lambda location: location['name'])
        
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

MACOS_USER_PRIMARY_DIR_NAMES = frozenset({
    'Desktop',
    'Documents',
    'Downloads',
    'Library',
    'Movies',
    'Music',
    'Pictures',
    'Public',
})

SYSTEM_CONVERT_BLOCK_PREFIXES = (
    '/Applications',
    '/System',
    '/Library',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/opt',
)

CONVERT_OS_PRIMARY_MESSAGE = (
    'Unable to convert primary OS directories. Pick another folder to continue.'
)


def is_convert_blocked_path(library_path):
    """Hard deny: macOS user shell folders and system directory trees."""
    try:
        real_path = os.path.realpath(os.path.abspath(library_path))
    except OSError:
        return False

    if real_path == '/Volumes':
        return True

    home = os.path.realpath(os.path.expanduser('~'))
    shared = os.path.realpath('/Users/Shared')

    if real_path in {home, shared}:
        return True

    primary_in_home = {os.path.join(home, name) for name in MACOS_USER_PRIMARY_DIR_NAMES}
    if real_path in primary_in_home:
        return True

    for prefix in SYSTEM_CONVERT_BLOCK_PREFIXES:
        normalized_prefix = os.path.realpath(prefix)
        if real_path == normalized_prefix or real_path.startswith(normalized_prefix + os.sep):
            return True

    return False


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


def _empty_folder_warning():
    return {
        'show': False,
        'non_media_count': 0,
        'visible_root_items': 0,
        'visible_folder_count': 0,
        'visible_file_count': 0,
        'obvious_signals_present': False,
        'reasons': [],
    }


def _scan_folder_root_warning_signals(library_path):
    """Shared root scan for folder suitability heuristics."""
    try:
        root_entries = [
            entry for entry in os.listdir(library_path)
            if entry and not entry.startswith('.')
        ]
    except (PermissionError, OSError):
        return None

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

    return {
        'non_media_count': non_media_count,
        'visible_root_items': visible_file_count + visible_folder_count,
        'visible_folder_count': visible_folder_count,
        'visible_file_count': visible_file_count,
        'obvious_signals_present': obvious_signals_present,
    }


def _folder_warning_from_scan(scan, reasons):
    return {
        'show': bool(reasons),
        'non_media_count': scan['non_media_count'],
        'visible_root_items': scan['visible_root_items'],
        'visible_folder_count': scan['visible_folder_count'],
        'visible_file_count': scan['visible_file_count'],
        'obvious_signals_present': scan['obvious_signals_present'],
        'reasons': reasons,
    }


def analyze_general_purpose_folder(library_path, media_count):
    """Cheap, explainable warning heuristic for desktop/workspace folders."""
    scan = _scan_folder_root_warning_signals(library_path)
    if scan is None:
        return _empty_folder_warning()

    mixed_file_types_and_folders = (
        scan['visible_root_items'] >= 15
        and scan['visible_file_count'] > 0
        and scan['visible_folder_count'] > 0
    )

    reasons = []
    if scan['non_media_count'] >= 20:
        reasons.append('many_non_media_files')
    if media_count >= 0 and scan['non_media_count'] > media_count * 2:
        reasons.append('non_media_outnumbers_media')
    if mixed_file_types_and_folders:
        reasons.append('busy_mixed_root')
    if scan['obvious_signals_present']:
        reasons.append('desktop_like_contents')

    return _folder_warning_from_scan(scan, reasons)


def analyze_convert_to_library_folder(library_path, media_count):
    """Stricter convert-specific heuristic; avoids photo-dump false positives."""
    scan = _scan_folder_root_warning_signals(library_path)
    if scan is None:
        return _empty_folder_warning()

    busy_mixed_workspace_root = (
        scan['visible_root_items'] >= 15
        and scan['visible_file_count'] > 0
        and scan['visible_folder_count'] > 0
        and scan['non_media_count'] > 0
    )
    has_version_control_dir = os.path.isdir(os.path.join(library_path, '.git'))

    reasons = []
    if scan['non_media_count'] >= 20:
        reasons.append('many_non_media_files')
    if media_count >= 0 and scan['non_media_count'] > media_count * 2:
        reasons.append('non_media_outnumbers_media')
    if busy_mixed_workspace_root:
        reasons.append('busy_mixed_workspace_root')
    if scan['obvious_signals_present']:
        reasons.append('desktop_like_contents')
    if has_version_control_dir:
        reasons.append('version_control_dir')

    return _folder_warning_from_scan(scan, reasons)


def inspect_library_path(library_path, *, fast=False):
    """Shared open-library probe used by both picker UX and recovery flow."""
    abs_library_path = os.path.abspath(library_path)
    existing_db_path = detect_existing_db_path(abs_library_path)
    db_path = existing_db_path or canonical_db_path(abs_library_path)
    db_report = check_database_health(db_path)
    has_openable_db = library_has_openable_db(abs_library_path)

    if fast and has_openable_db and os.path.exists(db_path):
        try:
            conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
            cursor = conn.cursor()
            total_count = cursor.execute('SELECT COUNT(*) FROM photos').fetchone()[0]
            photo_count = cursor.execute(
                "SELECT COUNT(*) FROM photos WHERE file_type = 'photo'"
            ).fetchone()[0]
            video_count = cursor.execute(
                "SELECT COUNT(*) FROM photos WHERE file_type = 'video'"
            ).fetchone()[0]
            conn.close()
            counts = {
                'photo_count': photo_count,
                'video_count': video_count,
                'total_count': total_count,
            }
        except Exception as e:
            print(f"  ⚠️  Fast inventory failed, falling back to filesystem walk: {e}")
            counts = None
    else:
        counts = None

    if counts is None:
        try:
            counts = count_media_files_by_type(abs_library_path)
        except Exception as e:
            print(f"  ⚠️  Error counting media files: {e}")
            counts = {'photo_count': 0, 'video_count': 0, 'total_count': 0}

    media_count = counts['total_count']
    _, media_eta = estimate_duration(media_count)
    folder_warning = analyze_general_purpose_folder(abs_library_path, media_count)
    convert_folder_warning = analyze_convert_to_library_folder(abs_library_path, media_count)
    convert_blocked = is_convert_blocked_path(abs_library_path)

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
        'convert_folder_warning': convert_folder_warning,
        'convert_blocked': convert_blocked,
        'convert_block_reason': 'os_primary_directory' if convert_blocked else None,
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
                'folder_warning': _empty_folder_warning(),
                'convert_folder_warning': _empty_folder_warning(),
            })

        fast = bool(data.get('fast'))
        return jsonify(inspect_library_path(library_path, fast=fast))
        
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
            print(f"  🔧 Migrating database schema: {', '.join(report.missing_columns or [])}")
            from migrate_db import check_and_migrate_schema

            migrated = check_and_migrate_schema(db_path)
            report = check_database_health(db_path)
            print(f"  🏥 Post-migration health check: {report.status.value}")

            if not migrated or report.status in [DBStatus.MISSING_COLUMNS, DBStatus.MIXED_SCHEMA]:
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
        had_config = os.path.exists(CONFIG_FILE)
        reset_to_welcome_state()

        if had_config:
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


@app.route('/api/library/terraform/scan', methods=['POST'])
def scan_terraform_library():
    """Cheap Convert preflight: media counts, non-media count, and ETA."""
    try:
        data = request.get_json(silent=True) or {}
        library_path = data.get('library_path')

        if not library_path or not os.path.exists(library_path):
            return jsonify({'error': 'Invalid library path'}), 400
        if not os.path.isdir(library_path):
            return jsonify({'error': 'Selected path is not a folder'}), 400
        if not os.access(library_path, os.R_OK | os.X_OK):
            return jsonify({'error': 'Selected folder is not accessible'}), 503

        abs_library_path = os.path.abspath(library_path)
        if is_convert_blocked_path(abs_library_path):
            return jsonify({
                'error': CONVERT_OS_PRIMARY_MESSAGE,
                'convert_blocked': True,
                'convert_block_reason': 'os_primary_directory',
            }), 400

        scan_result = scan_convert_library(abs_library_path)

        photo_count = 0
        video_count = 0
        photo_bytes = 0
        video_bytes = 0
        for media_path in scan_result.media_files:
            ext = os.path.splitext(media_path)[1].lower()
            try:
                size_bytes = os.path.getsize(media_path)
            except OSError:
                size_bytes = 0
            if ext in VIDEO_EXTENSIONS:
                video_count += 1
                video_bytes += size_bytes
            else:
                photo_count += 1
                photo_bytes += size_bytes

        estimated_seconds = estimate_convert_duration_seconds(
            photo_count=photo_count,
            video_count=video_count,
            photo_bytes=photo_bytes,
            video_bytes=video_bytes,
        )
        _seconds, estimated_display = format_about_duration(estimated_seconds)
        media_count = photo_count + video_count

        return jsonify({
            'status': 'INVENTORY',
            'preflight': True,
            'library_path': abs_library_path,
            'photo_count': photo_count,
            'video_count': video_count,
            'media_count': media_count,
            'non_media_count': len(scan_result.non_media_files),
            'estimated_seconds': round(estimated_seconds, 1),
            'estimated_display': estimated_display,
            'convert_folder_warning': analyze_convert_to_library_folder(abs_library_path, media_count),
        })
    except Exception as e:
        error_logger.error(f"Convert preflight failed: {e}")
        error_logger.error(traceback.format_exc())
        return jsonify({'error': str(e)}), 500


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
        conn = None
        log_file = None
        try:
            data = request.json
            library_path = data.get('library_path')
            
            if not library_path or not os.path.exists(library_path):
                yield f"event: error\ndata: {json.dumps({'error': 'Invalid library path'})}\n\n"
                return

            if is_convert_blocked_path(library_path):
                yield f"event: error\ndata: {json.dumps({'error': CONVERT_OS_PRIMARY_MESSAGE, 'convert_blocked': True})}\n\n"
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
            scan_result = scan_convert_library(library_path)
            media_files = scan_result.media_files
            non_media_files = scan_result.non_media_files
            total_files = scan_result.total_media
            print(f"✅ Found {total_files} media files")
            print(f"✅ Found {len(non_media_files)} non-media files (will be moved to trash)\n")
            
            log_manifest('scan_complete', {'total_files': total_files, 'non_media_files': len(non_media_files)})

            quarantine_dirs, quarantine_files = quarantine_root_hidden(library_path)
            quarantine_paths = quarantine_dirs + quarantine_files
            if quarantine_paths:
                print("🗑️  Quarantining hidden root entries...")
                error_dir = os.path.join(trash_dir, 'errors')
                os.makedirs(error_dir, exist_ok=True)

                for quarantine_path in quarantine_paths:
                    try:
                        trash_path = move_file_to_category_trash(
                            library_path,
                            trash_dir,
                            quarantine_path,
                            'errors',
                        )
                        log_manifest(
                            'quarantine',
                            {'original': quarantine_path, 'moved_to': trash_path},
                        )
                        print(
                            f"   🗑️  {os.path.relpath(quarantine_path, library_path)} → trash"
                        )
                    except Exception as e:
                        print(f"   ⚠️  Could not quarantine {quarantine_path}: {e}")

                print(f"✅ Quarantined {len(quarantine_paths)} hidden root entr{'y' if len(quarantine_paths) == 1 else 'ies'}\n")
            
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
            yield f"event: phase\ndata: {json.dumps({'phase': 'convert', 'status': 'starting', 'total': total_files})}\n\n"
            
            # Create database
            db_path = canonical_db_path(library_path)
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            hash_cache = HashCache(conn)
            
            create_database_schema(cursor)
            conn.commit()
            print("✅ Database created\n")

            def _move_duplicate(source_path):
                return move_file_to_category_trash(
                    library_path,
                    trash_dir,
                    source_path,
                    'duplicates',
                )

            convert_deps = ConvertDependencies(
                library_path=library_path,
                hash_cache=hash_cache,
                stage_photo_for_canonicalization=lambda source_path, **kwargs: stage_photo_for_canonicalization(
                    source_path,
                    temp_prefix=kwargs.get('temp_prefix', 'convert_photo_'),
                    temp_dir=import_temp_dir,
                ),
                cleanup_staged_file=cleanup_staged_file,
                commit_staged_canonical_photo=commit_staged_canonical_photo,
                categorize_processing_error=categorize_processing_error,
                extract_exif_date=extract_exif_date,
                write_video_metadata=write_video_metadata,
                finalize_mutated_media=finalize_mutated_media,
                compute_hash=compute_full_hash,
                get_dimensions=get_image_dimensions,
                delete_thumbnail_for_hash=delete_thumbnail_for_hash,
                remove_source_after_commit=True,
                move_duplicate_to_trash=_move_duplicate,
                move_unsupported_to_trash=lambda source_path: move_file_to_category_trash(
                    library_path,
                    trash_dir,
                    source_path,
                    'errors',
                ),
                photo_temp_prefix='convert_photo_',
            )

            processed_count = 0
            duplicate_count = 0
            error_count = 0

            def _on_file_start(source_path, filename, file_index, total):
                _, ext = os.path.splitext(filename)
                file_type = 'video' if ext.lower() in VIDEO_EXTENSIONS else 'photo'
                print(f"{file_index}/{total}. Processing: {filename}")
                log_manifest('processing', {'file': source_path, 'file_type': file_type})

            def _on_success(source_path, result):
                row = conn.execute(
                    "SELECT current_path, content_hash, date_taken FROM photos WHERE id = ?",
                    (result.photo_id,),
                ).fetchone()
                if row:
                    target_path = os.path.join(library_path, row['current_path'])
                    print(f"   ✅ Canonical media committed: {row['current_path']}")
                    log_manifest(
                        'success',
                        {
                            'original': source_path,
                            'canonical_path': row['current_path'],
                            'new': target_path,
                            'hash': row['content_hash'],
                            'id': result.photo_id,
                            'date_taken': row['date_taken'],
                        },
                    )

            def _on_duplicate(source_path, _result, dup_path):
                print(f"   ⏭️  Duplicate -> {os.path.relpath(dup_path, library_path)}")
                log_manifest(
                    'duplicate',
                    {
                        'original': source_path,
                        'moved_to': dup_path,
                    },
                )

            def _on_rejected(source_path, result):
                rejection = result.rejection or {}
                category = rejection.get('category')
                print(f"   ❌ Convert failed: {rejection.get('technical_error', rejection.get('reason'))}")
                log_manifest(
                    'failed',
                    {
                        'file': source_path,
                        'reason': rejection.get('technical_error'),
                        'category': category,
                        'preserved_original': os.path.exists(source_path),
                    },
                )

            def _on_error(source_path, result):
                print(f"   ❌ Error: {result.error}")
                log_manifest(
                    'failed',
                    {
                        'file': source_path,
                        'reason': result.error,
                        'category': 'error',
                        'preserved_original': os.path.exists(source_path),
                    },
                )

            for event_name, payload in iter_convert_events(
                conn,
                media_files,
                convert_deps,
                on_file_start=_on_file_start,
                on_success=_on_success,
                on_duplicate=_on_duplicate,
                on_rejected=_on_rejected,
                on_error=_on_error,
            ):
                if event_name == 'progress':
                    processed_count = payload.get('processed', processed_count)
                    duplicate_count = payload.get('duplicates', duplicate_count)
                    error_count = payload.get('errors', error_count)
                    yield (
                        f"event: progress\ndata: "
                        f"{json.dumps({'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': payload.get('current'), 'total': payload.get('total')})}\n\n"
                    )
                elif event_name == 'rejected':
                    yield f"event: rejected\ndata: {json.dumps(payload)}\n\n"
                elif event_name == 'complete':
                    processed_count = payload.get('processed', processed_count)
                    duplicate_count = payload.get('duplicates', duplicate_count)
                    error_count = payload.get('errors', error_count)

            yield f"event: phase\ndata: {json.dumps({'phase': 'convert', 'status': 'complete', 'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count})}\n\n"
            
            # Cleanup non-canonical folders and trash any remaining non-media.
            print("\n🧹 Cleaning up folders and non-media stragglers...")
            yield f"event: phase\ndata: {json.dumps({'phase': 'folders', 'status': 'starting'})}\n\n"

            removed_count = 0
            trashed_stragglers = 0
            error_dir = os.path.join(trash_dir, 'errors')
            os.makedirs(error_dir, exist_ok=True)

            for _pass, (removed_this_pass, stragglers) in enumerate(
                iter_layout_cleanup_passes(library_path),
                start=1,
            ):
                removed_count += removed_this_pass
                if not stragglers:
                    break

                print(f"   🗑️  Trashing {len(stragglers)} non-media straggler(s)...")
                for straggler_path in stragglers:
                    if not os.path.exists(straggler_path):
                        continue
                    try:
                        trash_path = move_file_to_category_trash(
                            library_path,
                            trash_dir,
                            straggler_path,
                            'errors',
                        )
                        trashed_stragglers += 1
                        log_manifest(
                            'non_media_straggler',
                            {'original': straggler_path, 'moved_to': trash_path},
                        )
                    except Exception as e:
                        print(f"   ⚠️  Could not trash {straggler_path}: {e}")

            print(
                f"✅ Cleanup complete - removed {removed_count} folder(s), "
                f"trashed {trashed_stragglers} straggler(s)\n"
            )
            yield f"event: phase\ndata: {json.dumps({'phase': 'folders', 'status': 'complete', 'removed': removed_count, 'trashed_stragglers': trashed_stragglers})}\n\n"
            
            print("🔧 Ensuring metadata compliance...")
            log_manifest('metadata_compliance_started', {'media_count': processed_count})
            yield f"event: phase\ndata: {json.dumps({'phase': 'compliance', 'status': 'starting', 'total': max(processed_count, 1)})}\n\n"
            from library_metadata_compliance import ensure_library_metadata_compliant

            compliance_stats = ensure_library_metadata_compliant(
                library_path,
                db_conn=conn,
                hash_cache=hash_cache,
                progress_total=max(processed_count, 1),
            )
            if compliance_stats.errors:
                preview = compliance_stats.errors[:10]
                log_manifest(
                    'metadata_compliance_failed',
                    {'error_count': len(compliance_stats.errors), 'errors': preview},
                )
                yield f"event: phase\ndata: {json.dumps({'phase': 'compliance', 'status': 'failed', 'error_count': len(compliance_stats.errors)})}\n\n"
                log_file.close()
                yield f"event: error\ndata: {json.dumps({'error': f'Metadata compliance failed with {len(compliance_stats.errors)} error(s)', 'errors': preview})}\n\n"
                return

            log_manifest(
                'metadata_compliance_complete',
                {
                    'files_scanned': compliance_stats.files_scanned,
                    'files_fixed': compliance_stats.files_fixed,
                    'rating_stripped': compliance_stats.rating_stripped,
                    'orientation_baked': compliance_stats.orientation_baked,
                    'db_rows_updated': compliance_stats.db_rows_updated,
                },
            )
            yield f"event: phase\ndata: {json.dumps({'phase': 'compliance', 'status': 'complete', 'files_fixed': compliance_stats.files_fixed})}\n\n"

            print("🧹 Running pre-audit blocking cleanup...")
            log_manifest('blocking_cleanup_started', {})
            yield f"event: phase\ndata: {json.dumps({'phase': 'cleanup', 'status': 'starting'})}\n\n"

            cleanup_stats = ensure_blocking_audit_prep(
                library_path,
                db_conn=conn,
                trash_dir=trash_dir,
                reason="convert",
            )

            log_manifest(
                'blocking_cleanup_complete',
                {
                    'quarantined_metadata': len(cleanup_stats.quarantined_metadata),
                    'trashed_orphans': cleanup_stats.trashed_orphans,
                    'trashed_corrupt': cleanup_stats.trashed_corrupt,
                    'trashed_errors': cleanup_stats.trashed_errors,
                    'removed_dirs': cleanup_stats.removed_dirs,
                    'trashed_stragglers': cleanup_stats.trashed_stragglers,
                },
            )
            yield f"event: phase\ndata: {json.dumps({'phase': 'cleanup', 'status': 'complete', 'trashed_orphans': cleanup_stats.trashed_orphans, 'quarantined_metadata': len(cleanup_stats.quarantined_metadata), 'removed_dirs': cleanup_stats.removed_dirs})}\n\n"

            # Close DB
            conn.close()
            conn = None

            print("🔎 Running final verification...")
            log_manifest('final_audit_started', {'media_count': processed_count})
            yield f"event: phase\ndata: {json.dumps({'phase': 'audit', 'status': 'starting', 'total': max(processed_count, 1)})}\n\n"
            from clean_library_fast_audit import run_fast_library_audit
            issues = run_fast_library_audit(
                library_path,
                db_path=db_path,
                progress_callback=None,
                audit_progress_total=max(processed_count, 1),
            )

            if issues:
                preview = issues[:10]
                log_manifest('final_audit_failed', {'issue_count': len(issues), 'issues': preview})
                yield f"event: phase\ndata: {json.dumps({'phase': 'audit', 'status': 'failed', 'issue_count': len(issues)})}\n\n"
                log_file.close()
                yield f"event: error\ndata: {json.dumps({'error': f'Final verification failed with {len(issues)} issue(s)', 'issue_count': len(issues), 'issues': preview})}\n\n"
                return

            log_manifest('final_audit_complete', {'issue_count': 0})
            yield f"event: phase\ndata: {json.dumps({'phase': 'audit', 'status': 'complete', 'issue_count': 0})}\n\n"
            
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

            if processed_count > 0:
                invalidate_grid_read_caches()
            
            yield f"event: complete\ndata: {json.dumps({'processed': processed_count, 'duplicates': duplicate_count, 'errors': error_count, 'log_path': os.path.relpath(log_path, library_path), 'db_path': db_path})}\n\n"
            
        except Exception as e:
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass
            try:
                if log_file is not None and not log_file.closed:
                    log_file.close()
            except Exception:
                pass
            error_logger.error(f"Terraform failed: {e}")
            print(f"\n❌ Terraform failed: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')


# ============================================================================
# FAVORITES / RATING API
# ============================================================================

def set_photo_favorite_rating(photo_id, explicit_rating=None):
    """Set a photo rating using the file-SOT mutation contract."""
    from file_operations import extract_exif_rating, write_exif_rating, strip_exif_rating

    conn = None
    finalize_result = None

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT current_path, content_hash, date_taken, rating, width, height FROM photos WHERE id = ?",
        (photo_id,),
    )
    row = cursor.fetchone()
    conn.close()
    conn = None

    if not row:
        return {'error': 'Photo not found'}, 404

    rel_path = row['current_path']
    full_path = os.path.join(LIBRARY_PATH, rel_path)

    if not os.path.exists(full_path):
        return {'error': 'File not found on disk'}, 404

    current_rating = extract_exif_rating(full_path)
    if current_rating is None or current_rating == 0:
        current_rating = 0

    print(f"⭐ Photo {photo_id}: current rating = {current_rating}, toggling...")

    if explicit_rating is not None:
        new_rating = int(explicit_rating)
        if not 0 <= new_rating <= 5:
            return {'error': 'Rating must be 0-5'}, 400
    else:
        new_rating = 0 if current_rating == 5 else 5

    db_rating_raw = row['rating']
    db_rating = None if db_rating_raw in (None, 0) else int(db_rating_raw)
    target_db_rating = None if new_rating == 0 else new_rating
    file_matches_target = (
        current_rating == new_rating
        if new_rating != 0
        else current_rating == 0
    )
    db_matches_target = db_rating == target_db_rating

    if file_matches_target and db_matches_target:
        print(f"   → Already at rating {new_rating if new_rating != 0 else 'NULL'}; skipping write")
        return {
            'photo_id': photo_id,
            'rating': target_db_rating,
            'favorited': new_rating == 5,
            'photo': {
                'id': photo_id,
                'path': rel_path,
                'content_hash': row['content_hash'],
                'width': row['width'],
                'height': row['height'],
            },
        }, 200

    if new_rating == 0:
        print(f"   → Stripping rating from {os.path.basename(full_path)}")
        if not strip_exif_rating(full_path):
            error_logger.error(
                f"Failed to strip EXIF rating for photo {photo_id}: {full_path}"
            )
            return {'error': 'Failed to update EXIF rating'}, 500
        verified_rating = extract_exif_rating(full_path)
        if verified_rating not in (None, 0):
            error_logger.error(
                f"EXIF rating verify failed after strip for photo {photo_id}: "
                f"read {verified_rating} from {full_path}"
            )
            return {'error': 'Failed to verify EXIF rating removal'}, 500
        db_rating = None
    else:
        print(f"   → Writing rating {new_rating} to {os.path.basename(full_path)}")
        if not write_exif_rating(full_path, new_rating):
            error_logger.error(
                f"Failed to write EXIF rating for photo {photo_id}: {full_path}"
            )
            return {'error': 'Failed to update EXIF rating'}, 500
        verified_rating = extract_exif_rating(full_path)
        if verified_rating != new_rating:
            error_logger.error(
                f"EXIF rating verify failed for photo {photo_id}: "
                f"expected {new_rating}, read {verified_rating} from {full_path}"
            )
            return {'error': 'Failed to verify EXIF rating write'}, 500
        db_rating = verified_rating

    precomputed_hash = compute_full_hash(full_path)

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
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
            precomputed_hash=precomputed_hash,
            defer_thumbnail_cleanup=True,
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
            commit_row_mutation(conn)
            apply_pending_thumbnail_cleanup(
                finalize_result,
                delete_thumbnail_for_hash,
            )
            print(
                f"⭐ Photo {photo_id}: favorite update made file a duplicate of "
                f"{finalize_result.duplicate.photo_id if finalize_result.duplicate else 'unknown'}"
            )
            return {
                'photo_id': photo_id,
                'duplicate_removed': True,
                'message': 'Photo became a duplicate after updating favorite and was moved to trash'
            }, 200

        cursor.execute(
            "UPDATE photos SET rating = ? WHERE id = ?",
            (db_rating, photo_id),
        )
        commit_row_mutation(conn)
        apply_pending_thumbnail_cleanup(
            finalize_result,
            delete_thumbnail_for_hash,
        )
    except Exception:
        if conn is not None:
            conn.rollback()
        if finalize_result is not None:
            rollback_finalize_mutated_media(finalize_result)
        raise
    finally:
        if conn is not None:
            conn.close()
            conn = None

    print(f"⭐ Photo {photo_id}: rating {current_rating} → {new_rating if new_rating != 0 else 'NULL'}")

    return {
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
    }, 200


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
    try:
        data = request.get_json(silent=True) or {}
        payload, status_code = set_photo_favorite_rating(
            photo_id,
            data.get('rating'),
        )
        return jsonify(payload), status_code
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
        
        notify_catalog_reset_from_make_perfect(result)
        
        print(f"\n✅ Make Library Perfect completed successfully")
        
        return jsonify(attach_catalog_revision(result))
        
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

    payload = request.get_json(silent=True) or {}
    resume_arg = payload.get("resume")
    resume: bool | None
    if resume_arg is None:
        resume = None
    else:
        resume = bool(resume_arg)

    event_queue: queue.Queue = queue.Queue()
    cancel_event = threading.Event()

    def run_op():
        try:

            def progress_callback(ev):
                event_queue.put(('evt', ev))

            def cancel_check():
                return cancel_event.is_set()

            result = run_db_normalization_engine(
                LIBRARY_PATH,
                db_path=DB_PATH,
                progress_callback=progress_callback,
                resume=resume,
                cancel_check=cancel_check,
            )
            if result.get("status") == "CANCELLED":
                event_queue.put(('cancelled', result))
            else:
                event_queue.put(('done', result))
        except Exception as e:
            error_logger.error(f"Make Library Perfect stream failed: {e}")
            error_logger.error(traceback.format_exc())
            event_queue.put(('err', str(e)))

    threading.Thread(target=run_op, daemon=True).start()

    @stream_with_context
    def generate():
        try:
            while True:
                try:
                    kind, payload = event_queue.get(timeout=1.0)
                except queue.Empty:
                    continue
                if kind == 'evt':
                    yield f"data: {json.dumps(payload)}\n\n"
                elif kind == 'done':
                    notify_catalog_reset_from_make_perfect(payload)
                    yield f"data: {json.dumps({'type': 'complete', 'result': attach_catalog_revision(payload)})}\n\n"
                    break
                elif kind == 'cancelled':
                    yield f"data: {json.dumps({'type': 'cancelled', 'result': payload})}\n\n"
                    break
                elif kind == 'err':
                    yield f"data: {json.dumps({'type': 'error', 'error': payload})}\n\n"
                    break
        finally:
            cancel_event.set()

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        },
    )


@app.route('/api/library/make-perfect/date-range/stream', methods=['POST'])
def api_make_library_perfect_date_range_stream():
    """
    Clean library scoped to an inclusive date range (YYYY-MM-DD).

    Body: {"date_from": "2026-05-01", "date_to": "2026-06-30"}
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

    payload = request.get_json(silent=True) or {}
    date_from = payload.get('date_from')
    date_to = payload.get('date_to')
    if not date_from or not date_to:
        return jsonify({'error': 'date_from and date_to are required (YYYY-MM-DD)'}), 400

    event_queue: queue.Queue = queue.Queue()
    cancel_event = threading.Event()

    def run_op():
        try:

            def progress_callback(ev):
                event_queue.put(('evt', ev))

            def cancel_check():
                return cancel_event.is_set()

            result = run_db_normalization_engine(
                LIBRARY_PATH,
                db_path=DB_PATH,
                progress_callback=progress_callback,
                resume=False,
                cancel_check=cancel_check,
                date_from=str(date_from),
                date_to=str(date_to),
            )
            if result.get("status") == "CANCELLED":
                event_queue.put(('cancelled', result))
            else:
                event_queue.put(('done', result))
        except Exception as e:
            error_logger.error(f"Date-range clean library stream failed: {e}")
            error_logger.error(traceback.format_exc())
            event_queue.put(('err', str(e)))

    threading.Thread(target=run_op, daemon=True).start()

    @stream_with_context
    def generate():
        try:
            while True:
                try:
                    kind, payload = event_queue.get(timeout=1.0)
                except queue.Empty:
                    continue
                if kind == 'evt':
                    yield f"data: {json.dumps(payload)}\n\n"
                elif kind == 'done':
                    notify_catalog_reset_from_make_perfect(payload)
                    yield f"data: {json.dumps({'type': 'complete', 'result': attach_catalog_revision(payload)})}\n\n"
                    break
                elif kind == 'cancelled':
                    yield f"data: {json.dumps({'type': 'cancelled', 'result': payload})}\n\n"
                    break
                elif kind == 'err':
                    yield f"data: {json.dumps({'type': 'error', 'error': payload})}\n\n"
                    break
        finally:
            cancel_event.set()

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        },
    )


@app.route('/api/library/make-perfect/checkpoint', methods=['GET'])
def api_clean_library_checkpoint_probe():
    """Cheap probe for a resumable clean-library run (no inventory walk)."""
    try:
        from make_library_perfect import find_resumable_clean_library_checkpoint

        if not LIBRARY_PATH:
            return jsonify({'error': 'No library configured'}), 400

        if not os.path.isdir(LIBRARY_PATH):
            return jsonify({'error': 'Configured library path is missing or invalid'}), 400

        checkpoint = find_resumable_clean_library_checkpoint(LIBRARY_PATH)
        if not checkpoint:
            return jsonify({'status': 'NONE', 'resumable': False})

        return jsonify(
            {
                'status': 'RESUMABLE',
                'resumable': True,
                'resume': {
                    'phase': checkpoint.get('phase'),
                    'scan_completed_count': checkpoint.get('scan_completed_count', 0),
                    'canonicalize_index': checkpoint.get('canonicalize_index', 0),
                    'manifest_path': checkpoint.get('manifest_path'),
                },
            }
        )
    except Exception as e:
        error_logger.error(f"Clean library checkpoint probe failed: {e}")
        error_logger.error(traceback.format_exc())
        return jsonify({'error': str(e)}), 500


def _resolve_library_log_file(path_param: str):
    """Resolve a manifest path under the library .logs directory, or return an error."""
    if not path_param:
        return None, 'path query parameter is required'
    if not LIBRARY_PATH:
        return None, 'No library configured'

    abs_library = os.path.abspath(LIBRARY_PATH)
    logs_dir = os.path.abspath(os.path.join(abs_library, '.logs'))
    if os.path.isabs(path_param):
        abs_path = os.path.abspath(path_param)
    else:
        abs_path = os.path.abspath(os.path.join(abs_library, path_param))

    if abs_path != logs_dir and not abs_path.startswith(logs_dir + os.sep):
        return None, 'Invalid manifest path'
    if not os.path.isfile(abs_path):
        return None, 'Manifest not found'
    return abs_path, None


def _read_text_file_tail(path: str, max_lines: int = 40) -> list:
    max_lines = max(1, max_lines)
    chunk_size = 8192
    with open(path, 'rb') as handle:
        handle.seek(0, os.SEEK_END)
        position = handle.tell()
        buffer = b''
        while position > 0 and buffer.count(b'\n') <= max_lines:
            read_size = min(chunk_size, position)
            position -= read_size
            handle.seek(position)
            buffer = handle.read(read_size) + buffer
    text = buffer.decode('utf-8', errors='replace')
    lines = text.splitlines()
    return [line for line in lines[-max_lines:] if line.strip()]


@app.route('/api/library/make-perfect/manifest-tail', methods=['GET'])
def api_clean_library_manifest_tail():
    """Return the last N lines from a clean-library manifest (.jsonl under .logs)."""
    try:
        path_param = request.args.get('path', '')
        try:
            max_lines = int(request.args.get('lines', 40))
        except (TypeError, ValueError):
            max_lines = 40
        max_lines = min(200, max(1, max_lines))

        abs_path, error = _resolve_library_log_file(path_param)
        if error:
            status = 404 if error == 'Manifest not found' else 400
            return jsonify({'error': error}), status

        lines = _read_text_file_tail(abs_path, max_lines=max_lines)
        return jsonify({'lines': lines})
    except Exception as e:
        error_logger.error(f"Clean library manifest tail failed: {e}")
        error_logger.error(traceback.format_exc())
        return jsonify({'error': str(e)}), 500


@app.route('/api/library/make-perfect/checkpoint/abandon', methods=['POST'])
def api_abandon_clean_library_checkpoint():
    """Abandon the current resumable clean-library checkpoint (start fresh)."""
    try:
        from make_library_perfect import (
            abandon_clean_library_checkpoint,
            find_resumable_clean_library_checkpoint,
        )

        if not LIBRARY_PATH:
            return jsonify({'error': 'No library configured'}), 400

        checkpoint = find_resumable_clean_library_checkpoint(LIBRARY_PATH)
        if checkpoint:
            abandon_clean_library_checkpoint(checkpoint['_checkpoint_path'])
        return jsonify({'ok': True, 'abandoned': bool(checkpoint)})
    except Exception as e:
        error_logger.error(f"Clean library checkpoint abandon failed: {e}")
        error_logger.error(traceback.format_exc())
        return jsonify({'error': str(e)}), 500


@app.route('/api/library/make-perfect/scan', methods=['GET'])
def api_scan_make_library_perfect():
    """
    Clean library preflight. Default is cheap inventory (photos/videos + duration).
    Pass ?verify=1 for full yardstick audit (recovery / dev).
    """
    try:
        from make_library_perfect import scan_library_cleanliness

        verify = str(request.args.get("verify", "")).lower() in {"1", "true", "yes"}

        if not LIBRARY_PATH:
            return jsonify({'error': 'No library configured'}), 400

        if not os.path.isdir(LIBRARY_PATH):
            return jsonify({'error': 'Configured library path is missing or invalid'}), 400

        if not os.access(LIBRARY_PATH, os.R_OK | os.X_OK):
            return jsonify({'error': 'Configured library path is not accessible'}), 503

        print(f"\n{'='*60}")
        print(f"🔎 CLEAN LIBRARY SCAN: {LIBRARY_PATH}")
        print(f"{'='*60}\n")

        result = scan_library_cleanliness(LIBRARY_PATH, db_path=DB_PATH, verify=verify)
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
    try:
        data = request.json
        photo_ids = data.get('photo_ids', [])
        rating = int(data.get('rating', 5))
        
        if not 0 <= rating <= 5:
            return jsonify({'error': 'Rating must be 0-5'}), 400
        
        if not photo_ids:
            return jsonify({'error': 'No photo_ids provided'}), 400
        
        success_count = 0
        error_count = 0
        errors = []
        results = []

        for photo_id in photo_ids:
            try:
                payload, status_code = set_photo_favorite_rating(photo_id, rating)
                if status_code != 200 or payload.get('error'):
                    errors.append({
                        'photo_id': photo_id,
                        'error': payload.get('error', 'Failed to update favorite'),
                    })
                    error_count += 1
                    continue

                success_count += 1
                results.append(payload)

            except Exception as e:
                errors.append({'photo_id': photo_id, 'error': str(e)})
                error_count += 1

        print(f"⭐ Bulk favorite: {success_count} success, {error_count} errors")

        return jsonify({
            'success_count': success_count,
            'error_count': error_count,
            'errors': errors,
            'results': results,
        })
    
    except Exception as e:
        error_logger.error(f"Error in bulk favorite: {e}")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print("\n🖼️  Photos Light Starting...")
    print(f"📁 Static files: {STATIC_DIR}")
    print("📚 No library loaded — choose one from the welcome screen.")

    print(f"🌐 Open: http://localhost:5001\n")
    
    # Run a single backend process to avoid transient route drift from the
    # Werkzeug debug reloader serving newer frontend files against stale routes.
    app.run(debug=True, use_reloader=False, port=5001, host='0.0.0.0')
