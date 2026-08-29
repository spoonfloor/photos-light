# Lightbox @ 480px breakpoint — tracking doc

Status: **all steps landed** (0–6), plus follow-on narrow-width refinements
(2026-08-26: chevron timing/single-side reveal, more-menu sizing, more-menu
relocation). **2026-08-27:** Step 5's edge strips were removed and replaced
with a per-chevron hit halo, and swipe no longer touches the chevrons — part
of the lightbox/share batch, `docs/lightbox-share-batch-plan.md` (see
"Locked decisions" and session log). Update the checkboxes and append to the
session log as work lands, so any new agent session can pick this up cold.

## Goal

Bring the lightbox's mobile behavior (at/below the 480px breakpoint) in line
with the grid view, plus new gesture/nav features. See "Locked decisions"
below for exact parameters — don't re-litigate these without the user.

## Locked decisions

- Lightbox must reuse the grid's `--app-bar-*` tokens, not hardcoded values —
  same breakpoint, same source of truth.
- Swipe left/right and swipe down are **hard cuts**, not a filmstrip drag.
  Fancy interactive filmstrip transition is explicitly out of scope (see
  "Explored & rejected" below) — don't revisit without the user raising it.
  - **Amended 2026-08-27** — nav (swipe / chevron / arrow key) now plays a
    "fake swipe": the outgoing frame is still a hard cut, but the incoming
    `.lightbox-media-frame` mounts offset toward the side it came from and
    CSS-transitions to center. Not the rejected filmstrip — no drag tracking,
    no neighbor pre-mount, no physics. `LightboxMedia.animateFrameEntry`
    (shared), gated on a signed `enterFrom` nav delta threaded from each
    host's nav funnel; honors `prefers-reduced-motion`.
  - **Swipe-down exit (2026-08-28):** interactive drag-to-dismiss designed
    and **deferred** (see "Deferred — interactive drag-to-dismiss"). The
    interim is built: swipe-down plays a release-triggered drop + shrink +
    fade on the frame, then the normal close (`LightboxMedia.animateFrameExit`)
    — see "Interim — cheap 'scale + move down' exit". Unverified on-device.
  - **Open transition (2026-08-28):** genuine lightbox open plays a
    fade-up-from-black — a one-shot black scrim over `#lightboxOverlay`
    (`LightboxShell.playOpenScrim`). See "Open transition — fade-up from
    black". Unverified on-device.
  - **All three animations (2026-08-28):** every timing/distance/easing lives
    in CSS as `--lightbox-anim-*` tokens + `.is-animating-entry` /
    `.is-exiting` / `.lightbox-open-scrim` classes (styles.css). JS toggles
    classes, forces the priming reflow, and derives its cleanup backstop from
    the element's resolved `transition-duration`
    (`LightboxMedia.transitionTimeoutMs`) — no timing constants mirrored in
    JS. Current values: entry `80px` / `200ms` / `cubic-bezier(0.4,0.4,0,1)`;
    exit `240px` `scale(0.9)` `opacity 0` / `120ms` / `linear`; scrim
    `100ms` / `cubic-bezier(0.4,0.4,0,1)`.
- ~~Edge nav strips: **96px** wide, full height, one per side.~~
  **Superseded 2026-08-27** (user "changed my mind" — see batch plan
  `docs/lightbox-share-batch-plan.md` #2 and session log below): the
  full-height edge strips are gone at every width. Each chevron instead
  carries its own invisible square hit halo — a `::before`, side =
  `--lightbox-nav-btn-size + 2 * --lightbox-nav-halo-pad` (8px pad → 56px
  wide / 64px narrow), centred on the chevron. The halo is the entire
  prev/next pointer target and, on wide, the hover surface that reveals the
  chevron.
- **App bar never auto-hides.** No timer applies to it. It shows/hides only
  on an explicit tap of an unclaimed area (Step 4) — a manual toggle, not a
  fade-on-idle.
- **Arrow visibility is width-gated — two independent designs, not one
  shared timer** (redesigned 2026-08-25, adopts the Google Photos hover
  convention for wide widths; see session log):
  - **Narrow (≤480px, touch):** 1500ms auto-hide timer from image load
    (changed from the original 1000ms, then briefly 2000ms, to 1500ms —
    2026-08-26, see session log), independent of the app bar's state. A
    chevron tap or an arrow key resets the timer and re-shows the arrows.
    The chevron's hit halo stays tappable even after the chevron has faded
    (`.hidden` only drops opacity, not pointer-events — 2026-08-27); a tap
    there pages and re-reveals that side. Only `.inactive` (nav boundary)
    makes the halo inert.
    **Only the side just used re-shows**, not both — e.g. after navigating
    back, only the left chevron reappears (added 2026-08-26, see session
    log). Both still show on a true initial open. **A swipe does nothing to
    the chevrons** — no reveal, no timer reset (changed 2026-08-27, see
    session log; `lastNavWasSwipe` in `lightboxShell.js`). No hover — touch
    has none.
  - **Wide (>480px):** no timer at all. Chevrons are hidden by default;
    hovering a chevron's own hit halo reveals that chevron only — exclusive
    per side, pure hover-driven (plain CSS `.lightbox-nav-btn:hover`, no JS
    timer/state). Was strip-hover-driven until 2026-08-27 (strips removed —
    see the superseded edge-strip decision above).
- **Drag-based swipe (left/right/down) is touch-only.** Click-drag isn't a
  discoverable desktop convention the way touch swipe is, and a mouse drag
  doesn't carry the same intentionality as a touch swipe at the same
  distance threshold — so a desktop mouse never navigates or closes via
  drag. Plain click (no drag) still toggles the app bar on both inputs,
  since a click is a normal desktop interaction. Desktop nav relies on the
  chevrons (and their hit halos) and keyboard instead. (Added 2026-08-25,
  reverses part of the mouse-support session below — see session log.)
- **More menu relocation, narrow-width + app-surface only, not share**
  (added 2026-08-26, see session log): grid's inline Download/Change-date
  app-bar icons and the lightbox's inline Rotate/Change-date/Download icons
  hide at ≤480px and move into an overflow ("more") menu instead — grid's
  existing `#utilitiesMenu`, and a new lightbox-only instance
  (`#lightboxUtilitiesMenu` + `#lightboxMoreBtn`) that reuses the same
  `.utilities-menu` component/`PhotoChrome.toggleUtilitiesMenu` helper, not
  a parallel implementation. Share is unaffected at any width — scoped via
  `body:not(.share-view)` in CSS (grid) and by simply not existing in
  share's fragments (lightbox has no `*Share.html` fork, so this only
  applies where the moved buttons are app-only to begin with). Grid's menu
  additionally reorders Download/Change-date above Clear stars at this
  breakpoint only (`order: -2`/`-1` on `#downloadSelectedBtn`/
  `#editDateSelectedBtn`).
  - **Amended 2026-08-27** — the lightbox half of this was in fact *not*
    scoped away from share: the ≤480 rule was unconditional, so share's
    lightbox got a `⋮` more button opening a one-item (Download only)
    menu, and trash view's lightbox got an *empty* more button. Now gated:
    `LightboxShell.applyCapabilities` adds `.lightbox-more-menu-active` to
    `#lightboxOverlay` only when ≥2 of rotate/change-date/download are
    available, and the ≤480 inline→menu swap keys off that class. Share
    (Download only) and trash view (none) keep the lone action — or
    nothing — inline, no more button. See session log 2026-08-27.

