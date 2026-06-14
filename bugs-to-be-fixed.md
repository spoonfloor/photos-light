# Bugs To Be Fixed - Prioritized

Last updated: June 14, 2026

**Status:** 5 remaining bugs (+ 1 architecture item)

---

## 🔴 TIER 1: MEDIA DATE TRUTH — SINGLE RULEBOOK (Architecture)

**Priority:** 🔴 CRITICAL (high-order; blocks “truth in media”)  
**Estimated effort:** 1–2 days (shared module + wire all mutators + contract tests)  
**Status:** NOT STARTED

**Issue:** Date writes and reads are inconsistent across flows. The app can report success while only the DB/folders changed; embedded file metadata (especially video) is often untouched. Rebuild then “corrects” the grid back to whatever is still inside the file.

**Repro (example):** Import `img_19001127_….mov` → embedded `creation_time` is 2037 (not filename 1900) → manual date edit to 1900 → toast success but ffprobe still shows old date → rebuild shows wrong year again.

**Root causes:**

- **Writes:** Photos use exiftool + read-back verify; video date edit uses ffmpeg with **no verify** and failures are **swallowed** (DB/path still update). Import rejects failed video writes; date edit does not.
- **Reads:** Videos ignore `img_YYYYMMDD` filenames at ingest; `library_sync` (rebuild) is a **separate indexer**, not the normalization engine.
- **Drift:** Add, Convert, Clean, date edit, and rebuild do not all call one `read_media_date` / `write_and_verify_media_date` / `metadata_write_policy(ext)`.
- **UI:** Year picker may not refresh after date edit (`populateDatePicker` missing from post-edit sync).

**Flows that must share the rulebook:**

| Mutators (write + verify) | Read-only auditor (same read rules) | Separate jobs (no own date logic) |
|---------------------------|-------------------------------------|-----------------------------------|
| Add photos, Convert, Clean library, single/bulk/lightbox date edit, undo date edit | Rebuild database | Switch library, restore from trash |

**Do not allow:**

- Duplicate date/hash/path logic per flow
- Best-effort metadata writes on supported formats
- Success toasts without verified read-back
- Rebuild reading dates differently than ingest/edit wrote them

**Fix shape:**

1. One policy table (supported vs unsupported embedded dates per extension).
2. One `write_and_verify_media_date()` — fail closed; full rollback on failure.
3. One `read_media_date()` — used by ingest, clean, edit finalization, and rebuild (`library_sync` delegates here).
4. Video write: ffprobe read-back after ffmpeg; exiftool fallback for QuickTime if needed.
5. Wire all mutators through the shared API; remove swallow in `update_photo_date_with_files`.
6. Surface write failures in UI (no fake “Date updated”).
7. Contract tests: same fixture through add → edit → rebuild; ingest invariance for videos.

**Related docs:** `tech-docs/DATE_EDIT_BUG_SUMMARY.md`, `tech-docs/ARCHITECTURE_FRAGMENTATION_AUDIT.md`, workspace rule high-before-low fix ethic.

---

## 🔴 TIER 1: GRID HYDRATION — FIXED 2026-06-13

Catalog reset tier shipped. Re-smoke passed 2026-06-13 (Clean grid, bulk date, empty startup).

See `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` § Catalog reset and `tech-docs/GRID_HYDRATION_BUGS.md`.

---

## 🟡 TIER 2: POLISH - SHOULD FIX (Moderate Impact, Quick Wins)

### Terraforming - Cancel/Go Back Causes Stalled State

**Priority:** 🔴 CRITICAL  
**Estimated effort:** 1-2 hours  
**Status:** FIXED 2026-06-13

**Issue:** 'Go back' action in terraforming leads to a stalled state (loading library)

- During terraform preview, user clicks "go back" or cancels
- App shows "Loading library..." indefinitely
- Console shows "User cancelled at preview" and "Terraform flow failed or was cancelled"
- App enters limbo state and can't recover to show library
- User is stuck with no way to proceed

