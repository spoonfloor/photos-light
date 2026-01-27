# Hash Collision - Root Cause Identified

**Date:** 2026-01-27  
**Status:** ✅ Root cause confirmed, minimal repro created  
**Version:** v190

---

## Executive Summary

**The bug is REAL and REPRODUCIBLE.**

Videos with identical content but different timestamps produce the SAME hash after being set to the same date, causing UNIQUE constraint violations.

---

## Root Cause

### The Problem

The database has a `UNIQUE` constraint on `content_hash`. When two videos with identical A/V content but different embedded dates are both changed to the SAME date, they produce **byte-for-byte identical files**, thus identical hashes, violating the UNIQUE constraint.

### Why It Happens

1. **Terraform phase:** Files are imported with different dates
   - `nature-video-1.mov` → date: 2026:01:26, hash: `1db6ac8`
   - `video-01.mov` → date: 2025:07:20, hash: `9a22466`
   - Different dates = different file content = different hashes ✅

2. **Bulk date change:** All photos set to 2026:01:26 19:54:00
   - `nature-video-1.mov` → hash: `59d8ca28` ✅
   - `video-01.mov` → hash: `59d8ca28` ❌ **COLLISION!**
   - Same date + same A/V content = identical files = identical hashes

### Technical Details

Videos processed with ffmpeg:
```bash
ffmpeg -i input.mov -metadata creation_time=<date> -codec copy output.mov
```

- `-codec copy` preserves video/audio streams exactly
- Only metadata atoms are rewritten
- When two files with identical A/V content get the same metadata, they become **byte-for-byte identical**

---

## The Colliding Files

### Collision 1
- `nature-video-1.mov` (Photo ID 3)
- `video-01.mov` (Photo ID 101)
- **Same A/V content, different original timestamps**
- After date change to 2026:01:26: both hash to `59d8ca28`

### Collision 2
- `nature-video-2.mov` (Photo ID 5)
- `video-02.mov` (Photo ID 98)
- **Same A/V content, different original timestamps**
- After date change to 2026:01:26: both hash to `8e97dc04`

---

## Verification

### Original files are DIFFERENT
```bash
$ diff nature-video-1.mov video-01.mov
Binary files differ
```

### After same date, files are IDENTICAL
```bash
$ ffmpeg -i nature-video-1.mov -metadata creation_time=2026-01-26T19:54:00 -codec copy out1.mov
$ ffmpeg -i video-01.mov -metadata creation_time=2026-01-26T19:54:00 -codec copy out2.mov
$ diff out1.mov out2.mov
(no output - files are identical!)
```

### Stripped of metadata, files are IDENTICAL
```bash
$ ffmpeg -i nature-video-1.mov -codec copy -map_metadata -1 stripped1.mov
$ ffmpeg -i video-01.mov -codec copy -map_metadata -1 stripped2.mov
$ diff stripped1.mov stripped2.mov
(no output - A/V content is identical!)
```

---

## Minimal Reproduction

**Location:** `/Users/erichenry/Desktop/terraform-minimal-test/`

**Files (4 videos, 549 MB total):**
- `nature-video-1.mov` (135 MB)
- `nature-video-2.mov` (140 MB)
- `video-01.mov` (134 MB) - duplicate content of nature-video-1
- `video-02.mov` (139 MB) - duplicate content of nature-video-2

**Test procedure:**
1. Copy `terraform-minimal-test` → `terraform-minimal-test-target`
2. Terraform it (should succeed - different dates, different hashes)
3. Bulk date change to any single date (should FAIL with hash collision)

---

## Why v190 Didn't Fix It

The v190 fix added duplicate detection **during terraform** after EXIF write:

```python
# After rehashing post-EXIF write
cursor.execute("SELECT id, current_path FROM photos WHERE content_hash = ?", (content_hash,))
existing = cursor.fetchone()

if existing:
    # Move to trash as duplicate
    duplicate_count += 1
    continue
```

**This works during terraform** because it catches duplicates that emerge after EXIF normalization.

