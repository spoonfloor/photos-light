# Lightbox + share batch — cross-agent work plan

Nine changes to the lightbox, the share app bar, the ≤480 overlay, and one CSS
token. This doc is the single source of coordination so parallel agents don't
collide. Read it fully before claiming an item.

/ Created 2026-08-27. Owner: designer (scroll550). Decisions below are **locked**
— do not relitigate scope; if something looks wrong, flag it in chat, don't
freelance.

---

## How to use this doc

1. **Claim** an item by putting your session id + date in the Status table.
   Claim a whole **phase** if the items share files (see Conflict zones).
2. Work only inside your claimed scope. If you need to touch a file another
   claim owns, coordinate in chat first.
3. When done, fill the DoD checkbox, note the commit, and — if the change is
   share-affecting — mark it "needs share rebuild" (do **not** rebuild yet).
4. **One** agent runs the share-viewer rebuild + deploy at the very end, after
   every share-affecting item is merged. See Close-out.

## Status

| # | Item | Phase | Scope | Claimed by | State |
|---|------|-------|-------|-----------|-------|
| 2 | Remove edge strips → concentric halo | 1 | app+share, all widths | session 0306 (2026-08-27) | source done, needs share rebuild |
| 8 | Swipe no longer flashes chevron | 1 | app+share, narrow | session 0306 (2026-08-27) | source done, needs share rebuild |
| 3 | Lightbox fully contains the grid | 2 | app+share, narrow | session 0f18 (2026-08-27) | source done, needs share rebuild |
| 4 | Info panel: date only, tighten gap | 3 | share, all widths | — | not started |
| 9 | Info panel: 4 tuning vars | 3 | app+share, narrow | — | not started |
| 1 | Shared text-inset token = 2px | 4 | share, narrow | — | not started |
| 5 | Share download button stuck disabled | 5 | share, all widths | — | not started |
| 7 | Clear-selection CTA also hides overlay | 6 | app+share, narrow | — | not started |
| 6 | Share header dead-space hides overlay | 6 | share, narrow | — | not started |

---

## Ground rules

- **App → share inheritance** (`.claude/rules/app-share-inheritance.md`): share is
  the app with a read-only boot. Fix shared modules under `static/`, never
  hand-edit `share-viewer/`. Use `viewCapabilities.js` / documented share checks
  for anything that must differ — not a parallel implementation.
- **Single source of truth** (see the table in that rule file): CSS →
  `static/css/styles.css` (+ `share-overrides.css` only for documented share
  deltas); grid/lightbox/chrome → `static/js/photoSurface/*`; share boot →
  `static/js/shareBoot.js`; HTML → `static/fragments/*`.
- **Quality bar** (`~/.claude/CLAUDE.md`): fix it the way a talented dev would
  with full hindsight. No smallest-patch shortcuts. Match surrounding style.
