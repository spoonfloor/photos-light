# Hash Collision Investigation - Complete Findings

**Date:** 2026-01-27  
**Investigator:** Agent 2 (following Agent 1's incomplete investigation)  
**Status:** Root cause identified, minimal repro created, fix proposed  
**Version:** v190

---

## Executive Summary

**Bug confirmed:** Videos with identical A/V content but different timestamps produce the same hash when given the same date, causing `UNIQUE constraint failed: photos.content_hash` errors during bulk date changes.

**Root cause:** Two pairs of videos in the test library have identical video/audio content. When all photos are set to the same date via bulk date change, these pairs collide.

**Minimal repro:** Created 4-file test set (549 MB) that reliably reproduces the bug.

**Proposed fix:** Add duplicate detection during bulk date change (same logic already exists in terraform v190).

---

## What Agent 1 Got Wrong

Agent 1's investigation (`HASH_COLLISION_INVESTIGATION.md`) made several critical errors:

1. **Wrong collision pairs:** Claimed `video-01.mov` and `video-02.mov` were colliding with EACH OTHER
   - **Reality:** They collide with `nature-video-1.mov` and `nature-video-2.mov` respectively

2. **Wrong test set:** Created 28-file set with video-01 and video-02, but **missing** nature-video-1 and nature-video-2
   - Result: Bug couldn't reproduce, agent concluded the bug didn't exist

3. **Incomplete diagnosis:** Never identified there were 4 files involved in 2 collision pairs

4. **v190 implementation:** Added duplicate check in terraform, but that doesn't help bulk date changes

---

## Root Cause: Detailed

### The Collision Pairs

**Pair 1:**
- `nature-video-1.mov` - original hash: `5122ef6`, embedded date: 2026:01:26 19:54:14
- `video-01.mov` - original hash: `c517f6e`, embedded date: 2025:07:20 21:30:00
- **These files have IDENTICAL A/V content, only metadata differs**

**Pair 2:**
- `nature-video-2.mov` - original hash: `c2aa4cc`, embedded date: 2026:01:26 19:54:09
- `video-02.mov` - original hash: `5f55603`, embedded date: 2025:11:11 00:45:00
- **These files have IDENTICAL A/V content, only metadata differs**

### Verification

```bash
# Strip metadata from both files
ffmpeg -i nature-video-1.mov -codec copy -map_metadata -1 stripped1.mov
ffmpeg -i video-01.mov -codec copy -map_metadata -1 stripped2.mov

# Compare
diff stripped1.mov stripped2.mov
# Result: IDENTICAL (no output)
```

### Why It Happens

1. **During terraform:** Each file gets its original embedded date written via ffmpeg
   - Different dates → different file content → different hashes ✅

2. **During bulk date change:** All files get the SAME date (2026:01:26 19:54:00)
   - `nature-video-1.mov` with date 2026:01:26 → hash: `59d8ca28`
   - `video-01.mov` with date 2026:01:26 → hash: `59d8ca28` ❌ COLLISION
   - `nature-video-2.mov` with date 2026:01:26 → hash: `8e97dc04`
   - `video-02.mov` with date 2026:01:26 → hash: `8e97dc04` ❌ COLLISION

### Technical Details

ffmpeg uses `-codec copy` which:
- Preserves video/audio streams byte-for-byte
- Only rewrites metadata atoms in MOV container
- Result: Files with identical A/V content + same metadata = byte-for-byte identical files

---

## Minimal Reproduction

### Test Set Created

**Location:** `/Users/erichenry/Desktop/terraform-minimal-test/`

**Files (4 videos, 549 MB total):**
- `nature-video-1.mov` (135 MB) - SHA256: `5122ef6...`
- `nature-video-2.mov` (140 MB) - SHA256: `c2aa4cc...`
- `video-01.mov` (134 MB) - SHA256: `c517f6e...` (duplicate content of nature-video-1)
- `video-02.mov` (139 MB) - SHA256: `5f55603...` (duplicate content of nature-video-2)

### Test Procedure

1. Duplicate `terraform-minimal-test` → `terraform-minimal-target`
2. Terraform it (should PASS)
3. Bulk date change all photos to same date (should FAIL)

### Test Results

**Terraform (lines 213-276 in logs-terraform.txt):**
- ✅ PASSED
- All 4 files processed with different hashes
- No errors

**Bulk Date Change (lines 288-310 in logs-date-change.txt):**
- ❌ FAILED
- Processing order:
  1. Photo ID 3 (`nature-video-1`): `1db6ac8` → `59d8ca28` ✅
  2. Photo ID 4 (`nature-video-2`): `8151ba3` → `8e97dc04` ✅
  3. Photo ID 1 (`video-02`): `8d28f62` → `8e97dc04` ❌ COLLISION
  4. Photo ID 2 (`video-01`): `9a22466` → `59d8ca28` ❌ COLLISION
- Error: `UNIQUE constraint failed: photos.content_hash`
- Rollback executed

---

## Current Code: v190 Terraform Duplicate Detection

Location: `app.py` lines ~4041-4073

```python
# After rehashing post-EXIF write in terraform
cursor.execute("SELECT id, current_path FROM photos WHERE content_hash = ?", (content_hash,))
existing = cursor.fetchone()

if existing:
    # Move to trash as duplicate
    duplicate_count += 1
    # ... move file to trash ...
    continue
```

**This works in terraform but NOT in bulk date change.**

---

## Proposed Fix

### User's Analysis (Correct)

> "photo of a cat + oct1990 = abc
> same pixels + oct 1992 = xyz
> redate all to oct1993
> both files now def-> collision
> 
> the fix:
> during redate-> 
> 1/ redate abc; becomes def; def already exists? nope. great, you are now def; no collision
> 2/ redate xyz; becomes def; def already exists? yes! it's a dupe. move to trash"

### Implementation

Add duplicate detection to bulk date change (same logic as terraform):

**Location:** `app.py` in the `bulk_update_date/execute` endpoint, after rehashing

```python
# After writing EXIF and rehashing
new_hash = compute_hash(file_path)

# Check if this new hash already exists (and it's not THIS photo)
cursor.execute("SELECT id, current_path FROM photos WHERE content_hash = ? AND id != ?", 
               (new_hash, photo_id))
existing = cursor.fetchone()

if existing:
    # Hash collision - this is now a duplicate
    # Move to trash
    trash_path = move_to_trash(file_path)
    
    # Delete from database
    cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
    
    duplicate_count += 1
    yield f"event: duplicate\ndata: {json.dumps({'photo_id': photo_id, 'filename': filename})}\n\n"
    continue

# No collision - update the hash and path
cursor.execute("UPDATE photos SET content_hash = ?, current_path = ? WHERE id = ?", 
               (new_hash, new_path, photo_id))
```

### Why This Works

1. Files are processed sequentially
2. First file with new hash updates successfully ✅
3. Second file with same new hash detects collision, moves to trash ✅
4. No UNIQUE constraint violation

---

## What I Got Wrong

### Mistake 1: Overcomplicated the fix

I initially suggested changing the schema to `UNIQUE(content_hash, date_taken)` and talked about "Christmas tree scenarios."

**User's response:** "that makes no sense"

**They were right.** The fix is much simpler - just detect duplicates during date change, same as terraform.

### Mistake 2: Confused the use case

The schema v2 work (`UNIQUE(content_hash, date_taken)`) is for a DIFFERENT feature - allowing import of true duplicates with different dates.

This bug doesn't need schema changes - it just needs collision detection during date changes.

### What I Got Right

- Root cause identification (identical A/V content becomes identical after same date)
- Minimal repro creation (4 files)
- Log analysis showing the exact collision pattern
- Understanding that v190 already has the right logic, just in wrong place

---

## Files for Review

### Evidence
- `/Users/erichenry/Desktop/logs-terraform.txt` - Terraform succeeded with 4 files
- `/Users/erichenry/Desktop/logs-date-change.txt` - Date change failed with collision
- `/Users/erichenry/Desktop/terraform-minimal-test/` - Minimal repro (4 files, 549 MB)

### Documentation
- `HASH_COLLISION_INVESTIGATION.md` - Agent 1's incomplete investigation
- `HASH_COLLISION_ROOT_CAUSE.md` - My investigation (includes wrong fix suggestion)
- `HASH_COLLISION_FINDINGS.md` - This document (corrected findings)

### Code
- `app.py` - Current implementation (v190 has terraform fix, needs date change fix)
- `static/js/main.js` - Frontend (v190)

---

## Questions for Second Opinion Agent

1. **Is the minimal repro valid?** (4 files that reliably trigger the bug)

2. **Is the proposed fix correct?** (Add duplicate detection during date change)

3. **Where exactly should the fix go?** (Which function/line in app.py?)

4. **Should duplicates during date change be moved to trash or handled differently?**

5. **Are there edge cases I'm missing?**

6. **Should the user be notified when date changes create duplicates?**

---

## Testing Checklist (After Fix)

Using minimal repro at `/Users/erichenry/Desktop/terraform-minimal-test/`:

1. ✅ Terraform 4 files (should pass)
2. ✅ Bulk date change all to same date (should now succeed with 2 duplicates moved to trash)
3. ✅ Verify 2 photos remain in library
4. ✅ Verify 2 photos in `.trash/duplicates/`
5. ✅ No database errors
6. ✅ No orphaned files

Then test with full set at `/Users/erichenry/Desktop/terraform-master/` (386 files).

---

## Bottom Line

**Bug:** Real and reproducible  
**Cause:** Identical video content produces identical hashes with same date  
**Minimal repro:** Created (4 files)  
**Fix:** Add duplicate detection to bulk date change (user's analysis is correct)  
**My performance:** Got root cause right, proposed wrong fix initially, corrected by user  

**Recommendation:** Have second opinion agent review fix approach and implement.