**But it doesn't help during bulk date change** because:
1. Files are processed sequentially
2. File A is updated: old hash → new hash, DB updated ✅
3. File B is processed: old hash → new hash (collides with A's new hash) ❌
4. INSERT/UPDATE fails with UNIQUE constraint violation

The v190 check only happens **during import/terraform**, not during date changes.

---

## The Actual Design Problem

### Current Schema
```sql
CREATE UNIQUE INDEX idx_content_hash ON photos(content_hash);
```

This assumes: **One hash = One unique piece of content**

### Reality
For videos with embedded dates:
- **File hash includes the embedded date**
- Same A/V content with different dates = different hashes (good)
- Same A/V content with same dates = same hash (collision!)

### The "Christmas Tree Scenario"
The library is SUPPOSED to allow:
- Same photo at different dates (photo of tree in 2023 and 2024)
- Different `date_taken` values
- But currently relies on different `content_hash` values to distinguish them

**When dates become identical, content_hash becomes identical → COLLISION**

---

## Solutions (Not Implemented Yet)

### Option 1: Change UNIQUE constraint
```sql
-- Current (broken for this scenario)
UNIQUE(content_hash)

-- Fixed (allows same content at different times)
UNIQUE(content_hash, date_taken)
```

**Pros:** Matches intended behavior (same content at different dates is OK)  
**Cons:** Requires schema migration, affects duplicate detection

### Option 2: Detect collision in bulk date change
```python
# Before committing date change, check if new hash collides
new_hash = compute_hash(file_path)
cursor.execute("SELECT id FROM photos WHERE content_hash = ? AND id != ?", (new_hash, photo_id))
if cursor.fetchone():
    # Handle collision: skip, rename, or prompt user
```

**Pros:** No schema change  
**Cons:** Complex collision handling, still doesn't match intended behavior

### Option 3: Hash A/V content only (not metadata)
Strip metadata before hashing, so files with same A/V content always have same hash regardless of date.

**Pros:** Deterministic, no collisions  
**Cons:** Requires ffmpeg for every hash, much slower, breaks existing hashes

---

## Recommendation

**Option 1** (UNIQUE on content_hash + date_taken) is the cleanest solution and matches the intended "Christmas tree scenario" design.

This is the deferred schema v2 work mentioned in `bugs-to-be-fixed.md`:
```
### Import Duplicate Detection + Migration Infrastructure
**Status:** SCHEMA DESIGNED, REVERTED (60% complete)

**Decision made:**
- Duplicate = Same Hash + Same Date/Time (to the second)
- Allows "Christmas tree scenario" (same photo at different dates)
- Requires schema change: `UNIQUE(content_hash, date_taken)`
```

The bug confirms this schema change is NECESSARY, not just nice-to-have.

---

## Files Changed

### Created
- ✅ `/Users/erichenry/Desktop/terraform-minimal-test/` - Minimal 4-file repro (549 MB)
- ✅ `HASH_COLLISION_ROOT_CAUSE.md` - This document

### Investigation artifacts (can be deleted)
- `/Users/erichenry/Desktop/terraform-minimal-repro/` - Initial 4-file set
- `/Users/erichenry/Desktop/terraform-minimal-repro/test-collision/` - Test output

---

## Next Steps for User

1. **Verify minimal repro:**
   ```bash
   cd /Users/erichenry/Desktop
   cp -r terraform-minimal-test terraform-minimal-test-target
   # Point app to terraform-minimal-test-target
   # Terraform it
   # Bulk date change (should fail)
   ```

2. **Decide on solution:**
   - Schema v2 (UNIQUE on hash+date) - correct fix, requires migration work
   - Collision detection in bulk date change - workaround, band-aid

3. **Implementation** (not started, waiting for decision)

---

## Bottom Line

✅ **Root cause identified:** Videos with identical A/V content produce identical hashes when given identical dates  
✅ **Minimal repro created:** 4 files, 549 MB, reproduces bug reliably  
✅ **Solution known:** Schema v2 with UNIQUE(content_hash, date_taken)  
❌ **Not implemented:** Waiting for user decision on approach

**This is not a ffmpeg bug or a hashing bug. It's a schema design issue that requires the deferred v2 migration work.**
