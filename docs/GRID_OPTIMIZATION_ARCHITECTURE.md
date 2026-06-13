# Grid Optimization Architecture

Canonical design for the Photos Light main timeline grid: virtual scroll, placeholders, date navigation, and responsive layout. Written for the large NAS library benchmark (`/Volumes/eric_files/photo_library`, ~65k photos).

**Status:** P0 foundation shipped. **Phase A first date** still **open** (see dedicated section below). Target architecture below remains canonical; P1+ items still open.

**Asset versions (grid slice):** `gridLayout.js v6`, `virtualGrid.js v10`, `styles.css v31`, `main.js v412`.

---

## Progress (shipped)

| Area | Status | Notes |
|------|--------|-------|
| **GridEngine snapshot** | ✅ | `gridLayout.js`: `toLayoutSnapshot`, `publishCssVars`, `computeColumnLayout`, provisional + refined layouts |
| **GridView DOM** | ✅ | `.grid-root` / `.grid-spacer` / `.grid-canvas` / `.grid-tile-layer` / `.grid-content-layer` |
| **TileLayer (comfort)** | ✅ | Chunk rhythm, top-anchored repeat, `--placeholder-bg`, scroll-driven mount |
| **Placeholder-first mount** | ✅ | Gray cells before `/api/photos/month`; strict-viewport handoff |
| **Comfort ↔ real handoff** | ✅ | `committedMonths` + `grid-section-pending` / `grid-comfort-off`; never both layers visible |
| **Label gate** | ⚠️ | Blocks wrong provisional headers; **Phase A correct date still open** (see below) |
| **TimelineNavigator (scroll ↔ date)** | ✅ | `findMonthAtScrollTop` / `scrollTopForMonth` on snapshot; provisional gate on scroll-sync |
| **Resize remount** | ✅ | `ResizeObserver` → geometry change clears mounts |
| **Grid mutation sync** | ✅ | `syncGridAfterHistogramChange` + server `invalidate_grid_read_caches()` on row mutators |
| **Overlay at Phase A** | ✅ | `onProvisionalReady` dismisses overlay; app bar enabled at Phase A |
| **Phase A first date (anchor month)** | ❌ | App bar + grid label at comfort-grid first frame — **not passing** (v410–v412) |
| **ThumbnailQueue** | ⏳ | Not started — still passive lazy load |
| **NAS speed SLAs** | ⏳ | Architecture first; `< 3 s` usable not re-benchmarked on NAS after P0 |
| **Filtered mode same stack** | ⏳ | Gate exists; full filtered parity not verified |
| **FolderPicker latency** | ⏳ | Separate from grid slice |

### Dev acceptance (Chrome, local library — v410)

