# Bugs To Be Fixed — Prioritized

Last updated: June 15, 2026

**Prioritization lens:** Clean, smart architecture throughout the app. Fix **single sources of truth and shared contracts** before flow polish, lightbox features, or performance tuning. Do not stack tactical patches on fragmented paths (see workspace rule *high-before-low fix ethic*).

**Status:** Architecture foundations shipped · 3 active buckets remaining (2 bedrock · 1 preview · 1 research)  
**Last codebase audit:** 2026-06-15 — metadata compliance shipped; Convert pre-audit cleanup + unified flow controller still open

---

## Bucket rules

A **bucket** contains only work that **does not depend on any downstream bucket**. Work inside a bucket may run in parallel when tracks are independent.

Ordering principles (applied in sequence):

1. **Highest-order architecture first** — unify orchestration and compliance before product features or perf work.
2. **Highest risk first** — large refactors land while smoke paths are fresh and before lower-risk items stack on fragmented code.
3. **Pre-reqs first** — a bucket starts only after all upstream buckets are done (or explicitly waived).

Do **not**:

- Mix Open-library / recovery / grid-handoff changes with Add/Clean/Convert refactors (Open path is closed — keep it that way).
- Publish static grid rhythm tokens from JS — CSS owns spacing; JS reads for layout math only.
- Add per-flow date/hash/path logic — extend `media_dates.py` instead.
- Add a third parallel lightbox preview pipeline — extend the existing serve path.
- Implement performance optimizations before unified orchestration and compliance paths exist.

---

## Recommended sequence

Work bucket-by-bucket, top to bottom. Land each bucket with smoke + (where noted) packaged `.app` verification before the next begins.

| Bucket | Item(s) | Why this order |
|--------|---------|----------------|
| **1** | Library metadata compliance · Convert pre-audit cleanup · Unified flow controller | Bedrock architecture; no downstream deps; highest regression risk while contracts are still forked |
| **2** | Lightbox RAW · Lightbox MOV | Single preview/serve contract; product-critical; must not fork a parallel pipeline |
| **3** | Performance — high-latency operations | Research/plan only until buckets 1–2 stabilize the paths optimizations must attach to |

---

## Bucket 1 — Bedrock architecture

**Gate:** Nothing upstream. **Blocks:** Buckets 2–3 should not introduce new parallel orchestration or metadata paths while this is open.

Two independent tracks remain open (plus metadata compliance, shipped). May land as separate PRs; none depends on downstream buckets.

### Library Metadata Compliance — Shared Pre-Audit Pipeline

**Priority:** 🔴 CRITICAL (architecture)  
**Estimated effort:** 1–2 days  
**Status:** DONE (2026-06-15)  
**Risk:** High — touches Clean and Convert orchestrators; wrong slice creates a third metadata path

**Principle:** Clean and Convert share `run_fast_library_audit`, but only Clean runs metadata repair before it. Same exam, different prep.

**Issue:** Convert failed on auto-fixable metadata (e.g. `rating_zero` on JPGs) while Clean stripped rating 0 via a separate scan path. Convert ran canonicalize → layout → **blocking audit with no shared compliance pass**.

**Codebase (verified 2026-06-15):** Shared module `library_metadata_compliance.ensure_library_metadata_compliant()` runs before `run_fast_library_audit` in both `app.py` (Convert) and `make_library_clean_v2.py` (Clean). Clean scan delegates video metadata fixes and photo compliance signals through `normalization_repair.repair_file_metadata_compliance` / `file_needs_metadata_compliance`.

**Root cause:** Divergent paths — `normalization_repair` (in-place Clean) vs `photo_canonicalization` (staging Import/Convert). Two parallel metadata implementations.

**Fix shape (architecture, not Convert-only hack):**

1. Single compliance spec — what audit checks and how each class is fixed
2. Shared pre-audit compliance pass (reuse Clean metadata-repair slice or `ensure_library_metadata_compliant`)
3. Convert + Clean orchestrators call it before blocking audit; audit stays one truth test
4. Policy: `rating_zero` etc. = auto-fix; corrupt/layout/db mismatch = blocking

**Acceptance:**

