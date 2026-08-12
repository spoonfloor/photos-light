# Compliance-on-Mutation Program

**Status:** Open — program handoff  
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

**Problems today:**

- `duplicate_key ===` raw `content_hash`; starred vs unstarred byte-identical photos are distinct assets
- Starring can change hash and trigger duplicate trashing

**Target:**

- Compute dedupe identity on canonical content **after** logical rating strip (in-memory / at hash time — **not** requiring disk strip)
- Import, Clean dedupe, post-mutation duplicate checks use `duplicate_key`, not raw file hash
- Starring must not change `duplicate_key`, `content_hash`, path, or thumbnail cache key

**Modules:** `normalization_contract.py` (`compute_duplicate_key`), `normalization_repair.py`, `normalization_ingest.py`, `media_finalization.py`

**Definition of done:**

- Import/Clean treat starred/unstarred pairs as dupes
- Contract tests for identity computation

---

### 4. One pipeline on every file mutation

**Handoff:** [`CLEANLINESS_SOT_HANDOFF.md`](CLEANLINESS_SOT_HANDOFF.md)

Shared sequence (from [`LIBRARY_MUTATION_CONTRACT.md`](LIBRARY_MUTATION_CONTRACT.md)):

```
resolve path → write/transform → verify read-back → finalize_mutated_media (if bytes/path changed)
→ UPDATE photos → commit → invalidate_grid_read_caches()
```

**Known gaps:**

- Rotate: hash/dimensions update but canonical path rename not always guaranteed
- Per-flow logic still scattered in `app.py` vs `normalization_*`

**Existing building blocks (reuse, do not restart):**

- `normalization_core.py`, `photo_canonicalization.py`
- `normalization_ingest.py`, `normalization_convert.py`, `normalization_repair.py`
- `media_finalization.py` → `finalize_mutated_media()`
- `library_cleanliness.py`, `library_metadata_compliance.py`
- Client: `static/js/libraryMutation.js` (extend toward unified settlement)

**Definition of done:**

- Add, Convert, date edit, rotate, trash/restore use shared compliance primitives
- No drift-only fixes in `app.py` one-offs
- Contract tests: no canonical-path/hash drift after mutation

---

### 5. Embed date taken (1900 fallback)

**Related criterion:** `library_cleanliness.py` TBD #1 (usable library date)

When resolving `date_taken` via `media_dates.py`, writable containers get embedded metadata matching DB — including `1900:01:01 00:00:00` for unknown dates.

Wire through Clean v2 repair and parallel canonicalize paths; same policy as Add / date edit / compliance-on-mutation.

**Definition of done:**

- Clean-repaired writable files have embedded date matching DB
- `test_media_date_contract.py` (or Clean contract tests) cover photo + one video writer path

---

### 6. Open reconcile (background)

Cheap background pass on library open:

- Inventory + dirty delta (paths touched since last verify, watcher flags, recent imports)
- Applies **same rulebook** as mutation pipeline — not a separate “lite Clean”
- **Not** user-facing; no blocking modal
- User not prompted for Clean when library passes cheap health check

**Inspect integration (later):** Layer 2 dirty delta in Fast Inspect design ([`bugs-to-be-fixed.md`](../bugs-to-be-fixed.md) Inspect item)

**Definition of done:**

- Open library does not block on reconcile
- Reconcile uses shared audit/repair predicates only

---

### 7. Shrink Clean UX

- Document: Clean / **Verify & repair** for legacy, tampering, repair — not day-to-day hygiene
- UI: no routine Clean nudge when health check passes
- Clean v2 remains full-batch orchestrator consuming shared modules ([`CLEAN_LIBRARY_V2_HANDOFF.md`](CLEAN_LIBRARY_V2_HANDOFF.md))

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

- [ ] Legacy library at startup: migrate and open without dead-end modal
- [ ] Star toggle: DB-only; no file mutation
- [ ] Star-blind `duplicate_key` wired through import, Clean, finalize
- [ ] Every file mutation path uses shared compliance primitives; rotate canonical path fixed
- [ ] Embedded dates on all writable repair/mutation paths (1900 unknown)
- [ ] Background open reconcile; no Clean prompt on healthy library
- [ ] One audit predicate set shared by reconcile, Inspect (when built), and Clean
- [ ] Clean documented and scoped as exceptional full-batch repair
- [ ] Contract tests cover above; packaged `.app` smoke green

---

## Instruction to implementing agent

Start narrow and prove convergence. **Phase A before Phase B.**

If doing only one thing first:

1. **Library open health** — users must be able to open the library, or nothing else matters.
2. **DB-only star toggle** — stop active harm from everyday mutations.

Do **not** begin with open reconcile, Inspect, or a greenfield rewrite.

Do **not** run a library-wide EXIF rating strip.

Always ask: *Does this slice use the same rulebook as Clean, or am I inventing a second definition of clean?*
