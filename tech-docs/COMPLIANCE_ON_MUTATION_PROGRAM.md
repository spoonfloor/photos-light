# Compliance-on-Mutation Program

**Status:** Core program complete (Phases A–D verification green — 2026-08-12)  
**Last updated:** August 12, 2026  
**Tracker:** [`bugs-to-be-fixed.md`](../bugs-to-be-fixed.md) (active queue items cross-reference this doc)  
**North star:** [`GREENFIELD_LIBRARY_DESIGN.md`](GREENFIELD_LIBRARY_DESIGN.md) §6–9, C3, C8 — incremental, not scorched-earth  
**Prioritization:** [`.cursor/rules/high-before-low.mdc`](../.cursor/rules/high-before-low.mdc)

---

## Checkpoint / rewind (do this before Phase A)

Establish a restore point **before the first implementation slice**. Follows the same pattern as `pre-cleanup-2026-06-13` in [`ARCHITECTURE_FRAGMENTATION_AUDIT.md`](ARCHITECTURE_FRAGMENTATION_AUDIT.md).

### 1. Commit the program baseline (documentation only)

Commit at minimum:

- `tech-docs/COMPLIANCE_ON_MUTATION_PROGRAM.md`
- `bugs-to-be-fixed.md` (cross-links + stars migration wording)

This commit is **plan-only** — no behavior change — so it is a safe, readable baseline.

### 2. Tag that commit

```bash
git tag -a pre-compliance-on-mutation-2026-08-12 -m "Baseline before compliance-on-mutation program (plan committed)"
git push origin pre-compliance-on-mutation-2026-08-12   # optional, for remote backup
```

Replace the date if tagging on a different day.

### 3. Implement on a feature branch

```bash
git checkout -b feature/compliance-on-mutation
```

Do **not** land slices directly on `main` until smoke passes. One tag at start is enough for full rewind; add mid-program tags only before risky slices if desired (e.g. `pre-stars-db-only`).

### Restore options

| Goal | Command |
|------|---------|
| **Whole tree → baseline** | `git checkout pre-compliance-on-mutation-2026-08-12 -- .` then commit, or `git reset --hard pre-compliance-on-mutation-2026-08-12` on the feature branch (destructive) |
| **Single file → baseline** | `git checkout pre-compliance-on-mutation-2026-08-12 -- path/to/file` |
| **Abandon feature branch** | `git checkout main` · `git branch -D feature/compliance-on-mutation` |

Packaged app rewind: rebuild from the tag — `./packaging/build.sh` — then test `dist/mac-arm64/Photos Light.app` ([rebuild rule](../.cursor/rules/rebuild-app-for-prod-testing.mdc)).

### What the tag does *not* protect

- **Library data on disk** — mutations change `.library/` and media files. Tag rewinds **code**, not user libraries. Use existing DB backup behavior (`POST /api/library/migrate` backup, Clean checkpoints) before risky slices on real libraries.
- **Uncommitted work** — tag only captures committed state.

---

## Mission

Make **normal library use** keep the library healthy — so **Clean Library is exceptional, not routine maintenance**.

Each mutation (Add, date edit, rotate, Convert, trash/restore) applies the **same cleanliness rulebook** Clean uses today, on only the files touched. Opening a library runs a **cheap background reconcile** for external drift. **Starring** moves to DB-only truth and stops mutating files.

Phrase to remember:

**One rulebook, many orchestrators. Clean applies the full rulebook to everything; everyday actions apply it per file.**

---

## Non-negotiables

1. **One definition of clean** — Inspect, open reconcile, mutations, and Clean must consume the same predicates from shared modules (`library_cleanliness.py`, `library_metadata_compliance.py`, `normalization_contract.py`, `media_dates.py`). No flow-specific “good enough.”

2. **Stars are in scope** — DB-only toggles and star-blind duplicate identity are **prerequisites**, not a follow-up. Starring today **breaks** compliance-on-mutation (`set_photo_favorite_rating` → EXIF write → rehash → `finalize_mutated_media`).

3. **No library-wide EXIF star strip** — Leave legacy rating tags on disk. Stop writing new ones; ignore them for app truth and dedupe. Strip rating tags **lazily** only when a file is already in the repair pipeline (date edit, rotate, Clean repair on that file).

4. **Fail closed on file mutations** — Verify-after-write; no DB commit if file verify fails. Client reverts optimistic UI ([`LIBRARY_MUTATION_CONTRACT.md`](LIBRARY_MUTATION_CONTRACT.md)).