- Library with `rating_zero` passes Convert after compliance pass
- Clean and Convert share one compliance module; test covers compliance → audit green

**Shipped (2026-06-15):** `library_metadata_compliance.py` (`ensure_library_metadata_compliant`, `METADATA_COMPLIANCE_SPEC`); shared primitives in `normalization_repair.py` (`repair_file_metadata_compliance`, `file_needs_metadata_compliance`, `_photo_repair_log_events`); Clean scan delegates metadata slice via `normalize_repair_scan_identity` → `repair_file_metadata_compliance`. Wired in `app.py` (Convert, before final audit) and `make_library_clean_v2.py` (Clean, before `final_audit`). Tests: `test_library_metadata_compliance.py`, `test_normalization_repair.py`, `test_convert_invariance.test_convert_audit_green_when_compliance_strips_video_rating_zero`.

**Repro:** `terraform_*.jsonl` → `final_audit_failed` → `rating_zero` on paths Clean would have fixed.

---

### Convert — Pre-Audit Blocking Cleanup

**Priority:** 🔴 CRITICAL (product + architecture)  
**Estimated effort:** 0.5–1 day  
**Status:** NOT STARTED  
**Risk:** Medium — touches Convert orchestrator only; must not fork a third cleanup path separate from shared layout/audit helpers

**Principle:** Metadata compliance (Track A, shipped) fixes auto-fixable metadata before audit. Convert still fails final audit on **blocking** issues Clean would remove — rejected corrupt media left on disk and unexpected `.library` artifacts.

**Issue:** After `iter_convert_events` + folder cleanup + `ensure_library_metadata_compliant`, Convert can still hit `final_audit_failed` on issues Convert itself surfaced but did not remove:

- **Convert-rejected corrupt media** left at library root or other non-canonical paths (e.g. `03_fake-png.png` — rejected during canonicalize, `preserved_original: true`, never trashed)
- **Unexpected `.library` files** (e.g. `photo_library.db.zip`) — audit flags `unexpected_library_metadata_file`; Convert does not quarantine them (Clean / DB recovery paths do)

**Codebase (verified):** `app.py` `terraform_library()` folder phase only trashes `non_media_files` stragglers via `iter_layout_cleanup_passes` — supported extensions at root after convert failure are not stragglers. No `.library` metadata-dir hygiene pass before `run_fast_library_audit`. Manual smoke on `dirty-library_BEFORE` (2026-06-15): compliance green (`files_fixed: 0`), audit failed with 3 issues — `corrupted_media` + `noncanonical_root_file` on `03_fake-png.png`, `unexpected_library_metadata_file` on `.library/photo_library.db.zip`.

**Root cause:** Convert prep stops at layout cleanup + metadata compliance; blocking audit kinds that require **removal/quarantine** (not metadata rewrite) have no shared pre-audit pass. Clean handles these in repair phases; Convert does not.

**Fix shape (targeted — not full Clean merge):**

1. Shared pre-audit cleanup pass (or extend existing folder phase) after compliance, before `run_fast_library_audit`
2. Trash (or move to `.trash/errors/`) in-library media that convert rejected/failed and is not at a canonical path / not in DB
3. Quarantine unexpected files under `.library/` using existing db-health / Clean patterns — do not invent Convert-only quarantine logic in `app.py`
4. Reuse `library_filesystem`, `library_cleanliness`, and audit issue taxonomy — audit stays one truth test

**Acceptance:**

- `dirty-library_BEFORE` (or equivalent fixture) passes Convert final audit after convert + compliance + cleanup (not requiring a separate Clean run)
- Convert-rejected corrupt files are not left at library root
- Unexpected `.library` artifacts are quarantined or trashed before audit
- No third parallel cleanup implementation — grep shows shared helpers, not new per-flow trash/quarantine one-offs

**Repro:** Run Convert on `dirty-library_BEFORE` → `terraform_*.jsonl` → `metadata_compliance_complete` then `final_audit_failed` with `corrupted_media`, `noncanonical_root_file`, `unexpected_library_metadata_file`.

**Out of scope:** Full merge of Clean repair phases into Convert; auto-fix metadata (shipped compliance track); unified flow controller (parallel track below).

---

