# Share Greenfield Handoff — UI SOT + Secure Access

**Status:** Not started — master plan (2026-08-18).  
**Priority lens:** `.cursor/rules/high-before-low.mdc` — architecture and single source of truth before patches.  
**Supersedes / extends:** `tech-docs/SECURE_SHARE_HANDOFF.md` (security detail), `docs/share-ui-deltas.md` (UI allowlist), `docs/share-ui-parity.md` (behavior matrix).

---

## Executive summary

Share today has **two independent SOT failures**:

1. **UI / behavior** — The app and share viewer are sibling implementations. Interaction logic was partially extracted to `static/js/photoSurface/*`, but grid layout (`VirtualGrid` vs `SimplePhotoGrid`), HTML chrome (`appBar.html` vs `shareAppBar.html`), and orchestration (`main.js` vs `shareBoot.js`) still diverge. CSS copy does not guarantee behavior; dual wiring paths (boot + `onAfterRender`) caused real bugs (e.g. star/select toggled twice).

2. **Access / data** — Share URLs use a slug for navigation, not authorization. The publishable Supabase key in the GitHub Pages viewer allows anon `SELECT` on `albums` / `album_photos` and public reads from the `shares` bucket. See `tech-docs/SECURE_SHARE_HANDOFF.md` for the agreed capability-token model.

**Target:** One photo surface in `static/` (app is canonical; share subtracts features via capabilities). One read gate (`share-resolve` Edge Function). Zero drift: change app UI or interaction once → rebuilt share inherits it; change access model once → browser never talks to Postgres/Storage directly.

**Rule:** Change shared **behavior** in `static/js/photoSurface/*` (and capability-gated chrome/grid) only. Change shared **read contract** in `static/js/shareBoot.js` only. Never hand-edit `share-viewer/`; run `./scripts/build-share-viewer.sh`.

---

## What “subtractive share” means

| Dimension | App (library) | Share viewer |
|-----------|---------------|--------------|
| Grid, selection, lightbox, filters, chrome | Full surface | **Same modules** |
| Date jumper, edit date, delete, import, trash | Yes | **Absent** (capabilities) |
| Virtual scroll (large libraries) | Yes | Optional mode inside **one** grid engine |
| Star persistence | Library DB | `localStorage` (same UX) |
| Data source | Flask `/api/photos` | Edge Function `share-resolve` |
| Photo IDs at adapter boundary | Numeric | UUID strings (`GridSelection.setPhotoIdNormalizer`) |

Intentional UI deltas are allowlisted in `docs/share-ui-deltas.md`. Everything else is a regression.

---

