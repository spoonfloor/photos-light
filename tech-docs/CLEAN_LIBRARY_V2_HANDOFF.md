# Clean Library v2 — Handoff

**Status:** v2 is the default engine. Add Photos and Clean now share normalization primitives; Clean keeps cheap inventory preflight, resume, live ETA, **blocking final verification**, and **skip-unchanged** re-runs.
**Last doc sync:** 2026-06-08 (aligned with shared normalization runtime, `make_library_clean_v2.py`, `main.js`, tests).

> **2026-06-13:** Legacy engine removed. Restore from git tag `clean-library-legacy-final` if needed. Shared helpers live in `clean_library_media_utils.py`.
**Test library:** `/Volumes/public/clean-lib-speed-test` (~400 media files on NAS/WiFi)
**Last full clean (R7):** 2026-06-07 — 847.2s wall, SUCCESS, 371 survivors
**Last profile:** `tools/results/scan-profile_2026-06-07T16-40-35+00-00.json`

---

## Executive summary

Clean library was too slow on NAS-scale libraries (~60k photos). We:

1. **Quarantined** the original engine as **legacy** (still available via env; not removed).
2. **Shipped v2** — faster rules, hash-only duplicates, zip-artifact handling.
3. **Revived preflight** as a **cheap inventory** (walk + stat only) — photos/videos count + **about X hours** — then **Continue** (bail-out before a 30h+ run).
4. **Implemented resume** — checkpoint files on NAS; manual restart after disconnect (auto-reconnect deferred).
5. **Profiled** the NAS fixture and ran an **end-to-end clean** on `/Volumes/public/clean-lib-speed-test`.
6. **Converged Add Photos and Clean** on shared normalization primitives while preserving Clean-only orchestration.

**Bottom line:** First full clean @ 60k extrapolates to **~30–35h** on good WiFi (down from legacy ~55h). Preflight is seconds–low minutes, not hours. Every successful run ends with a **blocking final verification** (UI step 6); re-runs skip already-clean files. Add Photos and Clean now share the same normalization identity/canonical path primitives. Remaining gaps are mostly **first-pass wall time**, **Convert mode**, and **auto NAS reconnect**.

> **Note:** “v3” in older docs (`RESUME_NECESSITY_ANALYSIS.md`, `V3_MIGRATION_COMPLETE.md`) refers to **DB schema v3** or “no checkpoints” — not a third clean engine. Only **legacy** and **v2** exist in code.

---

## Goals (agreed)

| Goal | Status |
|------|--------|
| Clean library is the **yardstick** for library cleanliness | ✓ |
| Duplicates = **same file hash** only (pixel dupes out of spec) | ✓ v2 |
| **No slow audit preflight** (old hours-long gate) | ✓ cheap inventory |
| User can **bail before committing** to a long run | ✓ inventory + duration + Continue |
| **Resume** after NAS disconnect (manual restart) | ✓ v2 checkpoints |
| Scoreboard = **feedback during run**, not a cleanliness gate | ✓ |
| Safe failure (trash not delete, DB backup, idempotent re-run) | ✓ |
| Live **about X left** during run | ✓ rolling ETA (after ~25 files) |
| Reasonable time @ 60k on good WiFi | ✗ still ~30–35h first clean |
| **Blocking final verification** (fail if not CLEAN) | ✓ `audit` phase; `CleanLibraryError` on issues |
| Skip unchanged / maintenance-scale re-runs | ✓ `_try_skip_unchanged_media_record()` |
| UI **Start fresh** on interrupted run | ✓ interrupted gate + RESUME preflight buttons |
| Automatic NAS reconnect mid-run | ✗ deferred (nice-to-have) |

---

## Architecture

```
make_library_perfect.py             # Router (default v2, PHOTOS_CLEAN_LIBRARY_ENGINE=legacy)
├── make_library_clean_v2.py        # v2 engine: setup, scan walk, resume/checkpoints, final audit
├── normalization_contract.py       # Mode policies + duplicate/canonical identity helpers
├── normalization_core.py           # Shared per-file ingest primitives
├── normalization_ingest.py         # Thin Add Photos event/counter wrapper over core
├── normalization_repair.py         # Clean repair primitives + post-scan phase iterator
├── make_library_perfect_legacy.py  # Archived engine (unchanged behavior)
├── clean_library_inventory.py      # Cheap walk+stat inventory + duration estimate
├── clean_library_fast_audit.py     # Read-only verify audit (?verify=1)
└── library_cleanliness.py          # Shared rules (extension sets, layout, date formats)
```

