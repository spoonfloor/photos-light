# Secure Share Links — Agent Handoff

**Status:** Shipped (2026-08-18). Migration **Option B** (`access_token = slug` backfill; viewer accepts `?t=` then `?s=`; app emits `?t=` for new shares).  
**Priority lens:** `.cursor/rules/high-before-low.mdc` — fix the **access model** first; do not patch RLS or hide list calls in JS.  
**User intent:** Implement capability-token shares so recipients cannot enumerate or read other albums.  
**Master plan:** `tech-docs/SHARE_GREENFIELD_HANDOFF.md` — UI SOT + secure access (implementation order, done definition).

---

## Executive summary

Share links today upload album metadata and files to Supabase correctly, but **reads are wide open**: anyone with the publishable key (embedded in the GitHub Pages viewer) can `SELECT *` from `albums` / `album_photos` and fetch any object in the public `shares` bucket. The URL slug is navigation, not authorization.

**Target model:** one **capability token** per share in the URL (`?t=…`). The browser never queries Postgres or Storage directly. A single **read gateway** (Supabase Edge Function) validates the token and returns album JSON plus **signed storage URLs**. Tables stay unified (`albums` + `album_photos`); security moves to closed RLS + private bucket.

---

## Current architecture (as of handoff)

```
Photos Light app                    Supabase                         GitHub Pages
     │                                  │                                  │
     │  prepare: generate slug (local)  │                                  │
     │  publish: service role writes    │                                  │
     │ ───────────────────────────────► │  albums + album_photos (PUBLIC)  │
     │                                  │  storage/shares (PUBLIC bucket)  │
     │  returns ?s={slug} URL           │                                  │
     │                                                                  │
     │  recipient opens link ──────────────────────────────────────────► │
     │                                  │  ◄── shareBoot.js PostgREST     │
     │                                  │  ◄── public storage URLs        │
```

### Key files (read these first)

| Area | File | Role |
|------|------|------|
| Publish (write) | `share_albums.py` | Service-role upload + insert; slug generation; URL builder |
| API routes | `app.py` (`/api/share/prepare`, `/api/share/publish`, `/api/share/status`) | Prepare slug, SSE publish |
| Desktop UI | `static/js/shareFlow.js` | Preflight → inflight → complete overlay |
| Viewer data adapter | `static/js/shareBoot.js` | **Edit here** — copied to `share-viewer/js/` by build script |
| Viewer config | `share-viewer/js/config.js` | Supabase URL + publishable key (deploy-only; not generated) |
| Viewer build | `scripts/build-share-viewer.sh` | Assembles `share-viewer/` from `static/` |
| Schema | `supabase/migrations/20260812140000_share_albums.sql` | Open RLS + public bucket — **replace/extend** |
| Tests | `test_share_albums.py`, `test_share_viewer_build.py` | Unit + build guardrails |
| Env | `.env.example` | `SUPABASE_*`, `SHARE_VIEWER_BASE_URL` |

### Current URL format

```
https://spoonfloor.github.io/photos-light-sharing/?s={slug}
```

`slug` = 12-char `[a-z0-9]` from `generate_share_slug()` in `share_albums.py`.

### Current insecure policies (must remove)

From `20260812140000_share_albums.sql`:

- `albums_public_read` — `FOR SELECT … USING (true)`
- `album_photos_public_read` — same
- `shares_public_read` on `storage.objects` — entire bucket readable
- Bucket `shares` created with `public = true`

### Viewer read path today (`static/js/shareBoot.js`)

1. `parseSlug()` → `?s=` query param
2. `GET /rest/v1/albums?slug=eq.{slug}`
3. `GET /rest/v1/album_photos?album_id=eq.{id}`
4. `publicUrl(thumb_path)` → `/storage/v1/object/public/shares/…`

---

## Target architecture

```
Photos Light app                    Supabase
     │                                  │
     │  publish (service role)          │
     │ ───────────────────────────────► │  albums + album_photos (NO anon SELECT)
     │                                  │  storage/shares (PRIVATE bucket)
     │  returns ?t={access_token}       │
     │                                  │
GitHub Pages viewer                    │
     │  GET /functions/v1/share-resolve?token=…
     │ ───────────────────────────────► │  Edge Function (service role inside)
     │ ◄─────────────────────────────── │  { album, photos[], signed URLs }
```

### Access contract (single source of truth)