**Fix:** `recoverLibraryUiAfterFlowCancel()` on convert cancel — clears transition/handoff overlays and reloads grid or empty state.
- Test all cancel/back paths in terraform flow

---

### Performance Optimization - High-Latency Operations

**Priority:** 🟡 MEDIUM  
**Estimated effort:** Research + implementation (TBD)  
**Status:** NOT STARTED

**Issue:** Research improvements to efficiency of operations requiring rehashing and high-latency processing

**Operations to analyze:**

1. Import (file scanning, hashing, EXIF extraction)
2. Date change (file moves, EXIF updates, rehashing)
3. Rebuild database (full rescan, rehashing all files)
4. Update database/index (incremental scanning, hash comparison)
5. Any other operations requiring rehashing

**Research goals:**

- Identify bottlenecks in each operation
- Evaluate caching strategies for hashes
- Consider incremental vs full processing
- Explore parallelization opportunities
- Assess trade-offs between speed and accuracy

**Outcome:** Performance optimization plan with prioritized improvements

---

### Lightbox - RAW Format Not Displaying

**Priority:** 🔴 CRITICAL  
**Estimated effort:** 2-3 hours  
**Status:** NOT STARTED

**Issue:** RAW format doesn't show in lightbox

- Lightbox opens for RAW files but image fails to load
- Console shows "Image 1 failed to load" despite Status: 200, OK: true
- Corruption check passes but display fails
- Likely needs RAW file conversion or proper MIME type handling

**Impact:** RAW photos are common in photo libraries, prevents viewing significant portion of library

**Fix approach:**

- Check if server is serving RAW files with correct MIME type
- May need to generate preview/proxy image for RAW files
- Consider converting RAW to JPEG on-the-fly for display
- Check if browser can handle RAW formats natively
- Add error handling and user feedback for unsupported formats

---

### Lightbox - MOV Videos Not Displaying

**Priority:** 🔴 CRITICAL  
**Estimated effort:** 2-3 hours  
**Status:** NOT STARTED

**Issue:** .mov doesn't show in lightbox

- Lightbox opens for .mov files and shows video player controls
- Video duration shows (e.g., "0:03 / 0:05") but video content is black/not displaying
- Console shows proper dimensions and viewport calculations
- Likely codec or MIME type issue

**Impact:** MOV is a very common video format, prevents viewing videos in lightbox

**Fix approach:**

- Check if server is serving .mov files with correct MIME type (video/quicktime)
- Verify browser codec support for MOV container
- May need to transcode MOV to MP4/WebM for broader browser compatibility
- Check video element source and loading
- Add codec detection and error handling
- Consider generating web-compatible preview versions on import

---

### Lightbox - Add Rotation Action

**Priority:** 🟡 MEDIUM  
**Estimated effort:** 3-4 hours  
**Status:** NOT STARTED

**Issue:** Add rotation action in lightbox; needs to rotate actual pixels when possible losslessly, use flag when not (per terraforming protocol)

- Lightbox currently lacks ability to rotate images
- Should rotate actual pixels for lossless formats (JPEG with proper tools)
- Should use EXIF rotation flag for formats where pixel rotation would be lossy
- Follow terraforming protocol for file handling

**Impact:** Allows quick photo correction without leaving lightbox view

**Fix approach:**

- Add rotation button(s) to lightbox UI (rotate left/right)
- Use Material Symbols icon: `rotate_right` at 100 weight
- Decide if rotation should be clockwise (cw) or counterclockwise (ccw)
- Icon stylesheet: `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&icon_names=rotate_right" />`
- Implement backend endpoint for rotation
- Use lossless JPEG rotation when possible (jpegtran or similar)
- Fall back to EXIF rotation flag for other formats
- Update thumbnail after rotation
- Refresh display in lightbox

---

## Recommended Fix Order

Based on impact, frequency, and effort (high-order architecture first, then quick wins):

