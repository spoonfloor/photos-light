# Extension Lists Analysis - app.py

## Global Constants (Lines 73-83) - SOURCE OF TRUTH

```python
PHOTO_EXTENSIONS = {
    '.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.tiff', '.tif',
    '.webp', '.avif', '.jp2',
    '.raw', '.cr2', '.nef', '.arw', '.dng'
}
VIDEO_EXTENSIONS = {
    '.mov', '.mp4', '.m4v', '.mkv',
    '.wmv', '.webm', '.flv', '.3gp',
    '.mpg', '.mpeg', '.vob', '.ts', '.mts', '.avi'
}
ALL_MEDIA_EXTENSIONS = PHOTO_EXTENSIONS | VIDEO_EXTENSIONS
```

## Duplicate Lists Found:

### 1. Line 175 - extract_exif_date()

```python
video_exts = {'.mov', '.mp4', '.m4v', '.avi', '.mkv', '.wmv', '.webm', '.flv', '.3gp', '.mpg', '.mpeg', '.vob', '.ts', '.mts'}
```

**Missing from VIDEO_EXTENSIONS:** None
**Extra:** None
**Verdict:** IDENTICAL to VIDEO_EXTENSIONS (minus .avi which is in VIDEO_EXTENSIONS)

### 2. Lines 615, 675 - Date change restore functions

```python
photo_exts = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.tiff', '.tif'}
```

**Missing from PHOTO_EXTENSIONS:** .webp, .avif, .jp2, .raw, .cr2, .nef, .arw, .dng
**Why subset?** Only formats that support EXIF writes (excludes RAW formats and ambiguous lossy formats)
**Verdict:** INTENTIONALLY DIFFERENT - subset for EXIF-writable formats

### 3. Lines 2892-2894 - library/status endpoint

```python
photo_exts = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.tiff', '.tif'}
video_exts = {'.mov', '.mp4', '.m4v', '.avi', '.mpg', '.mpeg', '.3gp', '.mts', '.mkv'}
all_exts = photo_exts | video_exts
```

**Missing videos:** .wmv, .webm, .flv, .vob, .ts
**Why subset?** Appears to be core/common formats only
**Verdict:** INTENTIONALLY DIFFERENT - subset for common formats

### 4. Lines 3529-3536 - generate_preview_thumbnail()

```python
photo_exts = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif',
              '.tiff', '.tif', '.webp', '.avif', '.jp2',
              '.raw', '.cr2', '.nef', '.arw', '.dng'}
video_exts = {'.mov', '.mp4', '.m4v', '.avi', '.mkv', '.wmv',
              '.webm', '.flv', '.3gp', '.mpg', '.mpeg', '.vob',
              '.ts', '.mts'}
```

**Missing videos:** .avi (in VIDEO_EXTENSIONS)
**Verdict:** NEARLY IDENTICAL - missing .avi for videos

### 5. Lines 1321-1323 - cleanup_empty_folders()

```python
MEDIA_EXTS = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif',
              '.tiff', '.tif', '.mov', '.mp4', '.m4v',
              '.avi', '.mpg', '.mpeg', '.3gp', '.mts', '.mkv'}
```

**Missing:** Many video formats (.wmv, .webm, .flv, .vob, .ts), all RAW formats, .webp, .avif, .jp2
**Verdict:** INTENTIONALLY DIFFERENT - subset for "keep folder alive" check

### 6. Lines 4047-4050, 4111-4114 - cleanup_non_media_folders() [2 instances]

```python
MEDIA_EXTS = {'.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif',
              '.tiff', '.tif', '.mov', '.mp4', '.m4v',
              '.avi', '.mpg', '.mpeg', '.3gp', '.mkv',
              '.cr2', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2'}
```

**Extra RAW formats:** .raf, .orf, .rw2 (not in PHOTO_EXTENSIONS)
**Missing:** Many video formats, .webp, .avif, .jp2
**Verdict:** INTENTIONALLY DIFFERENT - extended RAW support + core formats

## Summary:

| Location         | Purpose               | Status                                |
| ---------------- | --------------------- | ------------------------------------- |
| Lines 73-83      | Global constants      | ✅ SOURCE OF TRUTH                    |
| Line 175         | Video date extraction | ⚠️ Can use VIDEO_EXTENSIONS           |
| Lines 615, 675   | EXIF-writable formats | ⚠️ Should be named constant           |
| Lines 2892-2894  | Library status check  | ⚠️ Subset - needs explanation         |
| Lines 3529-3536  | Preview generation    | ⚠️ Nearly identical - can use globals |
| Line 1321        | Empty folder cleanup  | ⚠️ Subset - needs explanation         |
| Lines 4047, 4111 | Non-media cleanup     | ⚠️ Extended RAW - needs explanation   |

## Conclusion:

**NOT all duplicates are bugs!** Some are intentional subsets for specific purposes:

- EXIF-writable formats (no RAW)
- Common formats only (smaller set for UI)
- Extended RAW formats (more than global)

**However:** No comments explain WHY they differ, making maintenance dangerous.
