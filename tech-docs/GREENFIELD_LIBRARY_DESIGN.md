# Greenfield Library Design

**Status:** Design reference (not implemented)  
**Date:** June 2026  
**Context:** Blue-sky architecture for rebuilding Photos Light from scratch while preserving locked UX and raising the bar on maintainability, migration, and agent legibility.

---

## 1. Product criteria (articulated)

These are the constraints and quality bar established in design discussion. They govern every decision below.

### Hard constraints

| # | Criterion |
|---|-----------|
| C1 | **Portable media facts must be baked into media** — date taken embedded in file bytes (EXIF, QuickTime atoms, etc.), baked rotation where allowed, and reflected in canonical folder layout. |
| C2 | **Rotation baked where today’s rules allow** — JPEG via `jpegtran -perfect` only; PNG/TIFF lossless; skip HEIC, WebP/AVIF/JP2, and video (same matrix as current `ORIENTATION_BAKING.md`). |
| C3 | **Stars are app truth, not file truth** — favorites live in the overlay only, never in EXIF, QuickTime metadata, sidecar files, or pixels. |
| C4 | **UX locked** — support everything the current app does (Add, Clean, Convert, grid, lightbox, trash, pickers, recovery, etc.), modulo C3. |
| C5 | **Performance ≥ today** — hash caching, lazy thumbnails, virtual grid, WAL SQLite, streaming long ops; room to improve via parallelism and batch tooling. |

### Explicit non-goals

| # | Criterion |
|---|-----------|
| C6 | **Reducing complexity is not a goal** — unless it serves maintainability, best practices, robust architecture, or elegance. |

### Design posture

| # | Criterion |
|---|-----------|
| C7 | **Blue sky / scorched earth** — no obligation to preserve current implementation structure. |
| C8 | **Clean may become obsolete** — the only flow explicitly allowed to shrink or disappear if invariants are maintained elsewhere. |

### Quality bar

| # | Criterion |
|---|-----------|
| C9 | **Best conceivable** — not “good enough” or “non-fatal.” |
| C10 | **Most maintainable** |
| C11 | **Most future-proof** |
| C12 | **Most performant** (subject to C5) |
| C13 | **Easiest to reason about** |
| C14 | **Easiest for agents to work on** |
| C15 | **Extractable knowledge** — a future system (or agent) can migrate the library without reading application source code. |

### Truth split

- **File truth:** date taken, baked orientation where lossless, pixels/bytes, canonical path/name.
- **Overlay truth:** stars, date_added, trash intent, and any app-only facts that should not travel as media metadata.

### Coherent exceptions

- **C3 vs C4:** Star UI, filters, bulk star, and trash read-only stars remain. Only persistence changes: overlay, never file metadata.
- **C8 vs C4:** If Clean disappears as a utilities-menu flow, repair/reconcile capability must still exist (on open, recovery, or background).

---

## 2. Design thesis

**One kernel, three layers, two command lanes, one stable identity.**

```
Layer 0 — PORTABLE     Media files: date + rotation baked; canonical dated tree
Layer 1 — OVERLAY      App truth not in pixels: stars, date_added, trash intent
Layer 2 — DERIVED      Index, hash cache, thumbnails, job scratch — all regenerable
```

**Identity:** Every photo receives a **`photo_id` (UUID) at first ingest**. It never changes. `content_hash` and `rel_path` are mutable facts updated after rotate, date edit, or repair.

**Overlay canonical form:** An **append-only event log** (`overlay.log.jsonl`) is the source of truth for Layer 1. SQLite `overlay.db` is a **materialized projection** for fast queries (star filter, trash list). Rebuild projection from log at any time.

**Operations:**

- **Commands** — instant overlay/index patches (star toggle, etc.)
- **Jobs** — checkpointed, streamed work (Add, Convert, repair, bulk date edit, rotate commit)

**Rulebook:** One compliance module defines audit checks and repair fixes. Import, rotate, date edit, Convert, and repair all call the same primitives. Spec exported to machine-readable JSON for agents.

---

## 3. On-disk layout

Media stays human-visible. All app infrastructure lives under a single hidden root.