## Target architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  static/  (SINGLE UI SOURCE OF TRUTH)                                   │
│  ├── js/photoSurface/*   grid, tile, selection, interactions, chrome,   │
│  │                        lightbox                                      │
│  ├── js/viewCapabilities.js   LIBRARY | SHARE | trash profiles          │
│  ├── js/shareBoot.js      share host: token parse, Edge Function,        │
│  │                        localStorage adapters → PhotoSurface.init     │
│  ├── js/main.js           library host: Flask API adapters → same init   │
│  ├── fragments/*.html     one chrome shell, capability-gated controls   │
│  └── css/styles.css + share-overrides.css (layout-only deltas)          │
└─────────────────────────────────────────────────────────────────────────┘
         │ build-share-viewer.sh                    │ packaging/build.sh
         ▼                                            ▼
  share-viewer/ (GitHub Pages)              dist/Photos Light.app

┌─────────────────────────────────────────────────────────────────────────┐
│  Supabase (SINGLE READ GATE FOR SHARE)                                  │
│  albums + album_photos — closed RLS (no anon SELECT)                    │
│  storage/shares — private bucket                                          │
│  Edge Function share-resolve — token in → album + signed URLs out       │
└─────────────────────────────────────────────────────────────────────────┘

Publish path (unchanged UX: preflight → inflight → complete):
  share_albums.py (service role) → DB + storage; URL ?t={access_token}
```

### Layer ownership

| Concern | Owner | Notes |
|---------|--------|-------|
| Tile DOM, star badge | `photoSurface/gridTile.js` | |
| Selection model + DOM sync | `photoSurface/gridSelection.js` | String IDs internally; normalizer at host |
| Click routing | `photoSurface/gridInteractions.js` | Wired **once** by grid lifecycle |
| App bar, filter chips, utilities | `photoSurface/chrome.js` | Gated by `ViewCapabilities` |
| Lightbox | `photoSurface/lightboxShell.js` | |
| Grid layout, scroll, filter, months | **One module** (`VirtualGrid` refactored or `PhotoGrid`) | `caps.virtual` for library vs share-sized albums |
| Feature matrix | `viewCapabilities.js` | |
| Share data fetch | `shareBoot.js` | Edge Function only; no PostgREST, no `publicUrl()` |
| Share publish + URL | `share_albums.py`, `shareFlow.js` | `?t=` capability token |
| Access enforcement | Supabase migration + `share-resolve` | Not JS hiding |

### Anti-patterns (do not do)

- Fix the same interaction in both `main.js` and `shareBoot.js` — move to `photoSurface/*`.
- Hand-edit `share-viewer/js/` or `share-viewer/css/` — edit `static/` and rebuild.
- Second grid renderer (`SimplePhotoGrid` parallel to `VirtualGrid`) long term.
- Duplicate HTML fragments for share when capability gating suffices.
- RLS `USING (slug = …)` while anon can still list tables.
- “Secure mode” flag on old PostgREST read path.
- Expose `SUPABASE_SERVICE_ROLE_KEY` in viewer or client-side Edge Function code.

---

## Known debt (starting point)

Documented from prior session:

| Item | Status | Notes |
|------|--------|-------|
| `photoSurface/*` extraction | Partial | Selection, interactions, chrome, lightbox shared |
| ~250 lines duplicate logic in `main.js` | **Fixed** | Delegates to GridSelection, GridInteractions, PhotoChrome |
| Duplicate click listeners (boot + onAfterRender) | Symptom of dual wiring | Unify grid lifecycle owner |
| `GridSelection.setPhotoIdNormalizer` | In place | App: numeric; share: string UUID |
| `VirtualGrid` vs `SimplePhotoGrid` | **Open** | Largest behavior drift |
| `shareAppBar.html` vs `appBar.html` | **Open** | Unify with capabilities |
| Open RLS + public bucket | **Open** | `SECURE_SHARE_HANDOFF.md` |
| `test_grid_selection.py`, `test_share_viewer_build.py` | Passing | Extend for security + e2e |
| Playwright parity | **Missing** | |
| Build script in CI/release | **Missing** | |
| Packaged app verification | Required | `./packaging/build.sh` — not `python3 app.py` |

---

## Implementation order (high → low)

Follow this sequence. Do not start with viewer CSS, slug length tweaks, or one-line interaction patches.

### Phase 1 — Architecture: secure access (Supabase)

**Detail:** `tech-docs/SECURE_SHARE_HANDOFF.md`

1. New migration: `access_token`, optional `expires_at` / `revoked_at`; backfill; **revoke** anon SELECT on `albums`, `album_photos`; **private** `shares` bucket.
2. Implement + deploy Edge Function `supabase/functions/share-resolve/`.
3. Verify with curl:
   - Valid token → 200 + JSON with signed URLs
   - Invalid token → 404
   - PostgREST list with publishable key → denied
   - Direct public storage URL → 403

**Migration choice:** Recommend **Option B** — backfill `access_token = slug`; viewer accepts `?t=` then `?s=` during transition; app emits `?t=` for new shares.

### Phase 2 — Architecture: UI single source of truth

1. **Unify grid** — Merge `SimplePhotoGrid` semantics into one engine behind `ViewCapabilities` (e.g. `virtual: true` library, `virtual: false` share). Same month sections, headers, filter pipeline, tile creation; share may eager-render album-sized sets.
2. **Unify HTML chrome** — Single fragment set (`appBar`, filter rail, utilities); hide/remove controls via capabilities (`dateJumper`, etc.). Retire `shareAppBar.html` / `shareFilterChipRail.html` forks when equivalent.
3. **Single wiring path** — Grid mount owns: render → `GridSelection.applyToDom` → `GridInteractions.wireContainer` (idempotent). Remove redundant wiring from `shareBoot.js` `onAfterRender`.
4. **Introduce `PhotoSurface.init({ caps, adapters })`** (or equivalent) — Thin hosts: `main.js`, `shareBoot.js`, trash only supply data/persistence/action adapters.

### Phase 3 — Product anatomy: publish + viewer adapter

**Publish (desktop):**

1. `share_albums.py` — Generate `access_token`; `insert_album` includes token; storage prefix = token; `build_share_url(?t=)`.
2. `app.py` — Prepare/publish pass token through API responses.
3. `static/js/shareFlow.js` — Display/copy `?t=` URL; session holds token.

**Viewer (`static/js/shareBoot.js` — rebuild after):**

1. Parse `?t=` (optional `?s=` alias during migration).
2. Replace PostgREST + `publicUrl()` with Edge Function fetch.
3. Use `thumb_url` / `original_url` from response.
4. `storageKey()` uses token, not slug.
5. `share-viewer/js/config.js` — `shareResolveUrl` or derive from `supabaseUrl`.

### Phase 4 — Production parity (three surfaces align)

| Surface | Action |
|---------|--------|
| Supabase | Migration + Edge Function + private bucket |
| GitHub Pages | Push rebuilt `share-viewer/` to `photos-light-sharing` |
| Desktop app | `./packaging/build.sh` — publish emits new URLs |

**Failure mode:** Migration + function live but viewer still on PostgREST → all shares break. Deploy viewer **with or before** migration.

Run `./scripts/build-share-viewer.sh` after every `static/` change affecting share.

### Phase 5 — Correctness

**Automated:**

- [ ] `test_share_albums.py` — token URL, `access_token` in insert payload
- [ ] `test_share_viewer_build.py` — still passes; no forbidden patterns in `shareBoot.js`
- [ ] `test_grid_selection.py` — ID normalizer contract
- [ ] Add Playwright suite: same interaction tests on library grid + built share viewer (fixture token / mock Edge Function)
- [ ] CI: build script + unit tests on PR

**Manual:**

- [ ] Publish 3-photo share from **packaged app**; complete overlay shows `?t=` URL
- [ ] Incognito: grid + lightbox + download zip (signed URLs)
- [ ] Wrong token → error UI; function 404
- [ ] Anon cannot list albums or read storage
- [ ] Star/select/shift-range/month-circle match app (parity matrix in `docs/share-ui-parity.md`)

### Phase 6 — Defer

- Expiry/revoke UI, manage-shares admin, content dedup across shares
- Download zip via dedicated Edge Function (v1: client JSZip + signed URLs from resolve)
- CSS cache-bust params, copy nits

---

## File map (read first)

| Area | File | Role |
|------|------|------|
| Security spec (detail) | `tech-docs/SECURE_SHARE_HANDOFF.md` | Token model, Edge Function contract, migration SQL |
| UI allowlist | `docs/share-ui-deltas.md` | Intentional share-only differences |
| Behavior matrix | `docs/share-ui-parity.md` | Shared modules + CI tests |
| Publish | `share_albums.py` | Service-role upload; token generation; URL builder |
| API | `app.py` | `/api/share/prepare`, `/publish`, `/status` |
| Desktop share UI | `static/js/shareFlow.js` | Preflight / inflight / complete |
| Share host | `static/js/shareBoot.js` | **Edit here** for read adapter; then rebuild |
| Library host | `static/js/main.js` | Flask adapters; grid orchestration |
| Capabilities | `static/js/viewCapabilities.js` | LIBRARY vs SHARE profiles |
| Shared surface | `static/js/photoSurface/*.js` | **Edit here** for interaction behavior |
| Grid (to unify) | `static/js/virtualGrid.js`, `static/js/photoSurface/simpleGrid.js` | Target: one engine |
| Build | `scripts/build-share-viewer.sh` | Assembles `share-viewer/` from `static/` |
| Schema | `supabase/migrations/20260812140000_share_albums.sql` | Replace/extend for secure access |
| Tests | `test_share_albums.py`, `test_share_viewer_build.py`, `test_grid_selection.py` | |

---

## Edge Function contract (summary)

Full spec in `SECURE_SHARE_HANDOFF.md`.

- **Request:** `GET /functions/v1/share-resolve?token=…`
- **Response:** `{ album, photos[] }` with `thumb_url`, `original_url` (signed, TTL TBD e.g. 1–24h)
- **Errors:** 400 missing token; 404 invalid/revoked/expired
- **CORS:** GitHub Pages origin + localhost

Viewer must not construct storage URLs; must not call `/rest/v1/albums` or `/rest/v1/album_photos`.

---

## Environment variables

| Var | Where | Purpose |
|-----|-------|---------|
| `SUPABASE_URL` | Desktop `.env` | Publish writes |
| `SUPABASE_SERVICE_ROLE_KEY` | Desktop `.env`; Edge Function secret | Publish + resolve |
| `SHARE_VIEWER_BASE_URL` | Desktop `.env` | Build share URLs |
| Publishable key | `share-viewer/js/config.js` | Invoke Edge Function from browser only |

---

## Done definition

### Security

- [ ] No anon read on `albums`, `album_photos`, or `shares` storage
- [ ] Viewer loads exclusively via `share-resolve`
- [ ] New shares emit `?t={access_token}` URLs
- [ ] Migration choice (A/B/C) recorded in `SECURE_SHARE_HANDOFF.md` → **Status: Shipped**

### UI parity

- [ ] One grid engine; share is capability mode, not permanent `SimplePhotoGrid` fork
- [ ] One HTML chrome with capability gating (or documented minimal build-time strip)
- [ ] Behavior changes only in `photoSurface/*` + capabilities; no parallel host logic
- [ ] `./scripts/build-share-viewer.sh` + tests in CI
- [ ] Playwright parity suite green
- [ ] Verified in `dist/mac-arm64/Photos Light.app`

### Documentation

- [ ] This doc → **Status: Shipped** with deploy date and migration choice
- [ ] `share-viewer/README.md` URL format updated
- [ ] `tech-docs/README.md` index links this handoff

---

## Related docs

- `tech-docs/SECURE_SHARE_HANDOFF.md` — Security/access deep dive
- `docs/share-ui-deltas.md` — UI subtraction allowlist
- `docs/share-ui-parity.md` — Shared module parity matrix
- `.cursor/rules/high-before-low.mdc` — Prioritization
- `.cursor/rules/rebuild-app-for-prod-testing.mdc` — Packaged app verification
- `share-viewer/README.md` — Build and deploy viewer

---

## Open questions

1. **Token length:** 32 url-safe for new shares vs 12-char backfill (`access_token = slug`).
2. **Signed URL TTL:** 1h vs 24h for lightbox/download sessions.
3. **Grid unification:** Refactor `VirtualGrid` in place vs new `PhotoGrid` facade — prefer extend/refactor to avoid a third grid.
4. **GitHub Pages deploy:** Agent/user push access to `photos-light-sharing`.
5. **Playwright:** Mock Edge Function in CI vs staging Supabase project.
