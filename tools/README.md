# Clean Library Performance Tools

Benchmark [Clean library](../make_library_perfect.py) against a real folder to measure
scan cost, full-run phase timing, and 60k extrapolation.

**Test library:** `/Volumes/public/clean-lib-speed-test` (~400 media files on NAS).

## Date-range clean (partial library)

To run Clean library on one inclusive date span without touching the rest of the catalog:

```bash
python3 tools/clean_library_date_range.py /Volumes/eric_files/photo_library \
  --from 2026-05-01 --to 2026-06-30
```

Scans only `YYYY/YYYY-MM-DD/` folders in that range (+ in-range DB paths). Rebuilds the
photos table for that window while preserving rows outside the range. Does not resume
checkpoints; skips library-wide empty-folder cleanup.

API (SSE): `POST /api/library/make-perfect/date-range/stream`
with body `{"date_from":"2026-05-01","date_to":"2026-06-30"}`.

## Quick start

**Engine:** v2 (`make_library_clean_v2.py` via `make_library_perfect.py`).

From the repo root:

```bash
# Non-destructive: cheap inventory preflight (product default)
python3 tools/benchmark_clean_library.py scan \
  --library /Volumes/public/clean-lib-speed-test \
  --label nas-wifi

# Full suite: preflight_skip → run_full → verify_clean → verify_clean_warm (mutates library)
python3 tools/benchmark_clean_library.py suite \
  --library /Volumes/public/clean-lib-speed-test \
  --label nas-wifi \
  --destructive
```

Reports are written to `tools/results/*.json`.

## Before you run

1. **Stop `app.py`** if it has the library open (SQLite + SMB locks skew results).
2. **Close Finder** windows on the test folder.
3. **Restore the fixture** before repeat suites (full clean changes files):

   ```bash
   # Example: copy from a known snapshot when you have one
   rsync -a --delete /path/to/snapshot/ /Volumes/public/clean-lib-speed-test/
   ```

## What each step measures

| Step | Engine | Product equivalent |
|------|--------|-------------------|
| `preflight_inventory` | `inventory_media_library()` via scan (no verify) | Clean library overlay preflight (counts + duration) |
| `run_full` | `run_db_normalization_engine()` | Clean library stream run (includes blocking `audit` phase) |
| `verify_clean` | `verify_library_cleanliness()` | Standalone yardstick (`?verify=1` scan; same engine as run's final audit) |
| `verify_clean_warm` | Immediate repeat | OS / SMB cache effect |

See `tech-docs/CLEAN_LIBRARY_V2_HANDOFF.md` for full context.

## CI checks

From repo root:

```bash
./tools/run_ci_checks.sh
```

Runs JS syntax checks, orphan-route grep (`tools/check_orphan_routes.py`), and the full Python unittest suite.

## Reading results

- **sec/file** — wall time ÷ supported media files
- **60k est** — linear extrapolation to 60,000 files (directional, not exact)
- **phases** (full run) — `setup`, `scan`, `dedupe`, `canonicalize`, `folders`, `rebuild_db`, `audit`

If `verify_clean` is slow with `issue_count: 0`, verify re-hashes every file even when nothing is dirty.

## Commands

```bash
python3 tools/benchmark_clean_library.py scan --library <path> [--label NAME]
python3 tools/benchmark_clean_library.py run --library <path> --destructive [--label NAME]
python3 tools/benchmark_clean_library.py suite --library <path> --destructive [--label NAME]
python3 tools/benchmark_clean_library.py suite --library <path> --skip-run   # scan only
```

Options: `--output path.json`, `--no-lock-warn`.
