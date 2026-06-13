# Grid hydration bugs (open)

Living doc for grid/API cache desync after **structural library changes** (Clean `photos_table_rebuilt`, bulk date moves). Discovered during smoke test on `cleanup/dead-code`, 2026-06-13.

**Not caused by Phase 1 dead-code removal** — pre-existing architecture gap between incremental grid patches and full DB rebuilds.

| | |
|---|---|
| **Status** | Fixed 2026-06-13 (catalog reset tier) |
| **Severity** | High (wrong grid counts / broken thumbnails after normal ops) |
| **Workaround (pre-fix)** | Close library → open same library again |
| **Fix** | Catalog reset tier — see `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` § Catalog reset |
| **Related** | `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` (incremental mutation design), `tech-docs/CLEAN_LIBRARY_V2_HANDOFF.md` (Clean flow) |

---

## Bug 1 — Clean Library finishes but grid shows stale subset

### Symptom

- Clean completes successfully (log: `photos_table_rebuilt`, `operation_complete`).
- Disk and DB agree (e.g. 145 photos on disk, 145 rows in `photos`).
- Grid shows far fewer items (e.g. ~6 visible months/sections).
- Hard refresh does **not** fix.
- **Close library → open same library** restores full grid.

### Repro (2026-06-13 smoke)

1. Open library with many files (e.g. `/Users/erichenry/Desktop/Photo Library/`).
2. Utilities → **Clean Library** → run to completion.
3. Observe grid vs folder:
   - `.logs/clean_library_*.jsonl`: `photos_table_rebuilt`, `row_count` matches DB.
   - `sqlite3 …/photo_library.db "SELECT COUNT(*) FROM photos;"` matches file count.
   - Grid under-represents months (e.g. missing 1900-01 bucket with 100 filed PNGs).

### Root cause

Two coupled gaps:

**Backend — session caches not invalidated after make-perfect**

- `PHOTO_TOTAL_COUNT_CACHE` and `MONTH_INDEX_CACHE` in `app.py` are cleared in `update_app_paths()` (library switch) and some mutation routes (delete, date edit).
- `POST /api/library/make-perfect/stream` and blocking `POST /api/library/make-perfect` **do not** call `invalidate_month_index_cache()` / `invalidate_photo_total_count_cache()` on completion, even when Clean runs `photos_table_rebuilt`.
- Subsequent `GET /api/photos`, `GET /api/photos/month_index` can return **pre-clean** totals until process restart or library switch.

**Frontend — Clean reload path is lighter than open-library**

- `executeUpdateIndex()` on success: `await loadAndRenderPhotos(false)` only (`main.js` ~9021).
- Open-library / recovery paths use `advanceLibraryGeneration()` + `loadAndRenderPhotosCommitted()` to avoid stale generation aborts and empty grids.
- Clean does not bump `libraryGeneration`, so virtual grid reload can lose against in-flight loads or serve cached API payloads.

### Code anchors

| Layer | Location |
|-------|----------|
| Clean finished → reload | `static/js/main.js` → `executeUpdateIndex()` |
| Open-library committed reload | `loadAndRenderPhotosCommitted()`, `advanceLibraryGeneration()` |
| Month index cache | `app.py` → `MONTH_INDEX_CACHE`, `get_cached_month_index()` |
| Cache invalidation on switch | `app.py` → `update_app_paths()` |
| Make-perfect stream (no invalidation) | `app.py` → `api_make_library_perfect_stream()` |
| Engine table rebuild | `make_library_clean_v2.py` → `photos_table_rebuilt` log event |

### Verify active library

Grid counts are per **configured session**, not “the folder you cleaned on disk”:

```javascript
fetch('/api/library/current').then(r => r.json()).then(console.log)
fetch('/api/photos?limit=1').then(r => r.json()).then(d => console.log('total', d.total))
fetch('/api/photos/month_index').then(r => r.json()).then(console.log)
```

Compare to:

```bash
sqlite3 "$DB" "SELECT COUNT(*) FROM photos;"
```

### Workaround

Close library → open the same path again (invalidates caches via `update_app_paths` + committed reload).

### Proposed fix