| Piece | Role |
|-------|------|
| `make_library_perfect_legacy.py` | Frozen pre-v2: full audit preflight, pixel dupes, blocking final audit |
| `make_library_clean_v2.py` | v2: inventory preflight, resume checkpoints, scan walk, Clean-only orchestration, blocking `final_audit()` |
| `normalization_contract.py` | Source of truth for mode policy: ingest skips duplicates/rejects unsupported, repair trashes losers/unsupported, Convert deferred |
| `normalization_core.py` | Shared per-file normalization identity and ingest photo/video primitives |
| `normalization_ingest.py` | Add Photos orchestration wrapper over `normalization_core.py` |
| `normalization_repair.py` | Repair scan identity, duplicate planning, canonical move, and post-scan phase iterator used by Clean v2 |
| `clean_library_inventory.py` | `inventory_media_library()` — photo/video counts, bytes, `about X hours` estimate |
| `clean_library_fast_audit.py` | Read-only yardstick audit using contract canonical path helpers — blocking at end of every run + optional `?verify=1` preflight scan |
| `tools/benchmark_clean_library.py` | Scan / run / suite harness |
| `tools/profile_clean_library_scan.py` | Per-file scan cost breakdown (dev/diagnostic) |

### Normalization convergence

Add Photos and Clean now share normalization identity rules instead of carrying separate forks:

- Duplicate identity is hash-only via `normalization_contract.compute_duplicate_key()`.
- Canonical paths flow through contract/library cleanliness helpers.
- Add Photos uses `normalization_ingest.iter_ingest_events()` over `normalization_core.py`.
- Clean v2 uses `normalization_repair.py` for scan-time identity, duplicate winner/loser planning, canonical moves, and post-scan repair phase iteration.
- Clean v2 still owns setup, inventory preflight, checkpoints/resume files, walk order, trash/log/stat side effects, DB rebuild, final blocking audit, and SSE event compatibility.
- Convert remains deferred; `CONVERT_POLICY` is present but destructive layout rewrite is not part of this convergence.

---

## Clean definition (v2 spec)

**In scope**

- Misfiled / misnamed media → canonical `YYYY/YYYY-MM-DD/img_YYYYMMDD_hash.ext` layout
- Hash duplicates → trash losers (oldest creation wins)
- Unsupported / corrupt files → `.trash`
- Ghost DB rows, moles (disk without DB), hash mismatches → repaired on full run
- Metadata: bake lossless rotation, strip EXIF rating = 0
- Empty / non-canonical folders removed (outside infrastructure)
- `.library` / DB health

**Out of scope (v2)**

- Pixel-level duplicates (same image, different bytes/encoding)

---

## Product behavior today

### Clean library (Utilities → Clean)

1. Overlay opens → checkpoint probe (`GET /api/library/make-perfect/checkpoint`). If resumable, user picks **Continue**, **Start over**, or **Cancel**.
2. **Cheap inventory preflight** (`GET /api/library/make-perfect/scan`).
3. Shows **N photos, P videos — about X hours** (or **Resume — about X remaining** if interrupted run exists).
4. User clicks **Continue** → streaming clean (`POST /api/library/make-perfect/stream`).
5. Working UI shows **6 steps** with file progress on scan, organize, rebuild, and final verification. Secondary line: **Total time remaining** (preflight estimate minus elapsed).
6. Engine runs repair phases, then **blocking final verification** (step 6). Run succeeds only if audit returns zero issues.
7. Finished UI → grid reloads.

Implementation: `static/js/main.js` → `openUpdateIndexOverlay()` (preflight) → `executeUpdateIndex()` → `streamMakeLibraryPerfect()`.

**Cancel** during run = pause (checkpoint preserved; toast: "Cleanup paused. You can continue it later.").

**Legacy engine:** preflight still runs **full audit** (`DIRTY`/`CLEAN` + issue counts). No inventory duration. Resume stubs are no-ops.

### API

| Endpoint | Behavior |
|----------|----------|
| `GET /api/library/make-perfect/scan` | **v2:** `INVENTORY` or `RESUME` (cheap inventory + estimate). **Legacy:** full audit → `DIRTY`/`CLEAN` |
| `GET /api/library/make-perfect/scan?verify=1` | Full fast audit (yardstick; recovery / dev) |
| `POST /api/library/make-perfect/stream` | Full clean with SSE progress. Body: `{"resume": false}` to abandon checkpoint and start fresh; default auto-resume |

### v2 `run()` phases

`setup` → `scan` → `dedupe` → `canonicalize` → `folders` → `rebuild_db` → **`audit`** → `complete`

