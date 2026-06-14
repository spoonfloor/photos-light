# Bugs To Be Fixed — Prioritized

Last updated: June 14, 2026

**Prioritization lens:** Clean, smart architecture throughout the app. Fix **single sources of truth and shared contracts** before flow polish, lightbox features, or performance tuning. Do not stack tactical patches on fragmented paths (see workspace rule *high-before-low fix ethic*).

**Status:** 2 architecture foundations · 4 architecture consolidations · 4 product items (2 critical lightbox · 1 feature · 1 research)

---

## Recommended sequence

Work top-to-bottom. Each step should land with smoke + (where noted) packaged `.app` verification before the next begins.

| Step | Item | Why this order |
|------|------|----------------|
| 1 | **Media Date Truth — Single Rulebook** | Highest-order data contract; every mutator and rebuild must share read/write/verify rules before more flow UI is unified. |
| 2 | **Open Library Journey — Protected Performance Path** | Pin the app-entry path in isolation; no Add/Clean/Convert refactors in the same pass. |
| 3 | **Add/Clean/Convert Flow Controller Helpers** | Safe, PR-sized extractions only after date truth and open-library behavior are pinned. |
| 4 | **Overlay Loader Factory / Progress Dialog Template** | One overlay family at a time; no state-machine changes in the same pass. |
| 5 | **Picker Module Unification** | Shared listing/sort helpers; keep selection models separate. |
| 6 | **Shared `apiFetchJson()` — Broader Adoption** | Incremental JSON clusters; leave SSE, fragments, and open-library paths alone unless scoped. |
| 7 | **Lightbox — RAW not displaying** | Product correctness; benefits from stable media/MIME patterns but does not block architecture work above. |
| 8 | **Lightbox — MOV not displaying** | Same as RAW; pair smoke after both land. |
| 9 | **Lightbox — Add rotation action** | Feature on top of stable lightbox + media write paths; follow terraforming rotation protocol. |
| 10 | **Performance — high-latency operations** | Research/plan only until architecture tiers above are stable; implementation may depend on unified sync/date paths. |

**Sequencing rules**

- Do **not** mix Open-library/recovery/grid-handoff changes with Add/Clean/Convert refactors.
- Do **not** add per-flow date/hash/path logic — extend the shared rulebook instead.
- Flow-helper and overlay extractions: one slice per PR, flow smoke after each.
- Lightbox display fixes: verify MIME/serve path and error surfacing; avoid a third parallel preview pipeline.

---

## Tier 1 — Architecture foundations

These define app-wide contracts. Nothing below Tier 2 should bypass or duplicate them.

### Media Date Truth — Single Rulebook

**Priority:** 🔴 CRITICAL  
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

**Related docs:** `tech-docs/DATE_EDIT_BUG_SUMMARY.md`, `tech-docs/ARCHITECTURE_FRAGMENTATION_AUDIT.md`

---

### Open Library Journey — Protected Performance Path

**Priority:** 🔴 CRITICAL  
**Estimated effort:** 1 day  
**Status:** NOT STARTED

**Issue:** Open library, switch library, recovery, and grid handoff still have fragmented control paths. Prior broad refactors regressed the healthy-library open path by adding slow pre-open behavior / disrupting the handoff.

**Non-negotiable acceptance:**

- Healthy large library opens to visible grid tiles in ≤3s.
- Close/reopen remains fast.
- No full filesystem/media scan before opening a healthy library.
- Recovery UI appears only after a fast DB/openability probe says the DB is not usable.
- Add/Clean/Convert flow changes must not be mixed into this work.

**Fix approach:**

- Treat Open library as its own branch/pass.
- Preserve the current fast path exactly until tests prove a replacement is equivalent.
- Add explicit smoke/perf checks for healthy open, close/reopen, missing DB, and corrupt DB.

---

## Tier 2 — Architecture consolidation

PR-sized deduplication and shared helpers. Start only after Tier 1 is pinned or explicitly scoped away from the same files.

### Add/Clean/Convert Flow Controller Helpers

**Priority:** 🟡 MEDIUM (architecture risk reduction)  
**Estimated effort:** 2–4 hours per helper slice  
**Status:** PARTIAL

**Issue:** Add, Clean, and Convert still carry separate state machines and helper patterns. Some safe shared helpers have shipped, but a full flow-controller extraction remains risky.

**Completed slices (see also Completed work):**

- Shared preflight count animator.
- Shared SSE stream consumer.
- Clean activity-feed wrapper cleanup.

**Remaining safe slices:**

- Extract ETA ticker helper only where duplicate behavior is clear and outside protected Open-library/recovery paths.
- Continue small `apiFetchJson()` adoption clusters where JSON/error handling is duplicated.
- Do not collapse `importState`, `cleanLibraryState`, and `terraformProgressState` until behavior is pinned.

