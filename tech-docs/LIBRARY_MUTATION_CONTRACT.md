# Library Mutation Contract

Canonical contract for **cleaning-engine mutations**: operations that touch library files on disk, reconcile the SQLite index, and update the grid UI.

This document extends the grid sync tiers in `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` with the **file-as-SOT UX contract** and execution order aligned with `.cursor/rules/high-before-low.mdc`.

Phrase to remember:

**File is source of truth. DB mirrors the file. UI is optimistic; failures revert.**

---

## Why this exists

Cleaning operations (star, date edit, rotate, delete, import row changes, restore, convert ingest) are **slow by nature**, especially on large libraries over network volumes. Each operation today wires its own:

- optimistic UI apply / revert
- API call and error handling
- `state.photos` updates
- grid cache sync (`syncGridAfterHistogramChange`)
- server histogram invalidation (`invalidate_grid_read_caches`)

That duplication produced real bugs (e.g. star toggle not invalidating `month_index`, inconsistent revert behavior, DB/EXIF drift). The fix is **one contract, many orchestrators** — not a fourth per-flow helper.

---

## Priority order (high → low)

When implementing or fixing mutations, follow this order from `high-before-low.mdc`:

| Priority | Work | Examples |
|----------|------|----------|
| **1. Architecture & SOT** | Unify mutation contract before per-flow patches | Shared client runner + server success hook; file verify before DB commit |
| **2. Product anatomy** | Same preflight / inflight / complete phases across flows | Instant optimistic surface → progress where needed → complete + bookkeeping |
| **3. Production parity** | Production flows use the same contract as reference paths | No debug-only sync helpers |
| **4. Correctness** | Wire missing invalidations, revert paths, bulk partial failure | Star/favorite cache invalidation; ghost file rows |
| **5. Polish** | Copy, CSS, micro-optimizations | Toast wording, badge animation |

**Stop and go higher** if you are about to:

- Add a new one-off revert/sync helper for a single flow while siblings still use the old pattern
- Fix a starred-filter symptom without wiring the shared server invalidation hook
- Make DB primary over file for toggle direction while file remains the persistence SOT

---

## Non-negotiable invariants

### 1. File is source of truth

- Embedded metadata on disk (EXIF, QuickTime atoms, etc.) is authoritative.
- `photos.*` columns are an **index** that must mirror the file after a successful mutation.
- Never commit DB state that disagrees with a verified file read-back.

### 2. Fail closed

- If file write or verify fails → **no DB commit** for that row (or full transaction rollback).
- Client **reverts** optimistic UI and shows an error toast.
- Toasts on failure are correct; the goal is to **eliminate ordinary failures** (NAS reliability, ghost paths, missing invalidations) — not to hide failures.

### 3. Optimistic UI, honest completion

Universal sequence:

```
1. applyOptimistic()     — instant visual change (where visually possible)
2. execute()             — slow cleaning-engine work (API / SSE)
3. on success:
     — leave optimistic UI as-is (do not flicker)
     — run bookkeeping only (state, caches, grid sync)
4. on failure:
     — revertOptimistic()
     — error toast (and partial-failure detail for bulk)
```

Date change and bulk ops use **progress overlays** for step 1 instead of faking final grid layout — same contract, different surface.

### 4. Two grid sync tiers (unchanged)

Do not conflate row mutations with catalog resets. See `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` § Grid mutation sync.

| Tier | When | Server | Client |
|------|------|--------|--------|
| **Row mutation** | Same catalog; histogram or row fields change | `invalidate_grid_read_caches()` on success | `syncGridAfterHistogramChange(scrollTargetMonth?)` |
| **Catalog reset** | Photos table rebuilt, library switch, make-perfect SUCCESS | `bump_library_catalog_revision()` | `rehydrateLibraryCatalog()` |

Row-level mutators must **not** bump `LIBRARY_CATALOG_REVISION`. Catalog resets must **not** rely on `refreshMonthIndex` alone.

---

## Server contract

### Pipeline (cleaning engine)

Every row-level file mutation should follow this order unless documented otherwise:

```
1. Resolve row → full path; fail 404 if missing on disk
2. Write embedded metadata (exiftool / ffmpeg / rotation pipeline)
3. Verify read-back where policy requires it (dates; ratings after write)
4. finalize_mutated_media() when bytes, hash, or canonical path may change
5. UPDATE photos SET … (rating, date_taken, path, hash, dimensions, etc.)
6. conn.commit()
7. invalidate_grid_read_caches()          ← required on success
8. Return consistent JSON (photo patch + flags like duplicate_removed)
```

**Metadata-only vs content mutations**

