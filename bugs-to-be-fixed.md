# Bugs To Be Fixed — Prioritized

Last updated: June 15, 2026

**Prioritization lens:** Clean, smart architecture throughout the app. Fix **single sources of truth and shared contracts** before flow polish, lightbox features, or performance tuning. Do not stack tactical patches on fragmented paths (see workspace rule *high-before-low fix ethic*).

**Status:** Bug fix queue **empty** — all bedrock buckets shipped (2026-06-15). Next work lives in **Deferred** below.

**Last codebase audit:** 2026-06-15 — `ensure_blocking_audit_prep` wired in Convert; unit tests green.

---

## Bucket rules

A **bucket** contains only work that **does not depend on any downstream bucket**. Work inside a bucket may run in parallel when tracks are independent.

Do **not**:

- Mix Open-library / recovery / grid-handoff changes with Add/Clean/Convert refactors (Open path is closed — keep it that way).
- Publish static grid rhythm tokens from JS — CSS owns spacing; JS reads for layout math only.
- Add per-flow date/hash/path logic — extend `media_dates.py` instead.
- Add a third parallel lightbox preview pipeline — extend the existing serve path.
- Invent Convert-only trash/quarantine logic in `app.py` — reuse `library_filesystem`, `library_cleanliness`, and Clean/db-health patterns.

---

## Shipped sequence (2026-06-13 → 2026-06-15)

| Item | Status |
|------|--------|
| Grid hydration & catalog reset | Done (2026-06-13) |
| Open library — protected performance path | Done (2026-06-14) |
| Dynamic grid — CSS-owned design tokens | Done (2026-06-14) |
| Media date truth — single rulebook | Done (2026-06-14) |
| Tier 2 — architecture consolidation | Done (2026-06-15) |
| Library metadata compliance | Done (2026-06-15) |
| Unified flow controller | Done (2026-06-15) |
| Lightbox RAW · MOV | Done (2026-06-15) |
| Convert — pre-audit blocking cleanup | Done (2026-06-15) |

**Optional verification still pending:** packaged `.app` smoke for flow controller, RAW/MOV lightbox, and Convert on `dirty-library_BEFORE` — rebuild with `./packaging/build.sh` before prod sign-off.

---

## Remaining work summary

### Bug fix queue

| Item | Status |
|------|--------|
| — | **Empty** |

### Deferred — separate future batches

Scoped when product pain or a dedicated pass warrants it. Not active queue.

**Frontend / API hygiene**

- Adopt `apiFetchJson()` on remaining JSON clusters (rotate/favorite/delete, import browse)

**Library management**

- Picker rescan button
- Picker refresh on disk contents change
- Keyboard shortcut for desktop (command-shift D)
- Photo picker sluggishness
- “Select this location” → “Open”, disabled for folders without DB
- “Create new” → blank DB + empty library state (not first-run)

**Library creation**

- New-library flow should land in empty library state, not first-run

**Delete & recovery**

- Remove thumbnail folder when deleting thumbnail cache entry

**Date editing**

- Date change navigates away from lightbox to grid (bad UX)
- Date change anchor date should be topmost photo in grid
- Sequence mode seconds interval (blocked on seconds UI)

**Lightbox**

- Date jump should frame grid so date is visible
- Full frame icon → spacebar closes full frame (bad)
- Video thumbnail shows first frame (bad UX when frame is black)

**Index rebuild**

- Resume capability after failure or interrupt

**Performance — high-latency operations**

Import, date change, rebuild database, update index, and any operation that rehashes files. Gate: bedrock stable ✓

**Navigation & sorting edge cases**

- Year-aware landing (prefers staying in target year) — need script to test
- Directional landing based on sort order — need script to test

**Grid / test infrastructure**

- Browser/integration test for full Phase A→B handoff (static contract test exists in `test_grid_handoff_contract.py`)
- Filtered grid paged-path parity — starred/video chips use paged `renderPhotoGrid`; manual verify only
- Bulk favorites API documented but not wired in production UI

**Backend verification sweeps**

- Clean Index: scan/execute/ghosts/moles
- Remove Duplicates utility internals (will be “Show Duplicates” after migration)
- Rebuild Thumbnails: check count/clear cache/lazy regen
- Health check on switch library
- Handle migration prompts
- Execute rebuild SSE progress
- File format conversions (HEIC/TIF → JPEG)
- Error handling for import/runtime issues

**Repo hygiene**

- Decide fate of `operation_state.py` (keep — wired into `library_sync`/schema)

---

## Completed work

Fixed items kept here for traceability. Detailed histories also live in `bugs-fixed.md` and `tech-docs/ARCHITECTURE_FRAGMENTATION_AUDIT.md` where noted.

### Convert — Pre-Audit Blocking Cleanup — 2026-06-15

