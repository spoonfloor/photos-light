# Hash Collision Investigation - Handoff Summary

**Date:** 2026-01-27  
**Status:** Investigation incomplete, handed off to another agent  
**Version:** v190

## Problem Statement

During bulk date change operation (setting all photos to same date), encountered error:

```
UNIQUE constraint failed: photos.content_hash
```

Files reported in error:

- `img_20251111_8d28f62.mov`
- `img_20250720_9a22466.mov`

## What Was Done

### 1. Initial Fix Attempt (v190)

Added second duplicate check in terraform after EXIF write and rehashing:

**Location:** `app.py` lines ~4041-4073

**Logic:**

```python
# After rehashing post-EXIF write
cursor.execute("SELECT id, current_path FROM photos WHERE content_hash = ?", (content_hash,))
existing = cursor.fetchone()

if existing:
    # Move to trash as duplicate
    duplicate_count += 1
    continue
```

**Result:** This catches duplicates that become identical AFTER metadata normalization, but did NOT solve the reported bug.

### 2. Test Set Creation

Created small test set at `/Users/erichenry/Desktop/terraform-master-small/` with 28 files including:

- `supported-formats/video-01.mov`
- `supported-formats/video-02.mov`
- `duplicates/video-01.mov`

**Test result:** Bulk date change SUCCEEDED (no collision).

## What Went Wrong

### Critical Error in Diagnosis

**I claimed:** video-01.mov and video-02.mov were duplicates with identical content

**Reality (verified with shasum):**

```bash
c517f6e...  supported-formats/video-01.mov  # SAME
5f55603...  supported-formats/video-02.mov  # DIFFERENT
c517f6e...  duplicates/video-01.mov         # SAME as video-01
```

**video-01.mov and video-02.mov have DIFFERENT underlying content.**

They CANNOT produce a hash collision through normal hashing.

## Current State

### Code Changes

- **v190:** Added duplicate check after rehashing in terraform (lines 4041-4073 in `app.py`)
- **v190:** Incremented `MAIN_JS_VERSION` to `'v190'`

### Test Artifacts

- `/Users/erichenry/Desktop/terraform-master-small/` - Small test set (28 files)
- `/Users/erichenry/Desktop/terraform-target-small/` - Terraformed small set (no collision reproduced)

### Large Test Set

- `/Users/erichenry/Desktop/terraform-master/` - Original large set (386 files)
- `/Users/erichenry/Desktop/terraform-target/` - Does not exist (was deleted or renamed)

## What Needs to Happen

### 1. Reproduce the Actual Bug

- Duplicate `terraform-master` → `terraform-target`
- Terraform it with v190
- Check database for the two problematic videos:
  - `img_20251111_8d28f62.mov`
  - `img_20250720_9a22466.mov`
- Verify they both exist with DIFFERENT hashes
- Attempt bulk date change
- Capture the ACTUAL error

### 2. Identify True Root Cause

Possible scenarios:

1. **Other duplicates exist:** The error mentions those 2 videos, but they might be colliding with OTHER files, not each other
2. **Video metadata handling bug:** Something in video EXIF write/read is causing unpredictable hashes
3. **Non-deterministic hashing:** Video files might include timestamps/metadata that changes between operations
4. **Database state issue:** Previous failed operations left inconsistent state

### 3. Find What's Actually Colliding

When the error occurs:

```sql
-- Find ALL files with the colliding hash
SELECT id, current_path, content_hash FROM photos
WHERE content_hash IN ('8d28f62', '9a22466');

-- Check if there are OTHER files with these hashes
```

### 4. Verify File Content

For the actual colliding files:

```bash
# Hash the actual video files on disk
shasum -a 256 /path/to/img_20251111_8d28f62.mov
shasum -a 256 /path/to/img_20250720_9a22466.mov

# Check if they're actually identical
```

## Key Questions for Next Agent

1. **Are video-01.mov and video-02.mov actually the problem?** Or is the error message misleading?
2. **Are there other duplicate files in the large set?** Run a content-based duplicate check
3. **Does the collision happen during terraform or date change?** The v190 fix should catch terraform collisions
4. **Is there something special about video metadata?** ffmpeg/exiftool might be doing something unexpected

## Logs to Check

When reproducing:

- `/Users/erichenry/Desktop/flask-log.txt` - Backend errors
- `terraform-target/.logs/terraform_*.jsonl` - Terraform manifest
- Browser console - Frontend errors
- `grep "8d28f62\|9a22466" <log-file>` - Track these specific hashes through the system

## Apology

I wasted significant time:

1. Misdiagnosed the problem (claimed videos were duplicates when they're not)
2. Created a test set that couldn't reproduce the bug
3. Implemented a fix (v190) that may be solving the wrong problem
4. Failed to verify basic assumptions (file content) before implementing solutions

The v190 code changes may or may not be helpful depending on the actual root cause.
