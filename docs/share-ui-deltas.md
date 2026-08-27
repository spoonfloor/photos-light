# Share viewer UI deltas

The share page inherits UI **look and behavior** from the Photos Light app via
shared modules in `static/js/photoSurface/` and `static/js/viewCapabilities.js`.
`static/fragments/appBar.html` and `static/fragments/utilitiesMenu.html` are
literally the same file for both surfaces (read directly by
`build-share-viewer.sh`) — per-surface items are `data-cap` gated, not a
second copy of the fragment, the same pattern `lightbox.html` already used.

Only the items below may differ; everything else must come from shared source.

## Intentionally absent

- Add photo, edit date, delete, trash, library menus
- `recent imports` filter chip
- Virtual scroll / in-app month paging
- Lightbox delete, rotate, edit date
- Lightbox info panel filename row — share shows the Date row only
  (`infoFilename` capability off in `viewCapabilities.js`)

## Share-only behavior

- Album title (`.share-page-title`) above the grid
- Photos grouped by **day** with headers like `August 10, 2026`
- Month/year jumper: month is always a dropdown; year is static (no chevron) when the album spans one year
- Month/year jumper hidden when all photos fall in a single month; hidden until month span is known
- Download button in app bar (not utilities menu) at every width — the
  ≤480px rule that moves the app's own download button into the more menu
  (`styles.css`) is scoped to `body:not(.share-view)` at its source
- Download button is **always enabled** (the app disables it without a
  selection). No selection → downloads the whole filtered album; with a
  selection → downloads the selection. `shareBoot.js` clears the `inactive`
  class the shared `appBar.html` ships with
- ≤480 select mode also exits on a tap in the header chrome dead space —
  the album-title row, the gap above it, and the filter-chip rail gutter —
  matching the "tap outside the grid" exit `gridInteractions.js` gives
  `#photoContainer`. `shareBoot.js` wires it and calls the shared
  `GridInteractions.exitSelectMode`
- Utilities menu: **Select** (≤480px only, shared with app — see below) +
  **Clear stars** + **Copy link** only
- Stars persisted in viewer `localStorage` (not library DB)
- Data loaded from Supabase edge function `share-resolve` (`shareBoot.js`)
- Download archive names: album title, else `shared-photos-{publish-date}`, else `shared-photos` (via `DownloadExport.buildShareArchiveFilename()`; never the URL token)

## Download naming (shared with app)

Share and library zip downloads use `static/js/photoSurface/downloadExport.js`:

- Strip `\ / : * ? " < > |` and control characters from archive and entry names
- Preserve Unicode and apostrophes in titles (no slugification)
- Share fallbacks: publish date label, then `shared-photos`; library falls back to `Photos`
- Zip entry names are basenames only (no `../` path segments)

## Media tiers (published package contract)

Each share is a **fixed snapshot** at publish time. Recipients only receive
**browser-viewable** assets; filenames match the delivered bytes.

| Tier | Field | Use |
|------|--------|-----|
| Thumb | `thumb_url` | Grid tiles only (~400px JPEG) |
| Original | `original_url` | Lightbox, in-browser preview, and download |

**Delivery rules (at publish):**

- Browser-native stills (JPG, PNG, GIF, WebP) → uploaded as-is
- HEIC, RAW, TIFF, and other non-native stills → one high-quality JPEG; catalog
  name ends in `.jpg`
- Browser-playable video → uploaded as-is (MP4, WebM, etc.)
- Other video → transcoded to MP4; catalog name ends in `.mp4`

`original_filename` in the share catalog is the **delivery filename**, not the
library source name. `display_path` is unused for new publishes (legacy albums
may still have a separate display asset).

Policy source of truth: `share_delivery.py` (`plan_share_delivery`).
Viewer native-still allowlist must stay aligned with `SHARE_BROWSER_NATIVE_STILL_EXTENSIONS`.

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