| Concern | Owner | Rule |
|---------|-------|------|
| Token generation | `share_albums.py` | High-entropy secret per share (recommend 32+ url-safe chars; keep or rename `generate_share_slug`) |
| URL shape | `share_albums.py` `build_share_url()` | `{SHARE_VIEWER_BASE_URL}/?t={access_token}` |
| Write path | `share_albums.py` + service role | Unchanged flow; store token on album row; storage prefix = token |
| Read path | Edge Function `share-resolve` only | Token in → album + signed URLs out; 404 if missing/expired/revoked |
| Browser | `shareBoot.js` | Calls Edge Function only; **no** PostgREST, **no** public storage URL builder |

### Schema changes (one migration)

Extend `albums` (do **not** create one table per share):

```sql
-- New columns on public.albums
access_token   text unique not null
expires_at     timestamptz null      -- optional v1; column OK to add now
revoked_at     timestamptz null      -- optional v1

-- slug column: keep for back-compat or drop after migration; token is the secret
```

Storage paths: `{access_token}/{position:04d}_{photo_id}/original.ext` (same shape as today but folder = token not slug).

RLS after migration:

- **Revoke** anon/authenticated `SELECT` on `albums`, `album_photos`
- **Revoke** anon storage read/list on `shares` bucket
- Service role (desktop publish + Edge Function) retains full access

### Edge Function: `share-resolve`

Suggested behavior:

1. Parse `token` query param; reject missing/empty → 400
2. Lookup `albums` where `access_token = token` and `revoked_at IS NULL` and (`expires_at IS NULL OR expires_at > now()`)
3. Not found → 404 (generic message)
4. Load `album_photos` ordered by `position`
5. For each row, create signed URLs for `thumb_path` and `original_path` (TTL e.g. 1–24h)
6. Return JSON:

```json
{
  "album": { "id", "title", "photo_count", "created_at" },
  "photos": [
    {
      "id", "position", "date_taken", "file_type", "width", "height", "rating",
      "original_filename", "thumb_url", "original_url"
    }
  ]
}
```

Place function under `supabase/functions/share-resolve/` (create if missing). Deploy with Supabase CLI or MCP.

CORS: allow GitHub Pages origin + localhost for dev.

---

## Implementation order (high → low)

Follow this sequence. Do not start with viewer CSS or slug length tweaks.

### Phase 1 — Architecture (Supabase)

1. **New migration** (e.g. `supabase migration new secure_share_access`) — add columns, backfill, lock RLS, private bucket
2. **Backfill existing rows:** `UPDATE albums SET access_token = slug WHERE access_token IS NULL` (preserves old links if viewer accepts `?s=` temporarily — see migration note below)
3. **Implement + deploy** `share-resolve` Edge Function
4. **Verify** with curl:
   - Valid token → 200 + JSON
   - Invalid token → 404
   - `GET /rest/v1/albums` with publishable key → empty or 401/403
   - Direct public storage URL → 403

### Phase 2 — Product anatomy (app publish + URL)

1. **`share_albums.py`**
   - Generate `access_token` at prepare time (or reuse single secret for slug+token initially)
   - `insert_album()` includes `access_token`
   - `build_share_url(token)` → `?t=`
   - Storage prefix uses `access_token`
2. **`app.py`** — prepare/publish pass token through (rename response fields if needed: `access_token`, keep `slug` internal only)
3. **`static/js/shareFlow.js`** — display/copy new URL shape; session holds token
4. **Tests** — update `test_share_albums.py` for `?t=` URLs

### Phase 3 — Production parity (viewer)

1. **`static/js/shareBoot.js`** (source of truth — run build script after)
   - Parse `?t=` (optionally accept `?s=` as alias during migration window)
   - Replace `supabaseFetch('/rest/v1/…')` with Edge Function fetch
   - Use `thumb_url` / `original_url` from response (drop `publicUrl()`)
   - `storageKey()` should use token not slug
2. **`share-viewer/js/config.js`** — add `shareResolveUrl` or derive from `supabaseUrl`
3. Run `./scripts/build-share-viewer.sh`
4. Update `share-viewer/README.md` URL format
5. **Deploy** built `share-viewer/` to `photos-light-sharing` GitHub Pages repo (user may do manually — document steps)

### Phase 4 — Correctness

1. End-to-end: select photos → share → open link in browser
2. Rebuild packaged app per `.cursor/rules/rebuild-app-for-prod-testing.mdc` before prod verification
3. Confirm old shares: either broken (acceptable) or backfilled with `access_token = slug` + viewer accepts both query params during transition

### Phase 5 — Defer

- Expiry/revoke UI in desktop app
- “Manage shares” admin screen
- Content dedup across shares
- Download zip via Edge Function (viewer currently uses JSZip client-side with direct URLs — will need signed URLs per file)

