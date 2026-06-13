# Architecture Fragmentation Audit

Living document: fragmentation hotspots, dead paths, and cleanup history.

| | |
|---|---|
| **Branch** | `cleanup/dead-code` |
| **Checkpoint tag** | `pre-cleanup-2026-06-13` (commit `b83452d`) |
| **Phase 1 tag** | `phase1-pre-2026-06-13` (before executable dead-code pass) |
| **Local verify marker** | Page title `Photos Light — cleanup/dead-code` (`static/index.html`) |

**Restore anything:** `git checkout pre-cleanup-2026-06-13 -- path/to/file`

---

## Cleanup accomplishments — 2026-06-13 (`cleanup/dead-code`)

Two passes, safest dead code only. No production UI or default-env behavior changed.

| Metric (vs tag) | Approx. |
|-----------------|---------|
| Net lines removed | **~6,700** |
| Python files deleted | 5 |
| `app.py` items removed | 4 (~270 lines) |
| `main.js` gross removal | ~1,700 lines |
| PyInstaller hiddenimports dropped | 4 |

**Verification:** `node --check static/js/main.js` OK; unittest suite — no new failures (pre-existing loader/DB-fixture errors only).

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

---

## Intentionally not removed (defer)

| Item | Reason |
|------|--------|
| `make_library_perfect_legacy.py` | `PHOTOS_CLEAN_LIBRARY_ENGINE=legacy`; PyInstaller bundle |
| `POST /api/photo/update_date` | Undo path (`undoDateEdit`) |
| `POST /api/photos/bulk_update_date` + `/execute` | Bulk date edit SSE in `saveDateEdit` |
| `archive/` markdown | Historical; README links some paths |
| Root `*_mockup.html` | Harmless design artifacts |

---

## Known fragmentation (remaining)

- Clean Library UI still uses `updateIndex*` DOM/JS names while calling `make-perfect` APIs.
- Legacy clean engine (`make_library_perfect_legacy.py`) remains beside v2 default.
- First-run debug button is a stub; wire `openFirstRunDebugMenu()` when adding dev tools.

## Phase 2 — repo hygiene (2026-06-13)

| Action | Detail |
|--------|--------|
| Root `*_mockup.html` → `archive/mockups/` | 9 design artifacts |
| Root `create_*.py` → `tools/fixtures/` | 7 one-off test library scripts |
| README links | `SETUP.md` / `TROUBLESHOOTING.md` → `archive/` paths |

`archive/` markdown corpus kept as historical reference (not deleted).