- **Date edit** — metadata write always changes bytes → rehash required → canonical path may change (new date folder + filename). Slowness from move + hash over NAS is expected; avoid *redundant* passes (duplicate orientation bake, unverified writes).
- **Star / rating** — small metadata write changes bytes; rehash may be required for canonical filename suffix. Optimize the pipeline for reliability, not by skipping verify or DB commit.
- **Rotate** — content mutation; full finalize path required.

There is **no** honest “path rename without rehash” after a metadata write: changing embedded metadata changes file bytes, so content hash must be recomputed before updating the canonical path.

### Success hook (single entry)

All row mutators that affect grid histogram or filter counts must call **`invalidate_grid_read_caches()`** after a successful commit.

Current wiring (audit as of 2026-06):

| Mutator | Invalidates cache on success? |
|---------|-------------------------------|
| Delete | ✅ |
| Restore | ✅ |
| Date edit (single + bulk SSE) | ✅ |
| Import complete / cancel | ✅ |
| Convert / terraform complete | ✅ |
| Toggle favorite | ✅ |
| Bulk favorite | ✅ — delegates to the same verified per-photo favorite contract |
| Rotate | ✅ |

New mutators must use the same hook. Use `commit_row_mutation(conn, *, invalidate_histogram=True)` rather than scattering raw `commit()` + invalidation calls.
Delete and restore are file-first row mutations: verify the move succeeded before changing the DB row, and roll the file move back if row archival/restore fails.

### Error shape

Return stable JSON for the client runner:

```json
{ "error": "human-readable message", "status": "error" }
```

Include structured flags when the engine handled a special case:

```json
{ "duplicate_removed": true, "message": "…" }
```

Log failures to `errors.log` under `{library}/.logs/` with photo id and path.

---

## Client contract

### Single entry: `runLibraryMutation`

Implement one client helper (name illustrative) in `static/js/main.js` or a small `libraryMutation.js` module. All production cleaning flows call through it.

```javascript
/**
 * @typedef {Object} LibraryMutationOptions
 * @property {() => void} applyOptimistic
 * @property {() => void} revertOptimistic
 * @property {() => Promise<MutationResult>} execute
 * @property {(result: MutationResult) => Promise<void>|void} [onSuccess]
 * @property {(error: Error, result?: MutationResult) => void} [onFailure]
 * @property {string} [failureToast] — default generic message
 * @property {boolean} [skipGridSync] — rare; prefer onSuccess calling sync
 */

async function runLibraryMutation(options) {
  options.applyOptimistic();
  try {
    const result = await options.execute();
    if (!result.ok) {
      throw new Error(result.error || 'Mutation failed');
    }
    if (options.onSuccess) {
      await options.onSuccess(result);
    }
    return result;
  } catch (error) {
    options.revertOptimistic();
    showToast(options.failureToast || error.message || 'Operation failed', null);
    if (options.onFailure) {
      options.onFailure(error);
    }
    throw error;
  }
}
```

**Bookkeeping on success** (default `onSuccess` where applicable):

1. Patch `state.photos` for affected ids (including `rating`, `date`, `path`, `month`).
2. Invalidate VirtualGrid month cache for touched months (`monthCache` entries) when row fields used by mounted cards change.
3. `await syncGridAfterHistogramChange(scrollTargetMonth)` for row-tier ops.
4. Handle `duplicate_removed` (close lightbox, sync grid, informational toast — not an error revert).

Do **not** re-apply optimistic UI on success.

### Grid sync entry (existing)

Keep **`syncGridAfterHistogramChange`** as the only row-tier grid sync. It already:

- Waits for in-flight photo load
- Calls `VirtualGrid.refreshMonthIndex` with active filter options when virtual grid is active
- Falls back to `loadAndRenderPhotos(false)` when not

New mutations must not call `loadAndRenderPhotos(false)` or `VirtualGrid.applyMutationPatch` directly.

### Operation variants

| Operation | Optimistic surface | execute | onSuccess notes |
|-----------|-------------------|---------|-----------------|
| **Star toggle** | Star icon + grid badge | `POST /api/photo/:id/favorite` | Patch `rating`; sync grid; active filter → `applyPhotoFilters` |
| **Date edit (single)** | Close editor; progress overlay | SSE or POST update_date | `applyDateEditPatch`; scroll target month |
| **Date edit (bulk)** | Progress overlay | bulk SSE | Per-row patch; sync once on complete |
| **Rotate (lightbox)** | Staged preview (already local) | `POST …/rotate` on leave | `applyCommittedPhotoUpdate`; thumbnail refresh |
| **Delete** | Selection / card removal | `POST /api/photos/delete` | sync grid |
| **Restore / undo delete** | — | restore API | sync grid |
| **Import row complete** | — | import SSE complete | sync grid |
| **Clean / make-perfect** | Overlay phases | stream | **`rehydrateLibraryCatalog`** (catalog tier) |

