# Lightbox @ 480px breakpoint — tracking doc

Status: **in progress** (Steps 0–2 done; Step 3 up next). Update the
checkboxes and append to the session log as work lands, so any new agent
session can pick this up cold.

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
- Edge nav strips: **96px** wide, full height, one per side.
- Debug aid: strips get a visible red overlay while sizing is dialed in —
  must be trivial to flip off before ship (flag/class, not baked in).
- **App bar never auto-hides.** No timer applies to it. It shows/hides only
  on an explicit tap of an unclaimed area (Step 4) — a manual toggle, not a
  fade-on-idle.
- **Arrow auto-hide timer applies only to the chevrons**, independent of the
  app bar's state. Delay: **1000ms** from image load. Any nav interaction
  (arrow tap or strip tap) resets the timer and re-shows the arrows. (Update
  2026-08-25: originally scoped as one shared timer for bar + arrows —
  split per user direction, see session log.)

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

## Explored & rejected

- **Filmstrip-style interactive swipe transition** — would require live 1:1
  drag tracking, pre-mounted/pre-laid-out neighbor images (not just
  pre-decoded), velocity-based commit/cancel physics, gesture-interruption
  handling, and a call on whether arrow-button nav should match the drag
  style. Estimated an order of magnitude more work than a hard cut, touching
  `lightboxMedia.js` layout and `lightboxMediaCache.js` preload logic. User
  explicitly deferred this — hard cut only, for now.

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
- [ ] **3. Swipe down → exit to grid** (same gesture recognizer as #2)
- [ ] **4. Tap unclaimed area → toggle app bar** (no-movement case of the
      same recognizer; anything hitting a registered interactive element is
      excluded automatically). App bar only — no timer, no effect on
      chevron visibility.
- [ ] **5. Edge nav strips** — 96px, full height, red debug overlay,
      registered as interactive elements so #4 excludes them for free
- [ ] **6. Arrow auto-hide** — 1000ms from image load, resets on any nav
      interaction (arrow tap or strip tap). Chevrons only, runs independent
      of app bar state/visibility.

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
