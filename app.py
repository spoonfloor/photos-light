#!/usr/bin/env python3
"""
Photo Viewer - Flask Server with Database API
"""

from flask import Flask, send_from_directory, jsonify, request, send_file, Response, stream_with_context
import sqlite3
from functools import wraps

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
import subprocess
import shutil
import time
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime
from PIL import Image
from pillow_heif import register_heif_opener
from io import BytesIO
from db_schema import create_database_schema
from library_sync import synchronize_library_generator, count_media_files, estimate_duration

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

# Supported media file extensions (wide net for discovery)
PHOTO_EXTENSIONS = {
    '.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.bmp', '.tiff', '.tif',
    '.webp', '.avif', '.jp2',
    '.raw', '.cr2', '.nef', '.arw', '.dng'
}
VIDEO_EXTENSIONS = {
    '.mov', '.mp4', '.m4v', '.mkv',
    '.wmv', '.webm', '.flv', '.3gp',
    '.mpg', '.mpeg', '.vob', '.ts', '.mts', '.avi'
}
ALL_MEDIA_EXTENSIONS = PHOTO_EXTENSIONS | VIDEO_EXTENSIONS

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
    """Create database connection"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # Return rows as dictionaries
    return conn

def get_image_dimensions(file_path):
    """Get image/video dimensions (width, height) from file"""
    try:
        # Check if it's a video file
        ext = os.path.splitext(file_path)[1].lower()
        if ext in ['.mov', '.mp4', '.m4v', '.avi', '.mpg', '.mpeg']:
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
    """Extract EXIF/metadata date using exiftool (photos) or ffprobe (videos)"""
    try:
        # Determine file type
        ext = os.path.splitext(file_path)[1].lower()
        video_exts = {'.mov', '.mp4', '.m4v', '.avi', '.mkv', '.wmv', '.webm', '.flv', '.3gp', '.mpg', '.mpeg', '.vob', '.ts', '.mts'}
        
        if ext in video_exts:
            # Try ffprobe for video metadata
            result = subprocess.run(
                ['ffprobe', '-v', 'quiet', '-show_entries', 'format_tags=creation_time', 
                 '-of', 'default=noprint_wrappers=1:nokey=1', file_path],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                # Convert ISO 8601 to EXIF format: 2000-01-01T08:00:06.000000Z -> 2000:01:01 08:00:06
                iso_date = result.stdout.strip()
                if 'T' in iso_date:
                    date_part, time_part = iso_date.split('T')
                    time_part = time_part.split('.')[0].split('Z')[0]  # Remove microseconds and Z
                    exif_date = date_part.replace('-', ':') + ' ' + time_part
                    return exif_date
        else:
            # Try exiftool for photo EXIF
            result = subprocess.run(
                ['exiftool', '-DateTimeOriginal', '-s3', '-d', '%Y:%m:%d %H:%M:%S', file_path],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        
        # Fall back to file modification time
        mtime = os.path.getmtime(file_path)
        return datetime.fromtimestamp(mtime).strftime('%Y:%m:%d %H:%M:%S')
    except Exception as e:
        print(f"Error extracting EXIF date: {e}")
        # Ultimate fallback
        mtime = os.path.getmtime(file_path)
        return datetime.fromtimestamp(mtime).strftime('%Y:%m:%d %H:%M:%S')

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

def write_photo_exif(file_path, new_date):
    """Write EXIF date to photo using exiftool"""
    print(f"🔧 Writing EXIF to: {os.path.basename(file_path)}")
    print(f"   Target date: {new_date}")
    
    try:
        cmd = [
            'exiftool',
            f'-DateTimeOriginal={new_date}',
            f'-CreateDate={new_date}',
            f'-ModifyDate={new_date}',
            '-overwrite_original',
            '-P',
            file_path
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        print(f"   exiftool exit code: {result.returncode}")
        print(f"   exiftool stdout: {result.stdout.strip()}")
        
        if result.returncode != 0:
            print(f"   ❌ exiftool stderr: {result.stderr}")
            raise Exception(f"exiftool failed: {result.stderr}")
        
        # Verify write succeeded by reading back
        print(f"   🔍 Verifying write...")
        verify_cmd = ['exiftool', '-DateTimeOriginal', '-s3', file_path]
        verify_result = subprocess.run(verify_cmd, capture_output=True, text=True, timeout=5)
        
        if verify_result.returncode == 0:
            read_date = verify_result.stdout.strip()
            print(f"   Read back: {read_date}")
            if read_date != new_date:
                raise Exception(f"EXIF verification failed: wrote {new_date}, read back {read_date}")
            print(f"   ✅ EXIF write verified")
        else:
            raise Exception(f"EXIF verification failed: could not read back date")
            
    except subprocess.TimeoutExpired:
        raise Exception("exiftool timeout after 30s")
    except FileNotFoundError:
        raise Exception("exiftool not found")

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

def generate_new_filename(old_filename, new_date):
    """Generate new filename with new date but same hash"""
    prefix, _, hash_part, ext = parse_filename(old_filename)
    if not prefix or not hash_part:
        # Can't parse - generate new canonical name with date and first 8 chars of filename
        new_date_str = new_date.split()[0].replace(':', '')
        basename = os.path.splitext(old_filename)[0][:8]
        ext = os.path.splitext(old_filename)[1]
        return f"img_{new_date_str}_{basename}{ext}"
    
    # Extract date: "2025:12:25 14:30:00" -> "20251225"
    new_date_str = new_date.split()[0].replace(':', '')
    return f"{prefix}_{new_date_str}_{hash_part}{ext}"

def get_date_folder(date_str):
    """Get folder path from date: YYYY/YYYY-MM-DD"""
    parts = date_str.split()[0].split(':')
    year = parts[0]
    month = parts[1]
    day = parts[2]
    return os.path.join(year, f"{year}-{month}-{day}")

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
                        photo_exts = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.bmp', '.tiff', '.tif'}
                        
                        if ext in photo_exts:
                            write_photo_exif(file_path, old_date)
                        else:
                            write_video_metadata(file_path, old_date)
                        
                        print(f"  ↩️  Restored EXIF: {os.path.basename(file_path)}")
            
            except Exception as e:
                print(f"  ⚠️  Rollback error (continuing): {e}")
        
        print(f"✅ Rollback complete")

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
                        photo_exts = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.bmp', '.tiff', '.tif'}
                        
                        if ext in photo_exts:
                            write_photo_exif(file_path, old_date)
                        else:
                            write_video_metadata(file_path, old_date)
                        
                        print(f"  ↩️  Restored EXIF: {os.path.basename(file_path)}")
            
            except Exception as e:
                print(f"  ⚠️  Rollback error (continuing): {e}")
        
        print(f"✅ Rollback complete")

def update_photo_date_with_files(photo_id, new_date, conn):
    """
    Update single photo date with full file operations
    Returns: (success, error_message, transaction)
    """
    cursor = conn.cursor()
    transaction = DateEditTransaction()
    
    try:
        # Get photo info
        cursor.execute("SELECT current_path, date_taken, file_type FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        if not row:
            return False, "Photo not found", transaction
        
        old_rel_path = row['current_path']
        old_filename = os.path.basename(old_rel_path)
        old_date = row['date_taken']
        file_type = row['file_type']
        
        old_full_path = os.path.join(LIBRARY_PATH, old_rel_path)
        
        if not os.path.exists(old_full_path):
            return False, "File not found on disk", transaction
        
        # Phase 1: Write EXIF
        try:
            if file_type == 'image':
                write_photo_exif(old_full_path, new_date)
            elif file_type == 'video':
                write_video_metadata(old_full_path, new_date)
            else:
                raise Exception(f"Unknown file type: {file_type}")
            
            transaction.log_exif_write(old_full_path, old_date)
            
            # Rehash file after EXIF write (content changed)
            sha256 = hashlib.sha256()
            with open(old_full_path, 'rb') as f:
                while chunk := f.read(1024 * 1024):
                    sha256.update(chunk)
            new_hash = sha256.hexdigest()
            
            # Get old hash from database
            cursor.execute("SELECT content_hash FROM photos WHERE id = ?", (photo_id,))
            row = cursor.fetchone()
            old_hash = row['content_hash'] if row else None
            
            if new_hash != old_hash:
                print(f"  📝 Hash changed: {old_hash[:8] if old_hash else 'N/A'} → {new_hash[:8]}")
                
                # Delete old thumbnail if hash changed (keep DB squeaky clean)
                if old_hash:
                    old_thumb_path = os.path.join(THUMBNAIL_CACHE_DIR, old_hash[:2], old_hash[2:4], f"{old_hash}.jpg")
                    if os.path.exists(old_thumb_path):
                        os.remove(old_thumb_path)
                        cleanup_empty_thumbnail_folders(old_thumb_path)
                        print(f"  🗑️  Deleted old thumbnail")
                
                # Update database with new hash
                cursor.execute("UPDATE photos SET content_hash = ? WHERE id = ?", (new_hash, photo_id))
                # Note: Old thumbnail with old hash will be orphaned, new one generated on-demand
            
        except Exception as e:
            transaction.log_failure(old_filename, e)
            raise
        
        # Phase 2: Rename and move file
        try:
            new_filename = generate_new_filename(old_filename, new_date)
            new_folder = get_date_folder(new_date)
            new_rel_path = os.path.join(new_folder, new_filename)
            new_full_path = os.path.join(LIBRARY_PATH, new_rel_path)
            
            # Create destination folder
            os.makedirs(os.path.dirname(new_full_path), exist_ok=True)
            
            # Move file
            shutil.move(old_full_path, new_full_path)
            transaction.log_move(old_rel_path, new_rel_path)
            
            # Clean up empty old folders
            try:
                old_dir = os.path.dirname(old_full_path)
                # Remove date folder if empty
                if os.path.isdir(old_dir) and not os.listdir(old_dir):
                    os.rmdir(old_dir)
                    # Remove year folder if empty
                    year_dir = os.path.dirname(old_dir)
                    if os.path.isdir(year_dir) and not os.listdir(year_dir):
                        os.rmdir(year_dir)
            except Exception as e:
                # Don't fail the whole operation if cleanup fails
                print(f"  ⚠️  Couldn't clean up empty folders: {e}")
            
            # Update database
            cursor.execute("""
                UPDATE photos 
                SET current_path = ?, 
                    original_filename = ?,
                    date_taken = ?
                WHERE id = ?
            """, (new_rel_path, new_filename, new_date, photo_id))
            
        except Exception as e:
            transaction.log_failure(old_filename, e)
            raise
        
        return True, None, transaction
        
    except Exception as e:
        return False, str(e), transaction

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
                    if img.mode != 'RGB':
                        img = img.convert('RGB')
                    
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
                    
                    img.save(thumbnail_path, format='JPEG', quality=85, optimize=True)
                os.remove(temp_frame)
                return True
            return False
        else:
            # Generate image thumbnail - center-crop to 400x400 square
            with Image.open(file_path) as img:
                from PIL import ImageOps
                img = ImageOps.exif_transpose(img)
                
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                
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
                
                img.save(thumbnail_path, format='JPEG', quality=85, optimize=True)
                return True
    except Exception as e:
        print(f"❌ Error generating thumbnail: {e}")
        return False


@app.route('/')
def index():
    """Serve the main page"""
    return send_from_directory(STATIC_DIR, 'index.html')

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
    
    # Determine sort direction
    order_by = 'DESC' if sort_order == 'newest' else 'ASC'
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Lightweight query - just id, date, month, file_type, current_path, width, height for grid structure
        query = f"""
            SELECT 
                id,
                date_taken,
                file_type,
                current_path,
                width,
                height
            FROM photos
            WHERE date_taken IS NOT NULL
            ORDER BY date_taken {order_by}, current_path ASC
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
            # Extract month from date_taken
            date_str = row['date_taken']
            if date_str:
                date_normalized = date_str.replace(':', '-', 2)
                month = date_normalized[:7]
            else:
                month = None
            
            photos.append({
                'id': row['id'],
                'date': date_str,
                'month': month,
                'file_type': row['file_type'],
                'path': row['current_path'],
                'width': row['width'],
                'height': row['height'],
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
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                
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
                
                img.save(thumbnail_path, format='JPEG', quality=85, optimize=True)
            
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
            
            # Convert to RGB if needed
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
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
            
            # Save to cache
            img.save(thumbnail_path, format='JPEG', quality=85, optimize=True)
            
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

def cleanup_empty_folders(file_path, library_root):
    """
    Delete folders that contain no media files, working up the directory tree.
    Non-media files are deleted along with folders (scorched earth approach).
    Stops at library root or when a folder with media is found.
    """
    MEDIA_EXTS = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', 
                  '.bmp', '.tiff', '.tif', '.mov', '.mp4', '.m4v', 
                  '.avi', '.mpg', '.mpeg', '.3gp', '.mts', '.mkv'}
    
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
        success, error, transaction = update_photo_date_with_files(photo_id, new_date, conn)
        
        if success:
            conn.commit()
            conn.close()
            print(f"✅ Updated photo {photo_id} with file operations")
            return jsonify({'status': 'success', 'new_date': new_date})
        else:
            # Rollback transaction
            transaction.rollback(LIBRARY_PATH)
            conn.rollback()
            conn.close()
            
            return jsonify({
                'status': 'error',
                'error': error,
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
        
        for photo_id, target_date in photo_date_map.items():
            success, error, transaction = update_photo_date_with_files(photo_id, target_date, conn)
            
            if success:
                success_count += 1
                # Merge this transaction into master
                master_transaction.operations.extend(transaction.operations)
            else:
                # Log failure
                cursor.execute("SELECT current_path FROM photos WHERE id = ?", (photo_id,))
                row = cursor.fetchone()
                filename = os.path.basename(row['current_path']) if row else f"photo_{photo_id}"
                master_transaction.log_failure(filename, error)
        
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
            print(f"✅ Updated {success_count} photos with file operations")
            return jsonify({
                'status': 'success',
                'updated_count': success_count
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
            success, error, transaction = update_photo_date_with_files(photo_id, new_date, conn)
            
            if success:
                conn.commit()
                conn.close()
                print(f"✅ Updated photo {photo_id} with file operations")
                
                # Send completion
                yield f"event: complete\ndata: {json.dumps({'updated_count': 1, 'photo_id': photo_id})}\n\n"
            else:
                # Rollback transaction
                transaction.rollback(LIBRARY_PATH)
                conn.rollback()
                conn.close()
                
                yield f"event: error\ndata: {json.dumps({'error': error, 'failed_files': transaction.failed_files})}\n\n"
                
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
            total = len(photo_date_map)
            
            for idx, (photo_id, target_date) in enumerate(photo_date_map.items(), 1):
                # Send progress update
                yield f"event: progress\ndata: {json.dumps({'current': idx, 'total': total, 'photo_id': photo_id})}\n\n"
                
                success, error, transaction = update_photo_date_with_files(photo_id, target_date, conn)
                
                if success:
                    success_count += 1
                    # Merge this transaction into master
                    master_transaction.operations.extend(transaction.operations)
                else:
                    # Log failure
                    cursor.execute("SELECT current_path FROM photos WHERE id = ?", (photo_id,))
                    row = cursor.fetchone()
                    filename = os.path.basename(row['current_path']) if row else f"photo_{photo_id}"
                    master_transaction.log_failure(filename, error)
            
            # Check results
            if master_transaction.failed_files:
                # At least one failure - rollback EVERYTHING
                print(f"❌ {len(master_transaction.failed_files)} failures - rolling back all changes")
                master_transaction.rollback(LIBRARY_PATH)
                conn.rollback()
                conn.close()
                
                yield f"event: error\ndata: {json.dumps({{'error': 'Failed to update some photos', 'failed_count': len(master_transaction.failed_files), 'total_count': total, 'failed_files': master_transaction.failed_files}})}\n\n"
            else:
                # All succeeded - commit
                conn.commit()
                conn.close()
                print(f"✅ Updated {success_count} photos with file operations")
                
                # Send completion
                yield f"event: complete\ndata: {json.dumps({'updated_count': success_count, 'total': total})}\n\n"
                
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

@app.route('/api/photos/import-from-paths', methods=['POST'])
def import_from_paths():
    """
    Import photos from file paths (SSE streaming version with fixes)
    """
    def generate():
        try:
            data = request.json
            file_paths = data.get('paths', [])
            
            if not file_paths:
                yield f"event: error\ndata: {json.dumps({'error': 'No paths provided'})}\n\n"
                return
            
            total_files = len(file_paths)
            print(f"\n{'='*60}")
            print(f"📥 IMPORT FROM PATHS: {total_files} file(s)")
            print(f"LIBRARY_PATH: {LIBRARY_PATH}")
            print(f"DB_PATH: {DB_PATH}")
            print(f"{'='*60}\n")
            
            yield f"event: start\ndata: {json.dumps({'total': total_files})}\n\n"
            
            # Track results
            imported_count = 0
            duplicate_count = 0
            error_count = 0
            
            conn = get_db_connection()
            cursor = conn.cursor()
            
            for file_index, source_path in enumerate(file_paths, 1):
                try:
                    if not os.path.exists(source_path):
                        print(f"{file_index}. ❌ File not found: {source_path}")
                        error_count += 1
                        yield f"event: progress\ndata: {json.dumps({'imported': imported_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': file_index, 'total': total_files})}\n\n"
                        continue
                    
                    filename = os.path.basename(source_path)
                    print(f"{file_index}. Processing: {filename}")
                    
                    # Hash the file
                    content_hash = compute_hash(source_path)
                    print(f"   Hash: {content_hash[:16]}...")
                    
                    # Check for duplicates
                    cursor.execute("SELECT id, current_path FROM photos WHERE content_hash = ?", (content_hash,))
                    existing = cursor.fetchone()
                    
                    if existing:
                        print(f"   ⏭️  Duplicate (existing ID: {existing['id']})")
                        duplicate_count += 1
                        yield f"event: progress\ndata: {json.dumps({'imported': imported_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': file_index, 'total': total_files})}\n\n"
                        continue
                    
                    # Determine date_taken
                    date_taken = extract_exif_date(source_path)
                    if not date_taken:
                        date_taken = datetime.fromtimestamp(os.path.getmtime(source_path)).strftime('%Y:%m:%d %H:%M:%S')
                    print(f"   Date: {date_taken}")
                    
                    # Build target path
                    date_obj = datetime.strptime(date_taken, '%Y:%m:%d %H:%M:%S')
                    year = date_obj.strftime('%Y')
                    date_folder = date_obj.strftime('%Y-%m-%d')
                    target_dir = os.path.join(LIBRARY_PATH, year, date_folder)
                    os.makedirs(target_dir, exist_ok=True)
                    
                    # Generate canonical filename
                    _, ext = os.path.splitext(filename)
                    short_hash = content_hash[:8]
                    base_name = f"img_{date_obj.strftime('%Y%m%d')}_{short_hash}"
                    canonical_name = base_name + ext.lower()
                    target_path = os.path.join(target_dir, canonical_name)
                    
                    # Handle naming collisions
                    counter = 1
                    while os.path.exists(target_path):
                        canonical_name = f"{base_name}_{counter}{ext.lower()}"
                        target_path = os.path.join(target_dir, canonical_name)
                        counter += 1
                    
                    # Get dimensions
                    dimensions = get_image_dimensions(source_path)
                    width = dimensions[0] if dimensions else None
                    height = dimensions[1] if dimensions else None
                    
                    # Insert into DB FIRST (atomic)
                    relative_path = os.path.relpath(target_path, LIBRARY_PATH)
                    file_size = os.path.getsize(source_path)
                    file_type = 'video' if ext.lower() in VIDEO_EXTENSIONS else 'image'
                    
                    cursor.execute('''
                        INSERT INTO photos (current_path, original_filename, content_hash, file_size, file_type, date_taken, width, height)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (relative_path, filename, content_hash, file_size, file_type, date_taken, width, height))
                    
                    photo_id = cursor.lastrowid
                    conn.commit()
                    print(f"   DB: Inserted ID {photo_id}")
                    
                    # Copy file to library
                    shutil.copy2(source_path, target_path)
                    print(f"   ✅ Copied to: {relative_path}")
                    
                    # Write EXIF metadata to file
                    try:
                        print(f"   🔧 Writing EXIF metadata...")
                        if file_type == 'image':
                            write_photo_exif(target_path, date_taken)
                        elif file_type == 'video':
                            write_video_metadata(target_path, date_taken)
                        else:
                            raise Exception(f"Unknown file type: {file_type}")
                        print(f"   ✅ EXIF written and verified")
                        
                        # Rehash file after EXIF write (content changed)
                        print(f"   🔄 Rehashing file after EXIF write...")
                        sha256 = hashlib.sha256()
                        with open(target_path, 'rb') as f:
                            while chunk := f.read(1024 * 1024):
                                sha256.update(chunk)
                        new_hash = sha256.hexdigest()
                        
                        if new_hash != content_hash:
                            print(f"   📝 Hash changed: {content_hash[:8]} → {new_hash[:8]}")
                            
                            # Delete old thumbnail if hash changed (keep DB squeaky clean)
                            old_thumb_path = os.path.join(THUMBNAIL_CACHE_DIR, content_hash[:2], content_hash[2:4], f"{content_hash}.jpg")
                            if os.path.exists(old_thumb_path):
                                os.remove(old_thumb_path)
                                cleanup_empty_thumbnail_folders(old_thumb_path)
                                print(f"   🗑️  Deleted old thumbnail")
                            
                            # Update database with new hash
                            cursor.execute("UPDATE photos SET content_hash = ? WHERE id = ?", (new_hash, photo_id))
                            conn.commit()
                            # Note: Thumbnail will be regenerated on-demand with new hash
                        
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
                        
                        # Track rejection count (duplicate vs error)
                        if category == 'duplicate':
                            duplicate_count += 1
                        else:
                            error_count += 1
                        
                        # Yield rejection event (special type of error with extra metadata)
                        yield f"event: rejected\ndata: {json.dumps({'file': filename, 'source_path': source_path, 'reason': user_message, 'category': category, 'technical_error': str(exif_error)})}\n\n"
                        
                        # Continue to next file (don't increment imported_count)
                        continue
                    
                    # SUCCESS - file imported with EXIF
                    imported_count += 1
                    
                    yield f"event: progress\ndata: {json.dumps({'imported': imported_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': file_index, 'total': total_files, 'photo_id': photo_id})}\n\n"
                    
                except Exception as e:
                    error_msg = str(e)
                    print(f"   ❌ Error: {error_msg}")
                    import traceback
                    traceback.print_exc()
                    error_count += 1
                    yield f"event: progress\ndata: {json.dumps({'imported': imported_count, 'duplicates': duplicate_count, 'errors': error_count, 'current': file_index, 'total': total_files, 'error': error_msg, 'error_file': filename})}\n\n"
            
            conn.close()
            
            print(f"\n{'='*60}")
            print(f"IMPORT COMPLETE:")
            print(f"  Imported: {imported_count}")
            print(f"  Duplicates: {duplicate_count}")
            print(f"  Errors: {error_count}")
            print(f"{'='*60}\n")
            
            yield f"event: complete\ndata: {json.dumps({'imported': imported_count, 'duplicates': duplicate_count, 'errors': error_count})}\n\n"
            
        except Exception as e:
            print(f"❌ Import error: {e}")
            import traceback
            traceback.print_exc()
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
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

@app.route('/api/utilities/duplicates')
@handle_db_corruption
def get_duplicates():
    """
    Find duplicate photos (same content_hash)
    
    Returns:
    {
      "duplicates": [
        {
          "hash": "abc123...",
          "count": 3,
          "files": [
            {
              "id": 123,
              "path": "2024/2024-01-15/img_20240115_abc1234.jpg",
              "date_taken": "2024:01:15 14:30:00",
              "file_size": 2048576
            },
            ...
          ]
        },
        ...
      ],
      "total_duplicate_sets": 45,
      "total_extra_copies": 67,
      "total_wasted_space": 134217728
    }
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Find hashes that appear more than once
        cursor.execute("""
            SELECT content_hash, COUNT(*) as count
            FROM photos
            GROUP BY content_hash
            HAVING count > 1
            ORDER BY count DESC
        """)
        
        duplicate_hashes = cursor.fetchall()
        
        duplicates = []
        total_extra_copies = 0
        total_wasted_space = 0
        
        for row in duplicate_hashes:
            content_hash = row['content_hash']
            count = row['count']
            
            # Get all files with this hash
            cursor.execute("""
                SELECT id, current_path, date_taken, file_size, file_type
                FROM photos
                WHERE content_hash = ?
                ORDER BY id ASC
            """, (content_hash,))
            
            files = []
            for file_row in cursor.fetchall():
                files.append({
                    'id': file_row['id'],
                    'path': file_row['current_path'],
                    'date_taken': file_row['date_taken'],
                    'file_size': file_row['file_size'],
                    'file_type': file_row['file_type']
                })
            
            duplicates.append({
                'hash': content_hash[:16] + '...',  # Truncate for display
                'count': count,
                'files': files
            })
            
            # Calculate stats (all copies except one)
            total_extra_copies += count - 1
            if files and files[0]['file_size']:
                total_wasted_space += files[0]['file_size'] * (count - 1)
        
        conn.close()
        
        print(f"📋 Found {len(duplicates)} duplicate sets ({total_extra_copies} extra copies)")
        
        return jsonify({
            'duplicates': duplicates,
            'total_duplicate_sets': len(duplicates),
            'total_extra_copies': total_extra_copies,
            'total_wasted_space': total_wasted_space
        })
        
    except Exception as e:
        app.logger.error(f"Error finding duplicates: {e}")
        return jsonify({'error': str(e)}), 500


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
        
        photo_exts = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.bmp', '.tiff', '.tif'}
        video_exts = {'.mov', '.mp4', '.m4v', '.avi', '.mpg', '.mpeg', '.3gp', '.mts', '.mkv'}
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
            for directory in [THUMBNAIL_CACHE_DIR, TRASH_DIR, DB_BACKUP_DIR, IMPORT_TEMP_DIR, LOG_DIR]:
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
    for directory in [THUMBNAIL_CACHE_DIR, TRASH_DIR, DB_BACKUP_DIR, IMPORT_TEMP_DIR, LOG_DIR]:
        try:
            os.makedirs(directory, exist_ok=True)
        except (PermissionError, OSError) as e:
            print(f"⚠️  Warning: Could not create directory {directory}: {e}")
            print(f"   This may indicate the library is not accessible.")


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
        
        # Validate config has required keys
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
        
        try:
            db_exists = os.path.exists(db_path)
        except (OSError, PermissionError) as e:
            return jsonify({
                'status': 'db_inaccessible',
                'message': f'Cannot check database access: {str(e)}',
                'library_path': library_path,
                'db_path': db_path,
                'valid': False
            })
        
        # Determine status - treat missing library/db as not_configured (first run)
        if not library_exists or not db_exists:
            # Library or database is gone - treat as first run
            delete_config()  # Clean up stale config
            return jsonify({
                'status': 'not_configured',
                'message': 'Library not found. Please select or create a library.',
                'library_path': None,
                'db_path': None,
                'valid': False
            })
        
        # Database file exists - verify it's actually usable
        try:
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            # Check if the photos table exists
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='photos'")
            if not cursor.fetchone():
                conn.close()
                return jsonify({
                    'status': 'db_missing',
                    'message': 'Database file exists but is not initialized.',
                    'library_path': library_path,
                    'db_path': db_path,
                    'valid': False
                })
            conn.close()
        except sqlite3.DatabaseError:
            return jsonify({
                'status': 'db_missing',
                'message': 'Database file is corrupted or invalid.',
                'library_path': library_path,
                'db_path': db_path,
                'valid': False
            })
        
        # All checks passed
        return jsonify({
            'status': 'healthy',
            'message': 'Library is ready.',
            'library_path': library_path,
            'db_path': db_path,
            'valid': True
        })
        
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
        
        # Check if path has a database
        potential_db_path = os.path.join(path, 'photo_library.db')
        
        if os.path.exists(potential_db_path):
            # Valid existing library
            return jsonify({
                'status': 'exists',
                'library_path': path,
                'db_path': potential_db_path
            })
        else:
            # New library needs initialization
            return jsonify({
                'status': 'needs_init',
                'library_path': path,
                'db_path': potential_db_path
            })
            
    except Exception as e:
        error_logger.error(f"Library path validation failed: {e}")
        return jsonify({'status': 'invalid', 'error': str(e)}), 500

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
        
        # Validate path exists and is accessible
        if not os.path.exists(path):
            return jsonify({'error': 'Path does not exist'}), 404
        
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
        has_db = False
        
        for item in items:
            # Skip hidden files/folders (starting with .)
            if item.startswith('.'):
                continue
            
            # Skip backup and archive folders
            item_lower = item.lower()
            backup_patterns = ['backup', 'backups', 'archive', 'archives', 'time machine', 'time_machine']
            if any(pattern in item_lower for pattern in backup_patterns):
                continue

            # Check if this is the database file
            if item == 'photo_library.db':
                has_db = True
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
            'has_db': has_db
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
        
        # Photo extensions
        photo_exts = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', 
                      '.bmp', '.tiff', '.tif', '.webp', '.avif', '.jp2',
                      '.raw', '.cr2', '.nef', '.arw', '.dng'}
        
        # Video extensions
        video_exts = {'.mov', '.mp4', '.m4v', '.avi', '.mkv', '.wmv', 
                      '.webm', '.flv', '.3gp', '.mpg', '.mpeg', '.vob', 
                      '.ts', '.mts'}
        
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
        
        # Check if path has a database
        potential_db_path = os.path.join(selected_path, 'photo_library.db')
        
        if os.path.exists(potential_db_path):
            # Valid existing library
            return jsonify({
                'status': 'exists',
                'library_path': selected_path,
                'db_path': potential_db_path
            })
        else:
            # New library needs initialization
            return jsonify({
                'status': 'needs_init',
                'library_path': selected_path,
                'db_path': potential_db_path
            })
            
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Selection timeout'}), 408
    except Exception as e:
        error_logger.error(f"Browse library failed: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/library/check', methods=['POST'])
def check_library():
    """Check if a path contains a valid library and count media files if no DB exists"""
    try:
        data = request.json
        library_path = data.get('library_path')
        
        if not library_path:
            return jsonify({'error': 'Missing library_path'}), 400
        
        # Check if path exists
        if not os.path.exists(library_path):
            return jsonify({
                'exists': False,
                'has_media': False,
                'media_count': 0,
                'library_path': library_path,
                'db_path': None
            })
        
        # Check if database exists
        db_path = os.path.join(library_path, 'photo_library.db')
        exists = os.path.exists(db_path)
        
        # If no database, scan for media files
        has_media = False
        media_count = 0
        
        if not exists:
            print(f"  📊 No database found, scanning for media files...")
            from library_sync import count_media_files
            try:
                media_count = count_media_files(library_path)
                has_media = media_count > 0
                print(f"  ✅ Found {media_count} media file(s)")
            except Exception as e:
                print(f"  ⚠️  Error counting media files: {e}")
                # Continue with has_media=False if counting fails
        
        return jsonify({
            'exists': exists,
            'has_media': has_media,
            'media_count': media_count,
            'library_path': library_path,
            'db_path': db_path
        })
        
    except Exception as e:
        app.logger.error(f"Error checking library: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/library/create', methods=['POST'])
def create_library():
    """Create new library structure at specified path"""
    try:
        data = request.json
        library_path = data.get('library_path')
        db_path = data.get('db_path')
        
        if not library_path or not db_path:
            return jsonify({'error': 'Missing library_path or db_path'}), 400
        
        print(f"\n📦 Creating new library at: {library_path}")
        
        # Check if library already exists
        if os.path.exists(library_path):
            return jsonify({'error': f'A folder already exists at this location. Please choose a different name or location.'}), 400
        
        # Create directory structure
        # Let OS errors pass through with accurate error messages
        os.makedirs(library_path, exist_ok=False)
        print(f"  ✅ Created: {library_path}")
        
        # Create subdirectories
        os.makedirs(os.path.join(library_path, '.thumbnails'), exist_ok=True)
        os.makedirs(os.path.join(library_path, '.trash'), exist_ok=True)
        os.makedirs(os.path.join(library_path, '.db_backups'), exist_ok=True)
        os.makedirs(os.path.join(library_path, '.import_temp'), exist_ok=True)
        os.makedirs(os.path.join(library_path, '.logs'), exist_ok=True)
        
        # Create empty database with schema
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Create all tables and indices using centralized schema
        create_database_schema(cursor)
        
        conn.commit()
        conn.close()
        
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

@app.route('/api/library/switch', methods=['POST'])
def switch_library():
    """Switch to a different library with health check"""
    try:
        data = request.json
        library_path = data.get('library_path')
        db_path = data.get('db_path')
        
        if not library_path or not db_path:
            return jsonify({'error': 'Missing library_path or db_path'}), 400
        
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
        else:
            print(f"⚠️  Saved library not found - user will be prompted")
            delete_config()  # Clean up stale config
    else:
        print(f"⚠️  No library configured - user will be prompted")
    
    print(f"🌐 Open: http://localhost:5001\n")
    
    app.run(debug=True, port=5001, host='0.0.0.0')