| # | Criterion | Result |
|---|-----------|--------|
| 1 | First visible date label is **real** (refined layout) | **FAIL** — see [Phase A first date (anchor month)](#phase-a-first-date-anchor-month) |
| 2 | Fake grid aligns with real grid at scroll 0 | **PASS** |
| 3 | Never black scroll, full range to 1900 | **PASS** |
| 4 | Comfort tile visual design | **Assumed PASS** (handoff too fast locally to eyeball; design locked) |
| 5 | Handoff fake → real: no overlap | **PASS** |

---

## Problem

The main photo grid must feel like a native app on a network-attached library:

- Full timeline scroll range immediately
- No blank screen while data loads
- Date jumper live and accurate during scroll
- Responsive column count (3–6) without layout ghosts or superimposed geometry
- Thumbnails prioritized where the user is looking

Current implementation mixes **multiple layout authorities** (CSS `auto-fill` vs JS `computeColumnLayout`), **multiple renderers** (paged `renderPhotoGrid` vs `VirtualGrid`), and **DOM-dependent date sync**. That produces regressions (fixed column count until scroll, images bleeding into padding, long blank periods after month jumps) that tactical fixes cannot reliably solve.

---

## Reference benchmark

Library: `/Volumes/eric_files/photo_library`

| Check | Target | Known failure (pre-architecture) |
|-------|--------|----------------------------------|
| Open library → file picker | Near-instant | ~48 frame lag (separate: FolderPicker) |
| “Opening library” overlay → usable grid | **< 3 s** | ~5.5 s |
| Overlay close → date jumper enabled | Near-instant | 6+ s |
| Choose year (e.g. 1986) → scroll starts | Near-instant | 6+ s |
| Scroll to 1900 → first thumbnails | Comparable to recent dates | ~12 s |
| Scroll into unloaded area | Urgent thumb priority there | Not scroll-driven |
| Resize / scroll | 3–6 cols, no jank, no bleed | Superimposed / stale mounts |

**Usable grid** means: overlay gone, tile pattern visible, full scrollbar range, month/year pickers enabled — not “all thumbnails loaded.”

---

## Design principles

1. **One engine computes layout** — no parallel CSS column formulas on the timeline path.
2. **One view paints DOM** — single owner of `#photoContainer` in timeline mode.
3. **Comfort layer always on** — tile pattern never leaves a void.
4. **Paint structure before data** — placeholders instantly; API hydrates in place.
5. **Timeline navigation ≠ rendering** — scroll position ↔ month from layout math only.
6. **Remount on column change** — never patch stale nodes when `n` or cell size changes.
7. **Labels are truth-gated** — month headers and date jumper month sync only after refined `month_index`, not provisional spread.

---

## Locked product decisions (comfort + handoff + labels)

These were validated in dev (v409–v410) and should not be regressed without explicit product discussion:

1. **Never black** — comfort tiles fill the viewport on scroll, including scroll to 1900, before and during hydrate.
2. **Dumb repeat rhythm** — fixed chunk (64 px gap + 12 full rows + partial row + 48 px section gap); **no fake month labels** in tile layer.
3. **Top anchor only** — comfort repeat and first real section align at `sections[0].yStart` (scroll 0). No scroll-wide row alignment between variable-height real months and fixed rhythm comfort.
4. **Handoff: one layer at a time** — strict viewport must have real gray placeholders mounted before comfort hides (`grid-comfort-off`). Never show comfort tiles and real gray cells stacked in the same region.
5. **Real grays before thumbs** — commit placeholder cells first; `/api/photos/month` hydrates thumbs in place afterward.
6. **Full scroll range at Phase A** — provisional snapshot sets spacer height so scrollbar is usable while `month_index` loads.
7. **Provisional layout is not date truth** — `buildProvisionalMonthEntries` spreads COUNT across calendar months (newest sort: Dec→Jan per year). Use it for **height + comfort + mount math only**. Never use it for the first month shown to the user. Wrong example: provisional `2026-12` at scroll 0 when true newest is `2026-04`.

**Provisional month spread caveat:** Photo counts and section boundaries are **estimates** until `month_index` returns; scroll position may nudge slightly on refine — acceptable once the **first visible date** is already correct from anchor truth.

---

## Target architecture

```
GridEngine (pure math, no DOM)
    ↓
GridController (load, resize, scroll, jump, generation tokens)
    ↓
GridView (sole timeline DOM writer)
    ├── TileLayer   (always visible)
    └── ContentLayer (mounted month sections)
TimelineNavigator (scroll ↔ date, reads LayoutSnapshot only)
ThumbnailQueue (viewport-first hydrate priority)
```

### GridEngine

**Inputs:** `photoContainer.clientWidth`, `month_index` (or provisional inputs), `sortOrder`.

**Output:** immutable `LayoutSnapshot`:

| Field | Description |
|-------|-------------|
| `columns` | `n` (3–6 on typical widths) |
| `cellSize` | Square cell width in px (`trackWidth`) |
| `gap` | 4 px |
| `sections[]` | `{ month, yStart, height, photoCount }` |
| `totalHeight` | Scroll spacer height |
| `provisional` | `true` until refined `month_index` applied |

**Column formula (canonical):**

```text
n = floor((width + gap) / (200 + gap))
cellSize = (width - (n - 1) * gap) / n
```

Constants from `gridLayout.js`: `GRID_GAP = 4`, `GRID_MIN_COL = 200`, `MONTH_HEADER_HEIGHT = 44`, `MONTH_SECTION_MARGIN = 48`, `HEADER_BAND_HEIGHT = 64` (44 + 20 px margin below label). Comfort header gap and real month section height both use **64 px** band for top alignment.

**Rules:**

- Timeline path must **not** use CSS `repeat(auto-fill, minmax(200px, 1fr))`.
- Publish snapshot to the container as CSS variables once per pass:

  ```text
  --grid-cols
  --grid-cell-px
  --grid-gap-px
  ```

- Cell grid uses fixed px from the engine: `repeat(n, var(--grid-cell-px))`.

### GridView DOM structure

```text
#photoContainer.grid-root
├── .grid-spacer              height = LayoutSnapshot.totalHeight
└── .grid-canvas              position absolute; width 100%; overflow hidden
    ├── .grid-tile-layer      always on (see Tile chunk spec)
    └── .grid-content-layer   virtual-mounted month sections only
```

**Contracts:**

- Only `GridView` writes timeline content into `#photoContainer`.
- `.grid-canvas { position: absolute; top/left/right/bottom: 0; overflow: hidden }` — clips to container; **JS sets `canvas.style.height = totalHeight`** (see post-mortem: invisible grid).
- Month sections: `left: 0; right: 0; width: 100%`.
- Virtual mode gate: library open + no starred/video filters (`state.libraryPath`).

### TileLayer (comfort grid)

Repeating chunk, scrolls with content, built from the **same** `n`, `cellSize`, and `gap` as the snapshot.

**Locked design decisions:**

1. **Header gap only** — reserve **64 px** (44 + 20) with **no** label, bar, or text.
2. **Tile color** — existing `--placeholder-bg` (`#2a2a2a`), same as current photo cards.

**Chunk rhythm:**

```text
[ 64 px empty gap ]
[ 12 rows × n cells ]
[ 1 row × max(1, n − 2) cells, left-aligned ]
[ 48 px gap ]          ← MONTH_SECTION_MARGIN
→ repeat vertically
```

Purpose: visual reference while scrolling; organic partial last row; rhythm similar to real months without fake labels. Real month headers and thumbnails paint **on top**; tiles remain visible in gaps.

### ContentLayer mount policy

On scroll (rAF), resize, or date jump (`syncComfortAndContent`):

1. **Buffer mount** — `findSectionsInViewport` (scrollY ± 1200 px): mount placeholder sections.
2. **Strict viewport** — `findSectionsInStrictViewport` (no buffer): handoff gate.
3. When every strict section is mounted:
   - Remove `grid-section-pending` (reveal real grays).
   - Hide TileLayer (`grid-comfort-off`).
   - Hydrate committed sections via `/api/photos/month`.
4. Otherwise: keep sections pending (hidden) and TileLayer visible.
5. Unmount sections leaving the buffer; drop from `committedMonths`.
6. If `columns` or `cellSize` changed: **clear all mounted sections** and remount visible.

**Never** wait for month API before first paint (fixes blank screen on jump to 1900 / 1986).

**Label gate:** while `layout.provisional`, `.month-header` is hidden via `.grid-labels-gated` even after handoff commit — user sees gray cells under comfort, not wrong month text.

### TimelineNavigator

Decoupled from draw and thumbnails:

| Direction | API |
|-----------|-----|
| Scroll → date | `monthAtScrollTop(snapshot, scrollY, appBarOffset)` |
| Date → scroll | `scrollTopForMonth(snapshot, monthKey, appBarOffset)` |

- Updates month/year pickers on scroll (rAF), not `IntersectionObserver`.
- Date picker **visible + scroll-synced** only after Phase B (`onReady` → `populateDatePicker` + sync). Phase A enables app bar but **does not** sync month from provisional layout.
- `syncDatePickerFromScroll` no-ops when `layout.provisional`.
- Years from `/api/years` at Phase B (with refined layout).
- Default year: newest → last year in list; oldest → first year.

Refined `month_index` may nudge scroll position slightly (~5–7 s on NAS) — acceptable; label gate prevents showing wrong month during Phase A.

### ThumbnailQueue

Replace passive-only `IntersectionObserver` for timeline mode:

1. **Viewport center / visible range** — highest priority.
2. **Expand outward** along scroll direction.
3. **Deprioritize or cancel** requests for sections far off-screen.

Same NAS latency whether scrolling to 1900 or 2025; difference should be queue policy, not accident.

### Resize contract

```text
ResizeObserver(photoContainer)
  → snapshot = GridEngine.compute(width, monthIndex, sort)
  if columns or cellSize changed:
      GridView.setSnapshot(snapshot)    // CSS vars + spacer
      GridView.remountVisible()
      TileLayer.rebuild(snapshot)
  else:
      GridView.setSnapshot(snapshot)    // height-only refine OK
```

Prevents column count stuck at 6 until scroll, ghosts in padding, and mixed geometries.

---

## Load sequence (NAS)

```text
Phase A (~1 s)
  Parallel: GET /api/photos?limit=1 (COUNT) + GET /api/years
  → provisional LayoutSnapshot (provisional: true)
  → TileLayer + spacer + full scroll range
  → buffer mount (strict sections stay pending / hidden)
  → dismiss “Opening library” overlay; enable app bar
  → NO month labels; NO date picker populate/sync (label gate)

Phase B (~5–7 s on NAS)
  GET /api/photos/month_index
  → refined LayoutSnapshot (provisional cleared)
  → clearLabelGate; remount visible
  → populateDatePicker + scroll sync
  → small scroll/date correction OK

Phase C (continuous)
  Per-month hydrate for committed sections
  → thumbnails replace placeholder cells
  (ThumbnailQueue not yet — still passive lazy load)
```

**Server note:** `month_index` full-table scan is the Phase B bottleneck. Long-term: cached histogram / incremental index (out of scope for first GridView ship).

---

## Modes

| Mode | When | Implementation |
|------|------|----------------|
| **Timeline** | Default; library open; no filters | GridEngine + GridView + TileLayer |
| **Filtered** | Starred or video toggles | Same stack; filter predicate on hydrate; avoid separate `renderPhotoGrid` fork |

Paged 400-photo window is **legacy** — do not use for unfiltered timeline (gate bug fixed v406: virtual when `libraryPath` set).

---

## Retire / stop extending

- CSS `auto-fill` on timeline `.photo-grid`
- Per-month inline `gridTemplateColumns` without remount on resize
- `IntersectionObserver` for date picker scroll sync (timeline uses layout math)
- Second renderer (`renderPhotoGrid`) for main timeline
- Overlay blocked on `month_index` completion
- Per-flow incremental DOM patch without server cache invalidation (`applyMutationPatch` retired from production paths)
- Showing month headers or date jumper month from **provisional** layout — **retired** (label gate)

---

## Implementation priority

| Priority | Work | Status |
|----------|------|--------|
| **P0** | GridEngine + GridView + CSS vars + resize remount + clip | ✅ Shipped |
| **P0** | TileLayer + comfort handoff (no overlap, never black) | ✅ Shipped |
| **P0** | Placeholder-first mount + hydrate | ✅ Shipped |
| **P0** | Label gate (headers + date sync after refine) | ✅ Shipped |
| **P1** | Overlay off at Phase A | ✅ Shipped |
| **P1** | TimelineNavigator on snapshot only | ✅ Shipped |
| **P1** | Grid mutation sync (incremental snapshot patch) | ✅ Shipped |
| **P1** | Date jumper shows **correct** month at Phase A first frame | ❌ Open — [Phase A first date](#phase-a-first-date-anchor-month) |
| **P1** | NAS `< 3 s` usable re-benchmark | ⏳ Open |
| **P2** | ThumbnailQueue viewport-first | ⏳ Open |
| **P2** | Filtered mode full stack parity | ⏳ Open |
| **P2** | FolderPicker open latency | ⏳ Open |
| **P3** | Lightbox large NAS video | ⏳ Separate |

---

## Current code map

| Module | Role today | Target name (optional rename) |
|--------|------------|-------------------------------|
| `static/js/gridLayout.js` | Layout math, patches, CSS var publish | **GridEngine** |
| `static/js/virtualGrid.js` | DOM, TileLayer, handoff, init, mutations | **GridView** + **GridController** |
| `static/js/main.js` | Load orchestration, date picker, edit/delete hooks | Thin controller surface |
| `static/css/styles.css` | `.grid-*` timeline path | CSS vars only on timeline |

Key symbols:

- `VirtualGrid.init` / `setSnapshot` / `syncComfortAndContent` / `applyMutationPatch`
- `GridLayout.buildProvisionalLayout` / `buildVirtualLayout` / `findMonthAtScrollTop`
- `loadAndRenderPhotosVirtual` hooks: `onProvisionalReady`, `onLayoutApplied`, `onReady`

Version milestones:

- **v406:** virtual grid gate (`libraryPath`, not `hasDatabase` on first open)
- **v407:** provisional layout + parallel years
- **v408:** layout-based date picker sync
- **v409:** GridView DOM, comfort handoff, mutation sync, canvas height fix
- **v410:** label gate (`grid-labels-gated`, date sync deferred to Phase B) — superseded for first-date requirement; see [Phase A first date](#phase-a-first-date-anchor-month)
- **v411:** `anchorMonth` from `limit=1` → `populateDatePicker` in `onProvisionalReady` (failed — wrong moment)
- **v412:** `onPhaseAAnchor` + sync `applyDatePickerFromYears` + `.grid-anchor-month-header` (failed — still not passing acceptance)

---

## Phase A first date (anchor month)

**Status:** ❌ **Not solved.** Do not mark this acceptance row PASS until verified on the **comfort-grid first frame**, not post–Phase B steady state.

### Goal

When the user first sees the fake/comfort grid (overlay dismissed, gray tile pattern visible, scroll at 0):

1. **App bar** month/year pickers show the **real** top-of-timeline month (e.g. **April 2026** on `sort=newest`), not blank, not a provisional guess (December).
2. **Grid** shows the same real month label at the top of the viewport (not an empty 64 px band, not a hidden header).
3. Achieve this **near-instantly at Phase A** — same window as `GET /api/photos?limit=1` + `GET /api/years` — **without** waiting for `GET /api/photos/month_index` (Phase B).

**Truth source (canonical):** the newest (or oldest) photo row returned by `GET /api/photos?limit=1&sort=…` — field `photos[0].month`. Provisional layout math must **never** be the first date shown.

**Acceptance moment (mandatory QA):** the **first paint** after overlay hide where only comfort tiles (and/or pending grays) are visible — **before** `month_index` returns and **before** thumbnails hydrate. A screenshot taken after Phase B with real thumbs and section headers **does not count**.

### Original bug (pre-fix)

Provisional layout places the first section at scroll 0 in calendar order (`2026-12` for newest sort). Date picker scroll-sync and mounted section headers read that layout → **~2 frames of “December 2026”** before `month_index` refined to **April 2026**.

### Failed attempts

| # | Version | What we tried | Why it failed | Lesson |
|---|---------|---------------|---------------|--------|
| **0** | (pre-v410) | Use provisional layout for scroll-sync and section headers at open | First section at scroll 0 is a **calendar spread guess**, not photo truth → December flash | Provisional snapshot is for **geometry**, not **labels** |
| **1** | **v410** | **Full label gate:** hide all `.month-header` via `grid-labels-gated`; defer `populateDatePicker` and scroll-sync until Phase B (`month_index`) | Stopped wrong month flash but left app bar **blank for seconds** and grid header **empty** during comfort phase — swapped one failure for another | **“Don’t show wrong date” ≠ “show no date.”** Gate the *source* of wrong labels, not all labels |
| **2** | **v411** | Read `photos[0].month` from existing Phase A `limit=1` fetch; call `populateDatePicker({ anchorMonth, years })` in `onProvisionalReady` | Ran **after** `setSnapshot` (comfort grid already painted) and **after** `hideLibraryTransitionOverlay` in the same callback but picker still `visibility:hidden` until async path completed; **grid headers still fully gated**; success claimed from **Phase B screenshot** (thumbs + real section) not comfort first frame | Implement the **acceptance moment**, not the steady state; verify **first frame**; app bar and grid are **two surfaces** — both must be addressed |
| **3** | **v412** | `onPhaseAAnchor` hook **before** `setSnapshot`; sync `applyDatePickerFromYears()`; `.grid-anchor-month-header` at scroll 0 exempt from label gate; prefetch `GET /api/photos/month` for anchor month | **Still failing** user acceptance at comfort first frame (exact failure mode TBD in QA — do not infer PASS) | Reordering alone insufficient if overlay/grid/picker paint order or anchor header stacking still wrong; need **instrumented first-frame test** and likely **mount anchor month section** at scroll 0, not only a floating header band |

### Lessons learned (do not repeat)

1. **Name the acceptance moment.** “First date is real” means **first comfort-grid frame**, not “eventually after `month_index`.”
2. **One cheap truth fetch already exists.** Phase A parallel `limit=1` carries the correct month — use it for **display**, not only for COUNT.
3. **Never conflate diagnosis with done.** Stating the correct fix in chat while shipping a partial hook (`onProvisionalReady` populate) or verifying the wrong screenshot is how this regressed twice.
4. **Two UI surfaces:** app bar pickers (`.date-picker` starts `visibility:hidden`) and in-grid month label (comfort tiles intentionally have **no** text; content-layer headers were gated). Both must show April at open.
5. **Block wrong labels, not all labels.** Hide provisional **section** headers (December guess); show anchor **truth** header (April from `limit=1`).
6. **Sync before reveal.** Set picker + anchor label **before** overlay dismiss and before treating the grid as “usable.”
7. **Prod parity:** after JS/CSS changes, rebuild packaged app before sign-off (`./packaging/build.sh`).

### Target fix (canonical — not yet implemented)

```text
Phase A (after limit=1 + years return, BEFORE overlay dismiss):
  anchorMonth = photos[0].month
  applyDatePickerFromYears(years, anchorMonth)   // sync, visibility visible
  mount anchor month truth at scroll 0            // header + optional month fetch
  setSnapshot(provisional)                        // comfort + height only
  dismiss overlay
Phase B:
  month_index refines geometry; scroll-sync from snapshot; replace anchor stub with real sections
```

Scroll-sync from provisional layout remains gated until Phase B. **Initial** displayed month always from `limit=1`, never from `buildProvisionalMonthEntries`.

---

## Acceptance (NAS library)

Open library **passes** when:

1. ≤ **3 s** from overlay shown to: tiles visible, full scroll range, app bar usable (date picker may appear at Phase B with **correct** month — not provisional guess).
2. **First month label shown** matches refined `month_index` (no provisional month flash).
3. Changing year/month scrolls **immediately** (tiles may still be gray).
4. Scrolling updates month/year **in real time** (layout-driven, post Phase B).
5. Scrolling to 1900 shows tiles continuously (comfort until real grays commit); thumb **priority** parity pending ThumbnailQueue.
6. Resize changes column count **predictably** (3–6), no images in padding, no jank.
7. Comfort → real handoff: **no overlap** in strict viewport.

**Grid mutations** (date edit, delete, duplicate collapse) **pass** when:

8. Affected tile(s) update or disappear within **~300 ms** — no full `month_index` round trip, no viewport wipe.
9. Cross-month date edit adjusts both month sections and scroll range immediately (thumbs may still hydrate async).
10. Bulk date edit applies each patch incrementally without blanking the grid.

---

## Known issues & open work

| Issue | Severity | Notes |
|-------|----------|-------|
| **Phase A first date** | **High (UX)** | v410–v412 failed; comfort first frame still blank/wrong — [section](#phase-a-first-date-anchor-month) |
| **`month_index` latency on NAS** | High (perf) | Phase B bottleneck (~5–7 s); not fixed in this slice |
| **ThumbnailQueue absent** | Medium | Scroll to 1900 vs 2025 still unequal thumb urgency |
| **NAS `< 3 s` SLA** | Medium | Not re-measured after P0; architecture prioritized over SLA proof |
| **Filtered timeline parity** | Medium | Starred/video may still diverge from GridView path |
| **FolderPicker ~48 frames** | Low (grid) | Separate from grid architecture |
| **Undo date edit full reload** | Low | May still call `loadAndRenderPhotos` |
| **Provisional scroll nudge on refine** | Low | Expected; mitigated by label gate |
| **Comfort visD hard to eyeball locally** | None (QA) | Handoff completes in same rAF when network is fast; design assumed correct per dev review |

---

## Post-mortem wisdom

Lessons from building and debugging the P0 slice — worth reading before the next change:

1. **Invisible grid after open** — `.grid-canvas` had `overflow: hidden` on a zero-height box (absolute positioning without height). All content clipped. **Fix:** `bottom: 0` in CSS **and** `canvas.style.height = totalHeight` in JS. Any change to canvas sizing should be tested with an empty or pending content layer.

2. **December → April label flash** — Provisional layout assigns photos to calendar months in year order (`sort=newest` → first bucket `YYYY-12`). **v410 response (label gate) overcorrected** — see [Phase A first date (anchor month)](#phase-a-first-date-anchor-month). Do not defer all dates to Phase B; show anchor truth from `limit=1` at Phase A first frame.

3. **Two layout authorities cause ghost geometry** — Timeline path must not mix CSS `auto-fill` with JS `computeColumnLayout`. One snapshot, CSS vars, remount on column change.

4. **Handoff is a state machine, not a CSS tweak** — `committedMonths`, strict vs buffer viewport, and `grid-comfort-off` must stay in sync. Patching visibility without the commit gate caused overlap or black frames.

5. **Architecture before SLAs** — Correct comfort/handoff/label behavior was locked before NAS timing work. ThumbnailQueue and cached `month_index` are the next levers for benchmark rows, not more DOM patches.

6. **Prod vs dev** — Static assets bundle via PyInstaller; after grid changes run `./packaging/build.sh` before judging packaged `.app` behavior.

---

## Grid mutation sync (product requirement)

When the user mutates library media, the timeline grid reflects the change **near instantly** without a full catalog reset. Two tiers share one contract:

### Row mutation (histogram change, same catalog)

**In scope:** date edit (single + bulk), delete, restore/undo delete, import (complete or partial cancel), convert/terraform ingest into an existing histogram.

**Server:** Every histogram-changing mutator calls `invalidate_grid_read_caches()` on success (drops `MONTH_INDEX_CACHE` + photo total count). Does **not** bump `LIBRARY_CATALOG_REVISION` — same catalog identity.

**Client:** `syncGridAfterHistogramChange(scrollTargetMonth?)` — virtual grid + no filters → `VirtualGrid.refreshMonthIndex()`; otherwise → `loadAndRenderPhotos(false, { forcePaged })`. Wired from date edit finalize, delete, undo date/delete, import complete/cancel follow-up.

**Anti-pattern (retire):** Per-flow `applyMutationPatch` / ad-hoc `loadAndRenderPhotos(false)` without server cache invalidation first.

### Catalog reset (full rehydrate)

**In scope:** Clean `photos_table_rebuilt`, recovery DB rebuild, library switch + make-perfect, any operation that replaces the photos catalog identity (row ids, month histogram).

**Client:** `rehydrateLibraryCatalog()` — bumps `libraryGeneration`, destroys virtual grid, clears thumbnail queue, runs `loadAndRenderPhotosCommitted` (Phase A→B bootstrap).

**Server:** `LIBRARY_CATALOG_REVISION` bumped via `bump_library_catalog_revision()` on library switch and structural completion (make-perfect SUCCESS, rebuild DB complete). `bump_library_catalog_revision()` also calls `invalidate_grid_read_caches()`. Grid read caches are keyed to revision; exposed as `catalog_revision` on grid APIs.

**Anti-pattern:** Calling `refreshMonthIndex` after catalog reset, or bumping revision on row-level delete/import/date edit.

---

## Out of scope (this document)

- Lightbox streaming / NAS video read latency
- Electron DevTools menu
- Local SSD metadata cache (explicitly deferred)

---

## References

- Layout constants: `static/js/gridLayout.js`
- Grid view + controller: `static/js/virtualGrid.js`
- Date picker wiring: `static/js/main.js` (`wireDatePicker`, `populateDatePicker`)
- Backend: `GET /api/photos`, `GET /api/photos/month_index`, `GET /api/photos/month`, `GET /api/years`
- Prod rebuild: `./packaging/build.sh` → `dist/mac-arm64/Photos Light.app`