5. **No added daily burden** — Optimistic UI for instant feedback; background reconcile on open; stars get **faster** (no exiftool round-trip).

---

## User-facing outcome (current vs after)

| | **Today** | **After** |
|---|-----------|-----------|
| **Routine hygiene** | Periodic multi-hour **Clean** to catch drift | Normal use keeps library aligned |
| **Star a photo** | Rewrites EXIF, may rehash/rename/trash dupes | DB update only; instant |
| **Date edit / rotate** | Partial compliance; rotate may leave wrong path | Full pipeline: embed → verify → hash → canonical path |
| **Open library** | Grid loads; drift accumulates silently | Grid loads; cheap background reconcile |
| **Clean Library** | Expected maintenance | Legacy mess, tampering, or explicit **Verify & repair** only |
| **External edits** (Finder, other apps) | Found only on next Clean | Caught on open reconcile or Inspect |

---

## Why Clean shrinks (without fragmenting “clean”)

**Clean** today is the only pass that reliably fixes the whole library. **After**, the same rules run:

- **On touch** — every file mutation uses shared normalization / finalization primitives.
- **On open** — background reconcile applies the same rulebook to dirty deltas.
- **On demand** — Clean / Verify & repair runs the **full** rulebook on every file (unchanged semantics, exceptional use).

Clean is not a different standard — it is the **batch application** of the same standard.

---

## Scope

### In program (core)

| Slice | Tracker item |
|-------|----------------|
| Library open / switch / migrate recovery | Library open health |
| DB-only stars + star-blind `duplicate_key` | Stars out of EXIF |
| One pipeline on every **file** mutation | Incremental compliance-on-mutation |
| Embed date taken (incl. 1900 unknown) on repair paths | Clean must embed date taken |
| Background open reconcile | Incremental compliance-on-mutation |
| Shrink Clean UX + align audit predicates | Incremental compliance-on-mutation |

### Related but separate (same batch, own handoffs)

| Item | Notes |
|------|-------|
| **Fast Inspect library** | Read-only confidence engine; reuses same audit predicates |
| **Convert resume** | Checkpoint parity with Clean v2; defer unified job runtime |

### Out of scope

- Full greenfield layout (overlay.log, split stores, UUID `photo_id`)
- Library-wide EXIF rating strip migration
- Export sidecar for stars
- Kernel rewrite (Rust/Go) or shell change
- NAS performance as primary goal

---

## Execution order

Do **not** treat slices as interchangeable. Order below matches high-before-low.

```
Phase A — Unblock & stop active harm          (~3–5 agent passes)
  1. Library open health (migrate API, modal, switch)
  2. Stars: DB-only toggle
  3. Star-blind duplicate_key (normalization_contract + import/Clean/finalize)

Phase B — File mutation convergence             (~4–6 agent passes)
  4. Rotate → full finalize (canonical path after hash change)
  5. Audit remaining mutators → shared pipeline (trash/restore, app.py one-offs)
  6. Embed dates on all writable repair/mutation paths (1900 fallback)

Phase C — Passive maintenance & product         (~3–5 agent passes)
  7. Open reconcile (background on library open)
  8. Audit rule alignment + lazy rating strip when file already touched
  9. Shrink Clean UX (health gate, copy, when-to-Clean docs)

Phase D — Verification                          (~2–3 agent passes)
  10. Contract tests + dev smoke + packaged .app rebuild
```

**Estimated total:** **12–16 focused agent passes** for the core program. Add **~6 passes** if Fast Inspect and Convert resume stay in scope (**18–22** full batch).

One **agent pass** = one vertical slice, tests, dev smoke, brief handoff — not full NAS regression every time.

---

## Slice specifications

### 1. Library open health

**Handoff:** [`chat-transcripts-and-handoffs/photos-light-library-health-handoff.txt`](../chat-transcripts-and-handoffs/photos-light-library-health-handoff.txt)

- Expose `can_migrate`, `recommended_actions` from `db_health.py` via one payload builder
- `POST /api/library/migrate` (backup before write, re-check health after)
- Wire startup modal + `switchToLibrary()` failure to migrate flow
- Contract tests in `test_db_health_consistency.py`

**Gate:** Users with legacy schema can migrate and open without a dead-end modal.

---

### 2. Stars — DB-only (greenfield C3, incremental)

**Problems today:**

- `set_photo_favorite_rating()` in `app.py` writes EXIF, rehashes, runs `finalize_mutated_media()`
- Dual truth: `photos.rating` and EXIF; Clean strips `rating=0` but favorite re-writes EXIF
- Star toggle is the opposite of “clean as you go”

