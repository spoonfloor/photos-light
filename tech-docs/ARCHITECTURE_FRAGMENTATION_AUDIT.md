# Architecture Fragmentation Audit

Living document: fragmentation hotspots, dead paths, and cleanup history.

| | |
|---|---|
| **Branch** | `cleanup/dead-code` |
| **Ship commit** | `7929071` (2026-06-13) |
| **Checkpoint tag** | `pre-cleanup-2026-06-13` (commit `b83452d`) |
| **Phase 1 tag** | `phase1-pre-2026-06-13` (before executable dead-code pass) |
| **Local verify marker** | Page title `Photos Light — cleanup/dead-code` (`static/index.html`) |

**Restore anything:** `git checkout pre-cleanup-2026-06-13 -- path/to/file`

---

## Cleanup accomplishments — 2026-06-13 (`cleanup/dead-code`, `7929071`)

Five passes: dead-code removal (Passes 1–3), architecture fixes (Pass 4), repo hygiene (Pass 5).

| Metric (branch total) | Approx. |
|-----------------------|---------|
| Net lines removed | **~8,400** |
| Python files deleted | 5 |
| JS/HTML/CSS fragments removed | 3 overlays + ~2,600 lines `main.js` |
| Files relocated | 16 (9 mockups, 7 fixture scripts) |
| New tests | `test_catalog_revision.py`, startup/missing-folder cases in `test_db_health_consistency.py`; post-ship: `test_grid_read_cache.py`, `test_grid_handoff_contract.py` |
| New tools | `tools/smoke_grid_hydration.py` |

**Smoke (dev + packaged backend):** empty startup ✓ · Clean → grid ✓ · bulk date ✓ · `not_configured` on packaged boot ✓

**Verification:** `node --check static/js/main.js` OK; `./packaging/build.sh` OK → `dist/mac-arm64/Photos Light.app`; unittest — no new failures (8 pre-existing loader/DB-fixture errors).

### Pass 1 — Python snapshots & orphaned backend

**Deleted files**

| Path | Why safe |
|------|----------|
| `app_v1.py` | `launcher.py` imports `app` only |
| `library_sync_v1.py` | PyInstaller artifact; runtime uses `library_sync.py` |
| `db_schema_v1.py` / `db_schema_v2.py` | History; `db_schema.py` imports v3 only |
| `migrate_db_v1.py` | Superseded by `migrate_db.py` |

**Removed from `app.py`**

| Item | Why safe |
|------|----------|
| `GET/POST /api/utilities/update-index/scan` and `/execute` | No `static/` caller; Clean uses `make-perfect` |
| Duplicate `GET /api/library/current` (`library_current`) | Shadowed by first handler |
| `cleanup_empty_folders_recursive()` | Never called |
| `cleanup_terraform_source_folders()` | Deprecated; never called |

**Also:** `packaging/Backend.spec`, `packaging/Photos Light.spec`, `SCHEMA_VERSIONS.md` — dropped stale hiddenimports / noted v1/v2 file removal.

### Pass 2 — Fake debug overlay preview (`main.js`)

**Removed**

| Item | Why safe |
|------|----------|
| `debugFlowPreviewState`, `DEBUG_FLOW_*` | Timer simulators only |
| `runDebugFlowPreview`, `openDebugFlowPicker`, `simulateDebugInflightPhase`, etc. | No production caller |
| `cleanLibraryPreviewState` + `showPreview*` / fake log lines | Only debug preview |
| Debug branches in import/clean handlers | Preview-only guards |

**Kept**

| Item | Reason |
|------|--------|
| `SHOW_FIRST_RUN_DEBUG_BUTTON` + hidden button | Future dev hook (`false` today) |
| `openFirstRunDebugMenu()` | Empty stub; button onclick |
| `setImportDebugPreflightCounts` / `setTerraformDebugPreflightCounts` | Real import & convert preflight |
| `CLEAN_LIBRARY_PREVIEW_WORKING_STEPS` | Real clean working step labels |

### Pass 3 — Executable dead code, no UX (`phase1-pre-2026-06-13`)

Orphan debug overlays, uncalled helpers, and routes unreachable from `static/` or packaged UI. **No production flow changed** (bulk date edit via SSE kept).

| Metric | Approx. |
|--------|---------|
| Net lines removed | **~1,050** |
| Files deleted | 3 |
| `main.js` gross removal | ~900 lines |
| `app.py` items removed | 6 routes/helpers (~220 lines) |

**Deleted files**

| Path | Why safe |
|------|----------|
| `static/fragments/debugFileCountOverlay.html` | Only loaded by removed debug flow |
| `static/fragments/rebuildThumbnailsOverlay.html` | Menu entry removed Apr 2026; no caller |
| `test_debug_file_count_api.py` | Tests removed debug APIs |

**Removed from `main.js`**

