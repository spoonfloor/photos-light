# Bugs To Be Fixed

Last updated: June 21, 2026

**Prioritization lens:** Fix **single sources of truth and shared contracts** before flow polish (see `.cursor/rules/high-before-low.mdc`).

---

## Active queue

### Library open health — migration prompts & switch failure recovery

**Priority:** High (correctness + architecture)  
**Status:** Open  
**Batch:** Backend verification sweeps  
**Handoff:** `chat-transcripts-and-handoffs/photos-light-library-health-handoff.txt`

**Summary:** Users with legacy-schema databases can be stranded on a dead-end “Database needs migration” modal. The backend knows migration is needed, but the UI offers only **Open library** and **Reload** — neither runs migration. When switch auto-migrate fails, the client shows a generic error toast instead of the same recovery path as startup.

**Symptoms:**

- **Startup / reload:** `GET /api/library/status` returns `needs_migration` → critical-error modal with **Open library** + **Reload** only → **Reload** loops back to the same modal
- **Switch failure:** `POST /api/library/switch` returns 400 with `status: needs_migration`, `action: migrate` → `switchToLibrary()` treats it as a generic failure (toast), not migration recovery UI
- **Happy-path switch works:** Picker switch auto-migrates missing columns today; bug is the unwired failure/recovery paths and startup modal

**Root cause:**

- `build_library_status_payload()` does not expose `can_migrate` or `recommended_actions` from `DBHealthReport`
- No `POST /api/library/migrate` for the already-configured library path
- `showCriticalErrorModal('db_needs_migration')` has no migrate CTA (unlike `db_missing`, which offers **Rebuild database**)
- No shared frontend action router mapping health payloads → Migrate / Rebuild / Open library

**Target fix (one vertical slice):**

- One payload builder: `can_migrate`, `recommended_actions`, primary `action` from `db_health.py`
- New `POST /api/library/migrate` (backup before write, re-check health after)
- Wire startup modal + `switchToLibrary()` failure to migrate flow
- Contract tests in `test_db_health_consistency.py`

**Manual repro:**

1. Start dev server (`python3 launcher.py` or `cd electron && npm start`)
2. Create legacy DB: `create_photos_only_db(..., include_rating=False)` under a test folder’s `.library/photo_library.db`
3. Open any healthy library in the UI (loads session into backend)
4. Replace that library’s `.library/photo_library.db` with the legacy copy
5. Reload the page (do not restart backend) → dead-end migration modal; **Reload** loops

Switch failure repro: `chmod 444` on legacy test DB, then **Open library** → generic error toast, no migrate UI.

**Out of scope for this fix:** Picker “Create new” / empty-library UX, Open-library performance path, Add/Clean/Convert inflight errors, packaged `.app` rebuild unless verifying at the end.

**Definition of done:**

- Legacy library at startup: one button migrates DB and opens grid normally
- Switch to legacy library: auto-migrate still works; failure shows same migrate recovery UI as startup
- New/changed behavior covered by `test_db_health_consistency.py`
- No duplicate health classification outside `db_health.py` + one payload builder

**Related tracker items (same batch — mark done when shipped):**

- Handle migration prompts
- Health check on switch library

---

### Stars out of EXIF + star-blind duplicate identity

**Priority:** High (architecture + correctness)  
**Status:** Open  
**Batch:** Library kernel / metadata truth model  
**North star:** [`tech-docs/GREENFIELD_LIBRARY_DESIGN.md`](tech-docs/GREENFIELD_LIBRARY_DESIGN.md) C3 (overlay-only stars) — ship incrementally via DB first  
**Related:** Incremental compliance item explicitly deferred C3; this item prioritizes it.

**Summary:** Stop writing star/favorite ratings into media files. Store ratings as app truth only. Redefine duplicate identity so the same photo with and without a star rating is one duplicate group — only one copy may remain in the library.

**Problems today:**

- `set_photo_favorite_rating()` writes EXIF Rating, rehashes the file, and runs `finalize_mutated_media()` — starring can rename/move files and trigger duplicate trashing
- Duplicate key === raw `content_hash`; starred vs unst starred byte-identical photos (modulo rating tag) are treated as distinct assets
- Dual truth: `photos.rating` in DB **and** EXIF on disk; Clean strips `rating=0` but favorite flow re-writes EXIF

**Target fix (one vertical slice):**

1. **Rating SOT = DB only**
   - Favorite/star API updates `photos.rating` only; remove `write_exif_rating` / strip-from-favorite from mutation path
   - One-time migration: EXIF rating → DB backfill, then strip rating tags from library files (Clean / open reconcile)
   - Grid, filters, trash read stars from DB; UX unchanged modulo faster toggles (no exiftool round-trip)
   - Defer full overlay.log model unless export/agent requirements force it

2. **Star-blind `duplicate_key`**
   - Compute dedupe identity on canonicalized content **after** rating strip (reuse `photo_canonicalization` / compliance primitives)
   - Import, Clean dedupe, and post-mutation duplicate checks key off `duplicate_key`, not raw file hash
   - Winner selection unchanged (existing Clean sort / trash_loser policy); loser trashed regardless of which copy was starred
   - Starring must not change `duplicate_key`, `content_hash`, path, or thumbnail cache key

**Definition of done:**

- Toggling favorite does not call exiftool or `finalize_mutated_media`
- Library files contain no Rating / RatingPercent tags after migration pass
- Two copies of the same image differing only by star metadata collapse to one survivor on import/Clean
- Contract tests: star toggle is DB-only; import/Clean treat starred/unstarred pairs as dupes
- Document decision: DB-first rating store; greenfield overlay deferred