- **Definition of Done**: every item below states observable behavior that
  proves it works. For the two bug items (#3, #5) reproduce first, confirm gone
  after, say what you checked.
- **"narrow" = ≤480px** everywhere in this batch (matches `docs/lightbox-480-plan.md`
  and recent commits). There is no other breakpoint in play.

## Docs to update as you go

- **#2 / #8** → `docs/lightbox-480-plan.md`: Step 5 (edge strips) is removed;
  Step 6 (chevron reveal) changes to halo/chevron `:hover`.
- **#4** → `docs/share-ui-deltas.md`: add "Lightbox info panel shows Date only
  (no filename)" under **Share-only behavior** / **Lightbox**.

---

## Phase sequence & dependencies

```
Phase 1  #2 ──▶ #8          lightbox nav teardown (one code area)
              │
Phase 2  #3 ◀─┘              overlay containment (depends on strips gone)

Phase 3  #4 ──▶ #9          info panel: content first, then tokenize

Phase 4  #1                 CSS token only — independent, run any time

Phase 5  #5                 share boot bug — independent, run any time

Phase 6  #7 ──▶ #6          overlay dismissal: action first, then tap surface
```

- **#2 before #8** — both live in the `navigate()` funnel + chevron visibility
  CSS. #2 rebuilds the reveal mechanism; #8 is then a small deletion from the
  rebuilt version, not a second untangle of `lastNavDelta`.
- **#2 before #3** — #3's "clean backdrop owns scroll-lock + tap-to-close" is
  only coherent once the full-height strips are gone.
- **#4 before #9** — change what the panel contains, then parameterize what's
  left. Don't tokenize markup you're about to edit.
- **#7 before #6** — #7 wires "hide overlay" onto the shared clear-selection
  control; #6 extends the tap surface to reach it.
- **#1 and #5** depend on nothing. Fit them wherever.

---

## Conflict zones (do not run these in parallel)

| Region | Items | Note |
|--------|-------|------|
| `photoSurface/lightboxShell.js` — `navigate()` / chevron reveal / `lastNavDelta` | 2, 8 | claim as one phase |
| `photoSurface/lightboxShell.js` — info panel wiring (`els.infoFilename`, `formatInfo`) | 4, 9 | claim as one phase |
| `styles.css` — lightbox nav block (~L1580–2050) | 2, 8 | same as above |
| `styles.css` — info panel block (~L1512–1566) | 4, 9 | same as above |
| `styles.css` — `.month-header` / ≤480 media block (~L990, ~L3805) | 1 | isolated once claimed |
| `share-overrides.css` — `.share-page-title` (L17) | 1 | isolated |
| `shareBoot.js` — app bar wiring | 5, 6, 7 | 5 is isolated to download state; 6/7 touch select/overlay — serialize 6/7 after 5 or coordinate |
| shared select-mode (`gridSelection.js`, `photoSurface/chrome.js`) | 6, 7 | claim as one phase |
| `static/fragments/lightbox.html` | 2 (strips), 4 (filename row) | small edits, coordinate if overlapping |

---

## Item specs

### #1 — Shared text-inset token, narrow = 2px
**Scope:** share, narrow. **Phase 4.**

Today at ≤480: the share album title (`.share-page-title`, `share-overrides.css:17`)
sits flush at 0 because `.page-wrapper { padding-inline: 0 }` at that breakpoint;
the date headers sit at 16px via `.grid-root .month-header-band { padding-inline:
16px … }` (`styles.css` ≤480 block, ~L3813). Two unrelated values.

**Do:**
- Define one var in `styles.css` (e.g. `--narrow-text-inset: 2px`) — it is
  consumed by date headers (app + share), so it lives in the shared file, not
  `share-overrides.css`.
- Point the ≤480 `.month-header-band` left padding at `var(--narrow-text-inset)`.
- Add a ≤480 rule for `.share-page-title` in `share-overrides.css` setting its
  left padding to `var(--narrow-text-inset)`. (Title is share-only chrome →
  the override file is correct here; only the *value* is shared.)
- No hardcoded second `2px`. If you write `2px` twice, you've done it wrong.

**DoD:** At ≤480, the share title's left edge and every date header's left edge
are identical and sit 2px from the viewport edge. Changing the one var moves
both. App (non-share) date headers at ≤480 also move to 2px — that is expected
and accepted.

---

### #2 — Remove edge strips, add concentric halo
**Scope:** app + share, all widths. **Phase 1 (with #8).**

Today each lightbox side has a 96px full-height invisible strip
(`--lightbox-edge-strip-width`, `.lightbox-edge-strip--left/--right` in
`lightbox.html` + `styles.css`). It does two jobs: (a) a wide click target for
prev/next, (b) the **only** trigger that reveals the chevrons on wide
(`.lightbox-overlay:has(.lightbox-edge-strip--left:hover) .lightbox-nav-left`).

**Do:**
- Delete the strip elements, their click handlers in `lightboxShell.js`, the
  `:has()` reveal rules, and `--lightbox-edge-strip-width` (+ the z-index
  workaround comments tied to the strip, ~`styles.css:1317`).
- Give each chevron a concentric square halo hit target, side = chevron button
  size + `2 * n`. Chevron button is 40px at `left/right: 20px` → center is 40px
  from the edge, so any `n ≤ 20` fits with margin. Expose `n` as a CSS var
  (`--lightbox-nav-halo-pad`, default 8 → 56px square). Halo shares the
  chevron's center; do not offset it.
- Rewire wide-width chevron reveal to `:hover` of the halo (≈ hovering the
  chevron). Narrow has no hover — chevron visibility there stays on the JS
  timer / `.hidden` path (and see #8).
- The halo treatment is identical at all widths.

**DoD:** No full-height dead zone on either side at any width. On desktop,
hovering within ~8px of a chevron reveals it and clicks page; the rest of the
overlay is inert backdrop. On narrow, tapping the halo pages; tapping elsewhere
on the backdrop does not.

---

### #8 — Swipe no longer flashes a chevron
**Scope:** app + share, narrow. **Phase 1 (after #2).**

The `navigate()` funnel sets `lastNavDelta` on every nav trigger (chevron, strip,
swipe, arrow) and briefly reveals the used side's chevron. Swipe should page the
photo but do nothing to chevron visibility.

**Do:** In the post-#2 `navigate()` / reveal logic, drop the swipe branch from
the chevron-reveal path only. Swipe still navigates. Click and arrow-key nav may
still briefly reveal the chevron (confirm with owner if in doubt — current
answer: leave click/arrow reveal as-is).

**DoD:** On narrow, swiping left/right in the lightbox changes photo with no
chevron appearing at any point. Arrow-key / tap nav unchanged.

---

### #3 — Lightbox fully contains the grid
**Scope:** app + share, narrow. **Phase 2 (after #2).**

Repro (iPhone Safari, narrow): open a photo → the grid peeks below the bottom
browser chrome; the lightbox shows a scrollbar; a scroll gesture leaks to the
grid page; the peek disappears after you scroll. This is shared lightbox code,
not a share-only path — fix once in `static/`.

**Do:** Make the lightbox overlay a full, opaque containment layer at ≤480:
scroll-lock the body, remove the internal scrollbar, stop touch-move / scroll
propagation to the grid, ensure the backdrop covers past the safe-area / browser
chrome. Coordinate with #2 — the cleaned-up backdrop (no strips) is what owns
this.

**DoD:** On iPhone Safari at ≤480, opening a photo covers the grid completely
with no peek (before scroll, after scroll, during rubber-band). No scrollbar in
the lightbox. Dragging vertically on the photo does not scroll the grid
underneath. State the device/OS you verified on.

---

### #4 — Info panel: date only, tighten label→value gap
**Scope:** share, all widths. **Phase 3 (with #9).**

Today the panel shows a filename row and a date row. `.info-label` has
`min-width: 80px; margin-right: 12px` — "Date:" is ~40px wide, so ~40px of dead
space sits before the value.

**Do:**
- In share, render only the Date row — no filename row. Gate via a share check /
  capability, not a forked panel. App keeps its current rows.
- Kill the oversized gap: drop `.info-label { min-width: 80px }` (or size it to
  content) so it reads `Date: Aug 1, 1969 at 5:00 AM` with a normal single
  space / small margin. Applies to the panel generally (harmless in app).

**DoD:** In share (wide and narrow), the info panel shows exactly one row,
`Date: <formatted date>`, with the value immediately after the label. No
filename anywhere in the panel. App info panel unchanged in content.

**Doc:** add the delta to `docs/share-ui-deltas.md`.

---

### #9 — Info panel: 4 tuning vars, seeded to toast
**Scope:** app + share, narrow. **Phase 3 (after #4).**

Introduce CSS vars on the lightbox info panel so the look can be dialed in. Seed
each to the stated reference value; owner will iterate on the numbers.

| Knob | Current | New var → seed |
|------|---------|---------------|
| Font size (label + value share it) | `.info-label` / `.info-value` both `14px` | `--lightbox-info-font-size` → `var(--modal-body-size)` (15px, = `.toast-message`) |
| Panel height | `.lightbox-info-panel { padding: 20px 28px }`, no set height | `--lightbox-info-panel-pad-y` → `16px` (toast's vertical padding; toast has no fixed height — match its padding) |
| Background | `.lightbox-info-panel { background: rgba(0,0,0,0.95) }` (already near-black) | `--lightbox-info-panel-bg` → near-black (keep `rgba(0,0,0,0.95)`; **not** the toast's `#2d2d2d` grey — owner said "near black") |
| Close-X glyph size | `.info-close-btn .material-symbols-outlined { font-size: 20px; font-weight: 200 }` | `--lightbox-info-close-size` → `18px` (weight `300`), matching `.toast-close-btn` |

The `.info-close-btn` already sits top-right at 8px/8px like `.toast-close-btn`.
The "most analogous close X in the same context" is the toast's — it's the same
`close` glyph in the same top-right transient-panel role.

**Do:** Wire all four as vars, scoped so they apply on both surfaces at narrow.
Label and value must read the *same* font-size var.

**DoD:** At ≤480, the info panel renders at 15px text, ~16px vertical padding,
near-black background, 18px close glyph. Overriding any single var visibly
changes only that dimension.

---

### #5 — Share download button stuck disabled
**Scope:** share, all widths. **Phase 5.**

Repro: open any share → the app-bar download button is greyed/inert. Make a
selection → still inert. `#downloadBtn` ships `class="app-bar-icon-button
inactive"` in the shared `static/fragments/appBar.html`. The app clears it in
`updateAppBar` (`main.js:~1859`, toggles on `selectedPhotos.size`).
`shareBoot.js` never clears it. Share's `resolveDownloadTargets()`
(`shareBoot.js:676`) already handles both cases (no selection → whole album,
selection → selected).

**Do:** In `shareBoot.js`, manage `#downloadBtn` enabled state: active on load
(download = whole album), and keep it active / reflect selection the way the app
does. Don't duplicate `updateAppBar` — factor or reuse if clean, otherwise a
small share-side toggle mirroring the app's rule.

**DoD:** Open a share → download button is enabled and downloads the whole
album. Select photos → still enabled, downloads the selection. Deselect all →
still enabled, back to whole album. Verify at wide and narrow.

---

### #7 — Clear-selection CTA also hides the overlay
**Scope:** app + share, narrow. **Phase 6 (before #6).**

The ≤480 select-mode overlay currently exits via deselect-all only when there is
a selection (`gridSelection.js:~159` — "Deselect all is also the way out of the
≤480 select mode"). Owner wants the clear-selection app-bar control to also
dismiss the overlay when nothing is selected.

**Do:** Make the shared clear-selection / deselect-all control perform
"hide overlay + exit select mode" even at zero selection. Shared behavior
(`gridSelection.js` / `photoSurface/chrome.js`), applies to app and share.

**DoD:** At ≤480, enter select mode, select nothing, tap the clear-selection
app-bar button → select mode exits and the overlay hides. With a selection it
still clears + exits as today.

---

### #6 — Share header dead-space hides the overlay
**Scope:** share, narrow. **Phase 6 (after #7).**

At ≤480 in share: in select/overlay mode, tapping blank space to the right of a
date header dismisses the overlay (good). Tapping right of the share title, the
gap above the title, or blank space right of the filter chips does **not**
(bad). Those regions are share-only chrome (`.share-page-title`, the chip rail).

**Do:** Extend the "tap dead space to dismiss overlay" hit-testing to cover the
share header band — title row, the area above it, and the chip-rail gutter —
reusing the same dismissal path #7 establishes. Share-only surface, so this can
live in `shareBoot.js` / share chrome wiring, but call the shared dismiss
action, don't reimplement it.

**DoD:** At ≤480 in share, in overlay mode, a tap on any non-interactive part of
the header (right of title, above title, right of chips) hides the overlay, same
as tapping beside a date header. Taps on the title text, chips, and app-bar
buttons still do their normal thing.

---

## Close-out (one agent, after every item is merged)

1. Confirm `docs/lightbox-480-plan.md` and `docs/share-ui-deltas.md` are updated
   (#2/#8, #4).
2. `./scripts/build-share-viewer.sh`
3. `./scripts/deploy-share-viewer.sh`
4. Do **not** hand-edit anything under `share-viewer/`.
5. Smoke test share at wide and ≤480: download button, info panel, lightbox
   containment, overlay dismissal, halo nav, title/date-header alignment.