- **Video playhead, narrow width** (added 2026-08-27, see session log):
  overriding iOS Safari's native `<video>` controls is not possible — the
  `::-webkit-media-controls-*` pseudo-elements are effectively read-only on
  iOS. So the custom transport (`lightboxVideoControls.js`) is used at every
  width and on every surface (share dropped its `nativeVideoControls`
  shortcut — was an undocumented inheritance break). At ≤480px it reduces to
  three controls in one row — **play/pause · progress bar · mute** — taking
  layout cues from the iOS Photos playhead but **not** its glass capsule
  (the app's flat bottom-scrim is kept). No loop, no elapsed/duration
  readout, no fullscreen at this width; the six-control desktop transport is
  unchanged above 480px. Playhead visibility is **bundled with the app-bar
  chrome** at ≤480px — both shown on open, both hidden together on the
  unclaimed-area tap (the desktop hover/idle model does not run on touch).
  Tap-on-video toggles chrome, not play/pause, at this width. The overlay is
  parented to `.lightbox-content` (not the letterboxed media box) at ≤480px,
  so it sits at the true bottom of the frame and the info panel pushes it
  up. Audio defaults **off** (`session.muted`); progress is rAF-driven off a
  `seekable`-validated duration, not `timeupdate` alone. See session log
  2026-08-27 (round 2).

## Prereq diagnosis (agreed necessary before feature work)

Full diagnosis is in the session transcript from 2026-08-24; summary:

1. Lightbox bar (`.lightbox-top-bar` / `.lightbox-icon-button`,
   `static/css/styles.css:1150`) is a fully separate implementation from the
   grid app bar (`.app-bar-wrapper` / `.app-bar-icon-button`,
   `static/css/styles.css:366`) — hardcoded sizes, no shared tokens.
2. The single canonical `@media (max-width: 480px)` block
   (`static/css/styles.css:3524`) does not touch lightbox at all — grid
   icons grow for touch below 480px, lightbox icons stay frozen at desktop
   size.
3. `.lightbox-nav-btn` (chevrons, `static/css/styles.css:1824`) has no grid
   counterpart and no responsive rule anywhere.
4. No gap token on `.lightbox-top-bar` — icons are just adjacent hit boxes.
5. An existing auto-hide system already lives in `lightboxShell.js`
   (`scheduleUIHide`/`uiHideTimeout`, line ~78): hides only the top bar,
   is **mouse-hover-driven** (`mouseenter`/`mouseleave`, no touch handling),
   and runs on a **2000ms** timer. This needs to be consolidated with the
   new tap-driven 1000ms arrow-hide system, not left running alongside it
   as a second competing clock.

## Open questions — resolved 2026-08-24

- **Top-bar icon gap: adopted.** `.lightbox-top-bar` now has
  `gap: var(--app-bar-actions-gap)`, matching the grid. That token was
  previously scoped only inside `.app-bar-elements-layer` (base value +
  JS squeeze target) with no `:root` fallback, so a naive
  `var(--app-bar-actions-gap)` reference from the lightbox tree would
  have silently resolved to no gap. Fixed by adding a `:root`-level
  `--app-bar-actions-gap: 8px` default; the layer's own declaration still
  shadows it for anything inside the grid app bar (including the JS
  squeeze behavior), so grid behavior is unchanged.
- **Nav chevron mobile sizing: resolved by flipping the anchor.** Rather
  than growing the existing 48px/36px for mobile (which would push an
  already-large chevron even bigger), the current 48px/36px is now the
  ≤480px (touch) value, and desktop was backed into a smaller size using
  the same 4:3 btn:glyph ratio: `--lightbox-nav-btn-size: 40px`,
  `--lightbox-nav-glyph-size: 30px` at `:root`, overridden back to
  48px/36px in the existing `@media (max-width: 480px)` block. Rationale:
  desktop is mouse-driven and doesn't need a touch-target floor; 48px
  already read "horsey" as the constant/only size.

## Open questions — resolved 2026-08-25

- **Edge nav strip width for mouse/desktop: resolved — same as touch.**
  Settled while adopting the Google Photos hover convention for wide
  widths (see "Locked decisions" and session log): 96px at every
  breakpoint, one CSS token, no separate desktop value to dial in.

## Explored & rejected

- **Filmstrip-style interactive swipe transition** — would require live 1:1
  drag tracking, pre-mounted/pre-laid-out neighbor images (not just
  pre-decoded), velocity-based commit/cancel physics, gesture-interruption
  handling, and a call on whether arrow-button nav should match the drag
  style. Estimated an order of magnitude more work than a hard cut, touching
  `lightboxMedia.js` layout and `lightboxMediaCache.js` preload logic. User
  explicitly deferred this — hard cut only, for now.

## Deferred — interactive drag-to-dismiss (down-swipe)

**Status (2026-08-28):** full design captured below; **not building it now.**
Shipping the cheap interim instead (see next section). Revisit only if the
interim doesn't satisfy.

The idea: the down-swipe exit becomes a real direct-manipulation gesture
instead of a hard cut.

1. **Engage.** First clearly-vertical move → photo animates to `g%` scale
   over `n` ms. Reads as "picked it up, downward-dismiss armed."
   **Locked (2026-08-28): err toward recognizing a horizontal swipe** —
   anything ambiguous stays nav; the dismiss-drag only engages on a
   clearly-vertical gesture.
2. **Follow.** Photo is glued to the finger with full fidelity — `translate`
   recomputed every frame, free 2D movement, not axis-locked once engaged.
3. **Point-of-no-return signal.** A commit threshold (contact-relative: `h`
   px below the initial touch point — preferred over a screen-bottom-relative
   `i` px for predictability). While the finger is past it, the photo tweens
   to `j%` scale (`j < g`); back across, it tweens back to `g%`. Fixed
   duration each way. Add a dead-band (arm at `h`, disarm at `h − margin`) so
   a finger resting on the line doesn't strobe.
4. **Release.**
   - Past threshold → animate an arbitrary continued downward move, then hard
     cut to grid (`ctx.onBack()`).
   - Under threshold → animate back to full size and original position
     (not a snap).

### Why it's deferred, not rejected

Sound interaction; the two-state scale (`g%` → `j%`) is a genuinely good
no-return signal. But it's ~40–50% of the filmstrip's cost:

- **Position-follow means `transform` is written per-frame in JS**, so the
  scale animations **cannot be CSS transitions** (same property). Both scale
  tweens become rAF lerps folded into the same per-frame
  `transform: translate(x,y) scale(s)` write.
- Commit threshold + hysteresis + dead-band state machine.
- Two release paths, both animated (commit continuation; cancel return).
- Horizontal-swipe disambiguation in the first ~10px (bias toward nav).
- Overlay is opaque `#000`, so the photo drags over black — no grid reveal
  until the cut unless the overlay also goes transparent (more plumbing:
  chrome handling, confirming the page paints through).
- Scope ≤480 / touch; `prefers-reduced-motion` skips both scale animations;
  the rotation-commit-can-bail wrinkle in `closeLightbox` applies to the
  commit path.

Tuning (`g`, `j`, `n`, `h`, durations, threshold feel) is only gettable by
prototyping on-device.

## Interim — cheap "scale + move down" exit (touch-end only)

**Status (2026-08-28): built, unverified on-device.**
`static/js/photoSurface/lightboxMedia.js` + `lightboxShell.js`,
`static/css/styles.css` (tokens + `.is-exiting`); share rebuilt.

No drag tracking. Reuses the existing swipe-down recognition in
`classifyGesture` (start/end delta past `SWIPE_MIN_DISTANCE`), which used to
call `ctx.onBack()` directly. Now: on a recognized down-swipe it calls
`LightboxMedia.animateFrameExit(content, () => ctx.onBack())` — the current
`.lightbox-media-frame` gets the `.is-exiting` class, which CSS transitions to
`translateY(var(--lightbox-anim-exit-translate)) scale(--…-exit-scale)` +
`opacity var(--…-exit-opacity)` over `--lightbox-anim-exit-duration`
`--lightbox-anim-exit-ease`, then `onBack()` runs the normal close. Current
token values: `240px` / `0.9` / `0` / `120ms` / `linear`.

- Sibling to `animateFrameEntry`; exported from `lightboxMedia.js`, called
  from `lightboxShell.js`. Shared, so share inherits it (share's `onBack` is
  synchronous `closeLightbox`).
- `transitionend` fires `onBack`; the backstop timeout is
  `transitionTimeoutMs(frame)` = resolved `transition-duration` + 100ms slack,
  so a missed event can't strand the lightbox open.
- `frame.dataset.exiting` guards against a second swipe re-triggering mid-exit
  (the second `onBack` is absorbed by `closeLightbox`'s `lightboxClosing` /
  null-id guards).
- `prefers-reduced-motion` → falls straight through to `onBack` (current
  instant hide), no class added. No width gate in the helper — it rides the
  recognizer, which is already touch-only via `allowDrag`.
- **Frame fades, overlay doesn't** — the frame itself fades to
  `--lightbox-anim-exit-opacity`; the black overlay stays opaque and is
  hard-cut to the grid by `onBack()`. (A true dissolve-to-grid via overlay
  opacity was floated and dropped for v1.)
- **Known gap:** `closeLightbox` awaits the rotation commit and can bail
  keeping the lightbox open (only if the user rotated a photo this session
  *and* the save fails). The frame keeps `.is-exiting` in that case; it
  self-heals on the next nav/reopen (`content.innerHTML = ''` rebuilds it),
  and the user has a failure toast. Not worth plumbing around for v1.
- **`translateY` sits outside `scale()`** in the CSS `transform` so the px
  value is literal, not scaled.

## Open transition — fade-up from black

**Status (2026-08-28): built, unverified on-device.**
`static/js/photoSurface/lightboxShell.js`, `static/css/styles.css`
(`.lightbox-open-scrim`); share rebuilt.

On a genuine lightbox open (not nav reloads — those have the fake-swipe),
`show()` calls `playOpenScrim()`: a one-shot `<div class="lightbox-open-scrim">`
is appended to `#lightboxOverlay` (styles.css gives it `position:absolute;
inset:0; z-index:100` — clears chrome and chevrons — `pointer-events:none`, and
an `opacity` transition over `--lightbox-anim-scrim-duration`
`--lightbox-anim-scrim-ease`, currently `100ms` / `cubic-bezier(0.4,0.4,0,1)`).
JS reflows, adds `.is-fading` (`opacity: 0`), and removes the node on
`transitionend` (backstop = `transitionTimeoutMs(scrim)`). Photo + chrome are
already painted underneath (both hosts load media before `show()`), so it reads
as a fade-up from black.

- Gated on `show()`'s existing `isInitialOpen` flag; `prefers-reduced-motion`
  → no scrim, instant.
- `LightboxShell` owns the scrim (overlay-level, not media-specific) but reuses
  `LightboxMedia.transitionTimeoutMs` for the backstop. Shared via `show()`, so
  share inherits it.
- **Known wrinkle:** if the photo isn't cached, the scrim fades to reveal the
  gray placeholder, then the image pops in. Accepted for v1; coupling the fade
  to image-load was considered and skipped.

## Swipe-nav on an un-prefetched photo — gray box, not black

**Status (2026-08-28): built, unverified on-device.** `LightboxMedia.loadStillImage`.

`animateFrameEntry` slides the incoming `.lightbox-media-frame` in; when the
next photo isn't in `LightboxMediaCache` yet (fast multi-swipe, non-adjacent
jump, prefetch still in flight) that frame carries a gray `#2a2a2a`
placeholder. The bug: `revealImage` removed the placeholder and appended the
`<img>` in one step, with no wait for rasterization — for an HTTP-cached image
the sync `img.complete` branch removed the placeholder before it ever painted.
Either way the frame showed the black `#000` overlay for a frame or two mid-
slide before the photo appeared.

Fix: the `<img>` now mounts **over** the still-present placeholder, and the
placeholder is removed only once `img.decode()` resolves (`requestAnimationFrame`
fallback for no-`decode()` browsers / decode rejection on interrupted nav). The
gray box rides the entry slide and the photo hard-cuts in over it whenever it's
ready — mid-animation or after, no fade (matches the existing pop). Shared
module, so share inherits it. `loadCachedStill` (decoded happy path) and the
video path (keeps its own gray bg until `loadeddata`) are unchanged.

## Task order

- [x] **0. Prereq — tokenize + consolidate**
  - [x] Replace hardcoded lightbox bar/icon/nav-btn values with tokens
        (done 2026-08-24, see session log — `.lightbox-icon-button` and
        the bar height now reuse the actual `--app-bar-*` tokens;
        `.lightbox-nav-btn` got its own `--lightbox-nav-*` tokens since
        chevrons have no grid counterpart to reuse)
  - [x] Remove the hover-only `scheduleUIHide`/`uiHideTimeout` system
        entirely (done 2026-08-25, see session log). Superseded the
        original "one shared timer" framing — replaced by two independent
        systems, built separately: app bar tap-toggle (Step 4) and
        chevron-only auto-hide timer (Step 6).
- [x] **1. Breakpoint/size parity** — lightbox icons/gaps match grid at 480px
      (landed + corrected + verified live 2026-08-25 — see session log.
      Scrim decoupled from icon-row box; icon row now matches grid's box
      model exactly, confirmed pixel-identical via `getBoundingClientRect()`
      at desktop and 390px.)
- [x] **2. Swipe left/right → navigate** (hard cut, reuses existing
      `navigate(±1)`) — done + verified 2026-08-25, see session log