**Acceptance:**

- Add, Clean, and Convert smoke pass after each slice.
- No Open-library/grid startup changes in the same pass.

---

### Overlay Loader Factory / Progress Dialog Template

**Priority:** 🟡 MEDIUM  
**Estimated effort:** 2–4 hours  
**Status:** NOT STARTED

**Issue:** Overlay loading/progress dialog wiring is duplicated across flows, increasing the chance of inconsistent close/done/cancel behavior.

**Fix approach:**

- Start with one overlay family only.
- Extract shared loader/template plumbing without changing flow state or backend APIs.
- Keep UI copy and behavior identical in the first pass.

**Acceptance:**

- Target overlay still opens, closes, cancels, and completes exactly as before.
- No Add/Clean/Convert state-machine changes in the same pass.

---

### Picker Module Unification

**Priority:** 🟡 MEDIUM  
**Estimated effort:** 4–6 hours  
**Status:** NOT STARTED

**Issue:** Folder and photo pickers share filesystem/listing/sort concerns but remain separate implementations, which invites drift and repeated fixes.

**Fix approach:**

- Extract shared filesystem/listing/sort helpers first.
- Keep `FolderPicker` and `PhotoPicker` selection models separate.
- Do not merge the picker classes wholesale.

**Acceptance:**

- Folder picker and photo picker preserve current selection behavior.
- Picker sort/listing behavior is covered by focused tests or manual smoke.

---

### Shared `apiFetchJson()` — Broader Adoption

**Priority:** 🟡 LOW–MEDIUM  
**Estimated effort:** Incremental  
**Status:** PARTIAL

**Issue:** JSON fetch/error handling remains inconsistent across `static/js/main.js`, though a small `apiFetchJson()` helper exists and some endpoints have been migrated.

**Fix approach:**

- Continue adopting `apiFetchJson()` in small endpoint clusters.
- Prioritize JSON-only endpoints with repeated `response.json().catch(() => ({}))` patterns.
- Leave SSE streams, static fragment loads, and protected Open-library flows alone unless the cluster is specifically scoped.

**Acceptance:**

- Each adoption cluster has JS syntax check and relevant flow smoke.
- No broad “convert all fetches” pass.

---

## Tier 3 — Product correctness & features

User-visible bugs and features that should not drive new parallel architecture. Prefer extending Tier 1–2 contracts when touching shared code.

### Lightbox — RAW Format Not Displaying

**Priority:** 🔴 CRITICAL (product)  
**Estimated effort:** 2–3 hours  
**Status:** NOT STARTED

**Issue:** RAW format doesn't show in lightbox

- Lightbox opens for RAW files but image fails to load
- Console shows "Image 1 failed to load" despite Status: 200, OK: true
- Corruption check passes but display fails
- Likely needs RAW file conversion or proper MIME type handling

**Impact:** RAW photos are common in photo libraries; prevents viewing a significant portion of the library.

**Fix approach:**

- Check if server is serving RAW files with correct MIME type
- May need to generate preview/proxy image for RAW files
- Consider converting RAW to JPEG on-the-fly for display
- Check if browser can handle RAW formats natively
- Add error handling and user feedback for unsupported formats

---

### Lightbox — MOV Videos Not Displaying

**Priority:** 🔴 CRITICAL (product)  
**Estimated effort:** 2–3 hours  
**Status:** NOT STARTED

**Issue:** .mov doesn't show in lightbox

- Lightbox opens for .mov files and shows video player controls
- Video duration shows (e.g., "0:03 / 0:05") but video content is black/not displaying
- Console shows proper dimensions and viewport calculations
- Likely codec or MIME type issue

**Impact:** MOV is a very common video format; prevents viewing videos in lightbox.

**Fix approach:**

- Check if server is serving .mov files with correct MIME type (`video/quicktime`)
- Verify browser codec support for MOV container
- May need to transcode MOV to MP4/WebM for broader browser compatibility
- Check video element source and loading
- Add codec detection and error handling
- Consider generating web-compatible preview versions on import

---

### Lightbox — Add Rotation Action

**Priority:** 🟡 MEDIUM (feature)  
**Estimated effort:** 3–4 hours  
**Status:** NOT STARTED

**Issue:** Add rotation action in lightbox; needs to rotate actual pixels when possible losslessly, use flag when not (per terraforming protocol)

- Lightbox currently lacks ability to rotate images
- Should rotate actual pixels for lossless formats (JPEG with proper tools)
- Should use EXIF rotation flag for formats where pixel rotation would be lossy
- Follow terraforming protocol for file handling

**Fix approach:**