| UI step | Engine phase | Notes |
|---------|--------------|-------|
| 1 | `scan` | Normalize, hash, metadata; skip-unchanged when DB + path prove clean |
| 2 | `dedupe` | Hash duplicates → trash losers |
| 3 | `canonicalize` | Move to canonical layout |
| 4 | `folders` | Remove empty / non-canonical dirs |
| 5 | `rebuild_db` | Rebuild photos table from disk |
| 6 | `audit` | `run_fast_library_audit()` — **blocking**; `CleanLibraryError` if any issues |

Scan/normalize is ~95% of wall time on first clean; audit adds a read-only pass (hashes every file). On audit failure, checkpoint stays at `audit` phase for resume.

Tests: `CleanLibraryBlockingVerifyTest`, `test_second_clean_skips_unchanged_without_rehashing`, `test_resume_after_cancel_during_final_audit`.

---

## Resume (v2)

### Artifacts (per run, under `<library>/.logs/`)

| File | Purpose |
|------|---------|
| `clean_library_<ts>.jsonl` | Append-only manifest (`operation_started`, `media_moved`, `operation_failed`, …) |
| `clean_library_<ts>.checkpoint.json` | Resume state: `phase`, `stats`, paths, `scan_completed_count`, `canonicalize_index` |
| `clean_library_<ts>.records.jsonl` | Serialized `MediaRecord` rows for post-scan phases |
| `clean_library_<ts>.scan_completed.txt` | One source path per line — files finished in scan |

Checkpoint written every **25 files** + on phase boundaries + on failure. **`status: complete`** on success (not resumable). **`status: abandoned`** if user starts fresh (`resume: false`).

### How resume is found

`find_resumable_clean_library_checkpoint(library_path)` scans `.logs/*.checkpoint.json`, ignores `complete`/`abandoned`, matches v2 + library path, picks latest `updated_at`.

### Product model (locked)

| Priority | Behavior |
|----------|----------|
| **Must have** | Manual restart — user reconnects NAS, opens Clean, sees **Resume**, clicks Continue |
| **Nice-to-have (deferred)** | Automatic reconnect / in-process retry without user click |

---

## Inventory preflight (v2)

### What it does

- One `os.walk` + `stat` per file — **no hash, no exiftool**
- Returns photo count, video count, total bytes
- Estimates duration: `photos × 1.7s + video_MB × 0.024s/MB` (+ 5% tail), display as **about X hours** (single number, not a range)

### Constants (from NAS profile, Jun 2026)

`PHOTO_SEC_PER_FILE = 1.7`, `VIDEO_SEC_PER_MB = 0.024` in `clean_library_inventory.py`

### Scan response shapes

**Fresh library:** `status: INVENTORY`, `preflight: true`, `summary.photo_count`, `summary.video_count`, `estimated_display`

**Interrupted run:** `status: RESUME`, `estimated_remaining_display`, `resume: { phase, scan_completed_count, … }`

---

## Run artifacts (collateral)

| Location | What |
|----------|------|
| `<library>/.logs/` | Manifest + checkpoint + records + scan_completed (see above) |
| `<library>/.db_backups/` | DB copy at **start of fresh run** only (not on resume) |
| `<library>/.trash/` | Unsupported, corrupt, duplicate losers |
| `<library>/.library/photo_library.db` | Rebuilt at end of run |
| `<library>/YYYY/…` | Canonical media layout after clean |

Example after R7: `clean_library_20260607_105708.*` in `.logs/`.

---

## Profiling (Jun 2026)

**Tool:** `tools/profile_clean_library_scan.py`  
**Fixture:** `/Volumes/public/clean-lib-speed-test` (383 photos, 17 videos)

| Type | Dominant cost | Median per file |
|------|---------------|-----------------|
| Photos | `canonicalize_photo_file` (hash + EXIF + bake) | ~1.7s |
| Videos | `hash_cache` (full file read) | ~3.8s (140 MB) – ~12.5s (600 MB) |

**Takeaways:**

- EXIF batching / double-verify are **small** wins (~10% photos); **hash/read** dominates.
- Inventory estimate (~12 min for 400-file dirty fixture) matched R7 full clean (~14 min).
- **60k photos only:** ~30h directional. **60k with large videos:** budget **~30–35h**.

---

## Benchmark methodology

### Harness

- **Tool:** `tools/benchmark_clean_library.py` — same engines as production.
- **Timer:** `time.perf_counter()` per step; `PhaseTimer` on progress events.
- **Output:** stdout + `tools/results/<label>_<timestamp>.json`.

### Test fixture

