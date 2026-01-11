#!/usr/bin/env python3
"""
Photo Viewer - Flask Server with Database API
"""

from flask import Flask, send_from_directory, jsonify, request, send_file, Response, stream_with_context
import sqlite3
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

# Register HEIF/HEIC support for PIL
register_heif_opener()

app = Flask(__name__, static_folder='static')

# Feature flags
app.config['DRY_RUN_DATE_EDIT'] = False  # REAL UPDATES - using test library

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, 'static')
DB_PATH = os.environ.get('PHOTO_DB_PATH', os.path.join(BASE_DIR, 'photo_library.db'))
LIBRARY_PATH = os.environ.get('PHOTO_LIBRARY_PATH', '/Volumes/eric_files/photo_library_test')
THUMBNAIL_CACHE_DIR = os.path.join(LIBRARY_PATH, '.thumbnails')
TRASH_DIR = os.path.join(LIBRARY_PATH, '.trash')
DB_BACKUP_DIR = os.path.join(LIBRARY_PATH, '.db_backups')
IMPORT_TEMP_DIR = os.path.join(LIBRARY_PATH, '.import_temp')
LOG_DIR = os.path.join(LIBRARY_PATH, '.logs')

# Ensure directories exist
for directory in [THUMBNAIL_CACHE_DIR, TRASH_DIR, DB_BACKUP_DIR, IMPORT_TEMP_DIR, LOG_DIR]:
    os.makedirs(directory, exist_ok=True)

# ============================================================================
# LOGGING CONFIGURATION (Hybrid Approach: print() + persistent logs)
# ============================================================================

# Configure main app logger
app_log_file = os.path.join(LOG_DIR, 'app.log')
app_handler = RotatingFileHandler(app_log_file, maxBytes=10*1024*1024, backupCount=10)
app_handler.setFormatter(logging.Formatter(
    '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
))
app.logger.addHandler(app_handler)
app.logger.setLevel(logging.INFO)

# Configure import logger (separate concern)
import_logger = logging.getLogger('import')
import_handler = RotatingFileHandler(
    os.path.join(LOG_DIR, f'import_{datetime.now().strftime("%Y%m%d")}.log'),
    maxBytes=10*1024*1024,
    backupCount=30
)
import_handler.setFormatter(logging.Formatter(
    '%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
))
import_logger.addHandler(import_handler)
import_logger.setLevel(logging.INFO)

# Configure error logger (separate concern)
error_logger = logging.getLogger('errors')
error_handler = RotatingFileHandler(
    os.path.join(LOG_DIR, 'errors.log'),
    maxBytes=10*1024*1024,
    backupCount=10
)
error_handler.setFormatter(logging.Formatter(
    '%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
))
error_logger.addHandler(error_handler)
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
                return img.size  # (width, height)
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
    """Extract EXIF date using exiftool"""
    try:
        # Try exiftool first
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