```
MyLibrary/
├── 2024/
│   └── 2024-06-15/
│       └── img_20240615_a1b2c3d4.jpg          ← Layer 0
├── 1900/1900-01-01/                           ← undated bucket (Layer 0)
│
└── .library/
    ├── LIBRARY.md                             ← human entry point (purpose, layers, rebuild)
    ├── library.schema.json                    ← machine entry point (generated from rulebook)
    │
    ├── overlay.log.jsonl                      ← Layer 1 canonical (append-only events)
    ├── overlay.db                             ← Layer 1 projection (stars, trash, import meta)
    │
    ├── index.db                               ← Layer 2 (grid/catalog projection)
    │
    ├── cache/
    │   ├── thumbnails/                        ← content-hash keyed JPEG squares
    │   └── hash.db                            ← path → hash cache (or LMDB)
    │
    ├── staging/                               ← atomic write temp (deleted after commit)
    ├── trash/                                 ← relocated media bytes (not metadata)
    │   ├── user_deleted/
    │   ├── duplicates/
    │   └── unsupported/
    │
    ├── jobs/<job_id>/                         ← manifest.jsonl + checkpoint.json
    └── backups/
        └── overlay/                           ← overlay.log + overlay.db snapshots only
```

### Backup policy

**Precious:** Layer 0 media + `.library/trash/` until purge + `overlay.log.jsonl` + `library.schema.json` + `LIBRARY.md`  
**Optional:** `overlay.db` (rebuild from log)  
**Never backup as truth:** `index.db`, `cache/`, `jobs/`

Trash is still user media until a purge operation commits. A backup tool may exclude trash only if the user has explicitly accepted that purged-or-pending-delete files are outside their recovery set.

---

## 4. Layer responsibilities

### Layer 0 — Portable media

**Owns:** pixels, embedded date taken, baked orientation (when allowed), canonical path/name.

**Path rule (unchanged from today):**

```
YYYY/YYYY-MM-DD/img_YYYYMMDD_<hash8>.ext
```

Undated photos: `1900/1900-01-01/img_19000101_<hash8>.ext`

**Read precedence for date** (same as today):

1. Trusted embedded metadata (EXIF / QuickTime / ffprobe)
2. Canonical basename `img_YYYYMMDD_*`
3. Photos unknown → `1900-01-01`; video mtime fallback only at ingest

**Write policy:** embed and verify after every mutation that touches metadata. Fail closed — no catalog commit if verify fails.

### Layer 1 — Overlay (app truth)

**Owns:** everything the app knows that must not be in files.

| Field | Example event |
|-------|----------------|
| `photo_id` | Assigned at ingest; stable forever |
| Ingest | `{ "op": "ingest_media", "photo_id": "…", "rel_path": "…", "content_hash": "…", "date_added": "…" }` |
| Starred | `{ "op": "set_starred", "photo_id": "…", "value": true }` |
| `date_added` | `{ "op": "set_date_added", "photo_id": "…", "at": "…" }` |
| Trash | `{ "op": "move_to_trash", "photo_id": "…", "trash_relpath": "…" }` |
| Restore | `{ "op": "restore", "photo_id": "…" }` |

**On content-changing mutations** (rotate, date edit), append:

```json
{ "op": "update_media", "photo_id": "…", "content_hash": "…", "rel_path": "…" }
```

Overlay events reference **`photo_id`**, not hash. Hash changes do not orphan stars or trash state.

**Projection (`overlay.db`):** small tables materialized from log tail; rebuilt on open or after corruption.

### Overlay log durability

The log is not an informal debug stream. It is canonical state and must be treated like a small database:

- Every event has `event_id`, `schema_version`, `created_at`, `op`, and an event checksum.
- Appends are atomic: write complete JSONL records, flush/fsync according to platform policy, then patch projections.
- Projection commits store the last applied `event_id`; rebuild resumes from the last verified event.
- Corrupt or partial tail records are quarantined, never silently skipped.
- Log compaction is allowed only by writing a verified `overlay.snapshot.jsonl` plus a new log generation.

### Layer 2 — Derived

**Owns:** anything rebuildable without user-visible data loss.