### Add/Clean/Convert — Unified Flow Controller

**Priority:** 🔴 CRITICAL (architecture)  
**Estimated effort:** 2–3 days  
**Status:** NOT STARTED  
**Risk:** High — regression surface across Add, Clean, and Convert; requires dedicated smoke plan

**Issue:** Three parallel frontend state machines — `importState`, `cleanLibraryState`, `terraformProgressState` (all in `main.js`) — duplicate overlay phase logic, cancel/recovery wiring, and preflight/inflight transitions. Tier 2 extracted shared helpers but not the controller layer.

**Codebase (verified):** Helpers are shared (`consumeSseStream`, `loadFlowOverlayFragment`, `recoverLibraryUiAfterFlowCancel`, etc.) but each flow still owns its own state object and phase wiring. No unified controller module or facade exists.

**Fix shape:**

1. Single flow controller (or thin facade) owning phase machine, overlay handoff registry, and cancel/recovery entry points
2. Flow-specific modules supply step configs and SSE handlers; controller owns shared lifecycle
3. Reuse shipped helpers — do not reimplement: `consumeSseStream`, `createInflightRemainingTicker`, `loadFlowOverlayFragment`, `recoverLibraryUiAfterFlowCancel`, `handoffFlowOverlays`
4. One slice per PR with flow smoke after each (Add → Clean → Convert)

**Acceptance:**

- No new per-flow phase/toggle/reset helpers outside the controller
- Cancel/go-back on all three flows clears overlays and restores grid or empty state through one path
- Debug and production flows share the same controller (no debug-only sync helpers)

**Out of scope for this bucket:** Backend metadata compliance (shipped); Convert pre-audit blocking cleanup (parallel track above); lightbox; perf.

---

## Bucket 2 — Preview / serve contract

**Gate:** Bucket 1 complete (or explicitly waived for an isolated serve-path fix that does not touch orchestration).

User-visible display bugs on a **single** serve/preview pipeline. Prefer extending existing MIME/serve/thumbnail paths over adding Convert-style parallel implementations.

**Codebase (verified):** Lightbox loads via `/api/photo/<id>/file` (`get_photo_file` in `app.py`). HEIC/TIF convert on-the-fly through `BROWSER_CONVERT_EXTENSIONS` (`image_pixels.py`); all other stills — including RAW — are served with `send_from_directory`. Videos (MOV included) are served the same way into a `<video>` element in `loadMediaIntoContent`.

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

- Extend `get_photo_file` / `BROWSER_CONVERT_EXTENSIONS` (or a sibling RAW preview helper) to generate JPEG proxies for RAW — same pattern as HEIC/TIF, not a parallel lightbox-only path
- Browsers cannot display RAW bytes from `send_from_directory`; Status 200 with unloadable body matches current repro
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

- Diagnose codec/MIME at the single serve endpoint — may need transcode to MP4/WebM (reuse or extend `generate_video_preview` patterns from thumbnail path)
- Verify `<video src="/api/photo/<id>/file">` loading and surface codec errors in UI
- Add codec detection and error handling

**Pair smoke:** Verify RAW and MOV together after serve-path changes — one PR if the root cause is shared.

---

## Bucket 3 — Research & deferred optimization

**Gate:** Buckets 1–2 stable — optimizations must attach to one code path, not three.

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

**Outcome:** Performance optimization plan with prioritized improvements — implement only after Bucket 1 orchestration/compliance and Bucket 2 preview contracts are stable.

---

## Remaining work summary

| Bucket | Items | Status | Est. effort |
|--------|-------|--------|-------------|
| 1 — Bedrock architecture | Metadata compliance · Unified flow controller | NOT STARTED | 3–5 days |
| 2 — Preview / serve | Lightbox RAW · Lightbox MOV | NOT STARTED | 4–6 hours |
| 3 — Research | High-latency perf plan | NOT STARTED | TBD |

**Total estimated (remaining):** ~3–5 days architecture + ~4–6 hours product/research

---

## Completed work

Fixed items kept here for traceability. Detailed histories also live in `bugs-fixed.md` and `tech-docs/ARCHITECTURE_FRAGMENTATION_AUDIT.md` where noted.