- [x] **3. Swipe down → exit to grid** (same gesture recognizer as #2) —
      done + verified 2026-08-25, see session log
- [x] **4. Tap unclaimed area → toggle app bar** (no-movement case of the
      same recognizer; anything hitting a registered interactive element is
      excluded automatically). App bar only — no timer, no effect on
      chevron visibility. Done + verified 2026-08-25, see session log.
- [x] **5. Edge nav strips** — 96px wide, full height, one per side,
      red debug overlay, registered as interactive elements so #4 excludes
      them for free. Width is a single CSS token used at every breakpoint —
      no separate desktop value (resolved 2026-08-25, see session log).
      Wide-width strips also need hover-state tracking (mouseenter/
      mouseleave), since Step 6's chevron reveal now depends on it.
- [x] **6. Arrow visibility, width-gated** (redesigned 2026-08-25 to adopt
      the Google Photos hover convention for wide widths — see "Locked
      decisions" and session log):
  - Narrow (≤480px, touch): 1000ms auto-hide timer from image load, resets
    on any nav interaction (arrow tap or strip tap). Chevrons only, runs
    independent of app bar state/visibility.
  - Wide (>480px): no timer. Chevrons hidden by default; hovering the left
    strip shows the left chevron only, hovering the right strip shows the
    right chevron only — exclusive per side, pure hover-driven.

## Definition of done

To be confirmed per-step when work starts (per house rule: state observable
behavior before declaring a step complete, not "it's fixed"). Draft:

- Step 0: lightbox bar visually unchanged at desktop width; at ≤480px,
  lightbox icon/gap sizes now equal grid's mobile values; only one hide-timer
  system exists.
- Step 1: resizing to ≤480px changes lightbox icon/gap sizes to match grid,
  confirmed by inspecting computed values against `--app-bar-*` tokens.
- Steps 2–6: manual gesture testing on a touch-emulated viewport (see
  criteria to be filled in per step).

## Session log

<!-- Append one entry per work session. Newest at bottom. -->

- **2026-08-24** — Planning only. Diagnosed prereq fragmentation, agreed
  fix-first, agreed task order, dropped filmstrip from scope, locked strip
  width/debug overlay/timer duration. No code changed yet. Next: start on
  Step 0 (tokenize + consolidate hide-timer).

- **2026-08-24** — Step 0, CSS tokenization sub-part. Edited
  `static/css/styles.css`:
  - `.lightbox-top-bar` height: `80px` → `calc(var(--app-bar-height) + 16px)`
    (still resolves to 80px today; now tracks the shared token instead of
    a standalone number).
  - `.lightbox-icon-button` width/height: `44px` → `var(--app-bar-icon-btn-size)`.
  - `.lightbox-icon-button .material-symbols-outlined` font-size: `24px` →
    `var(--app-bar-icon-glyph-size)` — this is the one that actually changes
    behavior at ≤480px (icon glyph now grows to 30px like the grid, instead
    of staying frozen — was diagnosis point #2).
  - `.lightbox-nav-btn` width/height: `48px` → new root token
    `--lightbox-nav-btn-size: 48px`.
  - `.lightbox-nav-btn .material-symbols-outlined` font-size: `36px` → new
    root token `--lightbox-nav-glyph-size: 36px`.
  - Deliberately did **not** add a `gap` to `.lightbox-top-bar`, and did
    **not** add ≤480px overrides for the two new `--lightbox-nav-*` tokens
    — see "Open questions" above, both need a call before Step 1.
  - Checked: no JS reads these px values directly (grepped
    `lightboxShell.js`, `lightboxMedia.js`), so no follow-on JS changes
    needed for this sub-part.
  - **Not yet done:** live-render check in a browser at desktop and ≤480px
    widths — no dev server was started this session, so "desktop pixel-
    identical" is confirmed by arithmetic (old hardcoded values ==
    computed token values today) but not by an actual rendered screenshot/
    devtools inspection. Do that before checking off this line for real.
  - Remaining in Step 0: hide-timer consolidation (`scheduleUIHide` /
    `uiHideTimeout` in `lightboxShell.js:78`, still 2000ms mouse-only,
    untouched this run).

- **2026-08-24** — Step 1, both open questions decided and implemented in
  `static/css/styles.css`:
  - **Top-bar gap:** `.lightbox-top-bar` gained `gap: var(--app-bar-actions-gap)`.
    Discovered `--app-bar-actions-gap` was scoped only inside
    `.app-bar-elements-layer` (base value there, also the JS squeeze target
    in `appBarLayout.js`'s `squeezeActionsGap()`) with no `:root` fallback —
    referencing it from the lightbox tree as-is would have silently resolved
    to no gap. Fixed by adding a `:root`-level `--app-bar-actions-gap: 8px`
    default (new comment at its declaration explains the two-tier scoping);
    the layer's local declaration still shadows it inside the grid app bar,
    so grid behavior/squeeze logic is unchanged.
  - **Chevron sizing:** anchor flipped per user direction — 48px/36px
    (current values) are now the ≤480px touch size, added as an override in
    the existing `@media (max-width: 480px)` block. `:root` defaults backed
    down to `--lightbox-nav-btn-size: 40px` / `--lightbox-nav-glyph-size: 30px`
    for desktop, keeping the same 4:3 btn:glyph ratio. Reasoning: desktop is
    mouse-driven (no touch-target floor needed) and 48px already read
    oversized as a constant.
  - **Not yet done:** live-render verification at desktop and ≤480px widths
    — no dev server started this session, same gap as Step 0's tokenization
    sub-part above. Do this before checking off Step 1's box for real.

- **2026-08-25** — Step 1 corrected + verified live. The `+16px` rationale
  logged above ("taller than grid to leave room for the gradient scrim")
  was checked via `git blame` and found to be written in the same session
  that added it, backfilled to justify keeping the pre-existing hardcoded
  80px — not a documented original design intent. Once actually modeled
  (gradient alpha as a function of box height, fixed icon position), a
  bar coupled 1:1 to the gradient's own height means a *taller* bar
  reduces contrast at the icon (alpha hits 0 exactly at the box's own
  bottom edge, and the icon sits closer to that edge as the box shrinks
  toward icon-row height) — the opposite of the original claim. Corrected
  by decoupling the two concerns into separate layers instead of one
  coupled box, in `static/css/styles.css` / `static/fragments/lightbox.html`
  / `static/js/photoSurface/lightboxShell.js`:
  - `.lightbox-top-chrome` (new): wrapper, fixed `height: calc(var(--app-bar-height) + 16px)`
    (= 80px, today's unchanged visual scrim extent), owns the `.hidden`
    fade so scrim + icons still hide/show together as one unit.
  - `.lightbox-scrim` (new): the gradient, unchanged, `inset: 0` inside
    the chrome wrapper, `pointer-events: none`.
  - `.lightbox-top-bar`: now literally matches `.app-bar-wrapper`'s box
    model — `height: var(--app-bar-height)` (64px), `align-items: center`,
    `padding: 0 20px` — instead of `align-items: flex-start` + `padding: 20px`.
    Icon row is vertically centered exactly like grid, not top-anchored.
  - `lightboxShell.js`: `els.topBar` selector repointed from
    `.lightbox-top-bar` to `.lightbox-top-chrome` (one-line change) so
    show/hide still affects both layers.
  - Rebuilt `share-viewer/` via `scripts/build-share-viewer.sh` (not
    deployed).
  - **Verified live** (existing dev server on :5001, own isolated browser
    tab — no library/session state touched, lightbox opened via a direct
    DOM toggle for chrome-only inspection): at desktop width, lightbox
    icon `getBoundingClientRect()` is pixel-identical to grid's
    (`{x:20,y:10,w:44,h:44}` lightbox vs `{y:10,w:44,h:44}` grid — same
    row height, same centering). At 390px width, bar height still 64px,
    glyph font-size 30px (≤480px token), matching grid. Screenshots taken
    at both widths.
  - **Debt found in the above pass, then actually fixed (not just
    flagged) later the same session** — see next entry. User pushed back
    on treating "icons must conform to grid app bar" as covering static
    size only; behavior (overflow/squeeze handling) was always part of
    that instruction, not separate follow-up debt.

- **2026-08-25** — Behavior parity, not just visual parity. Per explicit
  direction: lightbox app bar must match grid in both look *and* behavior.
  The 42px-vs-44px flex-shrink gap noted above was a symptom of a deeper
  issue — lightbox had no version of grid's overflow/squeeze engine at
  all, and patching `flex-shrink: 0` onto `.lightbox-icon-button` would
  have been a band-aid on top of a still-forked implementation (exactly
  the failure mode that produced the wrong +16px rationale earlier).
  Fixed by making the actual component shared, not just token-matched:
  - `static/js/photoSurface/appBarLayout.js`: converted from a
    module-level singleton (`document.querySelector('.app-bar-elements-layer')`,
    first match only — previously worked for grid only because
    `#appBarMount` precedes `#lightboxMount` in `index.html`, an accident
    of DOM order, not a designed contract) into a factory,
    `createAppBarLayoutController(mountId)`. `AppBarLayout` (grid, scoped
    to `#appBarMount`) and `LightboxAppBarLayout` (scoped to
    `#lightboxMount`) are now two independent instances of the same
    engine — own state, own observers, no shared mutable module state.
    All 6 existing `AppBarLayout.*` call sites (main.js, shareBoot.js,
    datePickerChrome.js, chrome.js) untouched — same public API.
  - `static/fragments/lightbox.html`: icon row rewritten to reuse grid's
    actual markup — `.app-bar-wrapper` / `.app-bar-elements-layer` /
    `.actions` / `.app-bar-icon-button` — instead of a parallel
    `.lightbox-*`-only tree. `.lightbox-top-bar` / `.lightbox-icon-button`
    now carry only true deltas: transparent background (grid's is opaque;
    lightbox needs the scrim to show through) and white icon color
    (vs. grid's off-white `--text-primary`). `.lightbox-spacer` deleted
    (dead code — was only needed by the old single-flex-row layout).
  - **Found and fixed before shipping, via code reading, not live
    testing:** grid's `.title-and-back` is decorative (title text) and
    `AppBarLayout.layout()` auto-hides it when the bar is too crowded to
    fit everything. Lightbox's leading button is the close/back control —
    hiding it under crowding would trap the user in the lightbox. Did
    *not* reuse `.title-and-back` for it; gave it a dedicated
    `.lightbox-back-btn` (absolute left, vertically centered via
    `transform: translateY(-50%)`) that `layout()` never touches, since
    `layer.querySelector('.title-and-back')` simply finds nothing in the
    lightbox instance and the hide branch no-ops.
  - `static/js/photoSurface/lightboxShell.js`: `show()` calls
    `LightboxAppBarLayout.init()`, `hide()` calls `.disconnect()` —
    mirrors main.js's grid lifecycle pattern.
  - Rebuilt `share-viewer/` (not deployed).
  - **Verified live** (same isolated-tab method as the prior entry):
    desktop — lightbox `#lightboxBackBtn` and action buttons all
    `{y:10, w:44, h:44}`, pixel-identical to grid; background
    `rgba(0,0,0,0)` (scrim shows through, not grid's opaque bar); actions
    gap `8px`, matching grid's default. **Squeeze path specifically**
    (the actual behavior this pass was about): this pane's
    `requestAnimationFrame` doesn't fire for JS-triggered work on a
    backgrounded tab — confirmed this is a test-harness limitation, not a
    regression, by showing grid's own *unmodified* `AppBarLayout` fails
    the same way here. Worked around it for verification only (patched a
    scratch copy of the module to call `layout()` synchronously instead
    of via rAF, not a shipped change) at a 300px viewport: 6 action icons
    naturally need 304px, budget is 260px → engine correctly computed
    `--app-bar-actions-gap: -0.8px` and set `app-bar-layout--actions-squeezed`,
    icons overlap slightly instead of shrinking (matches
    `squeezeActionsGap`'s documented last-resort behavior) — back button
    stayed visible and correctly positioned throughout. Grid's own app bar
    screenshot-checked afterward to confirm no regression from the
    `appBarLayout.js` refactor.
  - Not yet done: real-device/real-resize confirmation of the squeeze
    path (only verified via the rAF-bypassed scratch copy above, for the
    reason noted).

- **2026-08-25** — Step 0, hide-timer item: removed the old rule instead of
  replacing it in place. In `static/js/photoSurface/lightboxShell.js`:
  deleted `uiHideTimeout`/`uiHovered` state, `scheduleUIHide()`,
  `clearUIHideTimeout()`, `syncUIHoverState()`, `onOverlayMouseEnter/Leave()`,
  and the `mouseenter`/`mouseleave` bindings that drove them. Kept
  `showUI()`/`hideUI()` as plain setters for future timers to call.
  `show()`/`refreshChrome()` now just call `showUI()` directly. Also removed
  5 dead wrapper functions in `static/js/main.js`
  (`showLightboxUI`/`hideLightboxUI`/`clearLightboxUIHideTimeout`/
  `scheduleLightboxUIHide`/`syncLightboxUIHoverState`) and one redundant
  call site in `closeLightbox` (`LightboxShell.hide()` already covers it).
  Rebuilt `share-viewer/` (not deployed). **Resulting behavior:** app bar
  now stays visible permanently — no auto-hide of any kind — until Step 4
  builds the tap-to-toggle.
  - **Design decision, same session:** user changed the target design —
    it's not one shared hide timer for bar + arrows anymore. App bar never
    auto-hides on a timer, full stop; it only toggles on an explicit tap of
    an unclaimed area (Step 4). The 1000ms auto-hide timer applies to the
    chevrons only, and runs independently of whatever state the app bar is
    in. Updated "Locked decisions" and steps 4/6 above to match. Net effect
    on Step 0's checklist: the "consolidate into one timer" item is now
    moot — replaced by the removal (done, this entry) plus two independent
    builds already tracked as their own steps (4 and 6), not new Step 0
    work.
  - Next: Step 2 — swipe left/right gesture recognizer wired to
    `navigate(±1)`. (Step 4's tap-toggle depends on this same recognizer,
    so it can't be built first.)

- **2026-08-25** — Step 2, swipe left/right → navigate. Added a gesture
  recognizer to `static/js/photoSurface/lightboxShell.js`, deliberately
  shared infrastructure (not a one-off) so Steps 3 and 4 extend it rather
  than duplicating it:
  - `touchstart`/`touchend`/`touchcancel` bound on `els.overlay` (not just
    `#lightboxContent`), so it can later cover the whole lightbox surface
    for tap-to-toggle (Step 4).
  - Records only the start point and end point — no `touchmove` tracking,
    per the hard-cut locked decision (no filmstrip drag).
  - On `touchend`: classifies as a horizontal swipe only if
    `|deltaX| >= 50px` and `|deltaX| > |deltaY|`; swipe left calls
    `ctx.navigate(1)` (next), swipe right calls `ctx.navigate(-1)` (prev) —
    same convention as the existing chevron buttons. Sub-threshold moves
    and vertical-dominant moves are classified but intentionally left as
    no-ops today (Step 3 will act on the vertical-down case, Step 4 on the
    no-movement case).
  - `isInteractiveTarget()` excludes touches starting on buttons/links/
    the info panel via `closest()`, so a drag that begins on a chrome
    control never fires a swipe. Multi-touch (pinch) is also excluded —
    a second finger touching down re-fires `touchstart` with
    `touches.length !== 1`, which invalidates the in-progress gesture.
  - `hide()` now also resets the gesture's `touchActive` flag, matching
    the cleanup already done for other lightbox-session state.
  - Rebuilt `share-viewer/` (diffed identical to `static/`, not deployed).
  - **Verified live** (same isolated-tab method as prior entries, no
    library loaded, no real photo/session state touched): monkey-patched
    the global `navigateLightbox` with a spy, forced `state.lightboxOpen =
    true` and the overlay visible, then dispatched synthetic touch events
    against the real running `LightboxShell` (not a reimplementation).
    Results matched spec exactly — `calls === [1, -1]` for a swipe-left
    then swipe-right; zero calls for a sub-threshold move, a
    vertical-dominant move, a two-finger start, and a touch starting on
    `#lightboxBackBtn`. All test state (spy, `state.lightboxOpen`, overlay
    `display`) restored afterward and confirmed back to original values.
  - Not yet done: confirmation on an actual touch device/emulator tapping
    real photos (this pass used synthetic `Event` objects with hand-set
    `touches`/`changedTouches`, since no library was loaded in the
    isolated verification tab).

- **2026-08-25** — Step 3, swipe down → exit to grid. Extended the same
  recognizer in `static/js/photoSurface/lightboxShell.js`'s
  `onOverlayTouchEnd` (no new listeners — reuses the touchstart/touchend
  binding from Step 2):
  - Added a second classification branch after the existing horizontal
    check: `deltaY >= 50px && deltaY > |deltaX|` (vertical-dominant,
    downward only) calls `ctx?.onBack?.()` — the same path as tapping the
    back/close button (commits pending rotations), not the Escape
    shortcut (which discards them). Deliberate: swipe-down is a purposeful
    exit gesture, not a discard-and-bail escape hatch.
  - Swipe-up is a negative `deltaY`, so it falls through both branches and
    stays a no-op — not in scope per the locked decision (only "swipe
    down" was specified).
  - Both adapters (`main.js:6553`, `shareBoot.js:684`) already expose
    `onBack`, so this is inherited by share automatically with zero
    share-only code — consistent with the app→share inheritance rule.
  - Rebuilt `share-viewer/` via `scripts/build-share-viewer.sh` (diffed
    byte-identical to `static/`, not deployed).
  - **Verified live** (same isolated-tab, synthetic-touch method as Step
    2's entry — no library loaded, no real photo/session state touched;
    this pass corrected an initial mistake of patching `window.state` /
    `window.closeLightbox`, which are `undefined` since `main.js` is a
    classic script and `const state` doesn't attach to `window` — switched
    to bare identifiers, which do resolve in the shared script realm):
    spied on `closeLightbox` and `navigateLightbox`, forced
    `state.lightboxOpen = true` and the overlay visible, dispatched five
    synthetic swipes against the real running `LightboxShell`. Results:
    swipe down (100px) → 1 `closeLightbox` call; swipe up (100px) → 0
    (correctly a no-op); sub-threshold vertical (20px) → 0; swipe left/
    right (100px each, regression check) → `navigateLightbox` calls
    `[1, -1]` unchanged from Step 2. All test state (spies, `lightboxOpen`,
    overlay `display`) restored and confirmed back to original values.
  - Not yet done: same caveat as Step 2 — no actual touch device/emulator
    confirmation yet, synthetic events only.
  - Next: Step 4 — tap unclaimed area toggles the app bar (no-movement
    case of this same recognizer; registered interactive elements are
    already excluded via `isInteractiveTarget()`).

- **2026-08-25** — Step 4, tap unclaimed area → toggle app bar. Extended
  `onOverlayTouchEnd` in `static/js/photoSurface/lightboxShell.js` with a
  third classification branch (no new listeners, same touchstart/touchend
  binding as Steps 2–3):
  - New constant `TAP_MAX_MOVEMENT = 10px`, deliberately separate from
    `SWIPE_MIN_DISTANCE` (50px) — a genuine tap, not "any failed swipe
    attempt." A drag of 11-49px in either axis is ambiguous and stays a
    no-op, same as the existing sub-threshold-swipe no-op from Step 2.
  - `|deltaX| <= 10 && |deltaY| <= 10` → `toggleAppBar()`, a new function
    that reads `.lightbox-top-chrome`'s `hidden` class and calls the
    existing `showUI()`/`hideUI()` setters (from the Step 0 hide-timer
    removal) accordingly. App bar only — doesn't touch chevron visibility,
    which is unbuilt (Step 6) and independent per the locked decision.
  - "Anything hitting a registered interactive element is excluded
    automatically" came for free from Step 2's `onOverlayTouchStart`: a
    touch starting on a `button/a/input/textarea/select/[contenteditable]/
    .lightbox-info-panel` never sets `touchActive = true`, so
    `onOverlayTouchEnd` returns before any classification runs. No new
    exclusion logic needed. (Step 5's edge strips will need to render as
    one of these selectors — noted for that step, not addressed here.)
  - Touch-only (no click/mouse listener) — consistent with Steps 2–3 and
    with this plan's scope (≤480px touch behavior only); desktop is
    unaffected.
  - Rebuilt `share-viewer/` via `scripts/build-share-viewer.sh` (diffed
    byte-identical to `static/`, not deployed). No share-only code — the
    toggle only touches shared DOM/state already present in both boot
    paths.
  - **Verified live** (same isolated-tab, synthetic-touch method as Steps
    2–3, real running `LightboxShell`, no library/session state touched):
    forced the bar visible, then dispatched in order — tiny tap (3px) →
    bar hidden; tiny tap again → bar visible again (toggle both
    directions); ambiguous 25px drag → unchanged; swipe-left 100px →
    `navigateLightbox(1)` fired, bar state unchanged (toggle doesn't
    fire on a classified swipe); tap starting on `#lightboxBackBtn` →
    unchanged (interactive-target exclusion confirmed). All 5 checkpoints
    matched expected state in sequence:
    `[false, true, false, false, false, false]` (hidden-class value after
    each step). All test state (spies, `lightboxOpen`, overlay `display`,
    bar's `hidden` class) restored and confirmed back to original values.
  - Not yet done: same caveat as Steps 2-3 — synthetic events only, no
    real touch device/emulator pass yet.
  - Next: Step 5 — 96px-wide full-height edge nav strips, red debug
    overlay, registered as one of `onOverlayTouchStart`'s interactive
    selectors so Step 4's toggle excludes them for free.

- **2026-08-25** — Mouse support added retroactively to Steps 2-4, per
  explicit user direction. User hit this live: restarted the dev server,
  loaded their real library, opened the lightbox, and clicked on/above/
  below a photo with a mouse — no-op. Root cause: the recognizer only ever
  bound `touchstart`/`touchend`, so a desktop mouse click never fired any
  of it. This was a known, flagged gap (every prior verification used
  synthetic touch dispatch, never a real click), not a regression — the
  plan just never said desktop should be excluded, and the user wants it
  included. Asked user narrow-vs-broad scope (toggle-only vs all three
  gestures); user deferred to the recommendation — all three, mouse and
  touch feeding one shared classifier so they can't drift apart.
  In `static/js/photoSurface/lightboxShell.js`:
  - Extracted `classifyGesture(deltaX, deltaY)` out of `onOverlayTouchEnd`
    — the same three-branch swipe/swipe-down/tap logic, now called from
    both input paths so there's exactly one place the thresholds and
    branch order live.
  - Added `onOverlayMouseDown`/`onDocumentMouseUp`, mirroring
    `onOverlayTouchStart`/`onOverlayTouchEnd`: mousedown on the overlay
    arms the gesture (same `isInteractiveTarget` exclusion, plus
    `e.button !== 0` to ignore right/middle click), mouseup classifies it.
  - mouseup is bound on `document`, not the overlay — touch events
    auto-capture to their start element for the life of the gesture, mouse
    events don't, so a drag released over the info panel or outside the
    viewport still needs to resolve. Touch's existing `touchcancel`
    handling has no clean mouse equivalent; `mouseActive` still gets reset
    on `hide()` like `touchActive` does, covering the lightbox-closes-
    mid-gesture case.
  - `onOverlayMouseDown` calls `e.preventDefault()` once a gesture is
    armed, suppressing native image drag/text-selection so it can't steal
    the pointer mid-swipe or leave a drag-ghost artifact.
  - Rebuilt `share-viewer/` (diffed byte-identical, not deployed). No
    share-only code — same shared module, inherited automatically.
  - **Verified live with real browser-generated mouse events** (first
    time verification used the actual `computer` tool instead of
    synthetic `Event` dispatch) — no real library loaded (this
    environment has none; forced the overlay visible/state open the same
    way as prior isolated passes, spied `navigateLightbox`/`closeLightbox`
    on the window bindings): real click on empty overlay area toggled the
    bar hidden, click again toggled it back visible; a real click-drag
    left (150px) fired `navigateLightbox(1)` and left the bar state
    unchanged; a real click directly on `#lightboxBackBtn` fired the
    button's own click handler (`backCalls` incremented via the normal
    path, not the gesture path) and did not affect the bar — confirming
    the interactive-target exclusion holds for genuine mouse events, not
    just synthetic ones. All test state (spies, `lightboxOpen`, overlay
    `display`, bar's `hidden` class) restored and confirmed back to
    original values afterward.
  - Not yet done: a pass against the user's actual library/real photo (the
    dev server in this environment has no library loaded) — worth a quick
    manual click-through on their end now that the underlying cause is
    fixed.

- **2026-08-25** — Scope correction on mouse support: dropped drag-based
  nav/close for mouse entirely, per user direction after reviewing the
  prior entry's design. Reasoning discussed and agreed: click-drag isn't a
  discoverable desktop convention (touch swipe is, on mobile); a mouse drag
  doesn't carry the same intentionality as a touch swipe at the same
  distance threshold, so treating them as equivalent risked accidental
  triggers (most acutely for swipe-down-to-close). Chevrons, edge strips,
  and keyboard already give desktop a click-based nav path, so the drag
  gesture was redundant on top of being undiscoverable. Also flagged and
  resolved in the same discussion: chevron auto-hide (unbuilt, Step 6)
  needed a hover-reveal path for mouse or it'd be a dead end (no way to
  bring back a vanished, invisible control without already knowing to
  click blindly); and edge-strip width (unbuilt, Step 5) shouldn't
  pre-lock 96px for mouse since that number's rationale is touch-specific.
  See "Locked decisions" and "Open questions" above for the resulting
  decisions. Only the mouse-drag scope-back required an actual code
  change, since Steps 5–6 aren't built yet (the other two are forward-
  looking notes for when they are):
  - `static/js/photoSurface/lightboxShell.js`: `classifyGesture(deltaX,
    deltaY)` → `classifyGesture(deltaX, deltaY, { allowDrag })`. The
    swipe-left/right and swipe-down branches are now gated behind
    `allowDrag`; the tap-to-toggle branch is unconditional (unchanged for
    both inputs). Touch's call site passes `allowDrag: true`; mouse's
    passes `allowDrag: false` — so a mouse drag past the 10px tap threshold
    is now a no-op at any distance, in any direction, instead of firing
    navigate/close. `e.preventDefault()` on mousedown is unchanged (still
    needed to suppress native image drag-ghost even though drag no longer
    does anything).
  - Rebuilt `share-viewer/` via `scripts/build-share-viewer.sh` (diffed
    byte-identical to `static/`, not deployed). No share-only code.
  - **Verified live** (same isolated-tab, synthetic-mouse-event method as
    the prior mouse-support entry, real running `LightboxShell`, no
    library/session state touched): spied `navigateLightbox`/
    `closeLightbox`, forced the overlay visible/bar shown. A synthetic
    mouse drag-left (150px) and a synthetic mouse drag-down (150px) each
    produced zero nav/close calls (previously 1 each, per the prior
    entry's own verification) — confirming the walk-back took effect. A
    plain click (no drag) still toggled the bar's `hidden` class
    (`false → true`), confirming the shared tap path is untouched. All test
    state (spies, `lightboxOpen`, overlay `display`, bar's `hidden` class)
    restored and confirmed back to original values afterward.
  - Not yet done: real mouse device confirmation (synthetic events only,
    same caveat as every prior gesture-verification entry); Step 6's
    hover-reveal and Step 5's width decision are unbuilt, tracked above.

- **2026-08-25** — Planning only: adopted Google Photos' hover convention
  for edge nav at wide widths, per user direction. Resolves the standing
  "desktop strip width" open question and reshapes Step 6:
  - Edge nav strip width is now a single value, 96px, at every
    breakpoint — no separate desktop/mouse value to dial in live. Removes
    Step 5's "decide empirically" open question.
  - Step 6 splits into two independent designs instead of one shared
    timer: narrow (≤480px, touch) keeps the original 1000ms-auto-hide-
    timer design unchanged; wide (>480px) drops the timer entirely and
    instead reveals chevrons purely via hover — hovering the left strip
    shows the left chevron only, right strip shows the right chevron only,
    exclusive per side. This supersedes (not layers onto) the 2026-08-25
    "hover/movement over the lightbox resets the [shared] timer" decision
    logged earlier today, for wide widths specifically.
  - Confirmed with user: the timer does not survive at all for mouse/
    wide-width use — hover-in/hover-out on each strip is the entire show/
    hide mechanism there, likely implementable as pure CSS with no JS
    timer/state.
  - No code changed this session — doc/plan update only. Next: Step 5
    (96px edge strips, red debug overlay, hover-state wiring for the
    wide-width chevron reveal).

- **2026-08-25** — Step 5, edge nav strips. Added to
  `static/js/photoSurface/lightboxShell.js`, `static/fragments/lightbox.html`,
  `static/css/styles.css`:
  - New `--lightbox-edge-strip-width: 96px` root token, no ≤480px override
    — single value at every breakpoint, per this morning's Google Photos
    decision (no more empirical desktop-width pass needed).
  - `.lightbox-edge-strip`: `position: absolute`, full height (`top: 0;
    bottom: 0`), `width: var(--lightbox-edge-strip-width)`, transparent,
    `z-index: 0` — deliberately below `.lightbox-top-chrome` (1) and
    `.lightbox-nav-btn` (10), so the strip only catches clicks that don't
    land on an actual control, even though the chevrons and top-bar icons
    spatially overlap the strip's 96px zone. `.lightbox-edge-strip--debug`
    adds the red overlay; both are plain modifier classes on the two
    buttons in `lightbox.html`, one-line removal to flip off before ship.
  - Markup: two new `<button>`s (`#lightboxPrevStrip` / `#lightboxNextStrip`),
    not `<div>`s — `isInteractiveTarget()`'s selector already includes
    `button`, so Step 4's tap-to-toggle excludes them for free, no selector
    change needed (this was flagged as a to-do in Step 4's log entry).
    `aria-hidden="true"` + `tabindex="-1"`: the chevron remains the single
    accessible "Previous"/"Next" control; the strip is a supplementary
    pointer/touch target only, not a second one for keyboard/AT users.
  - `lightboxShell.js`: cached `els.prevStrip`/`els.nextStrip`, bound
    `click` → `ctx.navigate(-1)`/`ctx.navigate(1)` (same pattern as the
    existing chevron bindings), and extended `setNavArrows()` to toggle
    `.inactive` on the strips alongside the chevrons — the strip is a
    hit-target for the same action, so it shares the chevron's
    enabled/disabled state (`.lightbox-edge-strip.inactive` sets
    `pointer-events: none`, mirroring `.lightbox-nav-btn.inactive`).
  - No adapter changes in `main.js`/`shareBoot.js` — both already pass
    `navigate` into the shared `ctx`, so this is inherited by share
    automatically. Rebuilt `share-viewer/` via `scripts/build-share-viewer.sh`
    (diffed identical to `static/`, not deployed).
  - **Verified live** (existing dev server on :5001, no library loaded in
    this environment — same isolated-tab method as prior entries: forced
    the overlay open via direct DOM state, no real photo/session data
    touched): `getBoundingClientRect()` on both strips at a 1280×720
    viewport — `{x:0, y:0, w:96, h:720}` (left) and `{x:1184, y:0, w:96,
    h:720}` (right), full height, chevrons (`{x:20,w:40}` / `{x:1220,w:40}`)
    correctly nested inside each strip's zone. Screenshot confirmed the red
    debug overlay spans full height and chevrons + top-bar icons remain
    visually on top and unobstructed. Spied `navigateLightbox`: clicking
    inside the left strip away from the chevron fired `navigate(-1)`,
    right strip fired `navigate(1)` — correct chevron-matching direction.
    Forced the app bar hidden, then clicked inside a strip — bar stayed
    hidden and `navigate(-1)` still fired, confirming the strip click does
    not also reach the tap-toggle gesture path (interactive-target
    exclusion holds). Called `setNavArrows(false, true)` — `prevStrip`
    gained `.inactive` alongside `prevBtn`; clicking the inactive left
    strip produced zero additional `navigate` calls (`pointer-events: none`
    holds), matching the chevron's own inactive behavior. All test state
    (spy, bar `hidden` class, `setNavArrows`, overlay `display`,
    `state.lightboxOpen`) restored and confirmed back to original values.
  - Not yet done: real touch/mouse device confirmation with actual photos
    (synthetic/forced-state verification only, same caveat as every prior
    gesture-verification entry in this doc); Step 6's hover-reveal wiring
    for wide widths is unbuilt — nothing today reads the strip's hover
    state yet, since that reveal is expected to be pure CSS (`:hover`)
    when Step 6 lands, not JS state.
  - Next: Step 6 — arrow visibility, width-gated (narrow: 1000ms auto-hide
    timer; wide: hover-per-strip reveal, no timer).

- **2026-08-25** — Step 5 correction: debug overlay now paints above every
  layer, per explicit user direction. The original debug rule tinted the
  strip's own background (`.lightbox-edge-strip--debug`), but the strip
  sits at `z-index: 0` on purpose, so the tint was rendering *underneath*
  the chevrons and top-bar icon row wherever they overlap it — the debug
  aid didn't actually show the strip's true full extent. Fixed in
  `static/css/styles.css` / `static/fragments/lightbox.html`:
  - New decorative-only elements, `.lightbox-edge-strip-debug` (two
    `<div>`s, one per side, siblings of the strip buttons, same
    position/size via the shared `--lightbox-edge-strip-width` token) —
    `pointer-events: none`, `z-index: 20`, above `.lightbox-nav-btn` (10)
    and `.lightbox-top-chrome` (1). Deliberately a separate element from
    `.lightbox-edge-strip` rather than raising that button's own z-index:
    the strip has to stay at z-index 0 so real clicks on the chevron/top
    bar keep winning over it (Step 5's core behavior) — bumping it instead
    would have made debug mode start swallowing those clicks. This layer
    is purely visual and never affects hit-testing.
  - Removed the old `.lightbox-edge-strip--debug` rule and modifier class
    from both strip buttons in `lightbox.html` — the tint no longer lives
    on the functional element at all.
  - Rebuilt `share-viewer/` via `scripts/build-share-viewer.sh` (diffed
    identical to `static/`, not deployed).
  - **Verified live** (same isolated-tab method as prior entries, no
    library loaded, forced overlay open, all state restored after):
    `getBoundingClientRect()` on both new debug elements — `{x:0,y:0,
    w:96,h:720}` (left) / `{x:1184,y:0,w:96,h:720}` (right), `z-index: 20`,
    `pointer-events: none`, siblings of `.lightbox-overlay` alongside the
    chevrons/top-chrome (so CSS stacking-context rules guarantee the paint
    order, not just the computed z-index values). Visual confirmation at a
    narrow (400px) viewport: the back-arrow icon, previously rendered
    pure white against the top-chrome's dark background, now shows visibly
    red-tinted — proof the debug layer paints above the icon row, not
    under it. Regression-checked nav afterward at 1280px: clicking inside
    each strip (now with the debug `<div>` sitting on top of it) still
    fired `navigateLightbox(-1)` / `navigateLightbox(1)` correctly —
    `pointer-events: none` on the debug layer holds, so it doesn't
    intercept the click meant for the strip underneath.
  - Not yet done: same caveats as the main Step 5 entry above (no real
    device pass). Debug removal before ship still just two `<div>`s + one
    CSS rule, unchanged in shape from before this fix.

- **2026-08-25** — Step 6, arrow visibility, width-gated. Implemented per
  the locked design (two independent mechanisms, not one shared timer):
  - **CSS (`static/css/styles.css`)** — `.lightbox-nav-btn` reworked around
    two composable custom properties instead of a plain `opacity` value:
    `--lightbox-nav-shown` (is it revealed) × `--lightbox-nav-active-opacity`
    (is it usable, formerly `.inactive`'s hardcoded `opacity: 0.3`) — kept
    separate so "hidden by the timer/hover" and "disabled at a nav
    boundary" compose correctly without a combinatorial rule for every
    state pair; both-at-once just multiplies out to 0 automatically.
    - Wide default (unscoped rule = desktop, matching this file's
      established convention): `--lightbox-nav-shown: 0` — hidden until
      revealed — plus `pointer-events: none` on the chevron itself,
      permanently, at wide widths.
    - New `@media (min-width: 481px)` rules:
      `.lightbox-overlay:has(.lightbox-edge-strip--left:hover)
      .lightbox-nav-left { --lightbox-nav-shown: 1; }` (and the mirror for
      right/right) — exclusive per side, order-independent `:has()` rather
      than a `~` sibling combinator (the strips sit after the chevrons in
      the DOM, and `~` only flows forward).
    - Narrow override (existing EOF `@media (max-width: 480px)` block):
      `--lightbox-nav-shown: 1` by default (always shown, unchanged from
      pre-Step-6 behavior) and `pointer-events: auto` restored (direct tap
      on the chevron, no strip indirection); `.lightbox-nav-btn.hidden`
      sets `--lightbox-nav-shown: 0` — the class the new JS timer toggles.
  - **Root-caused before shipping, not left as a caveat — the "peekaboo"
    hover bug:** the chevron sits inside its strip's 96px zone but stacks
    above it (z-index 10 vs 0). If the chevron kept normal pointer-events,
    moving the cursor from "hovering the strip" onto the now-visible
    chevron would hand hit-testing to the chevron, which the `:hover`
    strip rule doesn't cover — the strip would lose `:hover` at the exact
    moment the user reached for the control, hiding it instantly and
    making it unclickable by mouse. Fixed by giving the chevron
    `pointer-events: none` at wide widths permanently: every click in the
    96px zone, including directly on the visible glyph, now resolves to
    the strip beneath, which already performs the identical `navigate()`
    call. Keyboard access (Tab + Enter/Space on the chevron `<button>`) is
    unaffected — `pointer-events` only gates mouse/touch hit-testing, not
    focus or synthetic click-from-keydown. Narrow keeps the chevron
    directly tappable (`pointer-events: auto`), since the timer-driven
    model has no hover state to protect.
  - **Second gap caught during live verification, not assumed away:** the
    `:has()` reveal rule, if left unscoped, has higher specificity (four
    class-equivalents) than the narrow `.hidden` class (two) — so on a
    narrow-but-mouse-capable viewport (a resized desktop browser window;
    this exact test setup), hovering the strip would pin the chevron
    visible and defeat the auto-hide timer, even though real touch devices
    never hover and would never hit this. Confirmed live, then fixed by
    wrapping the reveal rules in `@media (min-width: 481px)` so wide and
    narrow are genuinely two independent, non-overlapping designs, not
    "narrow happens to agree by coincidental default value."
  - **JS (`static/js/photoSurface/lightboxShell.js`)** — new
    `CHEVRON_AUTO_HIDE_DELAY = 1000`, `scheduleChevronHide()` (checks
    `window.matchMedia('(max-width: 480px)')` at arm-time — not
    continuously — before scheduling anything; wide never arms a timer at
    all, matching "the timer does not survive at all for mouse", not just
    "has no visible effect"), and `showChevrons()` (clears `.hidden` on
    both chevrons, then re-arms). `showChevrons()` is called once, from
    inside `refreshChrome()` — the single hook every existing call site
    (`main.js` and `shareBoot.js`, both pre-dating this plan) already
    calls right after loading a photo into the lightbox, whether that's
    the initial open or a nav-triggered swap. That one hook covers both of
    Step 6's narrow triggers ("1000ms from image load" and "any nav
    interaction resets the timer") without a second call site, since a
    successful nav interaction always ends in a new image load. No
    adapter changes needed in either surface. `hide()` now also calls the
    new `clearChevronHideTimeout()`, alongside the existing
    touch/mouse-gesture state reset, so a stray timeout can't fire after
    the lightbox has closed.
  - Rebuilt `share-viewer/` via `scripts/build-share-viewer.sh` twice (once
    per fix pass) — diffed identical to `static/` both times, not
    deployed. No share-only code anywhere in this step.
  - **Verified live** (existing dev server on :5001, no library loaded,
    forced overlay open, real mouse-driven `computer` tool input — not
    synthetic events — for every hover/click check; all state restored
    after): at 1280px, chevrons render with zero opacity by default
    (confirmed visually via screenshot — `getComputedStyle().opacity` was
    unreliable for calc()-derived values in this specific tool's JS
    introspection and was abandoned in favor of screenshots + DOM/class
    checks for the rest of this pass); hovering the left strip revealed
    the left chevron only, right stayed hidden, and vice versa on the
    right — confirmed by screenshot both ways, plus hovering neither
    hid both again. Clicking exactly on the now-visible chevron glyph
    (not just the surrounding strip) still fired `navigateLightbox(-1)`
    exactly once, confirming the pointer-events hand-off to the strip
    works and doesn't double-fire. At 390px: chevrons shown by default
    after `refreshChrome()`, both gained `.hidden` after ~1.3s (no
    `.hidden` right after refresh, present after the wait — consistent
    with the 1000ms delay), calling `refreshChrome()` again immediately
    cleared `.hidden` on both (reset confirmed), and — the specific
    regression this pass's second fix targeted — hovering the strip at
    390px with `.hidden` already present left it hidden, confirmed via
    screenshot showing no chevron rendered despite the hover. Re-confirmed
    the wide hover-reveal still worked after adding the `min-width` guard
    (not just before it). All test state (nav spy, overlay `display`,
    `state.lightboxOpen`, chevrons' `.hidden` class) restored and
    confirmed back to original values afterward.
  - Not yet done: real touch/mouse device confirmation with actual photos
    — same caveat as every step in this doc; everything above was
    real-input verification (`computer` tool hover/click) but still
    against a forced-open lightbox with no library loaded, not a genuine
    end-to-end session.
  - **Task order is now fully landed (Steps 0–6).** Remaining before this
    plan is truly done: a real-device/real-library pass (flagged as
    outstanding in every step's log above) and removing the Step 5 debug
    red-overlay markup (two `<div>`s in `lightbox.html` + one CSS rule) —
    both intentionally left for a deliberate close-out pass, not done
    inline here.

- **2026-08-25** — Real-library regression found and fixed: the exact
  "real-device pass" caveat repeated in every entry above turned out to
  be hiding a real bug, not just an unverified formality. User's repro
  (fresh server restart, incognito window, real library): edge strips
  rendered (red debug visible) but hovering revealed no chevron and
  clicking was a no-op — both Step 5 and Step 6 silently non-functional
  the moment a real photo was on screen.
  - **Diagnosis, in order:** ruled out a stale server/build first — diffed
    the actual bytes served from `:5001` against `static/` source for
    `styles.css`, `lightboxShell.js`, and `fragments/lightbox.html`
    (fetched dynamically via `loadLightbox()`, not inlined at initial page
    load — confirmed via `versionedStaticUrl`), all identical; confirmed
    the server process had genuinely restarted (new PID); confirmed
    Chrome 151 fully supports `:has()`. None of those were it. Asked the
    user to run one targeted diagnostic
    (`document.elementFromPoint()` at the strip's own center) in their
    real console rather than keep guessing blind — came back
    `IMG#.lightbox-media-element`, i.e. the photo itself was the topmost
    hit-tested element at that point, not the strip.
  - **Root cause:** `LightboxMedia.applyMediaStyles()`
    (`static/js/photoSurface/lightboxMedia.js:111,122`) sets the actual
    `<img>`/`<video>` to `position: absolute` inline, inside
    `.lightbox-media-frame` (`position: relative`, no z-index of its own).
    `.lightbox-content`, their container, had no `position` set at all.
    Per the CSS2.1 stacking spec, a non-positioned container is not a
    containment boundary — a positioned descendant with no stacking
    context anywhere between it and the nearest real stacking-context
    ancestor "bubbles up" and is painted as a direct participant of that
    ancestor's own stacking order. Here that ancestor is
    `.lightbox-overlay` itself, and the escaped media element lands in the
    same z-index:auto/0 tier as `.lightbox-edge-strip` (Step 5, explicit
    `z-index: 0`). Tied z-index falls back to DOM order, and the photo is
    inserted into the DOM after the strip — so the photo silently painted
    (and hit-tested) above it. `.lightbox-nav-btn` (z:10) and
    `.lightbox-top-chrome` (z:1) were never at risk, since positive
    z-index is a tier above this entirely — consistent with the user only
    reporting the strip as broken, not the chevrons or top bar. This is
    exactly why Steps 5–6's own testing never caught it: this environment
    has no library, so `.lightbox-content` was always empty — there was
    never anything present that could escape and cover the strip.
  - **Fix** (`static/css/styles.css`, `.lightbox-content`): added
    `position: relative; z-index: -1;`. Position is required for z-index
    to have any effect at all; the value is negative, not `0`, on purpose
    — `0` would only make `.lightbox-content` itself tie with the strip
    and lose the same way, by the same DOM-order tie-break. Negative
    places the whole now-contained subtree (frame, image, video,
    placeholder — contained regardless of their own internal
    position/z-index, since none of them can escape past this boundary
    anymore) in the stacking order's negative tier, unconditionally below
    the strip/chevrons/top-bar, with no dependency on DOM order at all.
  - Rebuilt `share-viewer/` via `scripts/build-share-viewer.sh` (not
    deployed).
  - **Verified the fix directly, not just in theory:** since this
    environment still has no real library, reproduced the exact failure
    condition synthetically — built a `.lightbox-media-frame` +
    `.lightbox-media-element` `<img>` with the identical classes, nesting,
    and inline styles `applyMediaStyles()` actually sets (not a
    simplified stand-in), inserted into `#lightboxContent`. Before
    confirming the fix, `elementFromPoint()` at the strip's center
    reproduced the user's exact symptom
    (`IMG#.lightbox-media-element` on top). After rebuilding with the CSS
    fix in place, the same check resolved to
    `BUTTON#lightboxPrevStrip.lightbox-edge-strip...`, matching the
    pre-bug expectation. Re-ran the real-mouse-input checks from the Step
    6 entry with the fake photo still present: hovering the strip revealed
    only that side's chevron (screenshot-confirmed), and clicking fired
    `navigateLightbox(-1)` exactly once. All test state (nav spy, injected
    fake media, overlay `display`, `state.lightboxOpen`, chevrons'
    `.hidden` class) restored and confirmed back to original values
    afterward.
  - **Confirmed by the user against their real library** (reload, no
    hard-refresh needed — same repro as the original report): hover
    reveals the chevron, click navigates. This regression is closed.

- **2026-08-25** — Debug overlay removed (the Step 5 close-out item flagged
  above). Deleted the two `.lightbox-edge-strip-debug` `<div>`s from
  `static/fragments/lightbox.html` and their CSS rule
  (`.lightbox-edge-strip-debug` + the `--left`/`--right` modifiers) from
  `static/css/styles.css`. Grepped both `static/` and `share-viewer/` for
  `lightbox-edge-strip-debug` afterward — the only remaining hits were in
  the (stale) generated `share-viewer/`, cleared by rebuilding. The strips
  themselves (`.lightbox-edge-strip`, functional, invisible) are
  untouched. **Verified live:** 0 `.lightbox-edge-strip-debug` elements in
  the DOM, 2 `.lightbox-edge-strip` elements still present; screenshot
  confirms no red tint at either edge; clicking the (now fully invisible)
  left strip still fired `navigateLightbox(-1)`. Test state restored
  afterward. Rebuilt `share-viewer/` (not deployed).
  - Only remaining open item from Step 5/6's close-out: a real touch
    device pass (swipe/tap), never re-confirmed since the mouse-support
    work landed.

- **2026-08-26** — Follow-on narrow-width batch, four changes landed
  together per user request (all in `static/`, rebuilt into `share-viewer/`
  byte-identical, verified live in an isolated tab — no library loaded,
  same forced-open/synthetic-event method as every prior entry):
  1. Chevron auto-hide timer 1000ms → 2000ms (later corrected to 1500ms,
     see below) — `CHEVRON_AUTO_HIDE_DELAY` in `lightboxShell.js`.
  2. Chevrons now show only the side just used after a nav interaction,
     not both — new `navigate(delta)` funnel inside `lightboxShell.js`
     (every trigger — chevron click, strip click, swipe, arrow key — routes
     through it) sets `lastNavDelta`; `showChevrons()` reveals only that
     side, both on a true initial open. See "Locked decisions".
  3. More menu (`.utilities-menu`) had no narrow-width override at all —
     frozen at desktop size (14px font / 20px icon), same bug pattern
     Step 0/1 fixed for the lightbox bar. Added to the canonical EOF
     `@media (max-width: 480px)` block: 17px font, 32px icons. Clear
     stars' two-glyph composite icon (`hide_source` + filled `star`
     stacked, not one glyph like every sibling) scaled as a unit — 32px
     container + outer glyph, inner star kept its desktop 2/3 ratio
     (13.333/20 → 21.333px) so it still reads as one icon.
  4. More-menu relocation (see "Locked decisions" above for the full
     description) — grid's `#downloadBtn`/`#editDateBtn` and the
     lightbox's inline rotate/edit-date/download hide at this breakpoint
     on the app surface; grid reuses the (previously silently-always-
     visible-regardless-of-width) `#downloadSelectedBtn` plus a new
     `#editDateSelectedBtn` — handler factored into a shared
     `openDateEditorForSelection()` in `main.js` so the app-bar button and
     the menu item aren't two implementations. Lightbox gets a new
     `#lightboxMoreBtn` + `#lightboxUtilitiesMenu`, wired via the existing
     `PhotoChrome.toggleUtilitiesMenu`/`hideUtilitiesMenu` helpers (no new
     toggle logic) and calling the same `ctx.onRotate`/`onEditDate`/
     `onDownload` the inline buttons already called. Also added
     `.utilities-menu` to `isInteractiveTarget()`'s exclusion selector —
     without it, a tap landing on the (now-present) lightbox menu's own
     padding, not on one of its buttons, would have fallen through to the
     tap-to-toggle-app-bar gesture underneath.
  - Not done this pass: this doc wasn't updated until the whole 2026-08-26
    batch (this entry + the two fixes below) landed; real touch-device
    confirmation still outstanding (same standing caveat as every entry in
    this doc).

- **2026-08-26** — Chevron regression found and fixed, from a live user
  repro: open lightbox → let chevrons auto-hide → tap left → **both**
  chevrons reappeared instead of just the left one. Also requested in the
  same pass: auto-hide timer 2000ms → **1500ms**.
  - **Root cause:** `openLightbox()` (`main.js`) calls `LightboxShell.show()`
    on *every* photo load, not only the true first open — a nav interaction
    reloads the lightbox with a new photo the same way opening it does.
    `show()` unconditionally reset `lastNavDelta = null` on every call, so
    it wiped out the direction `navigate(delta)` had just set a moment
    earlier, right before `showChevrons()` read it — every nav looked
    identical to "initial open" and showed both sides. The prior session's
    own live verification missed this because it stubbed `navigateLightbox`
    to a no-op to avoid crashing on missing photo data, which skipped the
    real re-`show()` call and hid the bug from the test itself.
  - **Fix** (`lightboxShell.js`): `show()` now tracks whether the overlay
    was already open via a new internal `isShowing` flag (set true in
    `show()`, false in `hide()`) and only resets `lastNavDelta` when this
    is a genuine open-from-closed transition, not a nav-triggered reshow.
    Self-contained inside `lightboxShell.js` — no change needed to `main.js`/
    `shareBoot.js`'s adapters, since `ctx.isOpen()` can't be used for this
    (the caller already flips `state.lightboxOpen = true` before calling
    `show()` either way, so it can't distinguish the two cases from inside
    `show()`).
  - Rebuilt `share-viewer/` (byte-identical), not deployed.
  - **Verified live** with a proper end-to-end repro this time (real
    `show()` re-invoked on nav via a stub that mimics `openLightbox()`'s
    actual call shape — `show()` then `refreshChrome()` — instead of a
    total no-op): open → both shown; wait for the real 1500ms timer to
    fire → both hidden; real click on the left chevron → only left shown,
    right stays hidden. Matches the user's repro exactly.

- **2026-08-26** — More-menu reorder bug found and fixed, from a live user
  screenshot: Download/Change-date were rendering *below* Clear stars in
  the grid's more menu, not above it as intended by the narrow-width
  `order: -2`/`-1` CSS from the batch above.
  - **Root cause:** `PhotoChrome.toggleUtilitiesMenu()` (`chrome.js`) set
    `menu.style.display = 'block'` when opening the menu. `.utilities-menu`'s
    own class already declares `display: flex; flex-direction: column` —
    but that inline style wins over any stylesheet rule regardless of
    specificity, so the menu was actually laid out as a plain block the
    instant it was shown. Flex `order` only has an effect on children of a
    flex (or grid) container; in block layout it's inert, so the two items
    silently rendered in plain DOM order (below Clear stars) even though
    their computed `order` value was correctly -2/-1 — which is exactly
    what the prior session verified and mistook for confirmation, without
    ever actually checking visual position with the menu open. Pre-existing
    bug, unrelated to the new narrow-width work — just never visible
    before because block layout and flex-column-with-default-order look
    identical until something sets a non-zero `order`.
  - **Fix** (`chrome.js`): `toggleUtilitiesMenu()` now sets
    `menu.style.display = 'flex'` (matching the class), and its own
    open/closed check updated from `=== 'block'` to `=== 'flex'` to match.
    Shared helper — the fix applies to both the grid's `#utilitiesMenu` and
    the new `#lightboxUtilitiesMenu`, one implementation. Left the same bug
    pattern in `main.js`'s `toggleUtilitiesMenu()`/`hideUtilitiesMenu()`
    fallback branches untouched and flagged only — that code path is dead
    (it only runs `if (typeof PhotoChrome === 'undefined')`, and
    `PhotoChrome` is always loaded), out of scope for this fix.
  - Rebuilt `share-viewer/` (byte-identical), not deployed.
  - **Verified live**, real page reload (the running page had the old
    `chrome.js` already parsed/executed in memory — editing the file on
    disk doesn't retroactively change a script a live page already ran, so
    the first re-check after editing still showed the bug until reloaded):
    open/close/reopen toggle still works (`display` correctly `flex` when
    open, `none` when closed); with the menu open at 375px, Download and
    Change-date now render above Clear stars (`top: 74`/`126`/`178`px
    respectively); at 1280px (desktop), order is unchanged — Clear stars
    still first, as intended (the `order` override is narrow-width only).

- **2026-08-27** — Phase 1 of the lightbox/share batch
  (`docs/lightbox-share-batch-plan.md`): edge strips removed, swipe no
  longer touches the chevrons. All in `static/`; `share-viewer/` rebuild
  deferred to the batch close-out.
  - **#2 — edge strips → concentric hit halo.** User reversed the Step 5
    decision ("changed my mind"). Removed both `.lightbox-edge-strip`
    `<button>`s from `lightbox.html`, the `.lightbox-edge-strip*` CSS, the
    `--lightbox-edge-strip-width` token, and the `els.prevStrip`/`nextStrip`
    caching + click bindings + `setNavArrows` toggles in `lightboxShell.js`.
    New `--lightbox-nav-halo-pad: 8px` (+ `--lightbox-nav-btn-edge-gap:
    20px`, factored out of the two hardcoded `left/right: 20px`). Each
    `.lightbox-nav-btn` gets a `::before` with `inset: calc(-1 *
    var(--lightbox-nav-halo-pad))` — an invisible square hit area, side =
    button + 2·pad (56px wide, 64px narrow), staying centred on the chevron
    (centre is 40px from the edge, so the halo is fully on-screen for any
    pad ≤ 20px). Base rule `pointer-events: none` → `auto` so the chevron's
    own `:hover` fires and a click through the still-invisible halo pages
    immediately. Wide reveal rewired from
    `.lightbox-overlay:has(.lightbox-edge-strip--left:hover)
    .lightbox-nav-left` to plain `@media (min-width: 481px) {
    .lightbox-nav-btn:hover { --lightbox-nav-shown: 1 } }` — still exclusive
    per side, no flicker (reveal keys off the same element the cursor sits
    on, so the old `pointer-events: none`/strip-indirection dance is
    unnecessary). `.lightbox-content`'s negative-z-index comment updated (it
    referenced the strip); the rule is kept — positive-z-index chrome
    already outranks the escaped media, but the negative tier is a
    belt-and-braces guard regardless of DOM order.
  - **#8 — swipe does nothing to the chevrons.** New module-scope
    `lastNavWasSwipe`, set by `navigate(delta, { fromSwipe })` (only the
    swipe branch of `classifyGesture` passes `true`; chevron clicks and
    arrow keys use the default `false`). `showChevrons()` returns early when
    it's set — no class change, no `scheduleChevronHide()` re-arm — so a
    swipe leaves whatever the timer was already doing untouched. Reset to
    `false` on a genuine open (alongside `lastNavDelta = null` in `show()`).
  - **Verified** (static file server, lightbox force-opened with a
    placeholder image, no backend): 0 `.lightbox-edge-strip` elements;
    `::before` halo present at ±8px inset; `elementFromPoint` across the
    halo box hits `#lightboxPrevBtn` and just outside falls through to
    `#lightboxContent`; wide — chevron invisible by default, real
    mouse-hover over the halo reveals that side only; narrow (375px) —
    chevron always shown, 48px button / 36px glyph, halo 64px. JS
    `node --check` clean. **Not verified live:** the swipe→no-chevron path
    end-to-end (needs touch events + real photo nav / backend) — traced and
    syntax-checked only. Real touch-device pass still outstanding (standing
    caveat on every entry in this doc).
  - **Follow-ups from user testing, same day:**
    1. Narrow: a tap on the hit halo must page even once the chevron has
       auto-hidden — the old edge strip stayed tappable through the
       auto-hide, the halo did not. Fix: dropped `pointer-events: none`
       from `.lightbox-nav-btn.hidden` (narrow block); the base rule's
       `auto` now carries through, and only `.inactive` kills the halo.
       Verified: `.hidden` → opacity 0 but `elementFromPoint` still hits
       the button; `.inactive` → halo inert.
    2. `[Intervention] Ignored attempt to cancel a touchend event with
       cancelable=false` spam while dragging in the lightbox on a real
       device. `onOverlayTouchEnd`'s `e.preventDefault()` is now guarded
       on `e.cancelable`. The scroll that makes touchend non-cancelable is
       the #3 bug (lightbox shouldn't scroll at all on narrow) — this only
       silences the warning.

- **2026-08-27** — Collapse the single-item lightbox more menu. The ≤480
  inline→more-menu swap (2026-08-26 entry) shipped unconditional, so
  share's lightbox got a `⋮` button opening a Download-only menu and trash
  view's got an empty `⋮`. Now gated on menu size:
  - `static/js/photoSurface/lightboxShell.js` — `applyCapabilities()`
    computes `moreMenuItemCount` from `caps.rotate/editDate/download` (the
    same gates the menu items already carry) and toggles
    `.lightbox-more-menu-active` on `#lightboxOverlay` when it is ≥2.
  - `static/css/styles.css` — the ≤480 block's inline-hide +
    `#lightboxMoreBtn { display: flex }` rules are now scoped under
    `.lightbox-more-menu-active`. Without the class: inline buttons keep
    their caps-gated state, `#lightboxMoreBtn` stays `display: none`
    (unchanged default at line ~1294). Stale "app-only override" comment
    there rewritten.
  - Library lightbox (rotate + change-date + download = 3) is unchanged —
    still uses the menu. Share (1) and trash view (0) now keep the lone
    action inline / show nothing extra.
  - Docs: `docs/share-ui-deltas.md` gains a lightbox-download bullet;
    "More menu relocation" locked decision above gets a 2026-08-27
    amendment.
  - Rebuilt `share-viewer/` via `scripts/build-share-viewer.sh`. **Not yet
    committed or deployed** — the working tree also carries a parallel
    session's in-flight changes (`lightboxMedia.js`, `shareBoot.js`,
    `main.js`), so the commit/deploy step is left to coordinate.
  - **Verified** (static server, `share-viewer/index.html`, lightbox
    force-opened + `LightboxShell.refreshChrome()`, no backend): at 375px —
    share surface: `#lightboxOverlay` has no `.lightbox-more-menu-active`,
    `#lightboxMoreBtn` computes `display: none`, `#lightboxDownloadBtn`
    computes `display: flex` (inline, `hidden=false`). Library surface:
    class present, `#lightboxMoreBtn` `flex`, inline rotate/download `none`,
    `#lightboxDownloadMenuBtn` `flex` — unchanged. `node --check` clean.
  - Not yet done: real touch-device pass (standing caveat on every entry).

- **2026-08-27** — Video playhead, narrow width. iOS Safari's native
  `<video controls>` (Liquid Glass, un-resizable, unstyleable) was showing
  in the **share** viewer because `buildShareLightboxLoadOptions`
  (`shareBoot.js`) passed `nativeVideoControls: true` — an undocumented
  break from app→share inheritance (the app has always used the custom
  transport). Feasibility of restyling the native controls: nil
  (`::-webkit-media-controls-*` is read-only on iOS). So: unify on the
  custom transport everywhere, then simplify it at ≤480px.
  - `static/js/shareBoot.js` — dropped `nativeVideoControls: true`, added
    `mountVideoControls` mounting `LightboxVideoControls` (same closure as
    `main.js`). Added `LightboxVideoControls.unmount()` in
    `renderLightboxMedia` (before the content swap) and `closeLightbox`,
    mirroring `main.js`'s teardown — share previously never needed it.
  - `static/js/photoSurface/lightboxMedia.js` — removed the now-dead
    `nativeVideoControls` option (`resolveLoadOptions` + the
    `video.controls = true` branch). Nothing sets it any more.
  - `scripts/build-share-viewer.sh` — `cp` `lightboxVideoControls.js` into
    `share-viewer/js/` and add its `<script>` tag (was app-only). Bumped
    `styles.css?v=13→14`, `shareBoot.js?v=14→15`.
  - `static/index.html` — `styles.css?v=50→51`, `lightboxVideoControls.js
    ?v=1→2`.
  - `static/js/lightboxVideoControls.js` — the stage `click` → `togglePlay`
    is gated to wide only (`matchMedia('(max-width: 480px)')`). At narrow a
    tap on the video toggles chrome (via `LightboxShell`'s recognizer), not
    playback; play/pause is the button.
  - `static/css/styles.css` (EOF ≤480 block) — new video-playhead section:
    `.lightbox-video-controls-inner` becomes a flex row;
    `.lightbox-video-controls-top-row { display: contents }` hoists play +
    mute onto that row alongside their sibling
    `.lightbox-video-progress-track` (`order: 0 / 1 / 2`); time display,
    spacer, loop, fullscreen → `display: none`; buttons 32→44px, glyph
    22→26px, track 4→6px with a taller invisible `input` hit area.
    Visibility bundling: `.lightbox-video-controls-hidden` (the desktop
    hover-model class, still toggled by the JS) is overridden inert here,
    and `.lightbox-overlay:has(.lightbox-top-chrome.hidden)
    .lightbox-video-controls-overlay { visibility: hidden }` is the only
    thing that hides the playhead — so it follows the app bar's
    show/hide/tap exactly. Wide (>480px) untouched: `:has()` rule is inside
    the media block, hover/idle model still owns visibility there.
  - `test_share_viewer_build.py` — new `test_share_uses_custom_video_transport`
    (share mounts `LightboxVideoControls`, no `nativeVideoControls` anywhere,
    the script is bundled). All 12 tests pass.
  - Rebuilt `share-viewer/` via `scripts/build-share-viewer.sh`.
  - **Verified** (static file server, standalone harness with the real
    `styles.css` + `material-symbols.css`, overlay markup from
    `createControlsOverlay`, no backend): at 375px — single row
    `[⏸ 44×44] [progress flex, h6] [🔊 44×44]`, order 0/1/2, glyph 26px;
    loop/fullscreen/time `display: none`; overlay `visibility: visible` even
    with `.lightbox-video-controls-hidden` present, flips to `hidden` when
    `.lightbox-top-chrome.hidden` is added, back to `visible` when removed.
    At 900px — `inner` block, `top-row` flex, all six controls `flex/block`,
    play 32×32 / glyph 22px, track its own full-width row below, and the
    chrome-hidden toggle has **no** effect (wide keeps its hover model).
  - **Not yet done:** real touch-device pass (standing caveat); **not
    committed or deployed** — same as the 2026-08-27 more-menu entry, the
    working tree still carries a parallel session's in-flight `enterFrom`
    fake-swipe changes (`main.js`, `lightboxMedia.js`, `shareBoot.js`), so
    commit/deploy is left to coordinate.

- **2026-08-27** — Video playhead, round 2 (all in
  `static/js/lightboxVideoControls.js`; no CSS this round — the base
  `position: absolute; bottom: 0` and last round's `:has()` visibility rule
  both carry through the new parent). Tested in Chrome DevTools mobile sim.
  1. **Playhead moved to the bottom of the frame.** Was appended to
     `.lightbox-video-stage` (the letterboxed media box), so on a landscape
     clip it floated mid-screen. New `overlayHost(stage)`: at ≤480px the
     overlay is parented to `.lightbox-content` (`stage.closest(...)`)
     instead — a `flex: 1` sibling of `.lightbox-info-panel`, so it pins to
     the true bottom of the content box and the info panel pushes it up via
     flexbox, no JS. Wide keeps it in the stage (survives
     `requestFullscreen()`; the FS button is narrow-hidden anyway).
     `unmount()` now also removes the overlay node (it used to rely on the
     caller's `innerHTML = ''`, still true, but the node can now be a direct
     child of content).
  2. **Progress ↔ actual progress.** `video.duration` on the streamed
     share MP4 is unreliable (Infinity/NaN while buffering, or a
     fragmented-moov length ≠ playable range → fill tops out partway and
     wraps there on loop). New `playableDuration(video)`: finite
     `video.duration` else `video.seekable.end(last)` else 0. All progress
     math (`renderProgress`, the scrubber seek) goes through it, and `pct`
     is clamped 0–100. `durationchange` + `seeked` added as listeners.
  3. **Smoothness.** `timeupdate` (~4 Hz) was the only tick. Added a
     `requestAnimationFrame` loop (`progressTick`/`startProgressLoop`/
     `stopProgressLoop`) that runs only while `!video.paused` — started on
     `play`, stopped on `pause`/`ended`/`unmount`. `timeupdate` stays as a
     paused-state backstop. This also closes the loop-restart gap from #2:
     the frame after the wrap reads `currentTime ≈ 0` immediately instead
     of waiting ~250 ms.
  4. **Audio defaults off.** `session.muted: false → true` (one line). Also
     the only autoplay mobile allows without a gesture. Session-scoped, so
     an explicit unmute still persists.
  - Bumped `lightboxVideoControls.js?v=2→3` (`static/index.html` +
    build script). Rebuilt `share-viewer/`.
  - **Verified** (static harness, real `styles.css`, controls mounted on a
    sourceless `<video>` in the real lightbox DOM shape): at 375px — overlay
    parented to `#lightboxContent`, full-width, bottom edge == content
    bottom; open the info panel → overlay bottom tracks the panel top
    (pushed up); shrink the frame to a 150px landscape box → overlay stays
    at content bottom, not the frame's; `.lightbox-top-chrome.hidden` still
    hides it. At 1000px — overlay parented to `#stage`, loop + fullscreen
    buttons back. Muted icon (`volume_off`) shows by default at both widths.
    `node --check` clean; ref-check clean; `test_share_viewer_build.py` 12/12.
  - **Not verified here:** the rAF smoothness / loop-wrap / duration-fallback
    behavior against a real playing video — no video fixture in this env
    (canvas-`captureStream` didn't produce a usable clip in the pane).
    Logic-reviewed only; the user is testing with a real clip in DevTools.
  - **Not committed or deployed** — same coordination caveat as the entries
    above (parallel `enterFrom` work in the tree).

- **2026-08-28** — Follow-on: narrow-width `.lightbox-video-ctrl-btn
  .material-symbols-outlined` font-size `26px → 30px`, matching
  `--app-bar-icon-glyph-size` so the play/mute glyphs read at the same
  optical size as the trash/etc. icons in the top bar (weight was already
  equal — both inherit the base `wght 200`; the play icon keeps its own
  `wght 500 / FILL 1`). `styles.css?v=51→52` (app) / `?v=14→15` (share),
  rebuilt `share-viewer/`. Verified at 375px: volume glyph computes 30px /
  `wght 200`, identical to `#lightboxDeleteBtn`'s. Round-1 of this work is
  now committed on `main` (`2096f9e`, `b6fbc8a`); round-2 + this follow-on
  remain uncommitted.

- **2026-08-28** — Follow-on: `.lightbox-video-play-icon` weight `wght 500
  → 200` (kept `FILL 1`), so the play/pause glyph stops reading heavier
  than the rest of the transport / the top-bar icons. Not width-scoped —
  the only definition of this rule, applies everywhere. `styles.css?v=52→53`
  (app) / `?v=15→16` (share), rebuilt `share-viewer/`. Still uncommitted.

- **2026-08-28** — Progress bar: duration latch (client-side, container-
  agnostic — the real fix for the jerk). Was dividing the fill by
  `playableDuration()`, which fell back to `video.seekable.end()` every rAF
  frame while the fragmented/streamed MP4 reported no total duration — a
  moving denominator, so the bar stalled / crept backward / snapped
  repeatedly, worst on a cold (uncached) load. Assessed the upstream option
  (faststart / non-`empty_moov` in `image_pixels.py`'s browser-MP4
  command): worthwhile but secondary, and doesn't cover the app's live
  streaming proxy. Did the client fix instead so correctness doesn't depend
  on the container:
  - New module state `latchedDuration` (null until known). `renderProgress`
    holds the fill at 0% + shows elapsed-only (`formatTime(currentTime)`,
    no `/ total`) while null — this is also the permanent graceful fallback
    if a duration never arrives.
  - `tryLatchDuration()` on `loadedmetadata` + `durationchange` (and once
    after `wireControls`, for already-cached sources): takes the **first**
    finite `video.duration`, latches it, and calls `renderProgress()` once
    — a single hard cut to the true current position, no catch-up sweep.
    Later `durationchange` events are ignored on purpose.
  - After latch, the rAF loop divides by the constant — the moving-
    denominator jerk is gone.
  - `playableDuration()` deleted (its `seekable.end` fallback was the bug).
    Scrubber seek + `resetTransport` now key off `latchedDuration`;
    `resetTransport` paints via `renderProgress()` instead of a blind zero
    (it also fires on `loadedmetadata`, by which point the snap may already
    have happened). `unmount()` clears the latch per video.
  - `lightboxVideoControls.js?v=3→4` (app + build script), rebuilt
    `share-viewer/`.
  - **Verified** (static harness, real 3s faststart MP4 + a forced
    `duration = Infinity` to simulate the no-metadata window; playback
    itself can't run in the hidden preview pane, so progression was driven
    by explicit seeks): unlatched with playback at 1.5s → fill `0%`, time
    `0:01`, scrubber inert; `durationchange` fires → single snap to `50%` /
    `0:01 / 0:03`; seeks to 1.5/2.85/0.02s of 3s → `50%` / `95%` / `0.67%`
    (clean loop-wrap, no mid-jump); `unmount()` clears the latch. `node
    --check` + `test_share_viewer_build.py` 12/12.
  - **Not verified:** real continuous playback smoothness (hidden pane
    suspends `<video>`); the user is testing in DevTools. Upstream
    faststart change not done — tracked as the follow-up optimization.
  - Still uncommitted (on top of committed round 1).

- **2026-08-28** — Progress bar: latch on a *final* duration, not the first
  finite one. The previous entry's "first finite value" was wrong for the
  fragmented MP4 this pipeline serves — `video.duration` can report a small,
  still-growing finite value mid-download, and latching it made the fill
  race to 100% within a second or two and pin there. Fix in
  `lightboxVideoControls.js`:
  - `durationIsFinal(video)` — finite `duration` AND the media is fully
    loaded: `buffered.end(last) >= duration - 0.25`, or
    `networkState === NETWORK_IDLE (1)`. `tryLatchDuration` now gates on
    this; also wired to `progress` + `canplaythrough` (not just
    `loadedmetadata`/`durationchange`) so it re-checks as the buffered
    range grows. Until final, the fill stays at 0 + elapsed-only readout
    (unchanged fallback). For these short clips "fully buffered" is a
    fraction of a second.
  - Monotonic display clamp — `maxPct` tracks the highest fill % shown in
    the current play-through; `renderProgress` renders `max(maxPct, raw)`
    so a stray late correction can only stall the bar, never rewind it.
    Reset when `currentTime` jumps back > 0.25s (loop wrap / backward seek —
    covers both uniformly) and on each latch. Reset in `unmount()`.
  - `lightboxVideoControls.js?v=4→5`, rebuilt `share-viewer/`.
  - **Verified** (static harness, real 3s clip + stubbed
    `duration`/`buffered`/`networkState`): finite `duration=0.4` with
    `buffered` empty → does **not** latch, fill held at 0; buffered reaches
    duration / `networkState` idle → latches, snaps to position. Seeks
    1.5→2.7→0.6→0.03s of 3s → `50% → 90% → 20% → 1%` (forward tracks up,
    backward jump resets the ceiling so the bar follows down — the
    loop-wrap case). Remount on a cached clip re-latches immediately via the
    post-`wireControls` check. `node --check` + tests 12/12.
  - **Not verified:** continuous playback (hidden pane suspends `<video>`) —
    DevTools test covers it. Still uncommitted.

- **2026-08-28** — Progress-bar bug **still open**, work handed off.
  `durationIsFinal` (buffered/networkState gate) still latches a too-small
  duration on the app's **streamed proxy path** (`_browser_video_proxy_response`
  → fragmented `empty_moov` MP4, no Content-Length) — `networkState` toggles
  to idle under backpressure and `buffered.end` transiently equals the
  partial-and-growing `duration`. Confirmed not-affected: any static-file
  video path (all share videos; app browser-direct H.264). Repro needs a
  real library with an iPhone `.mov`/HEVC clip — not available this session,
  so the streaming path was never exercised directly.
  **Full handoff + recommended fixes in `docs/video-playhead-handoff.md`**
  (fix A: client self-healing lower-bound latch; fix B: drop `empty_moov`
  from `FRAGMENTED_MP4_MOVFLAGS`; fix C: cached faststart proxy artifact).
  Everything above **shipped + deployed** — photos-light `120df80` +
  `bb56958`, share Pages repo `f5fcc2e`. The open bug is not a regression
  (that one path degrades to ~the old behaviour).

- **2026-08-28** — Swipe-nav black flash on an un-prefetched photo. On a
  narrow h-swipe to a photo not yet in `LightboxMediaCache`, the sliding
  frame showed the black `#000` overlay for a frame or two before the photo
  appeared, instead of the gray placeholder. Root cause in
  `LightboxMedia.loadStillImage`'s `revealImage`: it removed the placeholder
  and appended the `<img>` in one step with no wait for rasterization — and
  for an HTTP-cached image the synchronous `img.complete` branch removed the
  placeholder before it had ever painted, so `animateFrameEntry` slid an
  empty frame.
  - **Fix** (`lightboxMedia.js`): the `<img>` now mounts *over* the
    still-present placeholder; the placeholder is removed only once
    `img.decode()` resolves (`requestAnimationFrame` fallback for
    no-`decode()` / decode rejection on interrupted nav). Gray box rides the
    entry slide, photo hard-cuts in over it whenever ready (mid-animation or
    after) — no fade, matches the existing pop. `revealed` guard added since
    the reveal now schedules async work and can be entered twice
    (`onload` + the sync `complete` check).
  - Shared module → share inherits it. `loadCachedStill` (decoded happy
    path) and the video path (own gray bg until `loadeddata`) untouched.
    New section "Swipe-nav on an un-prefetched photo — gray box, not black".
  - **Verified:** `node --check`; full share-viewer e2e suite 23/23 (covers
    lightbox open, media element visibility, info-panel relayout). **Not
    verified on-device** — no library available in this session's preview;
    the sync `img.complete` path is exercised by the e2e data-URI pixels,
    the network-load path is not.
  - **Uncommitted, not deployed.** Working tree also carries a parallel
    session's unrelated WIP (`static/css/styles.css`, `static/index.html`,
    `static/fragments/appBar.html`, `static/js/main.js`,
    `static/js/photoSurface/appBarLayout.js`) — the test run's
    `build-share-viewer.sh` regenerated `share-viewer/` on top of that WIP,
    so `share-viewer/` is dirty beyond this change. Deploy this from a clean
    worktree of the target commit once it lands.