| Store | Purpose | Rebuild |
|-------|---------|---------|
| `index.db` | Grid rows, month histograms, filters | `rebuild_index()` = walk Layer 0 + join overlay projection |
| `cache/thumbnails/` | Square JPEG previews | Lazy regen from content hash |
| `cache/hash.db` | One row per library-relative path | Wipe anytime; repopulate on scan |
| `jobs/` | Operational audit, resume checkpoints | Not migrated; optional retention policy |

**Incremental index maintenance:** normal mutations patch affected rows. Full rebuild is offline/rare (recovery, corruption, major repair).

---

## 5. Library Kernel

Single-writer process owning all disk mutations and catalog consistency.

```
┌─────────────────────────────────────────────────────────┐
│  Shell (Electron)                                       │
│  Flows, grid, lightbox, pickers — presentation only      │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTP + SSE (localhost)
┌───────────────────────────▼─────────────────────────────┐
│  API (thin)                                             │
│  Query plane (reads)  │  Command plane  │  Stream plane │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  Library Kernel                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ Job runtime │  │ Command bus  │  │ Compliance      │ │
│  │ checkpoint  │  │ star, etc.   │  │ rulebook        │ │
│  └──────┬──────┘  └──────┬───────┘  └────────┬────────┘ │
│         └────────────────┼───────────────────┘          │
│                          ▼                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Media    │  │ Overlay  │  │ Index    │  │ Cache   │ │
│  │ pipeline │  │ log+proj │  │ builder  │  │ manager │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└─────────────────────────────────────────────────────────┘
                            │
              exiftool, jpegtran, ffmpeg, sips
```

### Module boundaries (for maintainability + agents)

| Module | Responsibility | Must not |
|--------|----------------|----------|
| `library-spec` | Layout, date, orientation rules; generates `library.schema.json` | Touch pixels |
| `media` | Probe → transform → embed date → verify → hash → stage → commit | Know about stars |
| `overlay` | Append events; project to `overlay.db` | Mutate files |
| `index` | Build/patch/query projection | Be source of truth |
| `jobs` | Checkpoint, manifest, cancel, resume | Embed flow-specific rules |
| `api` | Route to kernel | Contain business logic |

Each module ships: types, invariants, fixture library, golden tests.

### Media pipeline (every file touch)

```
Probe → Plan → Transform → EmbedDate → Verify → Hash → Stage → Commit → OverlayEvent → IndexPatch
```

Same pipeline for ingest, rotate commit, date edit, and repair.

---

## 6. Operations map (UX → kernel)

| Current UX | Kernel | Lane |
|------------|--------|------|
| Add photos | `ingest` job | Job (SSE) |
| Clean library | `repair_library` job | Job (SSE); may become background reconcile (C8) |
| Convert to library | `convert_folder` job | Job (SSE) |
| Edit date (single/bulk) | `edit_date` job | Job (SSE) |
| Rotate (lightbox commit) | `rotate` job/command | Command or short job |
| Star / bulk star | `set_starred` command | Command (overlay append + index patch) |
| Delete / restore / purge trash | overlay + file move commands/jobs | Mixed |
| Open library / recovery | `attach_library`, `rebuild_index`, optional repair | Job |
| Grid / lightbox / trash browse | Query plane | Read |

All flows share lifecycle: **preflight → inflight → complete**, uniform stream envelope, shared scorecard/log patterns.

### Clean library (C8)

Long-term: invariants enforced on every mutation via media pipeline + verify. **Clean** shrinks to:

- Legacy libraries opened for the first time
- External tampering detected on open
- User-initiated “Verify & repair” (discoverable utilities entry)

Background reconcile on open is acceptable replacement for routine cleanup if UX parity for recovery is preserved. A visible repair command remains part of the product surface so users have an explicit recovery path.

---

## 7. Performance (C5, C12)

Keep what works today; add where safe:

| Technique | Target |
|-----------|--------|
| Hash cache (`hash.db`, one row per rel_path) | Scan, dedupe, audit |
| exiftool stay-open batching | Ingest, repair, date embed |
| Worker pool for independent files | Ingest, repair (catalog commits serialized) |
| WAL SQLite | Overlay + index reads during writes |
| Lazy thumbnails (content-hash keyed) | Grid |
| Virtual grid + keyset pagination | Client |
| Thumbnail queue (viewport priority) | Client |
| Incremental index patch | Star toggle, single delete |
| Skip unchanged files in audit | Hash cache hit + path compliance check |