| Item | Why safe |
|------|----------|
| `debugFileCountState`, `startDebugFileCountFlow()`, overlay helpers (~440 lines) | No menu entry; unreachable |
| `rebuildThumbnails()` + overlay helpers (~180 lines) | Menu removed; devtools-only |
| `showUnifiedErrorDetails` / `showRejectionDetails` | Zero call sites |
| `wirePhotoCards` / `wireMonthSelectors` | Deprecated stubs; `ensureGridInteractionsWired` owns wiring |
| `updateLightboxDimensions` | Empty deprecated stub |
| `DEBUG_CLICK_TO_LOAD` branch | Always `false`; pink overlay debug only |
| `previewOnly` flow-activity parameter plumbing | No caller passed `previewOnly: true` after Pass 2 |

**Removed from `app.py`**

| Item | Why safe |
|------|----------|
| `POST /api/debug/analyze-file-count` + helpers | Debug file-count overlay only |
| `POST /api/debug/scan-clean-library` | Same overlay only |
| `GET /api/utilities/check-thumbnails`, `POST /api/utilities/rebuild-thumbnails` | JS overlay removed |
| `cleanup_terraform_folders()` | Never called |

**Also:** `#debugFileCountOverlay` CSS block removed from `styles.css`.

**Kept (corrected)**

| Item | Reason |
|------|--------|
| `POST /api/photos/bulk_update_date` + `/execute` | **Production** bulk date edit SSE (`saveDateEdit`) |

**Verification:** `node --check static/js/main.js` OK; unittest — 163 run, 8 pre-existing loader/DB-fixture errors (no new failures).

### Pass 4 — Architecture fixes (production behavior)

Unified patterns per `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` — not tactical patches.

| Fix | What changed |
|-----|----------------|
| **Catalog reset tier** | `LIBRARY_CATALOG_REVISION` + `rehydrateLibraryCatalog()` after Clean / DB rebuild / library switch; bumps invalidate month-index and total-count caches |
| **Empty startup** | Removed `restore_library_session_from_config()` from `launcher.py` / `app.py`; config kept for `/api/library/last-used` only; missing folder → `reset_to_welcome_state()` → `not_configured` |
| **Clean scoreboards** | `setCleanLibraryOverlayPhase()` + `syncCleanLibraryScoreboards()` — one row visible per phase (preflight / inflight / legacy-audit); no stale Processed/Duplicates row on reopen |
| **Convert cancel** | `recoverLibraryUiAfterFlowCancel()` on convert/terraform cancel — clears handoff overlays, reloads grid or empty state |

**Docs:** `tech-docs/GRID_HYDRATION_BUGS.md` (fixed), `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` § Catalog reset, `bugs-to-be-fixed.md` tier-1 closed.

**Post-ship (same branch):** histogram mutation tier + Phase A→B handoff hardening — see **Grid sync & Phase A→B handoff** section below.

### Pass 5 — Repo hygiene

| Action | Detail |
|--------|--------|
| Root `*_mockup.html` → `archive/mockups/` | 9 design artifacts |
| Root `create_*.py` → `tools/fixtures/` | 7 one-off test library scripts |
| README links | `SETUP.md` / `TROUBLESHOOTING.md` → `archive/` paths |
| `init_db.py`, `archive/SETUP.md` | Updated fixture script paths |

`archive/` markdown corpus kept as historical reference (not deleted).

---

## Legacy clean engine removed — 2026-06-13

| Action | Detail |
|--------|--------|
| Deleted | `make_library_perfect_legacy.py` (~1,700 lines); `PHOTOS_CLEAN_LIBRARY_ENGINE=legacy` router branch |
| Added | `clean_library_media_utils.py` — shared verify/format helpers (breaks audit↔v2 circular import) |
| Tag | `clean-library-legacy-final` @ `7929071` — restore: `git checkout clean-library-legacy-final -- make_library_perfect_legacy.py` |
| Tests | Removed 3 pixel-dupe legacy tests; v2-only tests no longer gated on engine version |

---

## Grid sync & Phase A→B handoff — 2026-06-13 (post-7929071, same branch)

Follow-on work on `cleanup/dead-code` after smoke exposed import/cache and Clean/handoff grid bugs. Goal: **one policy per tier** (histogram mutation vs catalog reset), not per-flow patches.

| Metric (incremental) | Approx. |
|----------------------|---------|
| New / updated tests | `test_grid_read_cache.py`, `test_grid_handoff_contract.py`; `test_catalog_revision.py` tearDown uses `invalidate_grid_read_caches()` |
| Server helper | `invalidate_grid_read_caches()` in `app.py` |
| Client sync entry | `syncGridAfterHistogramChange()` in `main.js` |
| Retired from production paths | `VirtualGrid.applyMutationPatch` on delete; ad-hoc `loadAndRenderPhotos(false)` on import/undo without server invalidation |

### Histogram mutation sync contract (row-level ops)

Unified server + client contract per `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` § Grid mutation sync.