- Add rotation button(s) to lightbox UI (rotate left/right)
- Use Material Symbols icon: `rotate_right` at 100 weight
- Implement backend endpoint for rotation
- Use lossless JPEG rotation when possible (jpegtran or similar)
- Fall back to EXIF rotation flag for other formats
- Update thumbnail after rotation; refresh display in lightbox

---

## Tier 4 — Research & deferred optimization

### Performance — High-Latency Operations

**Priority:** 🟡 MEDIUM (research)  
**Estimated effort:** Research + implementation (TBD)  
**Status:** NOT STARTED

**Issue:** Research improvements to efficiency of operations requiring rehashing and high-latency processing.

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

**Outcome:** Performance optimization plan with prioritized improvements — **implement only after Tier 1–2 contracts are stable** so optimizations attach to one code path, not three.

---

## Summary

| Category | Count | Next action |
|----------|-------|-------------|
| Tier 1 — Architecture foundations | 2 | Start **Media Date Truth — Single Rulebook** |
| Tier 2 — Architecture consolidation | 4 | Flow helpers (incremental) after Tier 1 pinned |
| Tier 3 — Product | 3 | Lightbox RAW/MOV after architecture queue or in parallel if isolated |
| Tier 4 — Research | 1 | Plan only until unified sync/date paths exist |

**Estimated effort (remaining):** ~2–3 days architecture foundations + ~1 day consolidation slices + ~9–12 hours product/research (excluding performance implementation)

---

## Completed work

Fixed items kept here for traceability. Detailed histories live in `bugs-fixed.md` and `tech-docs/ARCHITECTURE_FRAGMENTATION_AUDIT.md` where noted.

### Grid hydration & catalog reset — 2026-06-13

Catalog reset tier shipped. Re-smoke passed 2026-06-13 (Clean grid, bulk date, empty startup).

Includes histogram mutation sync (`syncGridAfterHistogramChange`), Phase A→B handoff hardening, and Clean scoreboard phase wiring from `cleanup/dead-code`.

**Docs:** `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` § Catalog reset, `tech-docs/GRID_HYDRATION_BUGS.md`, `tech-docs/ARCHITECTURE_FRAGMENTATION_AUDIT.md` (Pass 4 + grid sync sections)

---

### Terraforming — Cancel/Go Back stalled state — 2026-06-13

**Issue:** “Go back” or cancel during terraform preview left the app stuck on “Loading library…” with no recovery path.

**Fix:** `recoverLibraryUiAfterFlowCancel()` on convert cancel — clears transition/handoff overlays and reloads grid or empty state.

**Verification:** Convert cancel/back paths smoke-tested 2026-06-13.

---

### Picker & grid UI — 2026-01-29

- ✅ Picker shift-select
- ✅ Grid star icon
- ✅ Grid video icon

---

## Backlog — UX improvements (not bugs)

Enhancement ideas for future feature work, not current fix queue.

### Library management

- Add rescan button to folder picker
- Picker should refresh on change to disk contents
- Add keyboard shortcut for desktop (command-shift D)
- Photo picker is a bit sluggish
- “Select this location” should read “Open” and be disabled for folders without DB
- Add “Create new” button that creates blank DB and navigates to empty library state

### Delete & recovery

- Should also remove thumbnail folder when deleting thumbnail cache entry

### Date editing

- **See Tier 1: Media Date Truth** — video writes unverified; rebuild/read drift; year picker not refreshed after edit
- Date change causes navigation from lightbox to grid (bad UX)
- Date change anchor date should be topmost photo in grid

### Lightbox

- Date jump should frame grid so date is visible
- Full frame icon → spacebar → closes full frame (bad)
- Video thumbnail shows first frame (bad UX when frame is black)

### Library creation — better new library flow

- Switch library → Create new (sentence case) → folder/location selection flow → empty library state (NOT first-run state)
- Current problem: New library points to first-run state instead of empty library state

### Index rebuild — no resume capability

- Need a way to resume index rebuilding if it fails
- Impact: If rebuild fails or is interrupted, must start over from scratch

---

## Deferred — can't assess / need clarification

These need more information or test cases before prioritization.

### Navigation & sorting edge cases

- Year-aware landing (prefers staying in target year) — need script to test
- Directional landing based on sort order — need script to test

### Date editing

- Sequence mode seconds interval — can't assess in app because it lacks seconds display

### Import behind the scenes

- ~~Extract EXIF date (fallback to mtime)~~ — superseded by **Media Date Truth — Single Rulebook** (Tier 1)

### Various features need backend verification

- Clean Index: scan/execute/ghosts/moles
- Remove Duplicates utility internals (will be “Show Duplicates” after migration)
- Rebuild Thumbnails: check count/clear cache/lazy regen
- Health check on switch library
- Handle migration prompts
- Execute rebuild SSE progress
- File format conversions (HEIC/TIF → JPEG)
- Error handling for import/runtime issues
