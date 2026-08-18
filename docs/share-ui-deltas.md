# Share viewer UI deltas

The share page inherits UI **look and behavior** from the Photos Light app via
shared modules in `static/js/photoSurface/` and `static/js/viewCapabilities.js`.

Only the items below may differ; everything else must come from shared source.

## Intentionally absent

- Date jumper (month/year picker)
- Add photo, edit date, delete, trash, library menus
- `recent imports` filter chip
- Virtual scroll / in-app month paging

## Share-only behavior

- Album title (`.share-page-title`) above the grid
- Download button in app bar (not utilities menu)
- Stars persisted in viewer `localStorage` (not library DB)
- Data loaded from Supabase (`shareBoot.js`)

## Build

```bash
./scripts/build-share-viewer.sh
```

Output updates `share-viewer/` for GitHub Pages deploy. Do not edit generated files by hand.