| Layer | What changed |
|-------|----------------|
| **Server** | `invalidate_grid_read_caches()` — single helper dropping `MONTH_INDEX_CACHE` + photo total count; wired on delete, date edit, restore, import (complete + partial cancel via `finally`), convert/terraform complete, and via `bump_library_catalog_revision()` / `reset_to_welcome_state()` |
| **Client** | `syncGridAfterHistogramChange(scrollTargetMonth?)` — virtual timeline → `VirtualGrid.refreshMonthIndex()` with scroll re-anchor; filtered/paged fallback → `loadAndRenderPhotos(false, { forcePaged })`; waits for in-flight `currentPhotoLoad` before syncing |
| **Wiring** | Date edit finalize, delete, undo date/delete, import complete/cancel follow-up, import overlay close — all through `syncGridAfterHistogramChange` |
| **Import repro fix** | Import → bulk date → re-import same files no longer requires server restart (stale `month_index` until invalidation was the root cause) |

**Date edit (client):** bulk/single SSE still updates `state.photos` via `applyDateEditPatch` during progress; timeline grid sync is **`refreshMonthIndex` on complete**, not mid-edit `applyMutationPatch` or scroll.

### Catalog reset / Phase A→B handoff (Clean, cold load, library switch)

Fixes for ghost-folder Clean → broken grid and hard-refresh duplicate top row (provisional DOM coexisting with refined DOM).

| Fix | What changed |
|-----|----------------|
| **Clean ordering** | `executeUpdateIndex()` — `await rehydrateLibraryCatalog({ throwOnError: true })` **before** `showCleanLibraryFinishedUi()` (grid rehydrates before “complete” UI) |
| **Committed load gate** | `hasCommittedPhotoRender()` — `loadAndRenderPhotosCommitted()` succeeds only when virtual grid is active and **not** provisional (no “hasDatabase alone” false success) |
| **Provisional teardown** | `clearProvisionalArtifacts()` — clears mounted months, anchor section, comfort tile layer before refined layout |
| **Refined handoff** | `applyRefinedIndex()` — on `wasProvisional`: clear artifacts, `rebuildLayoutFromIndex(..., { remount: true })`, scroll to anchor/first month |
| **Refresh handoff** | `refreshMonthIndex()` — scroll re-anchor after provisional→refined or when scroll exceeds new layout height |
| **Anchor vs month DOM** | `getMountedMonthSection()` targets `.virtual-month-section[data-month=…]` only; anchor uses `data-grid-anchor-truth` so hydration cannot hit the wrong node |

**Docs:** `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` — grid mutation sync section rewritten (two tiers, anti-patterns); status table row updated.

**Verification:** `node --check static/js/main.js` + `virtualGrid.js` OK; `python3 -m unittest test_grid_read_cache.py test_grid_handoff_contract.py test_catalog_revision.py` OK.

**Smoke (manual, pending full re-run):** ghost-folder Clean → single month section, no orphan top row · import 12 → date bulk → re-import 24 · hard refresh matches post-Clean grid.

---

## Intentionally not removed (defer)

| Item | Reason |
|------|--------|
| `POST /api/photo/update_date` | Undo path (`undoDateEdit`) |
| `POST /api/photos/bulk_update_date` + `/execute` | Bulk date edit SSE in `saveDateEdit` |
| `archive/` markdown | Historical; README links some paths |
| `archive/mockups/*.html` | Design artifacts (moved from repo root) |

---

## Known fragmentation (remaining)

- Clean Library UI still uses `updateIndex*` DOM/JS names while calling `make-perfect` APIs.
- First-run debug button is a stub; wire `openFirstRunDebugMenu()` when adding dev tools.
- `VirtualGrid.applyMutationPatch` remains exported in `virtualGrid.js` but is **not** wired from production `main.js` paths — remove or gate when handoff smoke is green.
- `test_grid_handoff_contract.py` is static (regex on source); no browser/integration test for full Phase A→B yet.
- Filtered grid still uses paged `renderPhotoGrid` path (`shouldUseVirtualGrid()` false when starred/video chips active) — parity not verified after handoff work.

## Resolved since Pass 4 (documented for traceability)

| Issue | Resolution |
|-------|------------|
| Import after date edit served stale `month_index` until server restart | Server `invalidate_grid_read_caches()` on import complete/cancel; client `syncGridAfterHistogramChange` |
| Clean / hard refresh ghost rows (provisional + refined DOM) | `clearProvisionalArtifacts`, anchor/month selector split, `remount: wasProvisional`, Clean awaits rehydrate before finished UI |
| `loadAndRenderPhotosCommitted` false success on provisional grid | `hasCommittedPhotoRender()` gate |
| Per-flow delete `applyMutationPatch` vs unified sync | Delete uses `syncGridAfterHistogramChange` only |

## Deferred (Phase 4)

- Rename `updateIndex*` → `cleanLibrary*` (Clean overlay DOM/JS)
- Decide fate of `operation_state.py` (keep — wired into library_sync/schema)
- CI grep for orphan routes; loader-failed test scripts
