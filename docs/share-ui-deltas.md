# Share viewer UI deltas

The share page inherits UI **look and behavior** from the Photos Light app via
shared modules in `static/js/photoSurface/` and `static/js/viewCapabilities.js`.

Only the items below may differ; everything else must come from shared source.

## Intentionally absent

- Add photo, edit date, delete, trash, library menus
- `recent imports` filter chip
- Virtual scroll / in-app month paging
- Lightbox delete, rotate, edit date

## Share-only behavior

- Album title (`.share-page-title`) above the grid
- Photos grouped by **day** with headers like `August 10, 2026`
- Month/year jumper: month is always a dropdown; year is static (no chevron) when the album spans one year
- Month/year jumper hidden when all photos fall in a single month; hidden until month span is known
- Download button in app bar (not utilities menu)
- Utilities menu: **Clear stars** + **Copy link** only
- Stars persisted in viewer `localStorage` (not library DB)
- Data loaded from Supabase edge function `share-resolve` (`shareBoot.js`)
- Download archive names derive from the album title via shared `DownloadExport.buildArchiveFilename()` (forbidden path chars stripped; falls back to link token)

## Download naming (shared with app)

Share and library zip downloads use `static/js/photoSurface/downloadExport.js`:

- Strip `\ / : * ? " < > |` and control characters from archive and entry names
- Preserve Unicode and apostrophes in titles (no slugification)
- Fall back to link token (share) or `Photos` (library) when the label sanitizes to empty
- Zip entry names are basenames only (no `../` path segments)

## Media tiers (published package contract)

Each share is a **fixed snapshot** at publish time. Three URL tiers:

| Tier | Field | Use |
|------|--------|-----|
| Thumb | `thumb_url` | Grid tiles only (~400px JPEG) |
| Display | `display_url` | Lightbox / in-browser preview (full-res JPEG or browser-safe MP4) |
| Original | `original_url` | Download only (HEIC, MOV, etc.) |

Publish creates display assets when the original is not browser-safe (HEIC/TIFF/RAW
→ `display.jpg`; proxy-needed video → `display.mp4`). Browser-native stills and
direct-play videos use `original_url` as display.

The viewer never falls back to thumbs in lightbox. Failures show a toast.

## Deploy (full release unit)

Share changes that touch media or resolve require **all** of:

1. Supabase migration (if schema changed)
2. Deploy `share-resolve` edge function
3. Rebuild Photos Light `.app` (publish path) and republish affected albums
4. `./scripts/build-share-viewer.sh` + `./scripts/deploy-share-viewer.sh`

Do not deploy GitHub Pages alone when the media contract changed.

```bash
./scripts/build-share-viewer.sh
./scripts/deploy-share-viewer.sh
```

Output updates `share-viewer/` for GitHub Pages. Do not edit generated files by hand.