1. 🔴 **Media Date Truth — Single Rulebook** (1–2 days, CRITICAL - truth in media; fixes video date edit + rebuild drift)
2. 🔴 **Terraforming - Cancel/Go Back Causes Stalled State** (1-2 hrs, CRITICAL - blocks app access) — FIXED 2026-06-13
3. 🔴 **Lightbox - RAW Format Not Displaying** (2-3 hrs, CRITICAL - common file format)
4. 🔴 **Lightbox - MOV Videos Not Displaying** (2-3 hrs, CRITICAL - common video format)
5. 🟡 **Lightbox - Add Rotation Action** (3-4 hrs, feature addition with lossless rotation)
6. 🟡 **Performance Optimization - High-Latency Operations** (research + implementation TBD)

---

## SUMMARY

**Next up:** Media Date Truth — Single Rulebook (CRITICAL - 1–2 days, architecture)

**Total remaining:** 5 bugs + 1 architecture item

- 🔴 Critical architecture: 1 (Media Date Truth)
- 🔴 Critical: 3 bugs (Lightbox RAW Format, Lightbox MOV Videos; Terraforming cancel — fixed)
- 🟡 Polish: 2 bugs (Lightbox Rotation, Performance Research)

**Estimated total effort:** ~9-12 hours for remaining bugs + research (excluding performance optimization implementation)

**Recently Fixed:** ✅ Picker Shift-Select, ✅ Grid Star Icon, ✅ Grid Video Icon (Jan 29, 2026)

---

## 📝 BACKLOG: UX IMPROVEMENTS (Not Bugs, Future Enhancements)

These are enhancement ideas, not bugs. To be considered for future feature work.

### Library Management

- Add rescan button to folder picker
- Picker should refresh on change to disk contents
- Add keyboard shortcut for desktop (command-shift D)
- Photo picker is a bit sluggish
- 'Select this location' should read 'Open' and be disabled for folders without DB
- Add 'Create new' button that creates blank DB and navigates to empty library state

### Delete & Recovery

- Should also remove thumbnail folder when deleting thumbnail cache entry

### Date Editing

- **See Tier 1: Media Date Truth** — video writes unverified; rebuild/read drift; year picker not refreshed after edit
- Date change causes navigation from lightbox to grid (bad UX)
- Date change anchor date should be topmost photo in grid

### Lightbox

- Date jump should frame grid so date is visible
- Full frame icon → spacebar → closes full frame (bad)
- Video thumbnail shows first frame (bad UX when frame is black)

### Library Creation - Better New Library Flow

- Switch library → Create new (change to Sentence case) → folder/location selection flow → empty library state (NOT first run state)
- Current problem: New library points to first run state instead of empty library state

### Index Rebuild - No Resume Capability

- Need a way to resume index rebuilding if it fails
- Impact: If rebuild process fails or is interrupted, must start over from scratch

---

## ⏸️ DEFERRED: CAN'T ASSESS / NEED CLARIFICATION

These issues need more information or test cases before they can be prioritized.

### Navigation & Sorting Edge Cases

- Year-aware landing (prefers staying in target year) - Don't understand; need script to test
- Directional landing based on sort order - Don't understand; need script to test

### Date Editing

- Sequence mode seconds interval - Can't assess in app because lacks seconds display

### Import Behind the Scenes

- ~~Extract EXIF date (fallback to mtime)~~ — superseded by **Media Date Truth — Single Rulebook** (Tier 1); see that entry for ingest/rebuild read policy and video filename handling.

### Various Features Need Backend Verification

- Clean Index: scan/execute/ghosts/moles
- Remove Duplicates utility internals (will be "Show Duplicates" after migration)
- Rebuild Thumbnails: check count/clear cache/lazy regen
- Health check on switch library
- Handle migration prompts
- Execute rebuild SSE progress
- File format conversions (HEIC/TIF → JPEG)
- Error handling for import/runtime issues
