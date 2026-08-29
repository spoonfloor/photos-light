# Lightbox narrow gestures — pinch-zoom + edge overscroll — work plan

Add pinch-to-zoom, double-tap zoom, pan-while-zoomed, and **edge overscroll**
(rubber-band when you try to swipe past the first or last photo) to the ≤480
lightbox. This doc is the single source of coordination so parallel agents
don't collide. Read it fully before claiming a phase.

/ Created 2026-08-28. Owner: designer (scroll550).
/ Amended 2026-08-29: edge overscroll folded in (was a separate proposal);
  module renamed `lightboxZoom.js` → `lightboxGestures.js`; phases
  resequenced — overscroll now lands first, as the walking skeleton that
  de-risks the shared recognizer / layer / shell seam for pinch and pan.
  (Filename kept as-is so in-flight references don't break.)

Decisions under **Locked decisions** are locked — do not relitigate scope; if
something looks wrong, flag it in chat, don't freelance.

Related: `docs/lightbox-480-plan.md` (breakpoint behavior, gesture recognizer),
`docs/lightbox-share-batch-plan.md` (item #3 — the `touch-action: none`
containment fix this plan must not regress), `.claude/rules/app-share-inheritance.md`.

---

## How to use this doc

1. **Claim** a phase by putting your session id + date in the Status table.
   Phases are sequential (A→G); claim the lowest unclaimed one whose deps are met.
2. Work only inside your claimed phase. Coordinate in chat before touching a
   file another claim owns (see Conflict zones).
3. When done: fill the DoD checkbox(es), note the commit, mark "needs share
   rebuild" if share-affecting (do **not** rebuild yet).
4. **One** agent runs the share-viewer rebuild + deploy at close-out (phase G).

## Status

| Phase | Item | Depends on | Claimed by | State |
|-------|------|-----------|-----------|-------|
| A | `lightboxGestures.js` skeleton + `.lightbox-gesture-layer` + `reset()` wiring + shared rubber-band helper + `LightboxShell.canNavigate()` + shell no-op seam | — | — | not started |
| B | One-finger drag: **edge overscroll** (verify after A) + **pan while zoomed** (verify after C) | A | — | not started |
| C | Pinch scale about midpoint, clamp + rubber-band, snap-back | A | — | not started |
| D | Double-tap toggle + 300ms single-tap disambiguation | C | — | not started |
| E | reduced-motion, coarse-pointer feature-detect, tokenize knobs | B, C, D | — | not started |
| F | Device tuning pass with owner | E | — | not started |
| G | Share rebuild + deploy + smoke test | F | — | not started |

Phase B may be claimed as soon as A lands. Its **overscroll** half completes
and verifies on its own. Its **pan** half is written in the same handler but
can't be exercised until a zoom exists (Phase C) — so B's pan DoD checkbox
waits for C, and the B owner coordinates with whoever takes C.

---

## Why now / the constraint

- **`touch-action: none`** on `.lightbox-overlay` at ≤480 (`static/css/styles.css`,
  ≤480 media block) is a load-bearing iOS containment fix (batch item #3,
  commit `6e6c38e`). It governs native pinch-zoom **and** native
  overscroll/pan. **Do not change it.** Every gesture here — zoom, pan,
  overscroll — is hand-rolled in JS; we never ask the browser for a native
  gesture.
- The existing gesture recognizer (`lightboxShell.js` — "Gesture recognizer")
  is a **locked "hard cut, no live drag tracking"** decision: it reads
  start/end points on release only. Pinch, pan, and overscroll all require
  live `touchmove` tracking, so they live in a **separate recognizer**, not an
  extension of `classifyGesture`. Edge overscroll is the **one scoped
  exception** to the hard-cut rule (see Locked decisions) — mid-strip swipe
  stays hard-cut.
- `applyMediaStyles` (`lightboxMedia.js`) **owns `mediaEl.style.transform`**
  (translate + rotate) and re-runs on every nav / rotate / resize. The
  `.lightbox-media-frame` owns `transform` for entry/exit animation
  (`animateFrameEntry` / exit). Any gesture transform on either element is
  clobbered or collides → gestures get **their own transform layer**.
- App→share inheritance: build in `static/js/photoSurface/*`, never hand-edit
  `share-viewer/`. Zoom, pan, and overscroll are all read-only and
  width-gated → **share inherits them for free**, no capability flag expected.

---

## Ground rules

- **App → share inheritance** (`.claude/rules/app-share-inheritance.md`): fix
  shared modules under `static/`, no forked share copies, no `share-viewer/`
  edits. Differences (none expected here) go through `viewCapabilities.js`.
- **Quality bar** (`~/.claude/CLAUDE.md`): build it the way a talented dev
  would with full hindsight. No smallest-patch shortcuts. Match surrounding
  style (IIFE modules, `wire(ctx)` adapter shape, token-per-knob).
- **Definition of Done**: observable behavior, verified on a real device.
  State the device/OS you verified on.
- **"narrow" = ≤480px** everywhere, matching the rest of the lightbox batch.
  No gestures on wide/desktop this round (see Locked decisions).

---

## Definition of Done

iPhone Safari **and** Android Chrome, ≤480, inside the lightbox:

1. Two-finger pinch scales the photo about the **finger midpoint**, from 1×
   (fit) to **1:1 image pixels** (1 image px = 1 CSS px), rubber-banding past
   both ends and snapping back on release.
2. Double-tap toggles zoom: from 1× → **2.5× fit** centered on the tap point
   (clamped to the 1:1 ceiling); from any zoomed state → 1×.
3. One-finger pan works **only while zoomed**, clamped to the image edges with
   the same rubber-band function.
4. **Edge overscroll:** at the first photo a drag toward "previous" (and at the
   last photo a drag toward "next") pulls the photo a short distance against
   the rubber-band function, exposing black past the pulled edge, then snaps
   back on release. It never pages and never persists. A drag toward a valid
   neighbour still hard-cuts to that photo exactly as before.
5. At 1×, away from a boundary: swipe-nav, swipe-to-close, and
   single-tap-toggles-chrome behave exactly as before this change. **No
   drag-follow** between photo 1 and photo 50. #3 containment holds — the grid
   never scrolls behind the overlay, before / during / after any rubber-band.
6. Navigating to another photo, rotating, or backgrounding the app resets zoom
   **and** overscroll to identity.
7. `prefers-reduced-motion: reduce` → all gesture transitions are instant;
   gestures still work.
8. Wide / desktop: unchanged. The module is inert when the pointer is not
   coarse.

---

## Design spec

| Knob | Value | Source | Notes |
|------|-------|--------|-------|
| Fit scale | computed (contain) | — | baseline; photo fits viewport |
| Double-tap target | **2.5× fit**, clamped ≤ 1:1 | PhotoSwipe 5 `secondaryZoomLevel` | centered on tap point |
| Max pinch (ceiling) | **1:1 image px** (1 img px = 1 CSS px) | OpenSeadragon `maxZoomPixelRatio` (1.1 slack) | computed cap, not a token |
| Min pinch (floor) | 1× (fit) | — | cannot zoom out past fit |
| Rubber-band function | `f(x,d,c) = x·d·c / (d + c·x)`, **c = 0.55** | reverse-engineered iOS UIScrollView | **shared** by the pinch clamp and edge overscroll; `d` = viewport dim, `x` = overshoot |
| Overscroll max travel | `--lightbox-overscroll-max-px` (start: **68** ≈ 0.18 × a 375pt viewport) | — | hard cap so a fast flick can't drag the photo fully off-screen; `f` alone is asymptotic but slow to bite |
| Overscroll capture threshold | first **10px** of `touchmove`, horizontal-dominant | repo `TAP_MAX_MOVEMENT` = 10 | reuse the constant; see capture rule under the state machine |
| Zoom / snap-back tween | `--lightbox-gesture-tween-ms` = **200ms** | Android PhotoView `DEFAULT_ZOOM_DURATION` | **shared** by pinch snap-back and overscroll snap-back; hand-tune in phase F |
| Double-tap detection window | `--lightbox-zoom-dbltap-window-ms` = **300ms** | OpenSeadragon `dblClickTimeThreshold` | also the legacy WebKit click delay |
| Tween easing | `cubic-bezier(0.4, 0.4, 0, 1)` | repo (`lightbox-480-plan.md`, frame entry) | match existing lightbox motion |

**Sources** (for the record, so phase F isn't re-researched):
- PhotoSwipe — https://photoswipe.com/adjusting-zoom-level/
- OpenSeadragon options — https://openseadragon.github.io/docs/OpenSeadragon.html
- Android PhotoView — https://github.com/Baseflow/PhotoView
- Apple "Zooming by Tapping" — https://developer.apple.com/library/archive/documentation/WindowsViews/Conceptual/UIScrollView_pg/ZoomingByTouch/ZoomingByTouch.html
- iOS UIScrollView mechanics (rubber-band c = 0.55) — https://medium.com/@esskeetit/scrolling-mechanics-of-uiscrollview-142adee1142c

The feel constants (200ms, c = 0.55, 300ms, 0.18 travel cap) are the least
authoritative part — iOS publishes almost none of it. They are starting
points; phase F tunes them on-device with the owner.

### Tuning knobs (phase E)

All knobs land in one place, the way batch #9 tokenized the info panel. CSS
custom properties on the ≤480 `:root` block, read once by
`lightboxGestures.js` on wire:

```
--lightbox-gesture-rubber-c: 0.55;      /* pinch clamp + edge overscroll resistance */
--lightbox-gesture-tween-ms: 200;       /* pinch snap-back + overscroll snap-back */
--lightbox-overscroll-max-px: 68;       /* hard cap on rubber-band travel */
--lightbox-zoom-dbltap-scale: 2.5;      /* multiple of fit */
--lightbox-zoom-dbltap-window-ms: 300;
```

The 1:1 ceiling is **computed** (natural px vs. rendered px), not a token.
No magic numbers inline — if you write `0.55`, `2.5`, or `10` twice, it's
wrong (the 10px capture threshold reads from the shared `TAP_MAX_MOVEMENT`).

---

## Architecture

### New module: `static/js/photoSurface/lightboxGestures.js`

Same shape as `lightboxShell.js` — IIFE, `wire(ctx)` adapter, element cache.
~260 LOC target. Owns one live-`touchmove` recognizer that dispatches to
pinch, pan, and overscroll. Exposes:

- `wire(ctx)` — bind touch listeners on `.lightbox-content`
- `reset()` — return zoom + overscroll to identity, clear transform,
  idempotent, cheap
- `isZoomed()` — settled scale > 1×
- `isGestureActive()` — mid-pinch, mid-pan, **or** mid-overscroll

### Dedicated transform layer

`lightboxGestures` inserts one wrapper element — `.lightbox-gesture-layer` —
around the media inside `.lightbox-media-frame` (frame → gesture-layer →
media). Every gesture writes **only** to this one element, and nothing else
does:

- pinch / pan: `transform: translate(...) scale(...)`, `transform-origin: 0 0`
- overscroll: `transform: translateX(...)`

Identity at rest. `applyMediaStyles` and the frame entry/exit animations keep
their transforms untouched.

- `lightboxMedia` calls `LightboxGestures.reset()` at the tail of
  `applyMediaStyles` and on every nav / rotate.
- The layer sits **inside** the frame's `overflow: hidden`. For overscroll
  that is the point: translating the layer slides the photo off one edge and
  exposes the black frame behind it — the iOS "end of the strip" look, with no
  extra styling. For pan, the clamps keep the image covering the frame; edges
  rubber-band.

### Shell integration (minimal)

`lightboxShell` gains one small accessor and one guard:

- **`LightboxShell.canNavigate(direction)`** — returns whether the lightbox can
  page that way (`direction` −1 / +1). Reads the same state that already drives
  the chevron `.inactive` class (`setNavArrows` / `updateLightboxArrowStates`):
  `!els.prevBtn.classList.contains('inactive')` and the `nextBtn` equivalent.
  The gestures module calls this to decide whether a 1-finger horizontal drag
  is a boundary overscroll or a normal swipe it should leave alone.
- The recognizer consults
  `LightboxGestures.isZoomed() || LightboxGestures.isGestureActive()` and
  no-ops its swipe / swipe-down / tap classification when true.
  `onOverlayTouchStart` already bails on `e.touches.length !== 1`, so a
  2-finger start never arms a swipe. The new seams: a **1-finger start while
  zoomed** routes to pan; a **1-finger horizontal start at a blocked boundary**
  routes to overscroll — both inside `lightboxGestures`, never
  `classifyGesture`.

**No changes** to `classifyGesture`, `SWIPE_MIN_DISTANCE`, `TAP_MAX_MOVEMENT`,
or the mouse path.

### Gesture state machine (`lightboxGestures.js`)

Listeners on `.lightbox-content`, capture phase, `passive: false` (so we can
`preventDefault()` mid-gesture; at 1× with no gesture armed we never
`preventDefault`, leaving the shell's swipe/tap intact).

```
IDLE ──2 fingers──────────────────▶ PINCHING ──release──▶ scale>1 ? ZOOMED : settle→IDLE
IDLE ──1 finger, isZoomed──────────▶ PANNING  ──release──▶ ZOOMED
IDLE ──1 finger horizontal,
       canNavigate(dir) === false──▶ OVERSCROLLING ──release──▶ snap back→IDLE
ZOOMED ──double-tap───────────────▶ animate→IDLE
IDLE   ──double-tap───────────────▶ animate→ZOOMED (2.5×fit @ tap point)
any ──nav / rotate / background───▶ reset()→IDLE
```

**Overscroll capture rule.** The first ~10px of `touchmove` decides. If
`|dx| > |dy|` and `dx` points toward a side where `canNavigate(dir)` is
`false`, capture: enter `OVERSCROLLING`, `preventDefault`, set
`isGestureActive()`, and the shell's swipe-down-exit / swipe-nav classifier
no-ops for the rest of this touch. **Bias toward horizontal** — a lazy
diagonal drag at photo 1 rubber-bands rather than exits; swipe-to-exit at a
boundary needs a clearly vertical gesture. If the first motion isn't
horizontal-toward-a-blocked-side, don't capture — the shell handles the
release exactly as today.

Single-tap chrome toggle (`toggleAppBar`) now waits `--lightbox-zoom-dbltap-
window-ms` before firing, or resolves immediately on a confirmed second tap.
**This is a behavior change to the existing single-tap** — note it in the DoD
and `lightbox-480-plan.md`.

---

## Phases

### Phase A — skeleton + shared infra

Create `lightboxGestures.js` with `wire` / `reset` / `isZoomed` /
`isGestureActive` stubs. Insert `.lightbox-gesture-layer` in the
`lightboxMedia` mount path. Wire `reset()` into `applyMediaStyles` + nav +
rotate. Extract the rubber-band function `f(x,d,c)` and the snap-back tween
helper (Phases B and C both consume them). Add `LightboxShell.canNavigate()`.
Establish the shell no-op seam against `isZoomed() || isGestureActive()`.
**No gestures yet.**

**DoD:** layout, rotate, nav, entry/exit animation all visually identical to
before. `.lightbox-gesture-layer` present in the DOM at ≤480, absent / inert
at wide. `canNavigate(-1)` is `false` on the first photo, `canNavigate(1)`
`false` on the last, both `true` in the middle. No console errors.

### Phase B — one-finger drag: edge overscroll + pan

One handler, one owner, two behaviors.

**Edge overscroll** (verify as soon as this phase lands):
- 1-finger horizontal drag while at 1×. Capture per the rule above.
- Translate `.lightbox-gesture-layer` by `f(overshoot, viewportW, c)`, hard-
  capped at `--lightbox-overscroll-max-px`.
- Release → snap back to identity over `--lightbox-gesture-tween-ms` with the
  shared easing.
- Not at a boundary, or first motion not horizontal-toward-the-blocked-side →
  don't capture; the shell's hard-cut swipe fires on release as today.

**Pan while zoomed** (write it here; verify after Phase C):
- 1-finger drag while `isZoomed()`. Translate the layer, clamp to image edges
  with the same `f`.
- Sub-threshold single-finger taps still fall through to the shell (chrome
  toggle).

**DoD — overscroll (now):** on-device, at photo 1 a drag toward "previous"
rubber-bands and snaps back; a drag toward "next" still hard-cuts to photo 2.
Same at the last photo, mirrored. A middle photo is unchanged — no
drag-follow. A diagonal-ish drag at photo 1 rubber-bands and does **not**
exit; a clearly vertical drag still exits. Grid never scrolls behind, during
or after the rubber-band. State device/OS.

**DoD — pan (after C):** pan only functions while zoomed; releases inside
bounds; edges rubber-band and settle. At 1× and not at a boundary, one-finger
behavior is unchanged.

### Phase C — pinch

Two-finger `touchstart/move/end`. Track midpoint + distance; scale about
midpoint; clamp the 1× floor and 1:1 ceiling with the shared `f` (c = 0.55);
snap back on release over the shared tween. `isGestureActive()` true during
pinch; shell recognizer no-ops.

**DoD:** on-device, pinch zooms about the fingers, rubber-bands past both
limits, snaps back. Swipe-nav still works at 1×. Grid never scrolls behind.
State device/OS. Unblocks Phase B's pan DoD — coordinate with the B owner.

### Phase D — double-tap

Double-tap detection (`--lightbox-zoom-dbltap-window-ms`). From 1× → animate
to 2.5× fit centered on tap (clamped ≤ 1:1). From zoomed → animate to 1×.
Wire the 300ms single-tap disambiguation in the shell.

**DoD:** double-tap toggles as specified, centered on the tap. Single-tap
still toggles chrome, with no perceptible lag in normal use.

### Phase E — polish + tokenize

`prefers-reduced-motion` (instant transitions, all three gestures).
Feature-detect coarse pointer (`matchMedia('(pointer: coarse)')`) — the whole
module is inert otherwise. Extract all knobs to the CSS vars above; JS reads
them on wire. Clean up listeners in the shell's existing teardown.

**DoD:** overriding any single var visibly changes only that dimension.
reduced-motion honored. Desktop unaffected. No inline magic numbers.

### Phase F — device tuning

With the owner: dial `--lightbox-gesture-tween-ms`,
`--lightbox-gesture-rubber-c`, `--lightbox-overscroll-max-px`,
`--lightbox-zoom-dbltap-scale` on real hardware. Record final values + notes
in this doc.

### Phase G — close-out

1. Confirm `docs/lightbox-480-plan.md` (new pinch/double-tap step, the
   edge-overscroll behavior, the single-tap note) and `docs/share-ui-deltas.md`
   (confirm-inherited line for all gestures) are updated.
2. `./scripts/build-share-viewer.sh`
3. `./scripts/deploy-share-viewer.sh`
4. Do **not** hand-edit anything under `share-viewer/`.
5. Smoke test share at ≤480 on-device: pinch, double-tap, pan, **edge
   overscroll at the first and last photo**, then swipe-nav / swipe-close /
   chrome-toggle at 1× mid-strip, and #3 containment.

---

## Conflict zones (do not run in parallel)

| Region | Phases | Note |
|--------|--------|------|
| `lightboxMedia.js` — `applyMediaStyles` + mount path | A | gesture-layer insertion + `reset()` hook |
| `lightboxGestures.js` (new) | A–E | one owner at a time; sequential |
| `lightboxShell.js` — `canNavigate()` accessor | A | small, additive |
| `lightboxShell.js` — recognizer / `onOverlayTouchStart` seam | B (overscroll capture), D (single-tap disambiguation) | claim together if overlapping |
| `styles.css` — ≤480 `:root` block + new `.lightbox-gesture-layer` rule | A, E | isolated once claimed |
| `static/fragments/lightbox.html` | A | only if the gesture layer is authored in markup rather than injected (prefer injected) |

---

## Locked decisions

- **No native gestures.** `touch-action: none` at ≤480 stays. All pinch / pan /
  overscroll math is in JS.
- **Edge overscroll is the single scoped exception to "hard cut, no live drag
  tracking."** It is boundary-only, engages on the first horizontal
  `touchmove`, and captures the gesture — locking out swipe-down-exit and
  swipe-nav for that touch. **Mid-strip swipe stays hard-cut** — no drag-follow
  between photo 1 and photo 50. (Confirmed 2026-08-29.)
- **At a boundary, bias horizontal over vertical.** A diagonal drag
  rubber-bands rather than exits; swipe-to-exit there needs a clearly vertical
  gesture. (Confirmed 2026-08-29.)
- **Overscroll snaps back on release — never pages, never persists.** Matches
  iOS Photos.
- **Overscroll is media-type-agnostic.** It works at the boundaries of a video
  item too — it's a frame translate, not a photo operation. Only pinch / pan /
  double-tap are photo-only.
- **No wide/desktop gestures this round** (confirmed 2026-08-28). No
  discoverable trackpad/hover story yet; chevrons + keyboard cover desktop
  nav. Revisit only if the owner raises it.
- **Zoom + overscroll reset to identity on every photo change / rotate /
  background.** Matches iOS; simpler than carrying state across nav.
- **Video: 1× only for zoom.** Pinch on a playing video is a no-op for now.
  (Overscroll still applies — see above.)
- **Double-tap target is 2.5× fit** (not a fit↔fill toggle), locked for r1
  (2026-08-28). Fill is a cleaner geometric story but a smaller,
  aspect-dependent jump; owner chose the fixed multiple.
- **Separate recognizer.** Pinch / pan / overscroll never enter
  `classifyGesture`; the "hard cut, no live drag tracking" decision for
  swipe/close stands, as narrowed by the overscroll exception above.
- **Ceiling is 1:1 image pixels**, computed — not a token, not "4× fit".
- **Module is `lightboxGestures.js`.** It owns all three gesture families;
  naming it after one (`lightboxZoom.js`) would be a misleading name over real
  behavior. (Renamed 2026-08-29, before any phase was claimed.)

---

## Open questions

1. ~~No wide/desktop zoom this round.~~ **Resolved 2026-08-28: narrow only.**
2. ~~2.5× fit for double-tap vs. fit↔fill.~~ **Resolved 2026-08-28: 2.5× fit, locked for r1.**
3. ~~Reset-to-1×-on-nav vs. persist zoom.~~ **Resolved: reset (see Locked decisions).**
4. ~~Video zoom.~~ **Resolved: 1× only for zoom; overscroll applies.**
5. ~~Overscroll: boundary-only live tracking vs. general drag-follow.~~
   **Resolved 2026-08-29: boundary-only, the one hard-cut exception.**
6. ~~Diagonal drag at a boundary: overscroll or exit.~~
   **Resolved 2026-08-29: bias horizontal — overscroll.**
7. `--lightbox-overscroll-max-px` as a flat px value vs. a `calc()` off
   `100vw`. *(Assumed flat px, tuned in F — a fraction-of-viewport cap can
   come later if F says it needs to scale.)*

---

## Docs to update as you go

- **Phase B** → `docs/lightbox-480-plan.md`: add the edge-overscroll behavior
  and note it is the one exception to the hard-cut recognizer.
- **Phase D** → `docs/lightbox-480-plan.md`: add "Step 7 — pinch / double-tap
  zoom"; note the single-tap now waits ~300ms to disambiguate.
- **Phase G** → `docs/share-ui-deltas.md`: add a line under **Lightbox**
  confirming pinch-zoom, pan, and edge overscroll are inherited (no delta).
