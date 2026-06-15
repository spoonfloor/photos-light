"""
File Operations - Shared utilities for photo metadata extraction

Provides centralized functions for:
- Hash computation (with optional caching)
- EXIF date extraction
- Image dimension extraction
- EXIF rating extraction (for favorites feature)

All functions handle errors gracefully and return None on failure.
"""

import os
import subprocess
import json
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
from library_cleanliness import VIDEO_MEDIA_EXTENSIONS
from media_dates import read_embedded_media_date

register_heif_opener()


def _dimensions_from_exiftool(file_path):
    """Read display dimensions via exiftool when Pillow cannot decode the file."""
    try:
        result = subprocess.run(
            [
                'exiftool',
                '-j',
                '-ImageWidth',
                '-ImageHeight',
                '-Orientation',
                file_path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None, None

        payload = json.loads(result.stdout)
        if not payload:
            return None, None

        data = payload[0]
        width = data.get('ImageWidth')
        height = data.get('ImageHeight')
        if width is None or height is None:
            return None, None

        width = int(width)
        height = int(height)
        orientation = data.get('Orientation')
        if orientation in (5, 6, 7, 8):
            width, height = height, width
        return width, height
    except Exception as e:
        print(f"⚠️  Error extracting dimensions via exiftool from {file_path}: {e}")
        return None, None


def extract_exif_date(file_path):
    """
    Extract raw embedded metadata date (photos via exiftool, videos via ffprobe).

    For resolved dates including basename and ingest fallbacks, use
    ``media_dates.read_media_date`` instead.
    """
    try:
        return read_embedded_media_date(file_path)
    except Exception as e:
        print(f"⚠️  Error extracting EXIF date from {file_path}: {e}")
        return None


def get_dimensions(file_path):
    """
    Get image dimensions (width, height) using PIL.
    
    Handles EXIF orientation - returns dimensions AFTER applying orientation.
    For videos, returns None (use ffprobe separately if needed).
    
    Args:
        file_path: Path to image file
    
    Returns:
        tuple: (width, height) or (None, None) on error
    """
    try:
        ext = os.path.splitext(file_path)[1].lower()

        if ext in VIDEO_MEDIA_EXTENSIONS:
            # Don't extract dimensions for videos here
            # (caller should use ffprobe if needed)
            return None, None
        
        with Image.open(file_path) as img:
            # Get dimensions AFTER applying EXIF orientation (matches display).
            img_oriented = ImageOps.exif_transpose(img)
            return img_oriented.size  # (width, height)
    
    except Exception:
        pass

    width, height = _dimensions_from_exiftool(file_path)
    if width and height:
        return width, height

    print(f"⚠️  Error extracting dimensions from {file_path}")
    return None, None


def extract_exif_rating(file_path):
    """
    Extract EXIF Rating tag (0-5 scale for favorites).
    
    Standard EXIF tags checked:
    - Rating (0-5)
    - RatingPercent (0-100, converted to 0-5)
    
    Args:
        file_path: Path to photo file
    
    Returns:
        int: Rating (0-5) or None if no rating set
        - None = no rating
        - 0 = explicitly unrated/rejected
        - 1-5 = star ratings (5 = favorite)
    """
    try:
        result = subprocess.run([
            'exiftool',
            '-Rating',
            '-RatingPercent',
            '-j',
            file_path
        ], capture_output=True, text=True, timeout=30)
        
        if result.returncode == 0:
            data = json.loads(result.stdout)[0]
            
            # Try Rating first (0-5 scale)
            rating = data.get('Rating')
            if rating is not None:
                rating = int(rating)
                if 0 <= rating <= 5:
                    return rating
            
            # Try RatingPercent (0-100 scale, convert to 0-5)
            rating_pct = data.get('RatingPercent')
            if rating_pct is not None:
                rating_pct = int(rating_pct)
                # Convert: 0-20% = 0, 21-40% = 1, 41-60% = 2, 61-80% = 3, 81-100% = 4-5
                if rating_pct == 0:
                    return 0
                elif rating_pct <= 20:
                    return 1
                elif rating_pct <= 40:
                    return 2
                elif rating_pct <= 60:
                    return 3
                elif rating_pct <= 80:
                    return 4
                else:
                    return 5
    
    except Exception as e:
        print(f"⚠️  Error extracting rating from {file_path}: {e}")
    
    return None


def write_exif_rating(file_path, rating):
    """
    Write EXIF Rating tag (0-5 scale).
    
    Sets both Rating and RatingPercent for maximum compatibility.
    
    Args:
        file_path: Path to photo file
        rating: Rating value (0-5)
            - 0 = unrated/rejected
            - 5 = favorite
    
    Returns:
        bool: True if successful, False otherwise
    """
    try:
        if not 0 <= rating <= 5:
            print(f"⚠️  Invalid rating: {rating} (must be 0-5)")
            return False
        
        # Convert rating to percentage
        rating_pct = rating * 20  # 0->0, 1->20, 2->40, 3->60, 4->80, 5->100
        
        result = subprocess.run([
            'exiftool',
            '-overwrite_original',
            f'-Rating={rating}',
            f'-RatingPercent={rating_pct}',
            file_path
        ], capture_output=True, text=True, timeout=30)
        
        return result.returncode == 0
    
    except Exception as e:
        print(f"❌ Error writing rating to {file_path}: {e}")
        return False


def strip_exif_rating(file_path):
    """
    Strip Rating and RatingPercent tags completely from EXIF.
    
    Used when un-starring a photo (cleaner than writing 0).
    Matches Photos.app behavior.
    
    Args:
        file_path: Path to photo file
    
    Returns:
        bool: True if successful, False otherwise
    """
    try:
        result = subprocess.run([
            'exiftool',
            '-overwrite_original',
            '-Rating=',
            '-RatingPercent=',
            file_path
        ], capture_output=True, text=True, timeout=30)
        
        return result.returncode == 0
    
    except Exception as e:
        print(f"❌ Error stripping rating from {file_path}: {e}")
        return False


def extract_metadata_batch(file_paths, include_dimensions=True, include_rating=True):
    """
    Extract EXIF dates, dimensions, and ratings in a single exiftool call.
    
    MUCH faster than individual calls (30-40% speedup for bulk operations).
    
    Args:
        file_paths: List of file paths
        include_dimensions: Extract width/height (default: True)
        include_rating: Extract rating (default: True)
    
    Returns:
        dict: {file_path: {'date': str, 'width': int, 'height': int, 'rating': int}}
    """
    try:
        if not file_paths:
            return {}
        
        # Build exiftool arguments
        args = ['exiftool', '-j']
        args.extend([
            '-DateTimeOriginal',
            '-CreateDate',
            '-ModifyDate'
        ])
        
        if include_dimensions:
            args.extend(['-ImageWidth', '-ImageHeight'])
        
        if include_rating:
            args.extend(['-Rating', '-RatingPercent'])
        
        args.extend(file_paths)
        
        result = subprocess.run(args, capture_output=True, text=True, timeout=60)
        
        if result.returncode != 0:
            return {}
        
        data_list = json.loads(result.stdout)
        
        # Parse results
        results = {}
        for data in data_list:
            file_path = data.get('SourceFile')
            if not file_path:
                continue
            
            # Extract date
            date_taken = data.get('DateTimeOriginal') or data.get('CreateDate') or data.get('ModifyDate')
            
            # Extract dimensions
            width = data.get('ImageWidth')
            height = data.get('ImageHeight')
            
            # Extract rating
            rating = data.get('Rating')
            if rating is None:
                rating_pct = data.get('RatingPercent')
                if rating_pct is not None:
                    rating_pct = int(rating_pct)
                    # Convert to 0-5 scale
                    rating = min(5, max(0, rating_pct // 20))
            else:
                rating = int(rating)
            
            results[file_path] = {
                'date': date_taken,
                'width': width,
                'height': height,
                'rating': rating
            }
        
        return results
    
    except Exception as e:
        print(f"❌ Error in batch metadata extraction: {e}")
        return {}


# Convenience function for backward compatibility
def compute_hash_legacy(file_path):
    """
    Compute SHA-256 hash without caching (legacy mode).
    
    For new code, use HashCache.get_hash() instead.
    
    Args:
        file_path: Path to file
    
    Returns:
        str: Full SHA-256 hash (64 chars)
    """
    import hashlib
    
    try:
        sha256_hash = hashlib.sha256()
        with open(file_path, "rb") as f:
            for byte_block in iter(lambda: f.read(1048576), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()
    except Exception as e:
        print(f"❌ Error hashing {file_path}: {e}")
        return None
