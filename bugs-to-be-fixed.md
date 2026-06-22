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

### Clean must embed date taken (1900 fallback for unknown)

**Priority:** High (correctness + product anatomy)  
**Status:** Open  
**Batch:** Library kernel / cleanliness convergence  
**Related:** **Incremental compliance-on-mutation**; `media_dates.py` (`read_media_date`, `write_and_verify_media_date`, `metadata_write_policy`); `library_cleanliness.py` TBD criterion #1 (usable library date — “not audited or repaired by Clean / Convert yet”); `photo_canonicalization.py` (`canonicalize_photo_file`)

**Summary:** **Clean library** must write **date taken** into embedded metadata for every file whose container supports it, using the shared read/write rulebook. When no trustworthy capture date exists, embed the deterministic unknown placeholder **`1900:01:01 00:00:00`** (not NULL, not path-only inference, not silent skip).

**Problems today:**

- Clean audit/repair paths resolve `date_taken` for DB and canonical paths but do not consistently **write back** missing or mismatched embedded dates on disk
- Photos: `canonicalize_photo_file` writes via `write_photo_date_metadata` when metadata changed or embedded ≠ resolved date — but full Clean v2 repair / video paths may skip embed
- Videos: audit identity uses `read_media_date(..., allow_mtime_fallback=False)` only — no symmetric `write_and_verify_media_date` when embedded is absent
- Files with no real date may remain without embedded metadata while DB/path use `1900/1900-01-01/` — breaks “embedded matches DB” invariant and re-open / export / other-app reads

**Target fix (one vertical slice):**

1. After resolving `date_taken` (read precedence in `media_dates.py`), if `metadata_write_policy(ext)` allows write and embedded ≠ resolved (or missing), call `write_and_verify_media_date` with resolved value — including **`UNKNOWN_PHOTO_DATE_TAKEN`** when that is the resolved date
2. Wire through Clean v2 repair (`normalization_repair.py`, `make_library_clean_v2.py`) and any parallel canonicalize paths — same policy as Add / date edit / compliance-on-mutation
3. Fail closed on writable containers when verify-after-write fails; unsupported extensions skip embed (existing `UnsupportedMediaDateWrite` behavior)
4. Contract tests: photo + mov/mp4/mkv samples with missing embedded → Clean embeds resolved date; undated photo → embedded `1900:01:01`; basename-only date → embedded matches basename date

**Definition of done:**

- Every Clean-repaired file with a writable date container has embedded metadata matching DB `date_taken`
- Unknown-date media embeds `1900:01:01 00:00:00` and lives under `1900/1900-01-01/` with matching basename
- No duplicate date-write logic outside `media_dates.py` + shared canonicalize/repair primitives
- `test_media_date_contract.py` (or Clean contract tests) cover missing-embedded repair for photo and at least one video writer path

**Out of scope:** Inventing dates from mtime during Clean (ingest-only `allow_mtime_fallback`); changing read precedence; transcode / Convert date migration

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

---

### Fast inspect library — layered confidence engine (vs full Clean)

**Priority:** Medium (product + performance)  
**Status:** Open  
**Batch:** Library verification / shrink Clean UX  
**Related:** **Incremental compliance-on-mutation** (open reconcile + cheap health check); existing `clean_library_fast_audit.py`, `inspect_library_path()`, Clean v2 preflight  
**Design origin:** Chat exploration — check vs clean, statistical sampling, combined speed/confidence techniques (June 2026)

**Summary:** Add a **read-only Inspect library** action that answers “is this library healthy?” without repairing anything. It should be **orders of magnitude faster** than **Clean library** for the common case (library unchanged), by combining cheap whole-library signals with **bounded statistical sampling** — not by re-running the full Clean pipeline on every file every time.

**Problem today:**

- **Clean library** (`make_library_clean_v2.py`) is the heavy hammer: walk tree, hash, canonicalize, repair — correct but slow; users should not need it routinely once compliance-on-mutation lands
- **`clean_library_fast_audit.py`** is a read-only preflight used before Clean — good start, but still oriented toward “what will Clean fix?” not “is the library probably fine?” with explicit confidence
- **`inspect_library_path()`** is a picker/open probe (DB health + media counts) — not a deep cleanliness verification pass
- No user-facing **Inspect** with tunable depth, stated confidence, or adaptive escalation to Clean on a **scoped** issue set

**Conceptual split (product language):**

| | **Inspect library** | **Clean library** |
|---|---|---|
| **Question** | “Is anything wrong?” | “Fix everything that is wrong” |
| **Mutates disk/DB** | Never | Yes |
| **Typical cost** | Seconds (unchanged library) | Minutes–hours |
| **When** | App open, idle, pre-sync, user curiosity | Legacy mess, tampering, Inspect found problems |
| **Output** | Report + confidence + recommended scope | Repaired library state |

**Core design: confidence funnel (combine techniques, don’t one-pass hash everything)**

Spend a **confidence budget** — cheap layers first; expensive work only where doubt remains:

1. **Layer 0 — Index sanity (~ms):** DB referential integrity, impossible states, schema/index generation vs last verify — no disk walk
2. **Layer 1 — Manifest fingerprint (~seconds):** Compare catalog rollups (file count, total bytes, root mtime max, merkle/folder rollups) to one **stat-only** filesystem walk — no file reads
3. **Layer 2 — Dirty delta (~seconds when idle):** Since last inspect, only fully verify paths flagged by watcher, import/delete/rename, or open reconcile — cost ∝ churn, not library size
4. **Layer 3 — Two-speed per file:** stat → partial hash (first/last 4KB) → **full hash only on suspects** or random sample fill
5. **Layer 4 — Stratified adaptive sample:** Random sample within buckets (top-level folder, file type, size band); **overweight** recent imports and never-verified items; **adaptively widen** only in hot buckets if anything fails
6. **Layer 5 — Full hash (Clean-parity depth):** Explicit “paranoid” mode only — same per-file work as Clean, no repairs

**Statistical sampling (when Layer 4 uses deep per-file work)**

Assume same per-file treatment as today’s audit (walk + hash + rule checks) but on a **random subset**. Two different confidence questions — UI must be explicit about which:

**Question A — “Library is broadly healthy” (zero issues in sample):**  
Confidence that defect **rate** is below a threshold. Sample size is ~independent of library size for large libraries.

| Rule out more than… | ~90% confidence | ~95% confidence | ~99% confidence |
|---|---|---|---|
| **1%** bad files | ~230 files | ~300 files | ~460 files |
| **0.1%** bad | ~2,300 | ~3,000 | ~4,600 |
| **0.01%** bad | ~23,000 | ~30,000 | ~46,000 |

As **slider % of library** (example: 95% conf, “< 0.1% bad”):

| Library size | ~Slider |
|---|---|
| 1,000 files | ~100% (full scan) |
| 10,000 files | ~30% |
| 100,000 files | ~3% |

**Question B — “Catch the one broken file”:** If only **one** bad file exists anywhere, ~95% detection requires checking ~**95% of the library**. Small samples cannot guarantee catching isolated failures — product copy must say so.

**Does 30% of files ≈ 30% of runtime?**

- **Per-file work (hash, verify):** ~yes — roughly linear
- **End-to-end clock time:** `fixed overhead + (slider% × heavy work)` — tree listing, DB load, report write are **not** proportional; short runs feel “ heavier than 30% ”
- **Rule of thumb:** on long full runs, 30% sample ≈ 25–35% of wall time; on small libraries, overhead dominates

**Proposed UX (confidence target, not raw % slider)**

Expose presets; compute technique mix + sample size under the hood:

| Preset | Typical behavior | Target |
|---|---|---|
| **Quick** | Layers 0–2 only | ~90% conf library unchanged |
| **Normal** | + stratified 1–3% adaptive sample, stat/partial hash, full hash on failures | ~95% conf no meaningful drift |
| **Thorough** | + 10–30% smart sample (merkle hot branches, risk-weighted queue) | ~99% conf |
| **Paranoid** | 100% full hash, Clean-parity depth, still read-only | certainty |

Report should show: `Checked 2,400 of 80,000 files (3%) — 96% confidence — escalated 120 files to full hash — 0 issues`. On any issue: stop claiming high confidence; offer **Clean scoped to flagged paths/ids**.

**Adaptive early-exit rules:**

- 0 issues in first N (e.g. 500) → stop, emit confidence per stopping rule
- 1 issue in small sample → report not OK, suggest scoped Clean (no need to finish sample)
- Multiple issues in one bucket → auto-widen sample in that bucket only

**Integration with existing code (incremental, not greenfield):**

- Reuse rule checks from `clean_library_fast_audit.py` and `library_cleanliness.py` — Inspect calls same predicates, `dry_run=True`
- Reuse hashing from `normalization_contract` / `hash_cache` — two-speed stat → partial → full
- Persist **inspect manifest** (generation, rollups, last verify time, per-path verify generation) in `.library/` — updated on Add/Clean/mutation finalizer, not rebuilt each run
- Wire **open reconcile** (compliance-on-mutation item) as Layer 2 dirty delta
- Clean v2 preflight can call Inspect **Normal** instead of bespoke audit duplication where overlap exists

**API sketch:**

```
POST /api/library/inspect
{ "mode": "quick" | "normal" | "thorough" | "paranoid", "cancel_token": "..." }

→ {
    ok: bool,
    confidence: { level: 0.95, claim: "defect_rate_below_0.1_pct" },
    layers: { index: "pass", fingerprint: "pass", sample: { checked: 2400, total: 80000, escalated_full_hash: 120 } },
    issues: [...],  // capped, paginated
    recommended_action: "none" | "clean:scoped",
    clean_scope: { photo_ids: [...], paths: [...] },
    duration_ms: 8420
  }
```

**Out of scope:**