### Tier 2 — Architecture consolidation — 2026-06-15

PR-sized deduplication and shared helpers — one batch, shipped after Tier 1.

**Add/Clean/Convert flow controller helpers:**

- Shared preflight count animator (`animatePreflightNumericCounts`)
- Shared SSE stream consumer (`consumeSseStream`)
- Clean activity-feed wrapper + `handoffFlowActivityFeed` registry
- Inflight remaining ticker (`createInflightRemainingTicker`) — **Add** ratio, **Convert** velocity (Clean uses its own `estimateCleanWorkingRemainingSeconds` + SSE `serverRemainingSeconds`, not the shared ticker)
- Label stability (`formatInflightRemainingLabel`) — hysteresis + dwell; shared by Add, Clean subtitle, Convert
- Clean working-subtitle ETA + SSE `estimated_remaining_seconds`
- Convert scan ETA — backend `estimate_convert_duration_seconds`
- Overlay plumbing — `hideFlowOverlay`, `handoffFlowOverlays`, `wireFlowDetailsToggle`
- Cancel recovery — `recoverLibraryUiAfterFlowCancel`

**Overlay loader factory / progress dialog template:**

- `loadFlowOverlayFragment` for Import, Clean Library, Convert (choice / preview / warning / progress / complete)
- Idempotent, `versionedStaticUrl`, `response.ok` check, hide on load
- `wire*Overlay` once at insert; promise dialogs keep per-show handlers

**Picker module unification:**

- `pickerFilesystem.js` — `getLocations`, `listDirectory`, error helpers
- Wired in `folderPicker.js`, `photoPicker.js`, and `main.js`
- Sort/nav via `PickerUtils`; separate picker classes retained

**Shared `apiFetchJson()` — scoped adoption:**

- Helper + adoption on flow JSON clusters (years, library current, clean checkpoint/scan/manifest-tail, terraform scan/start error path, import path)
- Excluded by design: SSE streams, HTML fragments, binary file serve, open-library switch/create/recover paths

---

### Dynamic Grid — CSS-Owned Design Tokens — 2026-06-14

CSS owns rhythm on `.grid-root`; JS reads via `readGridRhythmTokens`; `publishCssVars` dynamic only.

**Was broken:** Static grid spacing duplicated in JS (`gridLayout.js` constants) and pushed onto the DOM via `publishCssVars`, overwriting CSS.

**Shipped:**

- CSS owns all static tokens on `.grid-root`; JS publishes only dynamic geometry (`--grid-cols`, `--grid-cell-px`)
- `readGridRhythmTokens(container)` — `getComputedStyle` for layout math
- Comfort chunk builder reads repeat-pattern vars from computed style
- Contract tests in `test_grid_handoff_contract.py`

**Docs:** `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` § Layout constants

---

### Open Library Journey — Protected Performance Path — 2026-06-14

Fast healthy open pinned; picker gate for bad/missing DB; contract tests in `test_grid_handoff_contract.py`.

**Product `openExistingLibrary`:**

- **Healthy folder:** `FolderPicker` (`OPEN_EXISTING_LIBRARY`) probes via `pickerFilesystem.listDirectory` → `has_openable_db` → **Open** enabled → `openExistingLibrary` → `switchToLibrary` → virtual grid. No `/api/library/check`, make-perfect scan, or recovery on this path (guarded by `test_grid_handoff_contract.py`).
- **Missing DB:** hint *“No photo library found in this folder.”* — **Open** disabled.
- **Bad / unopenable DB:** hint *“Library database found here but it can't be opened.”* — **Open** disabled.
- **Regression guards:** contract tests ensure healthy branches do not call recovery scan, make-perfect scan, or blocking normalize before grid load.

**Won't fix (intentional product scope):**

1. Wire recovery onto product Open — bad/missing DB stays picker-gated, not in-app repair
2. Unify product Open with `/api/library/check` — picker already probes via `list-directory`
3. Recovery on legacy/dev path — `browseSwitchLibraryLegacy` / `runLibraryRecoveryJourney` remain DevTools-only
4. Automated perf gate (≤3s open) — spot-check in dev or packaged `.app` when needed
5. Automated missing/corrupt DB smoke — picker block behavior is the shipped UX