**Out of scope:** Full overlay.log.jsonl split, export sidecar for stars, perceptual/near-duplicate detection

---

### Incremental compliance-on-mutation (greenfield-inspired)

**Priority:** High (architecture + product)  
**Status:** Open  
**Batch:** Library kernel / cleanliness convergence  
**North star:** [`tech-docs/GREENFIELD_LIBRARY_DESIGN.md`](tech-docs/GREENFIELD_LIBRARY_DESIGN.md) (design reference — **not** a mandate to rewrite)  
**Handoff:** [`tech-docs/CLEANLINESS_SOT_HANDOFF.md`](tech-docs/CLEANLINESS_SOT_HANDOFF.md)

**Summary:** Reap greenfield’s main user-facing benefit in the **current codebase**: each mutation keeps the library compliant as it goes, and opening a library quietly reconciles drift — so **Clean Library is exceptional, not routine maintenance**. This is an incremental refactor inspired by greenfield §6–7 and §9, not a scorched-earth rebuild.

**User-facing outcome:**

- Healthy libraries: no multi-hour **Clean** after normal Add / date edit / rotate / Convert use
- Grid, paths, embedded dates, and DB stay aligned without manual rebuild/clean cycles
- **Verify & repair** remains for legacy libraries, external tampering (Finder, other apps), and first open of messy collections

**What already exists (don’t restart):**

- Shared per-file pipeline for Add, Convert, and much of Clean v2: `normalization_core.py`, `photo_canonicalization.py`, `normalization_ingest.py`, `normalization_convert.py`, `normalization_repair.py`
- Post-mutation finalizer for date edit: `media_finalization.py` → `finalize_mutated_media()`
- Cleanliness rules SOT direction: `library_cleanliness.py`, `library_metadata_compliance.py`, `clean_library_fast_audit.py`
- Clean v2 skip-unchanged on repeat runs (`make_library_clean_v2.py`)

**Incremental target (ship in slices):**

1. **One pipeline on every mutation** — Add, Convert, date edit, rotate, trash/restore all call the same probe → transform → embed → verify → hash → commit primitives; fail closed (no catalog commit if verify fails). Close known gaps (e.g. rotate not always moving to canonical path after hash change — see CLEANLINESS SOT handoff).
2. **Verify-after-write everywhere** — reuse `write_photo_date_metadata` verification pattern; no “mostly done” file state.
3. **Light reconcile on library open** — cheap background pass (inventory + small fixes); not a user-facing Clean job. Full repair stays explicit (**Verify & repair** utilities entry).
4. **Shrink Clean UX** — first open of legacy/messy libraries and user-initiated repair only; document that routine Clean should be unnecessary on compliant libraries.

**Out of scope for this initiative:**

- Full greenfield on-disk layout (`.library/overlay.log.jsonl`, split stores, `photo_id` UUID identity)
- Stars-out-of-EXIF overlay model (greenfield C3) — see **Stars out of EXIF + star-blind duplicate identity** above
- Kernel rewrite in Rust/Go or Electron shell change
- NAS/Wi‑Fi performance as primary goal (network-bound jobs see marginal gains; wired 2.5GbE helps either path)

**Cost–benefit: incremental refactor vs full greenfield**

| | **Incremental refactor (recommended)** | **Full greenfield rebuild** |
|---|---|---|
| **Primary user benefit** | Library stays correct without routine Clean; quiet open reconcile | Same, plus cleaner long-term truth model (overlay, export bundle, agent legibility) |
| **Engineering cost** | Medium — finish convergence on existing modules; wire remaining mutation paths; add open reconcile | Very high — new kernel, migration, full UX parity re-proof |
| **Time to value** | Ship vertical slices (rotate compliance, open reconcile, shrink Clean) | Long horizon before users see benefit |
| **Regression risk** | Lower — bounded diffs, existing tests (`test_make_library_perfect.py`, normalization tests) | Higher — big-bang parity gap during rebuild |
| **NAS batch-job speed** | Marginal on Wi‑Fi (~10–15% from subprocess batching); meaningful only with fast wired path + parallelism | Same — architecture doesn’t bypass network bytes |
| **Maintainability** | Good if SOT holds; some legacy structure remains | Best — modules, overlay log, exported rulebook |
| **When to choose** | **Default** — reaps ~80% of UX value at ~20% of cost | When overlay/export/agent migration becomes a hard product requirement |

**Definition of done:**

- Every production mutation path uses shared compliance primitives; no drift-only fixes in `app.py` one-offs
- Verify-after-write enforced; failed verify rolls back file + catalog
- Library open runs background reconcile; user is not prompted for Clean on a library that passes cheap health check
- Clean / **Verify & repair** documented and scoped to legacy, tampering, and repair — not day-to-day hygiene
- Rotate, date edit, Add, Convert covered by contract tests; no canonical-path/hash drift after mutation

**Related docs:**

- [`tech-docs/GREENFIELD_LIBRARY_DESIGN.md`](tech-docs/GREENFIELD_LIBRARY_DESIGN.md) — inspiration; §6 operations map, §7 performance, §8–9 invariants
- [`tech-docs/CLEANLINESS_SOT_HANDOFF.md`](tech-docs/CLEANLINESS_SOT_HANDOFF.md) — existing incremental plan (“one SOT, many orchestrators”)
- [`tech-docs/CLEAN_LIBRARY_V2_HANDOFF.md`](tech-docs/CLEAN_LIBRARY_V2_HANDOFF.md) — current Clean engine; should shrink as compliance-on-mutation lands
