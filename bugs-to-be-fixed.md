# Bugs To Be Fixed

Last updated: June 18, 2026

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
