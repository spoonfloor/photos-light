# Clean Library v2 — Handoff

**Status:** v2 is the default engine. Cheap inventory preflight + resume + live ETA are implemented.  
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

**Bottom line:** First full clean @ 60k extrapolates to **~30–35h** on good WiFi (down from legacy ~55h). Preflight is seconds–low minutes, not hours. Confidence is still **~88% run-only** / **~95% with optional verify** — blocking verify and skip-unchanged remain the main gaps.

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
| Very high confidence without verify | ✗ — verify not blocking yet |
| Skip unchanged / maintenance-scale re-runs | ✗ deferred |
| Automatic NAS reconnect mid-run | ✗ deferred (nice-to-have) |

---

## Architecture

```
make_library_perfect.py          # Router (default v2, PHOTOS_CLEAN_LIBRARY_ENGINE=legacy)
├── make_library_clean_v2.py     # v2 engine (default): inventory preflight, resume, run
├── make_library_perfect_legacy.py  # Archived engine (unchanged behavior)
├── clean_library_inventory.py # Cheap walk+stat inventory + duration estimate
├── clean_library_fast_audit.py  # Read-only verify audit (?verify=1)
└── library_cleanliness.py       # Shared rules (zip artifacts, layout, etc.)
```

| Piece | Role |
|-------|------|
| `make_library_perfect_legacy.py` | Frozen pre-v2: full audit preflight, pixel dupes, blocking final audit |
| `make_library_clean_v2.py` | v2: inventory preflight, resume checkpoints, hash-only dupes, `purge_zip_artifacts()` |
| `clean_library_inventory.py` | `inventory_media_library()` — photo/video counts, bytes, `about X hours` estimate |
| `clean_library_fast_audit.py` | Full yardstick audit for `verify=True` only |
| `tools/benchmark_clean_library.py` | Scan / run / suite harness |
| `tools/profile_clean_library_scan.py` | Per-file scan cost breakdown (dev/diagnostic) |

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

1. Overlay opens → **cheap inventory preflight** (`GET /api/library/make-perfect/scan`).
2. Shows **N photos, P videos — about X hours** (or **Resume — about X remaining** if interrupted run exists).
3. User clicks **Continue** → streaming clean (`POST /api/library/make-perfect/stream`).
4. Status shows phase + **about X left** after ~25 files (rolling throughput); **estimating…** before that.
5. Run completes → grid reloads.

Implementation: `static/js/main.js` → `openUpdateIndexOverlay()` (preflight) → `executeUpdateIndex()` → `streamMakeLibraryPerfect()`.

**Legacy engine:** preflight still runs **full audit** (`DIRTY`/`CLEAN` + issue counts). No inventory duration. Resume stubs are no-ops.

### API

| Endpoint | Behavior |
|----------|----------|
| `GET /api/library/make-perfect/scan` | **v2:** `INVENTORY` or `RESUME` (cheap inventory + estimate). **Legacy:** full audit → `DIRTY`/`CLEAN` |
| `GET /api/library/make-perfect/scan?verify=1` | Full fast audit (yardstick; recovery / dev) |
| `POST /api/library/make-perfect/stream` | Full clean with SSE progress. Body: `{"resume": false}` to abandon checkpoint and start fresh; default auto-resume |

### v2 `run()` phases

`setup` → `scan` → `dedupe` → `canonicalize` → `folders` → `rebuild_db`

No blocking final audit at end of run. Scan/normalize is ~95% of wall time on first clean.

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

**Phases (approx):** scan ~12m · dedupe · canonicalize · folders · rebuild_db · total 14.1m

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
| **Confidence (run only)** | — | ~88% |
| **Confidence (+ verify)** | ~99% | ~95% |

Legacy remains on disk and is selectable: `PHOTOS_CLEAN_LIBRARY_ENGINE=legacy`.

---

## Confidence (clean achieved)

Illustrative — not statistically proven.

| Version | Confidence |
|---------|------------|
| Legacy full clean | ~99% |
| v2 + verify | ~95% |
| v2 run only (no verify) | ~88% |
| Inventory preflight alone | 0% (duration/count only; not cleanliness) |

---

## Shipped in this phase (Jun 2026)

- **`clean_library_inventory.py`** — cheap preflight + type/size-weighted estimate
- **Inventory preflight API** — `INVENTORY` / `RESUME` scan responses
- **UI preflight flow** — photos/videos + about X hours → Continue
- **Rolling live ETA** — phase + “about X left” / “estimating…” during stream
- **Resume checkpoints** — `.logs/clean_library_<ts>.*` artifact set
- **`find_resumable_clean_library_checkpoint` / `abandon_clean_library_checkpoint`**
- **Stream `resume` param** — auto-resume default; `false` = start fresh
- **`tools/profile_clean_library_scan.py`** — per-file cost breakdown
- **Router fix** — `make_library_perfect.py` syntax + legacy resume stubs
- **Tests** — `test_clean_library_inventory.py`, `CleanLibraryResumeTest`, `test_scan_inventory_preflight_by_default`
- **R7 live NAS clean** — full dirty fixture, SUCCESS, logs verified

---

## What we did NOT do (deferred)

- Skip unchanged / already-canonical files during run
- Incremental diff vs DB (maintenance mode)
- **Automatic** NAS reconnect mid-run
- Blocking verify at end of run (fail if not CLEAN)
- Canonical path proof in fast audit (legacy does dry-run canonicalize)
- Parallel hashing
- UI “Start fresh” button on resume preflight (API supports `resume: false`; no dedicated UI yet)
- Post-run verify in Clean overlay

---

## Recommended next steps

Priority order:

### 1. Skip unchanged files (biggest speed win on re-runs)

Skip when path + hash + DB + metadata already prove clean. **Deferred** until 2nd+ cleans matter; does little on first dirty pass.

### 2. Make verify mandatory and blocking

End every run with `verify_library_cleanliness()`. Fail run if not `CLEAN`.

### 3. Canonical path check in verify (no temp copy)

`expected_rel` from hash + date vs regex-only today.

### 4. Targeted repair loop

Verify fails → fix reported paths only → verify again.

### 5. Later extras

- Parallel hash workers (careful on NAS)
- Automatic NAS reconnect
- UI “Start fresh” on resume screen

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

1. Should verify be **automatic** at end of every clean, with a clear failed state?
2. Is **~4.5h verify @ 60k** acceptable bundled, or must verify also be incremental?
3. When skip-unchanged ships, what is the **maintenance run** target @ 60k (goal: minutes)?
4. Should UI expose **Start fresh** when `RESUME` preflight is shown?