**Target:**

- Favorite/star API updates `photos.rating` only — no `write_exif_rating`, no `finalize_mutated_media`
- Grid, filters, trash read stars from DB; UX unchanged except faster toggles
- Optional **read-only** backfill: EXIF → DB where DB is empty and EXIF has rating (no file writes)

**Legacy EXIF on disk:**

- **Leave alone** — do not walk the library stripping tags
- App ignores EXIF for star state going forward
- When a file is already being repaired, strip any rating tag as part of existing metadata compliance (same rulebook as `rating=0`)

**Definition of done:**

- Toggle favorite: no exiftool, no path/hash change
- Contract tests: star toggle is DB-only

**Deferred:** overlay.log, export sidecar

---

### 3. Star-blind duplicate identity

**Status:** Shipped (Phase A slice 3 — 2026-08-12)

**Problems addressed:**

- `duplicate_key ===` raw `content_hash`; starred vs unstarred byte-identical photos are distinct assets
- Starring could change hash and trigger duplicate trashing (also fixed by slice 2 DB-only stars)

**Shipped:**

- `compute_duplicate_key` hashes after logical Rating/RatingPercent strip (temp copy only — library file untouched)
- Import photo ingest, Clean dedupe (via shared key), and `finalize_mutated_media` look up collisions by star-blind key
- `content_hash` / path / thumb cache key remain raw storage identity; starring (DB-only) does not change them
- Contract tests: `test_star_blind_duplicate_key.py`

---

### 4. One pipeline on every file mutation

**Handoff:** [`CLEANLINESS_SOT_HANDOFF.md`](CLEANLINESS_SOT_HANDOFF.md)

Shared sequence (from [`LIBRARY_MUTATION_CONTRACT.md`](LIBRARY_MUTATION_CONTRACT.md)):

```
resolve path → write/transform → verify read-back → finalize_mutated_media (if bytes/path changed)
→ UPDATE photos → commit → invalidate_grid_read_caches()
```

**Slice 4 (rotate) — shipped 2026-08-12:**

- `rotate_photo()` commits through `finalize_mutated_media` (hash, dimensions, canonical path)
- HEIC→TIFF: source HEIC removed only after successful DB commit (fail-closed)
- Abandoned folders cleaned after path rename (`cleanup_empty_date_folders`)
- Contract tests: `test_rotate_photo.py`, `test_rotation_heic.py`

**Slice 5 (trash/restore) — shipped 2026-08-12:**

- Delete/restore stay file-first with verify-before-DB; restore rolls file back into trash if catalog write fails
- Restore helper no longer mid-commits — route owns `commit_row_mutation`
- Restore lands on shared canonical path (`build_canonical_photo_path`) when date+hash present
- Trash archive + restore merge use star-blind identity (same duplicate_key as import/Clean)
- Contract tests: `test_trash_view.py`, `test_date_added.py` restore path

**Still open (later slices):**

- Phase D verification / packaged `.app` rebuild

**Existing building blocks (reuse, do not restart):**

- `normalization_core.py`, `photo_canonicalization.py`
- `normalization_ingest.py`, `normalization_convert.py`, `normalization_repair.py`
- `media_finalization.py` → `finalize_mutated_media()`
- `library_cleanliness.py`, `library_metadata_compliance.py`
- Client: `static/js/libraryMutation.js` (extend toward unified settlement)

**Definition of done (full Phase B pipeline):**

- Add, Convert, date edit, rotate, trash/restore use shared compliance primitives
- No drift-only fixes in `app.py` one-offs
- Contract tests: no canonical-path/hash drift after mutation

---

### 5. Embed date taken (1900 fallback)

**Status:** Shipped (Phase B slice 6 — 2026-08-12)

**Related criterion:** `library_cleanliness.py` TBD #1 (usable library date)

When resolving `date_taken` via `media_dates.py`, writable containers get embedded metadata matching DB — including `1900:01:01 00:00:00` for unknown dates.

**Shipped:**

- `ensure_embedded_media_date` / `file_needs_embedded_date_repair` in `media_dates.py`
- Clean/Convert compliance + Clean skip path detect and repair missing/mismatched embeds
- Video repair scan embeds via shared writer; identity uses `read_media_date(..., allow_mtime_fallback=False)`
- Contract tests: `test_media_date_contract.CleanRepairEmbedDateContractTest` (photo 1900 + basename + mkv writer path)