---

## Migration strategy for existing shares

**Option A (simplest):** Backfill `access_token = slug`, switch viewer to `?t=` only, **old `?s=` links break** unless viewer reads both params during a deprecation window.

**Option B (soft transition):** Backfill `access_token = slug`; viewer tries `?t=` then `?s=`; app emits `?t=` for new shares. Remove `?s=` support after a date.

**Option C (hard cut):** New tokens for all rows; all old links break. Only if no production shares matter.

Recommend **Option B** for minimal user pain.

Existing storage objects use `{slug}/…` paths. If token ≠ slug after backfill, either:

- Keep `slug` column equal to folder prefix and set `access_token` separately (requires **moving** storage objects), or
- Set `access_token = slug` so paths stay valid (easiest)

---

## Deploy coordination (three surfaces must align)

| Surface | Action |
|---------|--------|
| Supabase | Apply migration + deploy Edge Function + confirm bucket private |
| GitHub Pages | Push rebuilt `share-viewer/` to `spoonfloor/photos-light-sharing` |
| Desktop app | Rebuild `.app` (`./packaging/build.sh`) so publish emits new URLs |

**Failure mode:** migration + function live but viewer still on old PostgREST path → all shares 404. Deploy viewer before or with migration.

---

## Test plan

### Automated

- [ ] `test_share_albums.py` — token URL format, insert payload includes `access_token`
- [ ] `test_share_viewer_build.py` — still passes after `shareBoot.js` changes
- [ ] Add tests for `build_share_url`, token length/charset if logic changes

### Manual / integration

- [ ] Publish 3-photo share from app; complete overlay shows `?t=` URL
- [ ] Open URL in incognito → grid + lightbox load
- [ ] `curl` list albums with publishable key → denied
- [ ] Wrong token → viewer shows error, function returns 404
- [ ] Download selected photos still works (signed URLs in zip flow)
- [ ] Packaged app publish path (not just `python3 app.py`)

---

## Red flags — do NOT do these

- Per-share tables or schemas
- RLS `USING (slug = …)` while anon can still list tables
- Hide list in JS only — PostgREST must be closed
- Second parallel read path (e.g. “secure mode” flag on old viewer)
- Fork `shareBoot.js` under `share-viewer/js/` — edit `static/js/shareBoot.js` and rebuild
- Expose `SUPABASE_SERVICE_ROLE_KEY` in viewer or Edge Function client code

---

## Environment variables

| Var | Where | Purpose |
|-----|-------|---------|
| `SUPABASE_URL` | Desktop `.env` | Publish writes |
| `SUPABASE_SERVICE_ROLE_KEY` | Desktop `.env` only | Publish writes; Edge Function secret |
| `SHARE_VIEWER_BASE_URL` | Desktop `.env` | Build share URLs |
| `SUPABASE_PUBLISHABLE_KEY` | `share-viewer/js/config.js` | Call Edge Function from browser |

Edge Function needs `SUPABASE_SERVICE_ROLE_KEY` as a **secret** (Supabase dashboard / CLI secrets).

---

## Related docs

- `tech-docs/SHARE_GREENFIELD_HANDOFF.md` — **Master plan:** UI parity + secure access, phased implementation
- `share-viewer/README.md` — build + deploy viewer
- `docs/share-ui-deltas.md` — UI constraints for share surface
- `docs/share-ui-parity.md` — Shared module behavior matrix
- `.cursor/rules/rebuild-app-for-prod-testing.mdc` — prod verification
- `.cursor/rules/high-before-low.mdc` — prioritization

---

## Open questions for implementer

1. **Token length:** 12 chars (current slug entropy) vs 32 url-safe — recommend 32 for greenfield tokens; backfill may keep 12.
2. **Signed URL TTL:** balance lightbox session length vs leakage window (1h vs 24h).
3. **GitHub Pages deploy:** confirm agent/user has push access to `photos-light-sharing` or document handoff step.
4. **Supabase project:** linked ref in `supabase/.temp/project-ref` — use MCP/CLI against that project.

---

## Done definition

- [x] No anon read on `albums`, `album_photos`, or `shares` storage
- [x] Viewer loads exclusively via `share-resolve`
- [x] New shares emit `?t={access_token}` URLs
- [x] Publish flow unchanged UX (preflight / inflight / complete)
- [x] Tests green; prod `.app` rebuilt (`./packaging/build.sh`, bundled static verified 2026-08-18)
- [x] This doc updated with **Status: Shipped** and migration choice **Option B** recorded