1. **Backend:** On make-perfect `done` (stream + blocking), call `invalidate_photo_total_count_cache()` and `invalidate_month_index_cache()`.
2. **Frontend:** After Clean success, `advanceLibraryGeneration()` then `loadAndRenderPhotosCommitted(generation)` (match open-library recovery).
3. **Test:** Clean on library with 100+ rows → assert `month_index.total` and grid card count match DB without re-open.

---

## Bug 2 — Bulk date edit completes but thumbnails 404 (ghost photo IDs)

### Symptom

- Bulk date edit (shift / same / sequence) completes; toast shows success.
- Console: repeated `GET /api/photo/{id}/thumbnail 404 (NOT FOUND)` (e.g. IDs 66039, 66044).
- Operation may otherwise appear correct.

### Repro (2026-06-13 smoke)

1. Library where Clean (or prior ops) ran `photos_table_rebuilt` **without** full grid rehydration (Bug 1), **or** grid still holds pre-rebuild DOM/state.
2. Select multiple photos → bulk date edit → complete.
3. Watch network tab for thumbnail requests using IDs that no longer exist in DB.

### Root cause

**Incremental patch design vs structural ID change**

- Bulk edit uses SSE + `applyDateEditPatch()` per progress event (`saveDateEdit` → `/api/photos/bulk_update_date/execute`).
- Intentional per `docs/GRID_OPTIMIZATION_ARCHITECTURE.md`: *“Bulk date edit applies each patch incrementally without blanking the grid.”*
- After `photos_table_rebuilt`, SQLite row **ids** and `current_path` values change; old `data-id` on `.photo-card` nodes and entries in `state.photos` can reference **removed ids**.
- `get_photo_thumbnail(photo_id)` returns 404 when `SELECT … WHERE id = ?` finds no row (`app.py` ~1470–1475).
- **Undo** path does full `loadAndRenderPhotos(false)`; bulk **complete** path does not.

Thumbnail 404 here is a **symptom of stale grid identity**, not a broken thumbnail generator (contrast `archive/TROUBLESHOOTING.md` path/permission causes).

### Code anchors

| Layer | Location |
|-------|----------|
| Bulk SSE + incremental patch | `static/js/main.js` → `saveDateEdit()`, `applyDateEditPatch()` |
| Undo full reload | `undoDateEdit()` → `loadAndRenderPhotos(false)` |
| Thumbnail 404 | `app.py` → `get_photo_thumbnail()` |
| Table rebuild | Clean engine → `photos_table_rebuilt` |

### Workaround

- Close library → open same library (fixes Bug 1 state), **then** bulk edit; or
- Hard reload after any Clean that rebuilt the photos table; or
- Avoid bulk edit until grid shows correct total.

### Proposed fix

1. **Primary:** Fix Bug 1 so grid ids match DB after Clean.
2. **Bulk complete:** On SSE `complete`, call `loadAndRenderPhotos(false)` with generation bump (or `ThumbnailQueue.clear()` + remount visible months) when any patch reported `duplicate_removed` or when session saw `photos_table_rebuilt` during the run.
3. **Optional guard:** If thumbnail 404 and photo id ∉ latest `state.photos`, trigger single-photo remount or full reload once.

---

## Smoke test notes (dead routes)

Removed Phase 1 routes are gone; use **GET** for console checks (POST to deleted APIs hits Flask static catch-all → **405**, not 404):

```javascript
await fetch('/api/debug/scan-clean-library').then(r => r.status)      // 404
await fetch('/api/utilities/check-thumbnails').then(r => r.status)   // 404
```

---

## Distinction from fixed / documented issues

| Doc | Overlap |
|-----|---------|
| `bugs-fixed.md` — “Database Rebuild - Empty Grid” | Fixed **corrupt DB rebuild** flow; not Clean `photos_table_rebuilt` + API cache. |
| `archive/TROUBLESHOOTING.md` — thumbnail 404 | Generic path/permission/DB mismatch; not ghost ids after rebuild. |
| `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` | Incremental bulk edit is **by design**; does not document post-rebuild desync. |
| `tech-docs/CLEAN_LIBRARY_V2_HANDOFF.md` | States “Finished UI → grid reloads” as **expected**; this doc tracks when reload is insufficient. |