**Definition of done:**

- Clean-repaired writable files have embedded date matching DB
- `test_media_date_contract.py` (or Clean contract tests) cover photo + one video writer path

---

### 6. Open reconcile (background)

**Status:** Shipped (Phase C slice 7 — 2026-08-12)

Cheap background pass on library open:

- Inventory + dirty delta (stat-only: ghosts, moles, `file_size` drift)
- Applies **same** auto-fix metadata rulebook as Clean/Convert (`repair_file_metadata_compliance`) to size-drifted files; removes ghost rows
- **Not** user-facing; no blocking modal — scheduled from `update_app_paths` / library switch
- Mole *detection* only (indexing stays Clean/Import); full Clean UX shrink is slice 9

**Shipped:**

- `library_open_reconcile.py` — `collect_open_reconcile_delta`, `run_open_reconcile`, `schedule_open_reconcile_background`
- State file `.library/open_reconcile_state.json` (allowed metadata)
- Contract tests: `test_library_open_reconcile.py`

**Definition of done:**

- Open library does not block on reconcile
- Reconcile uses shared audit/repair predicates only

---

### 7. Audit alignment + lazy rating strip

**Status:** Shipped (Phase C slice 8 — 2026-08-12)

Shared auto-fixable metadata kinds for Clean audit + compliance, plus lazy EXIF star strip only when a file is already being rewritten.

**Shipped:**

- `collect_auto_fixable_metadata_issues` / `AUTO_FIXABLE_METADATA_KINDS` in `normalization_repair.py` (`rating_zero`, `unbaked_rotation`, `embedded_date_mismatch`)
- `clean_library_fast_audit.py` + `library_metadata_compliance.py` consume the same kinds
- Lazy strip of **any** EXIF Rating/RatingPercent during photo canonicalize, video compliance repair, and `finalize_mutated_media` (invalidates precomputed hash after strip)
- Non-zero EXIF stars alone do **not** trigger Clean/compliance (no library-wide star walk)
- Clean rebuild preserves DB-only stars when EXIF is stripped (`_merge_scan_rating`)
- Contract tests: `test_clean_library_fast_audit`, `test_normalization_repair`, `test_media_finalization`, `test_library_metadata_compliance`

**Definition of done:**

- Audit and compliance agree on auto-fixable metadata kinds
- Mutation/repair pipelines strip legacy EXIF ratings when already touching the file
- Non-zero EXIF rating alone does not mark a file non-compliant

---

### 8. Shrink Clean UX

**Status:** Shipped (Phase C slice 9 — 2026-08-12)

Product framing: full-batch Clean is **Verify & repair** — exceptional, not routine hygiene.

**Shipped:**

- Utilities + overlay renamed to **Verify & repair**; explainer states exceptional use (legacy, external edits, something looks wrong)
- Health gates: empty inventory → Done only; legacy `CLEAN` audit → Done only (no “Continue anyway?” nudge)
- New empty library via `createAndSwitchLibraryInSubfolder` opens with `switchToLibrary` — no blocking make-perfect
- Healthy open paths already skip make-perfect (`test_grid_handoff_contract`)
- Docs: when-to-use section below; Clean v2 remains the full-batch engine

**When to use Verify & repair**

| Situation | Action |
|-----------|--------|
| Everyday Add / date edit / rotate / open | Nothing — compliance-on-mutation + open reconcile |
| First open of a messy/legacy collection | Recovery journey may run full repair |
| Finder / other-app edits, suspected drift | **Verify & repair** (utilities) |
| Interrupted prior repair | Resume from checkpoint |

**Definition of done:**

- No routine Clean nudge when health check / empty / clean audit passes
- Copy scopes the command as exceptional full-batch repair

---

## Truth model (portable vs app)

| Layer | What | Where |
|-------|------|-------|
| **Portable (file)** | Date taken, baked rotation, canonical path | Embedded metadata + folder layout |
| **App (overlay)** | Stars, date_added, trash intent | DB (`photos.rating`, etc.) — overlay.log deferred |

**Clean** audits portable layer + DB alignment. **Stars** are not portable semantics (greenfield C3).

---

## UX / latency

Compliance-on-mutation does **not** add a second wait after daily actions.

| Mechanism | Effect |
|-----------|--------|
| Optimistic UI | Instant star/rotate preview; revert on failure |
| Per-file work at mutation time | Same cost as today for date edit/rotate — not stacked on Clean |
| DB-only stars | **Faster** than today |
| Background open reconcile | Invisible to user |

