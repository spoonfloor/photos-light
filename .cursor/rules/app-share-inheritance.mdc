---
description: Share inherits app UI/behavior by default; design every app feature with share in mind
alwaysApply: true
---

# App → share inheritance

The share experience is not a separate product surface. It is the **same UI** as the app, delivered through a different boot path and data source. **Change the app → share should pick it up automatically** wherever common sense allows.

## Default rule

**Inherit everything** from the main app unless explicitly forbidden:

- Visual design (layout, typography, spacing, motion, skeletons, lightbox chrome)
- Behavior (grid, filters, date picker, lightbox, toasts, loading phases)
- Performance patterns (lazy load, image tiers, scroll/layout strategies shared with app)

Do **not** reimplement, duplicate, or fork share-specific copies of logic that already exists under `static/`.

## Design new app features for share

When adding or changing **any** app feature, assume it **may belong in share** unless it is clearly library-only (mutations, local filesystem, account settings, etc.).

Before landing app-only code, ask:

1. **Should share get this?** If yes → build in shared modules from the start, not as a follow-up port.
2. **What must differ?** Gate with `viewCapabilities.js` or documented share checks — not a parallel implementation.
3. **What is intentionally absent?** Only omit from share if it belongs on the allowlist in `docs/share-ui-deltas.md` (or you are explicitly extending that doc).

Prefer shared primitives and capability flags over "app now, share later." **Share-later is a smell** unless the feature is genuinely impossible in share (e.g. requires local library write access).

## Single source of truth

| Concern | Edit here | Never hand-edit |
|---------|-----------|-----------------|
| CSS | `static/css/styles.css` (+ `share-overrides.css` only for documented share deltas) | `share-viewer/css/*` |
| Grid / lightbox / chrome | `static/js/photoSurface/*`, `static/js/viewCapabilities.js` | `share-viewer/js/photoSurface/*` |
| Share boot / resolve wiring | `static/js/shareBoot.js` | `share-viewer/js/shareBoot.js` |
| HTML shell | `static/fragments/*.html` (prefer shared fragments; `*Share.html` only when share must differ) | `share-viewer/index.html` |

`share-viewer/` is **generated output**. Rebuild with `./scripts/build-share-viewer.sh`; deploy with `./scripts/deploy-share-viewer.sh`.

## When forking is allowed

Fork **only** when share intentionally differs. The canonical list lives in `docs/share-ui-deltas.md`. Examples:

- No library mutations (add, delete, edit date, trash)
- Share-only data path (`shareBoot.js` → `share-resolve`)
- Share-only chrome (album title, download in app bar, copy link, local star storage)
- Share-only layout choices documented there (e.g. day grouping, month jumper rules)

If a delta is not in that doc, **default to inheriting from app** — extend shared modules or add capability flags, not a parallel share implementation.

## How to implement changes

1. **App-first, share-aware:** implement in `static/` so both surfaces can use it; decide share applicability at design time.
2. **Capability gate:** use `viewCapabilities.js` for behavior that must differ — not a second code path.
3. **Minimal overrides:** CSS deltas → `share-overrides.css`; HTML deltas → smallest `*Share.html` fragment; avoid new share-only JS unless boot/data wiring requires it.
4. **Rebuild & deploy:** after share-affecting changes, run build + deploy (see `deploy-share-viewer` rule).

## Red flags (stop and unify)

- New app feature wired only through `main.js` with no path for share boot to reuse it
- "We'll add share support later" for UI that has no library-write dependency
- New or edited files under `share-viewer/js/` or `share-viewer/css/` outside the build script
- Copy-paste from `static/js/photoSurface/*` into share-only modules
- Fixing a bug in share without fixing the shared module in `static/`

## Mental model

> Share is the app with a read-only boot, a different backend, and a short allowlist of intentional omissions — not a fork to maintain in parallel. New app work should be shaped so share can inherit it by default.
