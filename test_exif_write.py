#!/usr/bin/env python3
"""
Test EXIF/Metadata Writing
Proof-of-concept for date editing with file modification
"""

import subprocess
import sys
import os
from datetime import datetime


def write_photo_exif(file_path, new_date):
    """
    Write EXIF date to photo using exiftool
    
    Args:
        file_path: Path to photo file
        new_date: Date string in format "YYYY:MM:DD HH:MM:SS"
    
    Returns:
        (success: bool, message: str)
    """
    print(f"\n📸 Writing EXIF to photo: {os.path.basename(file_path)}")
    print(f"   New date: {new_date}")
    
    try:
        # exiftool command
        cmd = [
            'exiftool',
            f'-DateTimeOriginal={new_date}',
            f'-CreateDate={new_date}',
            f'-ModifyDate={new_date}',
            '-overwrite_original',  # Don't create backup files
            '-P',  # Preserve file modification time
            file_path
        ]
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode != 0:
            return False, f"exiftool failed: {result.stderr}"
        
        print(f"   ✅ exiftool succeeded")
        return True, "Success"
        
    except subprocess.TimeoutExpired:
        return False, "exiftool timeout after 30s"
    except FileNotFoundError:
        return False, "exiftool not found (install: brew install exiftool)"
    except Exception as e:
        return False, f"Unexpected error: {str(e)}"


def write_video_metadata(file_path, new_date):
    """
    Write metadata to video using ffmpeg
    
    Args:
        file_path: Path to video file
        new_date: Date string in format "YYYY:MM:DD HH:MM:SS"
    
    Returns:
        (success: bool, message: str)
    """
    print(f"\n🎥 Writing metadata to video: {os.path.basename(file_path)}")
    print(f"   New date: {new_date}")
    
    try:
        # Convert to ISO 8601 format for QuickTime
        # "2025:12:25 14:30:00" -> "2025-12-25T14:30:00"
        iso_date = new_date.replace(':', '-', 2).replace(' ', 'T')
        
        # Preserve original extension for ffmpeg format detection
        base, ext = os.path.splitext(file_path)
        temp_output = f"{base}_temp{ext}"
        
        cmd = [
            'ffmpeg',
            '-i', file_path,
            '-metadata', f'creation_time={iso_date}',
            '-codec', 'copy',  # Don't re-encode (fast)
            '-y',  # Overwrite without asking
            temp_output
        ]
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60
        )
        
        if result.returncode != 0:
            # Clean up temp file if exists
            if os.path.exists(temp_output):
                os.remove(temp_output)
            return False, f"ffmpeg failed: {result.stderr}"
        
        # Replace original with temp
        os.replace(temp_output, file_path)
        
        print(f"   ✅ ffmpeg succeeded")
        return True, "Success"
        
    except subprocess.TimeoutExpired:
        if os.path.exists(temp_output):
            os.remove(temp_output)
        return False, "ffmpeg timeout after 60s"
    except FileNotFoundError:
        return False, "ffmpeg not found (install: brew install ffmpeg)"
    except Exception as e:
        if os.path.exists(temp_output):
            os.remove(temp_output)
        return False, f"Unexpected error: {str(e)}"


def read_exif_date(file_path):
    """
    Read EXIF date from file
    
    Returns:
        (success: bool, date_string: str or None)
    """
    try:
        result = subprocess.run(
            ['exiftool', '-DateTimeOriginal', '-s3', '-d', '%Y:%m:%d %H:%M:%S', file_path],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if result.returncode == 0 and result.stdout.strip():
            return True, result.stdout.strip()
        else:
            return False, None
            
    except Exception as e:
        return False, None


def get_file_type(file_path):
    """
    Determine if file is photo or video
    
    Returns:
        'photo', 'video', or None
    """
    ext = os.path.splitext(file_path)[1].lower()
    
    photo_exts = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.bmp', '.tiff', '.tif'}
    video_exts = {'.mov', '.mp4', '.m4v', '.avi', '.mpg', '.mpeg', '.3gp', '.mts', '.mkv'}
    
    if ext in photo_exts:
        return 'photo'
    elif ext in video_exts:
        return 'video'
    else:
        return None


def test_exif_write(file_path, new_date):
    """
    Test writing EXIF/metadata to a file
    
    Args:
        file_path: Path to file
        new_date: Date string in format "YYYY:MM:DD HH:MM:SS"
    """
    print("=" * 70)
    print("EXIF/Metadata Write Test")
    print("=" * 70)
    
    # Check file exists
    if not os.path.exists(file_path):
        print(f"❌ Error: File not found: {file_path}")
        return False
    
    # Read original date
    print(f"\n📄 File: {file_path}")
    success, original_date = read_exif_date(file_path)
    if success:
        print(f"📅 Original date: {original_date}")
    else:
        print(f"⚠️  Could not read original date")
    
    # Determine file type
    file_type = get_file_type(file_path)
    if not file_type:
        print(f"❌ Error: Unsupported file type")
        return False
    
    print(f"🏷️  File type: {file_type}")
    
    # Write new date
    if file_type == 'photo':
        success, message = write_photo_exif(file_path, new_date)
    else:
        success, message = write_video_metadata(file_path, new_date)
    
    if not success:
        print(f"\n❌ Write failed: {message}")
        return False
    
    # Verify by reading back
    print(f"\n🔍 Verifying write...")
    success, read_date = read_exif_date(file_path)
    
    if success and read_date == new_date:
        print(f"✅ Verified: {read_date}")
        print(f"\n🎉 Test PASSED")
        return True
    elif success:
        print(f"⚠️  Warning: Read date doesn't match")
        print(f"   Expected: {new_date}")
        print(f"   Got:      {read_date}")
        return False
    else:
        print(f"⚠️  Could not verify (read failed)")
        return False


def main():
    """Main entry point"""
    if len(sys.argv) != 3:
        print("Usage: python test_exif_write.py <file_path> <new_date>")
        print("")
        print("Example:")
        print('  python test_exif_write.py photo.jpg "2025:12:25 14:30:00"')
        print('  python test_exif_write.py video.mov "2024:03:15 10:00:00"')
        print("")
        print("Date format: YYYY:MM:DD HH:MM:SS")
        sys.exit(1)
    
    file_path = sys.argv[1]
    new_date = sys.argv[2]
    
    # Validate date format
    try:
        datetime.strptime(new_date, '%Y:%m:%d %H:%M:%S')
    except ValueError:
        print(f"❌ Error: Invalid date format: {new_date}")
        print(f"   Expected: YYYY:MM:DD HH:MM:SS")
        sys.exit(1)
    
    # Run test
    success = test_exif_write(file_path, new_date)
    
    print("\n" + "=" * 70)
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