See [`LIBRARY_MUTATION_CONTRACT.md`](LIBRARY_MUTATION_CONTRACT.md) — *UI is optimistic; failures revert.*

---

## Verification

### Per slice

- Contract / unit tests before closing slice
- `node --check static/js/main.js` after client changes
- Relevant unittest modules (see existing `test_make_library_perfect.py`, `test_media_date_contract.py`, `test_db_health_consistency.py`, normalization tests)

### Program complete

- `./packaging/build.sh` before confirming packaged behavior ([`.cursor/rules/rebuild-app-for-prod-testing.mdc`](../.cursor/rules/rebuild-app-for-prod-testing.mdc))
- Manual smoke: star toggle (no file mtime change), rotate → canonical path, date edit, library open after legacy folder, interrupted flow recovery where applicable

**Phase D (2026-08-12):**

- Contract suite: 183 tests green (`test_db_health_consistency`, favorite/star-blind, rotate/HEIC, trash, media dates, open reconcile, audit/compliance, normalization/finalization, grid handoff, clean API)
- `node --check static/js/main.js`
- Full rebuild: `./packaging/build.sh` → `dist/mac-arm64/Photos Light.app` (291M)
- Packaged smoke: app launches; `/api/library/status` responds; bundled UI shows **Verify & repair**; migrate/checkpoint endpoints return structured no-library responses

Interactive library smoke (star mtime / rotate path / date edit on a real library) remains a quick manual pass when convenient.

### Red flags (stop and go higher)

- New per-flow cleanliness logic outside shared modules
- Star toggle still calls exiftool or `finalize_mutated_media`
- Inspect or open reconcile using different predicates than Clean audit
- Fixing rotate on server without client settlement parity

---

## Related documents

| Doc | Role |
|-----|------|
| [`GREENFIELD_LIBRARY_DESIGN.md`](GREENFIELD_LIBRARY_DESIGN.md) | Design north star; C3 stars, C8 Clean optional |
| [`CLEANLINESS_SOT_HANDOFF.md`](CLEANLINESS_SOT_HANDOFF.md) | Module extraction plan; rotation bug |
| [`CLEAN_LIBRARY_V2_HANDOFF.md`](CLEAN_LIBRARY_V2_HANDOFF.md) | Current Clean engine; should consume SOT |
| [`LIBRARY_MUTATION_CONTRACT.md`](LIBRARY_MUTATION_CONTRACT.md) | Client/server mutation contract |
| [`bugs-to-be-fixed.md`](../bugs-to-be-fixed.md) | Issue tracker |
| [`photos-light-library-health-handoff.txt`](../chat-transcripts-and-handoffs/photos-light-library-health-handoff.txt) | Migration modal slice |

---

## Program definition of done

- [x] Legacy library at startup: migrate and open without dead-end modal (Phase A slice 1 — 2026-08-12)
- [x] Star toggle: DB-only; no file mutation (Phase A slice 2 — 2026-08-12)
- [x] Star-blind `duplicate_key` wired through import, Clean, finalize (Phase A slice 3 — 2026-08-12)
- [x] Rotate → full finalize; canonical path after hash change (Phase B slice 4 — 2026-08-12)
- [x] Trash/restore on shared compliance primitives (Phase B slice 5 — 2026-08-12)
- [x] Embedded dates on all writable repair/mutation paths (1900 unknown) (Phase B slice 6 — 2026-08-12)
- [x] Background open reconcile on library open (Phase C slice 7 — 2026-08-12)
- [x] Audit/compliance share auto-fixable metadata kinds; lazy EXIF rating strip on mutation (Phase C slice 8 — 2026-08-12)
- [x] No Clean prompt on healthy / empty / clean-audit library; Verify & repair exceptional framing (Phase C slice 9 — 2026-08-12)
- [x] Clean / Verify & repair documented and scoped as exceptional full-batch repair (Phase C slice 9 — 2026-08-12)
- [x] Contract tests + packaged `.app` rebuild/smoke green (Phase D — 2026-08-12)

---

## Instruction to implementing agent

Start narrow and prove convergence. **Phase A before Phase B.**

If doing only one thing first:

1. **Library open health** — users must be able to open the library, or nothing else matters.
2. **DB-only star toggle** — stop active harm from everyday mutations.

Do **not** begin with open reconcile, Inspect, or a greenfield rewrite.

Do **not** run a library-wide EXIF rating strip.

Always ask: *Does this slice use the same rulebook as Clean, or am I inventing a second definition of clean?*