def generate_thumbnail_for_file(file_path, photo_id, file_type):
    """Generate thumbnail for a file"""
    try:
        # Determine thumbnail path
        base, ext = os.path.splitext(os.path.basename(file_path))
        thumbnail_filename = f"{base}_thumb.jpg"
        
        # Use date-based directory structure from file path
        relative_path_parts = file_path.replace(LIBRARY_PATH + '/', '').split('/')
        if len(relative_path_parts) >= 2:
            thumbnail_dir = os.path.join(THUMBNAIL_CACHE_DIR, relative_path_parts[0], relative_path_parts[1])
        else:
            thumbnail_dir = THUMBNAIL_CACHE_DIR
        
        os.makedirs(thumbnail_dir, exist_ok=True)
        thumbnail_path = os.path.join(thumbnail_dir, thumbnail_filename)
        
        if file_type == 'video':
            # Extract video frame
            temp_frame = os.path.join(IMPORT_TEMP_DIR, f"temp_frame_{photo_id}.jpg")
            cmd = [
                'ffmpeg',
                '-i', file_path,
                '-vframes', '1',
                '-vf', 'scale=-1:400',
                '-y',
                temp_frame
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0 and os.path.exists(temp_frame):
                with Image.open(temp_frame) as img:
                    if img.mode != 'RGB':
                        img = img.convert('RGB')
                    img.save(thumbnail_path, format='JPEG', quality=85, optimize=True)
                os.remove(temp_frame)
                return True
            return False
        else:
            # Generate image thumbnail
            with Image.open(file_path) as img:
                from PIL import ImageOps
                img = ImageOps.exif_transpose(img)
                
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                
                original_width, original_height = img.size
                target_height = 400
                target_width = int((original_width / original_height) * target_height)
                
                img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
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
        
        # Lightweight query - just id, date, month, file_type, current_path for grid structure
        query = f"""
            SELECT 
                id,
                date_taken,
                file_type,
                current_path
            FROM photos
            WHERE date_taken IS NOT NULL
            ORDER BY date_taken {order_by}
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
def get_photo_thumbnail(photo_id):
    """
    Serve thumbnail for a photo (lazy generation + caching)
    - First request: generate 400px height thumbnail, cache to disk
    - Subsequent requests: serve cached version
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get photo path
        cursor.execute("SELECT current_path, file_type FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        conn.close()
        
        if not row:
            return jsonify({'error': 'Photo not found'}), 404
        
        relative_path = row['current_path']
        
        # Thumbnail mirrors original structure but with _thumb suffix
        # e.g., img_xyz.jpg -> img_xyz_thumb.jpg
        base, ext = os.path.splitext(relative_path)
        thumbnail_relative_path = f"{base}_thumb{ext}"
        thumbnail_path = os.path.join(THUMBNAIL_CACHE_DIR, thumbnail_relative_path)
        
        # Serve cached thumbnail if it exists
        if os.path.exists(thumbnail_path):
            return send_file(thumbnail_path, mimetype='image/jpeg')
        
        # Generate thumbnail
        full_path = os.path.join(LIBRARY_PATH, relative_path)
        
        if not os.path.exists(full_path):
            return jsonify({'error': 'File not found on disk'}), 404
        
        # Ensure parent directory exists
        os.makedirs(os.path.dirname(thumbnail_path), exist_ok=True)
        
        # Only generate thumbnails for images (not videos for now)
        if row['file_type'] == 'video':
            # Generate video thumbnail using ffmpeg
            import subprocess
            
            # Create temp path for extracted frame
            temp_frame = os.path.join(os.path.dirname(thumbnail_path), f"temp_{photo_id}.jpg")
            
            # Extract first frame using ffmpeg
            cmd = [
                'ffmpeg',
                '-i', full_path,
                '-vframes', '1',
                '-vf', 'scale=-1:400',  # Fixed height 400px
                '-y',
                temp_frame
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode != 0 or not os.path.exists(temp_frame):
                return jsonify({'error': 'Failed to extract video frame'}), 500
            
            # Resize and save as final thumbnail
            with Image.open(temp_frame) as img:
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                # Already at 400px height from ffmpeg, just save
                img.save(thumbnail_path, format='JPEG', quality=85, optimize=True)
            
            # Clean up temp file
            os.remove(temp_frame)
            
            return send_file(thumbnail_path, mimetype='image/jpeg')
        
        # Generate thumbnail for images
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
            
            # Fixed height 400px, width determined by aspect ratio
            original_width, original_height = img.size
            target_height = 400
            target_width = int((original_width / original_height) * target_height)
            
            # Resize to fixed height
            img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
            
            # Save to cache
            img.save(thumbnail_path, format='JPEG', quality=85, optimize=True)
            
            # Serve the newly generated thumbnail
            return send_file(thumbnail_path, mimetype='image/jpeg')
            
    except Exception as e:
        print(f"❌ Error generating thumbnail for photo {photo_id}: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/photo/<int:photo_id>/file')
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

@app.route('/api/photos/delete', methods=['POST'])
def delete_photos():
    """Delete photos (move to .trash/ and move DB record to deleted_photos table)"""
    try:
        data = request.get_json()
        photo_ids = data.get('photo_ids', [])
        
        if not photo_ids:
            return jsonify({'error': 'No photo IDs provided'}), 400
        
        print(f"\n🗑️  DELETE REQUEST: {len(photo_ids)} photos")
        print(f"    Photo IDs: {photo_ids}")
        app.logger.info(f"Delete request: {len(photo_ids)} photos (IDs: {photo_ids})")
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Create deleted_photos table if it doesn't exist
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS deleted_photos (
                id INTEGER PRIMARY KEY,
                original_path TEXT NOT NULL,
                trash_filename TEXT NOT NULL,
                deleted_at TEXT NOT NULL,
                photo_data TEXT NOT NULL
            )
        """)
        
        deleted_count = 0
        errors = []
        trash_dir = TRASH_DIR
        os.makedirs(trash_dir, exist_ok=True)
        
        from datetime import datetime
        import json
        
        for photo_id in photo_ids:
            try:
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
                else:
                    print(f"    ⚠️  Original file not found: {full_path}")
                    trash_filename = os.path.basename(full_path)  # Store original name
                
                # Delete thumbnail cache
                base, ext = os.path.splitext(current_path)
                thumbnail_filename = f"{os.path.basename(base)}_thumb.jpg"
                thumbnail_relative_dir = os.path.dirname(current_path)
                thumbnail_path = os.path.join(THUMBNAIL_CACHE_DIR, thumbnail_relative_dir, thumbnail_filename)
                
                if os.path.exists(thumbnail_path):
                    os.remove(thumbnail_path)
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
        
        print(f"✅ Deleted {deleted_count} photos\n")
        
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
def update_photo_date():
    """Update photo date"""
    try:
        data = request.get_json()
        photo_id = data.get('photo_id')
        new_date = data.get('new_date')  # Format: YYYY:MM:DD HH:MM:SS
        
        if not photo_id or not new_date:
            return jsonify({'error': 'Missing photo_id or new_date'}), 400
        
        if app.config['DRY_RUN_DATE_EDIT']:
            print(f"\n🔍 DRY RUN - Would update photo {photo_id} date to: {new_date}")
            return jsonify({'status': 'success', 'dry_run': True, 'new_date': new_date})
        
        # Actually update the database
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("UPDATE photos SET date_taken = ? WHERE id = ?", (new_date, photo_id))
        conn.commit()
        conn.close()
        
        print(f"✅ Updated photo {photo_id} date to: {new_date}")
        return jsonify({'status': 'success', 'dry_run': False, 'new_date': new_date})
    except Exception as e:
        app.logger.error(f"Error updating photo date: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/photos/bulk_update_date', methods=['POST'])
def bulk_update_photo_dates():
    """Bulk update photo dates"""
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
        
        if mode == 'same':
            # Set all photos to the same date
            for photo_id in photo_ids:
                cursor.execute("UPDATE photos SET date_taken = ? WHERE id = ?", (new_date, photo_id))
            print(f"✅ Updated {len(photo_ids)} photos to same date: {new_date}")
        
        elif mode == 'shift':
            # Shift all photos by the offset from the first photo
            # Get first photo's original date
            cursor.execute("SELECT date_taken FROM photos WHERE id = ?", (photo_ids[0],))
            row = cursor.fetchone()
            if not row:
                return jsonify({'error': 'First photo not found'}), 404
            
            original_date_str = row['date_taken']
            
            # Parse dates (YYYY:MM:DD HH:MM:SS)
            original_date = datetime.strptime(original_date_str, '%Y:%m:%d %H:%M:%S')
            new_date_obj = datetime.strptime(new_date, '%Y:%m:%d %H:%M:%S')
            
            # Calculate offset
            offset = new_date_obj - original_date
            
            # Apply offset to all photos
            for photo_id in photo_ids:
                cursor.execute("SELECT date_taken FROM photos WHERE id = ?", (photo_id,))
                row = cursor.fetchone()
                if row:
                    photo_date = datetime.strptime(row['date_taken'], '%Y:%m:%d %H:%M:%S')
                    shifted_date = photo_date + offset
                    shifted_date_str = shifted_date.strftime('%Y:%m:%d %H:%M:%S')
                    cursor.execute("UPDATE photos SET date_taken = ? WHERE id = ?", (shifted_date_str, photo_id))
            
            print(f"✅ Shifted {len(photo_ids)} photos by {offset}")
        
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
            
            # Get all photos with their original dates to maintain order
            photo_dates = []
            for photo_id in photo_ids:
                cursor.execute("SELECT date_taken FROM photos WHERE id = ?", (photo_id,))
                row = cursor.fetchone()
                if row:
                    original_date = datetime.strptime(row['date_taken'], '%Y:%m:%d %H:%M:%S')
                    photo_dates.append((photo_id, original_date))
            
            # Sort by original date to maintain chronological order
            photo_dates.sort(key=lambda x: x[1])
            
            # Apply sequence starting from base date
            base_date = datetime.strptime(new_date, '%Y:%m:%d %H:%M:%S')
            for index, (photo_id, _) in enumerate(photo_dates):
                sequenced_date = base_date + (interval * index)
                sequenced_date_str = sequenced_date.strftime('%Y:%m:%d %H:%M:%S')
                cursor.execute("UPDATE photos SET date_taken = ? WHERE id = ?", (sequenced_date_str, photo_id))
            
            print(f"✅ Sequenced {len(photo_ids)} photos with {interval_amount} {interval_unit} intervals")
        
        conn.commit()
        conn.close()
        
        return jsonify({'status': 'success', 'dry_run': False, 'updated_count': len(photo_ids)})
    except Exception as e:
        app.logger.error(f"Error bulk updating photo dates: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/photos/restore', methods=['POST'])
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
                ORDER BY date_taken DESC
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
                ORDER BY date_taken ASC
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

@app.route('/api/photos/import', methods=['POST'])
def import_photos():
    """
    Import photos into the library with SSE progress streaming
    
    Returns Server-Sent Events with real-time progress:
    - event: progress (per-file updates)
    - event: complete (final summary)
    - event: error (if something goes wrong)
    """
    
    def generate():
        try:
            # Get uploaded files
            if 'files' not in request.files:
                yield f"event: error\ndata: {json.dumps({'error': 'No files provided'})}\n\n"
                return
            
            files = request.files.getlist('files')
            if not files:
                yield f"event: error\ndata: {json.dumps({'error': 'No files provided'})}\n\n"
                return
            
            total_files = len(files)
            print(f"\n📥 IMPORT REQUEST: {total_files} file(s)")
            import_logger.info(f"Import session started: {total_files} files")
            
            # Send initial status
            yield f"event: start\ndata: {json.dumps({'total': total_files})}\n\n"
            
            # Step 1: Create DB backup (once per session)
            backup_path = create_db_backup()
            if not backup_path:
                error_msg = 'Failed to create database backup'
                error_logger.error(f"Import aborted: {error_msg}")
                yield f"event: error\ndata: {json.dumps({'error': error_msg})}\n\n"
                return
            
            # Track results
            results = []
            imported_count = 0
            duplicate_count = 0
            error_count = 0
            
            conn = get_db_connection()
            cursor = conn.cursor()
            
            for file_index, file in enumerate(files, 1):
                result = {
                    'filename': file.filename,
                    'status': 'pending'
                }
                temp_path = None  # Initialize to avoid NameError in exception handler
                
                try:
                    # Save to temp location WHILE hashing (single pass - fast!)
                    temp_path = os.path.join(IMPORT_TEMP_DIR, file.filename)
                    print(f"\n📄 Processing: {file.filename}")
                    
                    # Hash while saving (eliminates double I/O)
                    content_hash = save_and_hash(file, temp_path)
                    result['hash'] = content_hash
                    print(f"  🔢 Hash: {content_hash}")
                    
                    # Check for duplicates EARLY (before expensive operations)
                    cursor.execute("SELECT id, current_path FROM photos WHERE content_hash = ?", (content_hash,))
                    duplicate = cursor.fetchone()
                    
                    if duplicate:
                        print(f"  ⚠️  DUPLICATE found (ID: {duplicate['id']}, Path: {duplicate['current_path']})")
                        result['status'] = 'duplicate'
                        result['duplicate_id'] = duplicate['id']
                        result['message'] = f"Duplicate of existing photo (ID: {duplicate['id']})"
                        duplicate_count += 1
                        
                        # Clean up temp file (no verification needed for duplicates)
                        os.remove(temp_path)
                        results.append(result)
                        
                        # Send progress event
                        yield f"event: progress\ndata: {json.dumps({'file_index': file_index, 'total': total_files, 'filename': file.filename, 'status': 'duplicate', 'imported': imported_count, 'duplicates': duplicate_count, 'errors': error_count})}\n\n"
                        continue
                    
                    # NOT a duplicate - verify integrity before proceeding
                    verified_hash = compute_hash(temp_path)
                    if verified_hash != content_hash:
                        print(f"  ❌ File corruption detected during upload")
                        os.remove(temp_path)
                        result['status'] = 'error'
                        result['message'] = 'File corruption during upload'
                        error_count += 1
                        results.append(result)
                        yield f"event: progress\ndata: {json.dumps({'file_index': file_index, 'total': total_files, 'filename': file.filename, 'status': 'error', 'imported': imported_count, 'duplicates': duplicate_count, 'errors': error_count})}\n\n"
                        continue
                    
                    # Extract EXIF date
                    date_taken = extract_exif_date(temp_path)
                    result['date'] = date_taken
                    print(f"  📅 Date: {date_taken}")
                    
                    # Skip dimensions during import (can extract lazily later if needed)
                    # This eliminates the biggest bottleneck (ffprobe on videos)
                    width, height = None, None
                    
                    # Step 6: Determine file type
                    ext = os.path.splitext(file.filename)[1].lower()
                    if ext in ['.mov', '.mp4', '.m4v', '.avi', '.mpg', '.mpeg']:
                        file_type = 'video'
                    elif ext in ['.jpg', '.jpeg', '.png', '.gif', '.heic', '.heif', '.tif', '.tiff']:
                        file_type = 'photo'  # Match migration scripts convention (+ GIF support)
                    else:
                        raise Exception(f"Unsupported file type: {ext}")
                    
                    # Step 7: Determine target path (YYYY-MM-DD/img_YYYYMMDD_hash.ext)
                    date_obj = datetime.strptime(date_taken, '%Y:%m:%d %H:%M:%S')
                    date_dir = date_obj.strftime('%Y-%m-%d')
                    new_filename = f"img_{date_obj.strftime('%Y%m%d')}_{content_hash}{ext}"
                    
                    target_dir = os.path.join(LIBRARY_PATH, date_dir)
                    target_path = os.path.join(target_dir, new_filename)
                    relative_path = os.path.join(date_dir, new_filename)
                    
                    print(f"  📁 Target: {relative_path}")
                    
                    # Step 8: Atomic rename to final location
                    os.makedirs(target_dir, exist_ok=True)
                    shutil.move(temp_path, target_path)
                    print(f"  ✅ File moved to library")
                    
                    # Step 9: Insert into DB
                    file_size = os.path.getsize(target_path)
                    
                    cursor.execute("""
                        INSERT INTO photos (
                            original_filename,
                            current_path,
                            date_taken,
                            content_hash,
                            file_size,
                            file_type,
                            width,
                            height
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        file.filename,
                        relative_path,
                        date_taken,
                        content_hash,
                        file_size,
                        file_type,
                        width,
                        height
                    ))
                    
                    photo_id = cursor.lastrowid
                    result['photo_id'] = photo_id
                    print(f"  💾 Added to DB (ID: {photo_id})")
                    import_logger.info(f"Imported: {file.filename} -> {relative_path} (ID: {photo_id})")
                    
                    # Step 10: Thumbnail will be generated lazily on first view
                    # This keeps import fast and non-blocking (especially for videos)
                    print(f"  ✅ Import complete (thumbnail will generate on demand)")
                    
                    result['status'] = 'success'
                    result['message'] = 'Successfully imported'
                    result['photo_id'] = photo_id  # Track for optional background pre-generation
                    imported_count += 1
                    
                except Exception as e:
                    print(f"  ❌ Error: {e}")
                    error_logger.error(f"Import failed for {file.filename}: {e}")
                    result['status'] = 'error'
                    result['message'] = str(e)
                    error_count += 1
                    
                    # Clean up temp file if it exists
                    if temp_path and os.path.exists(temp_path):
                        os.remove(temp_path)
                
                results.append(result)
                
                # Send progress event after each file
                yield f"event: progress\ndata: {json.dumps({'file_index': file_index, 'total': total_files, 'filename': file.filename, 'status': result['status'], 'imported': imported_count, 'duplicates': duplicate_count, 'errors': error_count})}\n\n"
            
            # Commit all changes
            conn.commit()
            conn.close()
            
            print(f"\n✅ Import complete:")
            print(f"   Imported: {imported_count}")
            print(f"   Duplicates: {duplicate_count}")
            print(f"   Errors: {error_count}\n")
            
            import_logger.info(f"Import session complete: {imported_count} imported, {duplicate_count} duplicates, {error_count} errors")
            
            # Send completion event
            yield f"event: complete\ndata: {json.dumps({'backup_path': os.path.basename(backup_path), 'total': total_files, 'imported': imported_count, 'duplicates': duplicate_count, 'errors': error_count, 'results': results})}\n\n"
            
            # Start background thumbnail pre-generation for imported photos
            imported_photo_ids = [r['photo_id'] for r in results if r['status'] == 'success' and 'photo_id' in r]
            if imported_photo_ids:
                print(f"🔄 Starting background thumbnail generation for {len(imported_photo_ids)} photos...")
                import_logger.info(f"Background thumbnail generation started for {len(imported_photo_ids)} photos")
                start_background_thumbnail_generation(imported_photo_ids)
            
        except Exception as e:
            print(f"❌ Import error: {e}")
            error_logger.error(f"Import session failed: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')


def start_background_thumbnail_generation(photo_ids):
    """
    Start background thread to pre-generate thumbnails for recently imported photos.
    This runs AFTER import completes, so it doesn't block the import process.
    """
    import threading
    
    def worker():
        for photo_id in photo_ids:
            try:
                # Fetch photo info
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT current_path, file_type FROM photos WHERE id = ?", (photo_id,))
                row = cursor.fetchone()
                conn.close()
                
                if not row:
                    continue
                
                # Generate thumbnail (will be cached)
                full_path = os.path.join(LIBRARY_PATH, row['current_path'])
                if os.path.exists(full_path):
                    # Trigger the lazy generation by calling the function directly
                    # The thumbnail endpoint would do this on first request anyway
                    generate_thumbnail_for_file(full_path, photo_id, row['file_type'])
                    print(f"  🖼️  Background: Generated thumbnail for photo {photo_id}")
            except Exception as e:
                # Don't let thumbnail failures crash the background thread
                error_logger.warning(f"Background thumbnail generation failed for photo {photo_id}: {e}")
                continue
    
    # Start daemon thread (won't prevent app shutdown)
    thread = threading.Thread(target=worker, daemon=True, name="ThumbnailGenerator")
    thread.start()



if __name__ == '__main__':
    print("\n🖼️  Photo Viewer Starting...")
    print(f"📁 Serving from: {STATIC_DIR}")
    print(f"💾 Database: {DB_PATH}")
    print(f"🌐 Open: http://localhost:5001\n")
    
    app.run(debug=True, port=5001, host='0.0.0.0')