Convert failed final audit on blocking issues it surfaced but did not remove: convert-rejected corrupt media left on disk and unexpected `.library` artifacts (e.g. `photo_library.db.zip`).

**Shipped:**

- `library_filesystem.py` — `ensure_blocking_audit_prep`, `move_file_to_category_trash`, `BlockingCleanupStats`, `quarantine_unexpected_metadata_entries`
- Wired in `app.py` `terraform_library()` between metadata compliance and final audit (cleanup SSE phase)
- Quarantines stray `.library` files; trashes orphan supported media not in DB (corrupt → `.trash/corrupted/`, valid orphans → `.trash/errors/`); prunes empty non-canonical folders

**Tests:** `test_library_filesystem.LibraryFilesystemTest.test_ensure_blocking_audit_prep_quarantines_metadata_and_trashes_orphans`, `test_convert_invariance.ConvertInvarianceContractTest.test_convert_blocking_cleanup_clears_audit_blockers_before_final_audit`

---

### Library Metadata Compliance — Shared Pre-Audit Pipeline — 2026-06-15

Clean and Convert share `run_fast_library_audit`; compliance pass runs before audit on both paths.

**Shipped:**

- `library_metadata_compliance.py` — `ensure_library_metadata_compliant`, `METADATA_COMPLIANCE_SPEC`
- Shared primitives in `normalization_repair.py` — `repair_file_metadata_compliance`, `file_needs_metadata_compliance`
- Wired in `app.py` (Convert) and `make_library_clean_v2.py` (Clean, before `final_audit`)

**Tests:** `test_library_metadata_compliance.py`, `test_normalization_repair.py`, `test_convert_invariance.test_convert_audit_green_when_compliance_strips_video_rating_zero`

---

### Add/Clean/Convert — Unified Flow Controller — 2026-06-15

**Shipped:**

- `static/js/flowController.js` — lifecycle for Add, Clean, Convert
- `wireFlowControllers()` registers flow adapters; `FlowController.syncOverlayPhase`, `cancelRecovery`, `dismissOverlay`
- Shell restore via `restoreLibraryShellAfterFlowDismiss`

**Smoke:** Add/Clean/Convert manual pass (PR 1–4). Packaged `.app` smoke pending full rebuild.

---

### Lightbox — RAW Format Not Displaying — 2026-06-15

**Shipped:** `RAW_PHOTO_EXTENSIONS` in `BROWSER_CONVERT_EXTENSIONS`; `get_photo_file` serves RAW via `still_image_to_jpeg_buffer()`; sips-first decode on macOS (`SIPS_FIRST_DECODE_EXTENSIONS`); lightbox decode-error toast.

**Tests:** `test_image_pixels.py` + optional macOS RAW integration

---

### Lightbox — MOV Videos Not Displaying — 2026-06-15

**Shipped:** `video_to_browser_mp4_buffer()` remux/transcode to fragmented MP4; browser-direct `.mp4`/`.m4v`/`.webm` still served from disk; lightbox `playsInline` + relayout on `loadedmetadata`.

**Tests:** `test_video_playback.py` + optional macOS MOV integration

---

### Tier 2 — Architecture consolidation — 2026-06-15

Flow helpers (SSE, countdown, activity feed), overlay factory (Add/Clean/Convert), `pickerFilesystem.js`, scoped `apiFetchJson` on flow JSON clusters.

---

### Dynamic Grid — CSS-Owned Design Tokens — 2026-06-14

CSS owns rhythm on `.grid-root`; JS reads via `readGridRhythmTokens`; `publishCssVars` dynamic only. Contract tests in `test_grid_handoff_contract.py`.

---

### Open Library Journey — Protected Performance Path — 2026-06-14

Fast healthy open pinned; picker gate for bad/missing DB; contract tests in `test_grid_handoff_contract.py`.

**Won't fix:** Wire recovery onto product Open; unify with `/api/library/check`; automated ≤3s perf gate; automated missing/corrupt DB smoke.

---

### Media Date Truth — Single Rulebook — 2026-06-14

Shared read/write/verify contract in `media_dates.py`. Contract tests in `test_media_date_contract.py`, `test_media_dates.py`, `test_quicktime_date_transitions.py`.

---

### Grid hydration & catalog reset — 2026-06-13

Catalog reset tier; histogram mutation sync (`syncGridAfterHistogramChange`); Phase A→B handoff hardening; Clean scoreboard phase wiring.

---

### Terraforming — Cancel/Go Back stalled state — 2026-06-13

**Fix:** `FlowController.cancelRecovery('convert')` + `restoreLibraryShellAfterFlowDismiss`.

---

### Lightbox — Rotation action — pre-2026-06-15

Staged rotation with commit-on-close; `POST /api/photo/<id>/rotate`. Tests: `test_rotate_photo.py`, `test_rotation_heic.py`.

---

### Picker & grid UI — 2026-01-29

- Picker shift-select
- Grid star icon
- Grid video icon