| Property | Value |
|----------|--------|
| Path | `/Volumes/public/clean-lib-speed-test` |
| Network | NAS over WiFi |
| Size | ~400 media files, ~3 GB (includes large `.mov` under `terraform-master/` when dirty) |
| Dirty state | Messy layout + ~1 DB row vs ~400 files on disk |
| Restore | Re-unzip from `clean-lib-speed-test.zip`; **skip `__MACOSX`** |

### Suite protocol (destructive)

1. `preflight_inventory` — cheap inventory (seconds)
2. `run_full` — mutates library
3. `verify_clean` / `verify_clean_warm` — yardstick

### 60k extrapolation formula

```
sec_per_file = elapsed_sec ÷ file_count
hours_60k    = (60_000 × sec_per_file) ÷ 3600
```

| Step kind | Denominator |
|-----------|-------------|
| Inventory / verify scan | `supported_media_files` |
| Full clean | Post-run media count or dirty scan count (state which) |

**Planning number for messy 60k on WiFi:** **about 30 hours** (photos-heavy); **up to ~35h** with videos / slow NAS day.

---

## Benchmark results

### Historical runs (pre-resume / zero-preflight era)

| Run | Engine | Full clean wall | @ 60k (post-run files) |
|-----|--------|-----------------|-------------------------|
| R2 `nas-wifi-full` | Legacy | 1190s | ~55h |
| R5 `v2-retry` | v2 | 859s | ~39h |
| R6 `nas-zero-preflight-v2` | v2 | 676s | ~30h |

R6 phases: scan 644.5s · dedupe 2s · canonicalize 19s · folders 7s · rebuild_db 1.4s

### R7 — `nas-live-clean` (v2, post-inventory+resume, 2026-06-07)

End-to-end validation on restored dirty fixture via `run_db_normalization_engine` (not UI).

| Metric | Value |
|--------|--------|
| Wall | **847.2s (~14.1 min)** |
| Status | **SUCCESS** |
| Scanned | 400 candidates |
| DB survivors | 371 |
| @ 60k (400 dirty scale) | **~35.3h** |
| @ 60k (371 post scale) | **~38.1h** |

**Stats:** `media_moved: 370`, `duplicates_trashed: 29`, `moved_to_trash: 49`, `metadata_fixed: 314`, `folders_removed: 86`, `db_rows_rebuilt: 371`

**Phases (approx):** scan ~12m · dedupe · canonicalize · folders · rebuild_db · audit · total 14.1m

**Aftermath:** `terraform-master/` removed; media under year folders (`1900`, `2012`, `2022`–`2026`, …); `.logs/clean_library_20260607_105708.*` written; checkpoint `status: complete`.

### Summary trend (full clean @ 60k)

| Run | Engine | @ 60k |
|-----|--------|-------|
| R2 legacy | Legacy | ~55h |
| R6 v2 | v2 | ~30h |
| **R7 v2 live** | v2 | **~30–35h** |

---

## Legacy vs v2

| | Legacy | v2 (today) |
|--|--------|------------|
| **Preflight** | Full audit (hours @ 60k) | Cheap inventory (seconds–minutes) |
| **Pixel dupes** | Yes | No |
| **Full clean @ 60k** | ~55h | ~30–35h |
| **Resume** | No | Yes (manual restart) |
| **Blocking final audit** | Yes (preflight + end) | Yes (end of every run) |
| **Skip unchanged on re-run** | No | Yes |

Legacy remains on disk and is selectable: `PHOTOS_CLEAN_LIBRARY_ENGINE=legacy`.

---

## Confidence (clean achieved)

Illustrative — not statistically proven.

| Outcome | Meaning |
|---------|---------|
| **v2 SUCCESS** | Repairs completed **and** blocking `audit` phase returned zero issues |
| **v2 audit failure** | `CleanLibraryError`; checkpoint at `audit` for resume; UI shows generic failure today |
| **Legacy SUCCESS** | Full clean + blocking final audit (legacy rulebook includes pixel dupes) |
| **Inventory preflight alone** | 0% cleanliness (duration/count only; not a cleanliness gate) |

**Known audit limitation:** fast audit checks canonical basename with a regex (`CANONICAL_BASENAME_RE`). Skip-unchanged uses computed `canonical_relative_path()`. These can theoretically disagree on edge cases — see deferred work below.

---

## Shipped (Jun 2026)

