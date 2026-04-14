# DB Cleanliness SOT - Agent Handoff

## Mission

Implement a **single source of truth for library cleanliness rules** and make all cleanliness-sensitive workflows consume it.

This is **not** a request to create one giant workflow.

This **is** a request to:

- centralize the canonical rules
- keep multiple orchestrators
- remove duplicated / drifting cleanliness logic from `app.py` and `make_library_perfect.py`

The next agent should treat this as an architectural cleanup with immediate correctness fixes, not a broad rewrite.

---

## Non-Negotiable Product Intent

The user intent from the prior discussion was:

- The "engine" should be composed of modules that can be used wherever needed.
- There should be **one SOT for rules**, not multiple parallel truths.
- Import, rotate, open/switch library, recovery, and clean-library should all rely on shared cleanliness primitives.
- `DBNormalizationEngine` should remain the heavyweight whole-library repair/audit orchestrator, but it should **not** be the only place where the app knows what "clean" means.

Phrase to remember:

**One SOT, many orchestrators.**

---

## Current Diagnosis

### 1. Canonical naming/path logic is duplicated

There are at least two separate implementations of canonical path generation:

- `app.py` -> `build_canonical_photo_path()`
- `make_library_perfect.py` -> `canonical_relative_path()`

They currently encode the same short-hash naming policy in two places. That is an immediate drift risk.

### 2. Lightbox rotation is cleanliness-incomplete

`rotate_photo()` and its background reconcile path update dimensions and `content_hash`, but do **not** guarantee that `current_path` is renamed/moved to the canonical short-hash path implied by the new hash.

This means a photo can become:

- hash-updated in DB
- thumbnail-invalidated
- still stored at a path that no longer matches canonical naming policy

That is a real cleanliness bug, not just an architectural smell.

### 3. Library DB health is classified in more than one way

Good path:

- `db_health.py` is already a centralized classifier
- `switch_library()` already uses `check_database_health()`

Bad path:

- `library_status()` still does ad hoc SQLite probing instead of delegating to `db_health.py`

Result:

- open/switch/status flows are not guaranteed to agree on what "healthy", "missing", "corrupt", or "needs migration" means

### 4. The engine is too monolithic to be the only owner of cleanliness

`make_library_perfect.py` contains:

- file normalization
- canonical naming
- duplicate handling
- relocation
- DB rebuild
- final audit

That is fine for the whole-library cleanup workflow, but these rules also need to be available to import, rotate, recovery, and library-open flows.

---

## Existing Good Building Blocks

These should be preserved and reused, not replaced:

- `library_layout.py`
  - canonical DB location
  - metadata dir / infrastructure dir rules
  - legacy vs canonical DB resolution

- `db_health.py`
  - DB status classification
  - one report object for healthy/missing/corrupt/mixed-schema/etc.

- `rotation_utils.py`
  - physical image rotation behavior
  - orientation stripping
  - lossless-vs-lossy rotation policy

Treat these as seeds of the SOT architecture.

---

## Target Architecture

Do **not** over-focus on exact filenames. The important thing is separation of responsibility.

The next agent may implement this as:

- a small package
- 2-3 new modules
- or a staged extraction into one shared module first

But conceptually the code should separate into:

### A. Pure cleanliness policy

No filesystem mutation.

Own:

- canonical date normalization
- canonical filename/path derivation
- short-hash naming policy
- root-entry allowlist
- ignored files like `.DS_Store`
- year/day folder validation
- media type classification

### B. File mutation / canonicalization operations

Filesystem effects allowed.

Own:

- bake orientation when appropriate
- write metadata in correct sequence
- recompute final hash after byte-changing operations
- compute final dimensions
- move/rename to canonical location
- thumbnail invalidation hooks

### C. DB reconciliation

DB effects allowed.

Own:

- reconcile one finalized file with its DB row
- duplicate detection contract where DB state matters
- rebuild `photos` table from canonical records
- DB-vs-filesystem audit helpers

### D. Orchestrators

These should remain separate:

- import flow
- lightbox rotation flow
- library open/switch/status flow
- missing/corrupt DB recovery flow
- `DBNormalizationEngine`

Each orchestrator should call the shared SOT modules instead of owning its own rules.

---

## Recommended Implementation Order

Do this in phases. Do not start with a giant rewrite.

### Phase 1: Extract the pure canonical helpers

First move the lowest-risk shared logic into one place.

Expected content:

- canonical date parsing/normalization
- canonical path builder
- root/day/year folder helpers
- ignored library files

Then make both:

- `app.py` import code
- `make_library_perfect.py`

use that shared implementation.

This is the best first step because it reduces drift immediately and is low risk.

### Phase 2: Unify DB health usage

Refactor `library_status()` and any other open/status path to use `check_database_health()` instead of bespoke SQLite checks.

At the end of this phase:

- startup
- status endpoint
- switch/open flow
- recovery decisions

should all agree on DB health classification.

### Phase 3: Extract a shared "finalize mutated media" helper

Create one helper responsible for the critical post-mutation canonicalization sequence.

That helper should be able to take a file whose bytes may have changed and return a fully canonical result:

- final hash
- final dimensions
- final canonical path
- thumbnail invalidation info
- duplicate collision info if relevant