Bulk: if some rows fail, revert optimistic state **only for failed ids** and toast with success/failure counts.

---

## Cleaning engine modules (server — many orchestrators, one contract)

File mutations stay in existing Python modules; the contract wraps them — it does not replace them.

| Concern | Module / function |
|---------|-------------------|
| Date write + verify | `media_dates.write_and_verify_media_date`, `update_photo_date_with_files` |
| Rating read/write | `file_operations.extract_exif_rating`, `write_exif_rating`, `strip_exif_rating` |
| Hash / path / duplicate policy | `media_finalization.finalize_mutated_media` |
| Canonical paths | `library_cleanliness.build_canonical_photo_path` |
| Rotation | `app.rotate_photo` + finalize |
| Whole-library repair | `make_library_perfect`, `make_library_clean_v2` (catalog tier) |

Orchestrators call these; they do not reimplement EXIF or path rules inline in route handlers.

---

## Execution plan (recommended order)

Use this when fixing star/filter slowness and sibling mutations. Do not skip higher items for a lower symptom.

### Phase 1 — Architecture (server)

1. Add `commit_row_mutation` (or document mandatory post-commit invalidation) and wire **favorite**, **bulk-favorite**, **rotate**, **delete**, **restore**, and **date edit** routes.
2. Ensure favorite toggle uses **verified** post-write rating before DB update (file SOT).
3. Audit all `@app.route` row mutators against the invalidation table above.

### Phase 2 — Architecture (client)

1. Introduce `runLibraryMutation`.
2. Migrate **star toggle** first (smallest surface, current bug repro).
3. Use per-photo serialized, cross-photo capped settlement for high-frequency row intents.
4. Migrate delete, rotate commit, restore to the runner (same pattern, delete regressions).

### Phase 3 — Correctness

1. Fix VirtualGrid `monthCache` / `mergePhotosIntoVirtualState` to **update** existing photo fields on mutation success, not only append new ids.
2. Ghost rows: fail fast with clear toast; optional hygiene job for DB paths with no file.
3. Bulk partial-failure handling in runner.

### Phase 4 — Reliability (NAS / large library)

1. exiftool stderr logging and retries on transient NAS errors.
2. Timeouts scaled to file size where needed.
3. Metadata-only mutation profiling — remove redundant orientation bake / duplicate passes on date edit when unchanged.

### Phase 5 — Polish

- Toast copy, undo affordances, progress ETA copy.

---

## Testing

### Automated (required for contract changes)

| Test | Purpose |
|------|---------|
| `test_grid_read_cache.py` | Server invalidation after row mutators; starred `month_index` |
| `test_toggle_favorite.py` | Favorite finalize + DB fields |
| `test_media_date_contract.py` | Date write verify policy |
| `test_media_finalization.py` | Hash/path/duplicate after mutation |

Add: favorite toggle invalidates cache (extend `test_grid_read_cache`).

### Manual (NAS / packaged app)

From `.cursor/rules/rebuild-app-for-prod-testing.mdc`: rebuild `./packaging/build.sh` before prod verification.

1. Star photo on network library → filter chip shows count without restart.
2. Unstar → filter updates; restart → state persists.
3. Bulk date edit → grid re-anchors; no stale month_index after import.
4. Failure case: read-only or missing file → optimistic revert + toast, DB unchanged.

---

## Anti-patterns

| Do not | Do instead |
|--------|------------|
| Per-flow `loadAndRenderPhotos(false)` after mutation | `syncGridAfterHistogramChange` |
| DB-first star without file verify | Write + verify file, then DB |
| Toggle direction from stale EXIF while DB differs | Read verified file state or DB written only after verify |
| Skip `invalidate_grid_read_caches` on row success | Always call on successful commit |
| Bump catalog revision on star/delete/date | Row tier: invalidate histogram only |
| New debug-only sync path | Same runner in prod and debug |
| Stack star-only cache fix without shared hook | Phase 1 server hook + Phase 2 client runner |

---

## References

- Grid sync tiers: `docs/GRID_OPTIMIZATION_ARCHITECTURE.md` § Grid mutation sync
- Fragmentation audit: `tech-docs/ARCHITECTURE_FRAGMENTATION_AUDIT.md`
- Cleanliness SOT: `tech-docs/CLEANLINESS_SOT_HANDOFF.md` (rules SOT; this doc is mutation **orchestration** SOT)
- High-before-low rule: `.cursor/rules/high-before-low.mdc`
- Server: `app.py` — `invalidate_grid_read_caches`, `update_photo_date_with_files`, `toggle_favorite`, `finalize_mutated_media`
- Client: `static/js/main.js` — `syncGridAfterHistogramChange`, `wireLightbox` star handler, `saveDateEdit`
- Tests: `test_grid_read_cache.py`, `test_toggle_favorite.py`