Revisit items 1–2 only if product requires in-app library repair from **Open library**.

---

### Media Date Truth — Single Rulebook — 2026-06-14

Shared read/write/verify contract in `media_dates.py` — one policy for ingest, edit, clean audit, and rebuild.

**Shipped:**

- `read_media_date()` — embedded → basename → photo unknown / video mtime (ingest only); untrusted embedded ignored when basename disagrees
- `write_and_verify_media_date()` + `metadata_write_policy(ext)` — fail-closed writes; QuickTime atom patch + ffprobe verify for video
- Wired through date edit, import, clean audit, canonicalization, and rebuild
- Year picker refresh after date edit
- Contract tests: `test_media_date_contract.py`, `test_media_dates.py`, `test_update_photo_date.py`, `test_quicktime_date_transitions.py`

**Docs:** `media_dates.py` module docstring, `tech-docs/DATE_EDIT_BUG_SUMMARY.md`

---

### Grid hydration & catalog reset — 2026-06-13

Catalog reset tier shipped. Re-smoke passed 2026-06-13 (Clean grid, bulk date, empty startup).

Includes histogram mutation sync (`syncGridAfterHistogramChange`), Phase A→B handoff hardening, and Clean scoreboard phase wiring from `cleanup/dead-code`.

**Docs:** `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` § Catalog reset, `tech-docs/GRID_HYDRATION_BUGS.md`, `tech-docs/ARCHITECTURE_FRAGMENTATION_AUDIT.md`

---

### Terraforming — Cancel/Go Back stalled state — 2026-06-13

**Fix:** `recoverLibraryUiAfterFlowCancel()` on convert cancel — clears transition/handoff overlays and reloads grid or empty state.

---

### Picker & grid UI — 2026-01-29

- Picker shift-select
- Grid star icon
- Grid video icon

---

### Lightbox — Rotation action — shipped (pre-2026-06-15 backlog)

Staged rotation in lightbox with commit-on-close; lossless vs lossy paths per terraforming protocol.

**Shipped:**

- UI: `lightboxRotateBtn` in `static/fragments/lightbox.html` (`rotate_left` icon)
- Client: staged `lightboxRotationSessions`, preview transform in `applyLightboxMediaStyles`, `commitPendingLightboxRotations` on close
- Backend: `POST /api/photo/<id>/rotate` — `rotate_file_in_place`, `can_rotate_losslessly`, HEIC/TIFF sibling handling
- Thumbnail refresh after commit via `refreshGridPhotoThumbnail` / `applyCommittedPhotoUpdate`

**Tests:** `test_rotate_photo.py`, `test_rotation_heic.py`

**Note:** Rotate still uses raw `fetch` (not `apiFetchJson`) — optional hygiene in backlog.

---

## Backlog — UX improvements (not bugs)

Enhancement ideas for future feature work, not current fix queue.

### Frontend / API hygiene

- Adopt `apiFetchJson()` on remaining JSON clusters (photo rotate/favorite/delete, import browse) — optional; not required for current queue

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

## Deferred — separate future batches

Work that does not belong in active buckets until scoped as its own pass. Does not block current bucket sequence.

### Navigation & sorting edge cases

- Year-aware landing (prefers staying in target year) — need script to test
- Directional landing based on sort order — need script to test

### Date editing

- Sequence mode seconds interval — can't assess in app because it lacks seconds display

### Grid / test infrastructure

- Browser/integration test for full Phase A→B handoff (static contract test exists in `test_grid_handoff_contract.py`)
- Filtered grid paged-path parity — starred/video chips use paged `renderPhotoGrid`; manual verify only
- Bulk favorites API documented but not wired in production UI

### Backend verification (feature areas)

- Clean Index: scan/execute/ghosts/moles
- Remove Duplicates utility internals (will be “Show Duplicates” after migration)
- Rebuild Thumbnails: check count/clear cache/lazy regen
- Health check on switch library
- Handle migration prompts
- Execute rebuild SSE progress
- File format conversions (HEIC/TIF → JPEG)
- Error handling for import/runtime issues

### Repo hygiene

- Decide fate of `operation_state.py` (keep — wired into library_sync/schema)