Star toggle becomes **faster** than today (overlay append only, no EXIF round-trip).

---

## 8. Migration and agent legibility (C14, C15)

### Entry points

1. **`LIBRARY.md`** — human: layers, rebuild commands, invariants
2. **`library.schema.json`** — machine: spec version, overlay event schema, layout rules, date/orientation matrices (generated from `library-spec`, never hand-edited)

### Export bundle (first-class command)

```
export/
├── LIBRARY.md
├── library.schema.json
├── overlay.snapshot.jsonl       ← full Layer 1 dump
├── media/                       ← optional copy or manifest of paths
└── REBUILD_INDEX.md             ← procedure for importer
```

`overlay.snapshot.jsonl` is a current-state export, not merely a replay log. It includes one row per known `photo_id` with current `rel_path`, `content_hash`, star state, trash state, `date_added`, and schema version.

A new system (or agent) needs:

1. Walk Layer 0 (self-describing media tree)
2. Read `overlay.snapshot.jsonl` (join on `photo_id`)
3. Ignore Layer 2 entirely

### Join key

**`photo_id`** for overlay. **`content_hash`** for dedupe and thumbnail cache. **`rel_path`** for filesystem operations. Never use hash alone as overlay identity.

---

## 9. Invariants (non-negotiable)

1. **File wins for portable semantics** — date taken and baked rotation in bytes; index mirrors, does not override.
2. **Overlay wins for app semantics** — stars, date_added, trash intent; never written to EXIF.
3. **Derived is disposable** — if `index.db` is deleted, library is intact; run `rebuild_index()`.
4. **Fail closed** — verify-after-write for Layer 0 mutations; revert optimistic UI on failure.
5. **Stable identity** — `photo_id` survives path and hash changes.
6. **Single writer** — kernel serializes structural mutations; commands queue through same gate.
7. **One rulebook** — audit and repair definitions have one source; exported to schema JSON.

---

## 10. Relation to current app

| Today | Greenfield |
|-------|------------|
| Stars in EXIF + DB | Overlay only |
| One `photo_library.db` for catalog + hash_cache + deleted JSON blobs | Split: overlay.log + overlay.db + index.db + hash.db |
| Multiple root dot-folders (`.thumbnails`, `.logs`, …) | Single `.library/` root |
| `content_hash` as implicit identity | `photo_id` + mutable hash |
| Per-flow endpoints and checkpoint formats | Unified job runtime + job manifests |
| Flask monolith (`app.py`) | Kernel modules + thin API |
| Debug vs production mutation paths | One command/job contract |

This document does **not** prescribe an incremental migration plan from the current codebase. It is the target architecture if rebuilding from scratch under the stated criteria.

---

## 11. Open decisions (explicitly deferred)

| Topic | Options | Notes |
|-------|---------|-------|
| Kernel language | Rust, Go, or strict modular Python | Rust/Go favored for concurrency + single binary; not a criteria lock |
| Shell | Electron vs Tauri vs native | Electron assumed for UX parity; not proven optimal |
| Clean UX | Utilities menu vs silent reconcile | C8 allows either if recovery works |
| Export sidecar for stars | Include `.photos-light.json` beside exported files | Not required by criteria; power-user option |
| Job log retention | Keep 30 days vs forever | Operational, not architectural |

---

## 12. Summary

The net design is a **local-first Library Kernel** with:

- **Layer 0:** dated media tree, date and rotation baked under today’s rules  
- **Layer 1:** append-only overlay log + SQLite projection; **`photo_id` stable forever**  
- **Layer 2:** index, cache, thumbnails, jobs — regenerable, never backed up as truth  
- **Commands** for instant app state; **jobs** for checkpointed file work  
- **One rulebook** exported as `library.schema.json` for agents and future importers  
- **UX parity** modulo stars-not-in-files; **Clean** optional if reconcile covers legacy  

Quality bar: maintainable, future-proof, performant, easy to reason about, and migratable without reading app source — not merely “non-fatal.”