- **`clean_library_inventory.py`** — cheap preflight + type/size-weighted estimate
- **Inventory preflight API** — `INVENTORY` / `RESUME` scan responses
- **UI preflight flow** — photos/videos + about X hours → Continue
- **Checkpoint probe + interrupted gate** — Continue / Start over / Cancel before preflight
- **6-step working UI** — scan → dedupe → organize → folders → rebuild → **Final verification**
- **Blocking final audit** — `audit` phase; SUCCESS only when `run_fast_library_audit()` returns no issues
- **Skip unchanged** — `_try_skip_unchanged_media_record()` on re-runs (no re-hash when DB + path prove clean)
- **Resume checkpoints** — `.logs/clean_library_<ts>.*` artifact set
- **`find_resumable_clean_library_checkpoint` / `abandon_clean_library_checkpoint`**
- **Stream `resume` param** — auto-resume default; `false` = start fresh
- **Cancel = pause** — cooperative cancel preserves checkpoint
- **Manifest tail API** — `GET /api/library/make-perfect/manifest-tail`
- **`tools/profile_clean_library_scan.py`** — per-file cost breakdown
- **Tests** — `test_clean_library_inventory.py`, `CleanLibraryResumeTest`, `CleanLibraryBlockingVerifyTest`, skip-unchanged tests
- **R7 live NAS clean** — full dirty fixture, SUCCESS, logs verified

---

## Deferred / not done

- **Automatic** NAS reconnect mid-run (manual resume is the locked model)
- **Canonical path proof in fast audit** — use `expected_rel` from hash + date instead of regex-only basename check
- **Targeted repair loop** — audit fails → fix reported paths only → verify again
- **Incremental diff vs DB** (maintenance mode beyond skip-unchanged)
- **Parallel hashing** (careful on NAS)
- **Audit failure UX** — surface issue kinds in overlay; guide user to resume at `audit` phase
- **Phase-adaptive “time remaining”** during working UI (today: preflight estimate minus wall elapsed)

---

## Recommended next steps

Priority order:

### 1. Canonical path check in audit

`expected_rel` from hash + date vs regex-only today. Align with skip-unchanged logic.

### 2. Targeted repair loop

Audit fails → fix reported paths only → verify again.

### 3. Audit failure UX

Clear failed state in overlay (not just “Failed to clean library” toast).

### 4. Maintenance-run target @ 60k

Measure skip-unchanged re-runs; goal: minutes, not hours.

### 5. Later extras

- Parallel hash workers (careful on NAS)
- Automatic NAS reconnect

---

## Key files

| File | Purpose |
|------|---------|
| `make_library_clean_v2.py` | v2 engine + resume |
| `make_library_perfect_legacy.py` | Legacy engine (preserved) |
| `make_library_perfect.py` | Router |
| `clean_library_inventory.py` | Cheap preflight + estimate |
| `clean_library_fast_audit.py` | Verify audit (`?verify=1`) |
| `app.py` | `/api/library/make-perfect/*` routes |
| `static/js/main.js` | Preflight overlay, ETA, stream |
| `static/fragments/updateIndexOverlay.html` | Photos/videos preflight stats |
| `tools/benchmark_clean_library.py` | Benchmark harness |
| `tools/profile_clean_library_scan.py` | Scan cost profiler |
| `tools/results/*.json` | Run reports |
| `test_make_library_perfect.py` | Engine + resume tests |
| `test_clean_library_inventory.py` | Inventory tests |

---

## How to run

### Product path

Utilities → Clean → review inventory → Continue.

### Benchmarks

```bash
# Cheap inventory preflight (non-destructive)
python3 tools/benchmark_clean_library.py scan \
  --library /Volumes/public/clean-lib-speed-test --label quick

# Full suite (mutates library)
python3 tools/benchmark_clean_library.py suite \
  --library /Volumes/public/clean-lib-speed-test \
  --label my-run --destructive --no-lock-warn
```

Suite steps: `preflight_inventory` → `run_full` → `verify_clean` → `verify_clean_warm`

### Profile per-file scan costs

```bash
python3 tools/profile_clean_library_scan.py \
  --library /Volumes/public/clean-lib-speed-test
```

### Direct engine run (same as production)

```python
from make_library_perfect import run_db_normalization_engine
run_db_normalization_engine("/Volumes/public/clean-lib-speed-test")
# resume=False to abandon checkpoint; default auto-resumes
```

Restore fixture from `clean-lib-speed-test.zip` (skip `__MACOSX`) between destructive suites.

---

## How to switch engines

```bash
# Default: v2
python3 app.py

# Legacy fallback (full audit preflight, no resume)
PHOTOS_CLEAN_LIBRARY_ENGINE=legacy python3 app.py
```

---

## Open questions

1. Is bundled audit @ 60k (~4.5h directional) acceptable, or must audit also be incremental?
2. What is the **maintenance re-run** target @ 60k with skip-unchanged (goal: minutes)?
3. Should audit failure offer **retry verification only** (resume at `audit` without re-running scan)?