This helper is the bridge between policy and execution.

### Phase 4: Fix lightbox rotation to use the shared finalization path

This is the highest-priority correctness fix.

After rotation, the app must end with:

- correct final `content_hash`
- correct final `current_path`
- correct dimensions
- invalidated old thumbnail
- DB and disk in agreement

Today it does not fully guarantee that.

### Phase 5: Refactor import to consume the same shared helper

Import already does the right class of work, but inline.

Replace duplicated path/hash/finalize logic with the shared canonicalization/finalization helper.

Do **not** regress the existing import behavior:

- build initial canonical path
- bake orientation
- write EXIF/video metadata
- rehash after byte changes
- rename to final canonical path derived from final hash
- update DB with final path/hash/size

### Phase 6: Slim `DBNormalizationEngine` into an orchestrator

Once shared helpers exist, make the engine consume them rather than owning parallel implementations.

The engine should still orchestrate:

- scan filesystem
- normalize files
- dedupe
- move to canonical locations
- rebuild/reconcile DB
- final audit

But it should stop being a second independent source of cleanliness truth.

### Phase 7: Align rebuild/recovery

Keep the safe two-phase rebuild mechanics.

But make the actual rebuild/indexing path use the same canonicalization and reconciliation rules as the rest of the app.

---

## Testing Strategy

This is important: **do not blindly "characterize current behavior"**.

The previous review correctly pointed out that some current behavior is already wrong. If you lock that behavior into tests, you will protect drift.

Use two categories of tests:

### 1. Invariant tests

Safe to lock down immediately.

Examples:

- canonical DB path is `.library/photo_library.db`
- canonical filename uses short hash
- `.DS_Store` is ignored
- root-level `photo_library.db` is not canonical
- DB health classification returns expected statuses

### 2. Desired-state tests for known bugs

For behaviors already believed to be wrong, do **not** write regression tests for the bad behavior.

Instead write tests that enforce the intended end state.

Examples:

- after rotation changes file bytes, the final file path matches the new canonical short-hash path
- after rotation, DB row and disk path agree
- `library_status()` and `switch_library()` classify the same unhealthy DB consistently

---

## Immediate Code Targets

These are the highest-value concrete areas to touch.

### 1. `app.py`

Target symbols / areas:

- `build_canonical_photo_path()`
- import flow around `/api/photos/import-from-paths`
- rotation flow:
  - `rotate_photo()`
  - `reconcile_rotated_photo_background()`
- library health / open flow:
  - `library_status()`
  - `switch_library()`

### 2. `make_library_perfect.py`

Target symbols / areas:

- `canonical_relative_path()`
- `parse_metadata_datetime()`
- `normalize_media_file()`
- `move_to_canonical_locations()`
- `rebuild_photos_table()`
- `final_audit()`

### 3. `db_health.py`

Preserve as authoritative DB classifier. Expand usage before expanding behavior.

### 4. `library_layout.py`

Preserve as authoritative DB-path/layout helper.

### 5. `rotation_utils.py`

Preserve as authoritative rotation-operation helper.

Do not duplicate rotation rules elsewhere.

---

## Specific Acceptance Criteria

The refactor is not done until these are true:

### Canonical rule sharing

- There is exactly one shared implementation of canonical media path derivation.
- Import and cleaner both use that shared implementation.

### Rotation cleanliness

- Rotating a photo can no longer leave the DB on a new hash while the file remains at an old now-noncanonical path.
- Post-rotate DB state and filesystem state are canonical and aligned.

### DB health consistency

- `library_status()` and `switch_library()` use the same DB health classifier.
- Missing / corrupt / outdated schema states are surfaced consistently.

### Engine scope

- `DBNormalizationEngine` still works as a whole-library repair/audit workflow.
- But the app no longer relies on it as the only place that "knows" cleanliness rules.

### Regression safety

- Invariant tests exist for the shared cleanliness rules.
- Desired-state tests exist for the rotation cleanliness bug and DB-health consistency.

---

## Things To Avoid

- Do not make every workflow literally call `DBNormalizationEngine`.
- Do not create another parallel implementation of path/hash canonicalization during the refactor.
- Do not mix "current behavior tests" and "desired behavior tests" carelessly.
- Do not over-design the final module/package layout before extracting the first shared rule.
- Do not lose the existing user-facing behavior of import while refactoring internals.

---

## Suggested First Four Commits / Work Chunks

If the next agent wants a concrete sequence, this is the best one:

1. Extract shared canonical path/date helpers and switch import + cleaner to use them.
2. Refactor `library_status()` to use `db_health.py`.
3. Introduce shared post-mutation finalization helper.
4. Refactor lightbox rotation reconcile to use that helper and end in canonical path/hash/DB state.

After that, continue with import cleanup and engine slimming.

---

## Final Instruction To Next Agent

Start narrow and prove convergence.

Do **not** begin by moving lots of files around.

Instead:

1. centralize the pure rules
2. make two existing consumers share them
3. fix the real rotation cleanliness bug
4. unify DB health classification
5. then continue the broader cleanup

If you do only one thing first, make it:

**extract canonical media path/date logic into one shared home and make both import and `DBNormalizationEngine` use it.**