- Replacing Clean repair logic — Inspect never mutates
- Perceptual / near-duplicate detection (byte-hash identity only, same as today)
- NAS-specific parallel I/O tuning as primary goal
- Promising 99% “every single file perfect” at 5% sample — statistically dishonest

**Definition of done:**

- New **Inspect library** utilities entry (read-only) with Quick / Normal / Thorough presets
- Inspect completes in seconds on a stable 50k+ library (Quick/Normal) on local SSD; reports stated confidence claim
- Finding zero issues at Normal on a compliant library does not prompt user to run Clean
- Any issue yields scoped `clean_scope` consumable by Clean v2 (or explicit “run Verify & repair” CTA)
- Inspect manifest persisted and incremented on mutations; dirty delta avoids full rescan when library unchanged
- Contract tests: sample-size math for confidence presets; inspect never writes media or catalog; adaptive widen on synthetic bad bucket
- Docs: when to Inspect vs Clean; honest copy on “one bad file in a million” limits

**Related tracker items:**

- **Incremental compliance-on-mutation** — open reconcile feeds Layer 2; shrinks need for routine Clean
- **Library open health** — distinct (migration/DB openability); Inspect assumes openable library

---

### Convert to library — resume after interrupt

**Priority:** High (correctness + product anatomy)  
**Status:** Open  
**Batch:** Convert / long-run orchestration  
**Related:** Clean v2 resume (`make_library_clean_v2.py`, `tech-docs/CLEAN_LIBRARY_V2_HANDOFF.md` § Resume); `normalization_convert.py` (explicitly defers resume/checkpoints); `POST /api/library/terraform` + `POST /api/library/terraform/scan` in `app.py`; `RESUME_DECISION_FINAL.md` (Terraform classified as checkpoint-critical)

**Summary:** **Convert to library** (folder → compliant library, in-place terraform) must support **manual resume** after cancel, crash, NAS disconnect, or app quit — same product model as Clean library: user reconnects, sees **Resume**, clicks Continue. Re-running from scratch on a 50k+ folder wastes hours of canonicalization work.

**Problems today:**

- Convert writes append-only `terraform_<ts>.jsonl` manifests under `.logs/` but **no checkpoint state** and no `find_resumable_*` helper
- `terraform_library()` always creates a **fresh** DB (`create_database_schema`), re-scans the full tree, and processes every media file — no skip set for already-converted paths
- `normalization_convert.py` header: “Resume/checkpoints and blocking final audit remain future Convert orchestration work”
- Preflight scan (`/api/library/terraform/scan`) returns only `INVENTORY` — never `RESUME` with remaining ETA
- Frontend has full resume UX for Clean (`resumeIntent`, checkpoint probe, `RESUME` preflight) but Convert overlay has no equivalent
- Interrupt mid-run leaves partial canonical layout + partial DB; user must either accept mess or restart and redo completed files (hash/exiftool/ffmpeg cost)

**Target fix (mirror Clean v2 resume slice):**

1. **Checkpoint artifacts** per run under `<folder>/.logs/`: `terraform_<ts>.checkpoint.json` (phase, stats, `manifest_path`, `processed_sources` or `convert_index`, `library_path`), plus optional `terraform_<ts>.processed.txt` (source paths finished in convert phase); mark `status: complete` / `abandoned` on success / fresh start
2. **Resume discovery:** `find_resumable_convert_checkpoint(library_path)` — ignore complete/abandoned, pick latest `updated_at`
3. **Resume orchestration:** On resume, open existing DB (do not recreate schema), skip sources already logged as success/duplicate in manifest or listed in processed file, continue `iter_convert_events` from `convert_index`; re-run layout cleanup only when convert phase completes
4. **API + UI:** Scan returns `status: RESUME` with `estimated_remaining_display` when checkpoint found; `POST /api/library/terraform` accepts `resume: true|false` and `manifest_path`; preview overlay shows Resume vs Start fresh (abandon checkpoint); SSE emits `resume` event with resumed counts
5. **Checkpoint interval:** Every N files (e.g. 25, match Clean) + phase boundaries + on failure; flush manifest + checkpoint together

**Manual repro:**

1. Pick a folder with thousands of media files (or synthetic tree)
2. Start **Convert to library**; let it process ~10% of files
3. Cancel or kill backend / disconnect NAS
4. Re-open Convert on same folder → today: only full preflight inventory; no Resume; starting again reprocesses from file 1

**Definition of done:**

- Interrupted Convert run can resume from last checkpoint without re-canonicalizing already-successful sources
- Scan/preflight surfaces `RESUME` with honest remaining-time estimate
- User can **Start fresh** (abandon checkpoint) vs **Resume** — abandoned checkpoints not offered again
- Contract tests: synthetic interrupt → resume completes same final DB/paths as uninterrupted run; fresh start after abandon ignores old checkpoint
- Document locked model: manual resume (no automatic in-process NAS reconnect — defer like Clean)

**Out of scope:** Automatic reconnect/retry without user click; EXIF metadata cache as substitute for checkpoints; resume for legacy `library_sync` rebuild path unless unified into Convert orchestrator
