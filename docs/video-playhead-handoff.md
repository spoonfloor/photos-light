# Video playhead — handoff

**Status:** narrow-width custom playhead shipped + deployed (photos-light
`120df80` + `bb56958`; share Pages repo `f5fcc2e`). The "finishes prematurely"
bug is **fixed via Fix A** (growing lower-bound duration, below) — committed,
pushed, and deployed (`lightboxVideoControls.js?v=6`; photos-light `92aa39e` +
`55eeada`; share Pages repo `7f1bc61`). Verified by logic sim only; still wants
a real-device pass on the streamed proxy path, and first-play motion still
steps/plateaus during the unknown window (smooth first play needs a
server-supplied duration — see Fix B / the ffprobe-header note).

Owner context: this grew out of the lightbox-480 batch
(`docs/lightbox-480-plan.md` — see the 2026-08-27/28 session-log entries for
blow-by-blow). This doc is the self-contained pickup point.

---

## What shipped (working, verified)

All in `static/js/lightboxVideoControls.js` + a bit of `static/css/styles.css`,
inherited by share via `scripts/build-share-viewer.sh` (rebuilt).

1. **Share uses the custom transport, not native `<video controls>`.**
   `shareBoot.js` was passing `nativeVideoControls: true` (undocumented
   app→share break). Now mounts `LightboxVideoControls` like the app; the
   dead `nativeVideoControls` option is gone from `lightboxMedia.js`;
   `build-share-viewer.sh` bundles `lightboxVideoControls.js`. *(This part is
   already committed — `2096f9e`.)*

2. **Narrow-width (≤480px) playhead = iOS-Photos-style single row:**
   `play/pause · progress · mute`, no loop/time/fullscreen, no glass capsule
   (flat bottom scrim kept). CSS in the EOF `@media (max-width: 480px)` block.
   `.lightbox-video-controls-top-row { display: contents }` hoists play+mute
   onto one flex line with the progress track.

3. **Playhead bundled with the app-bar chrome at ≤480px.** Both show on open,
   hide together on the unclaimed-area tap
   (`LightboxShell` gesture recognizer → `.lightbox-top-chrome.hidden` →
   `.lightbox-overlay:has(.lightbox-top-chrome.hidden) .lightbox-video-controls-overlay { visibility: hidden }`).
   Tap-on-video toggles chrome, not play/pause, at this width. Desktop keeps
   its hover/idle model untouched.

4. **Playhead parented to `#lightboxContent` (not the media box) at ≤480px**
   via `overlayHost()` — sits at the true bottom of the frame, and the info
   panel pushes it up via flexbox. Wide keeps it in `.lightbox-video-stage`
   (survives `requestFullscreen()`; FS button is narrow-hidden anyway).

5. **Audio defaults off** — `session.muted: true` (also the only autoplay
   mobile allows without a gesture).

6. **Icon sizing/weight parity** — narrow `.lightbox-video-ctrl-btn`
   glyphs 30px (matches `--app-bar-icon-glyph-size`); `.lightbox-video-play-icon`
   weight `500 → 200` (`FILL 1` kept).

7. **Smooth progress** — `requestAnimationFrame` loop
   (`startProgressLoop`/`progressTick`) while playing, replacing the ~4 Hz
   `timeupdate`-only updates.

8. **Duration latch** (the part with the open bug — see below).

---

## THE OPEN BUG: progress bar finishes prematurely

### Symptom
The fill animates smoothly to 100% within a second or two of playback start,
then sits pinned at 100% for the rest of the (looping) clip. Reported still
happening in Chrome after `?v=5`, server restart, and hard refresh.

### Root cause (established)
The pipeline serves **fragmented MP4** with `empty_moov`
(`FRAGMENTED_MP4_MOVFLAGS = "frag_keyframe+empty_moov+default_base_moof"`,
`image_pixels.py`). Such a stream has **no declared total duration**;
Chrome's `video.duration` is `NaN`/`Infinity` at first, then can report a
**small, still-growing finite value** as it reads fragments. Dividing the fill
by that moving value makes it race to 100% early.

### What's been tried (in `lightboxVideoControls.js`)
- **v1 latch:** latch the *first* finite `video.duration`, ignore later
  `durationchange`. → Bar raced to 100% (latched e.g. 0.4s).
- **v2 latch (current code):** only latch when duration is **provably final** —
  `durationIsFinal(video)`: `Number.isFinite(duration) && duration > 0 && (buffered.end(last) >= duration - 0.25 || networkState === NETWORK_IDLE)`.
  Plus a **monotonic clamp** (`maxPct`) so the displayed % can only stall,
  never rewind; reset on `currentTime` regression (loop-wrap / backward seek).
  → **Still finishing early per the user.**

### Why v2 still fails (hypothesis, NOT yet reproduced here)
The bug only reproduces on the **app's streamed proxy path**:
`/api/photo/<id>/file` → `needs_browser_video_proxy()` true (iPhone `.mov`,
or HEVC) → `_browser_video_proxy_response()` → `Response(generate())` with
**no `Content-Length` and no range support**, chunked from ffmpeg stdout.

On that stream, both arms of `durationIsFinal` are unreliable:
- `networkState` can transition to `NETWORK_IDLE (1)` mid-stream when Chrome's
  media buffer fills and it stops pulling (backpressure), then back to
  `LOADING`. So "idle" ≠ "download complete".
- `buffered.end(last)` can momentarily equal the current *partial, growing*
  `duration` — both wrong together.

So `durationIsFinal` returns true with a too-small `duration`, we latch it,
and the clamp can't help (the bar still legitimately reaches 100% against the
small denominator).

### Confirmed NOT affected
- **Static file serving** (browser-direct H.264 in the app; all share videos —
  `video_native` and `video_transcode` both upload to storage and are served
  as static files with range). Verified in a harness: a fragmented
  `empty_moov` MP4 served statically → Chrome gets `duration` fine via
  `durationchange` almost immediately. The bug needs the Content-Length-less
  stream.

### Repro requirements for the next agent
You need a **real library with an iPhone `.mov` (or HEVC) video** so the
app hits `_browser_video_proxy_response`. This session had no library, so the
streaming path was never exercised directly — everything was verified against
static test clips + stubbed `duration`/`buffered`/`networkState`.
Diagnostic: log `video.duration`, `video.buffered.end(last)`,
`video.networkState`, `video.readyState` on every `progress`/`timeupdate`
during a premature-finish playback and watch how `duration` grows.

---

## Recommended fixes (in priority order)

### A. Client: self-healing latch — ✅ DONE (working tree, `?v=6`, uncommitted)
`durationIsFinal` / `tryLatchDuration` / the `networkState` gate are gone.
`latchedDuration` → `estimatedDuration`, a monotonic **growing lower bound**
grown by `noteDuration()` from `max(seen finite video.duration, currentTime +
0.5)` on every `timeupdate` / `durationchange` / rAF tick. `sawRealDuration`
gates the "/ total" readout so an estimate that's really just the playhead
shows elapsed-only. `maxPct` clamp + loop-wrap reset kept. Logic-sim checked
(30s clip, `video.duration` growing 2.2× ahead of playback → bar plateaus
mid-range during the unknown window, tracks accurately once real duration
known, never pins at 100%; loop-wrap pass is exact). **Still unverified on a
real streamed-proxy video** — do that pass.

Original sketch, for reference:
Make `latchedDuration` a **growing lower bound**, not a one-shot:
```
on loadedmetadata/durationchange/progress/timeupdate:
  if Number.isFinite(video.duration):
    latchedDuration = max(latchedDuration ?? 0, video.duration, video.currentTime + ε)
```
- `pct = currentTime / latchedDuration` can never exceed ~100% because
  `latchedDuration >= currentTime` always → **no premature finish**.
- The existing monotonic `maxPct` clamp absorbs the "latchedDuration grows"
  direction → the bar stalls near its current position rather than jumping
  back, then resumes tracking once the real duration is known.
- Keep the "hold at 0 until first finite value" behaviour for the initial
  unknown window (still correct).
- Drop `durationIsFinal` / the `networkState` gate — the lower-bound approach
  doesn't need "is it final", it's correct at every intermediate value.

Trade-off: during the unknown window the bar advances *slower than real* (it's
dividing by an over-estimate that's really just `currentTime`), then eases to
correct. That's the accepted look for unknown-duration playback and is far
better than finishing early.

### B. Server: drop `empty_moov` from the streamed proxy (clean, small — needs testing)
`FRAGMENTED_MP4_MOVFLAGS` → try `"frag_keyframe+default_base_moof"` (no
`empty_moov`). ffmpeg knows the input's real duration, and a fragmented-MP4
`moov` carries no sample tables (those live in per-fragment `moof`), so it
*should* be able to write a populated `mvhd`/`mehd` duration up front even to a
pipe. ffprobe confirms such files carry the right duration; **whether Chrome
reads it from a Content-Length-less chunked stream at `loadedmetadata` is
untested** — verify in the real app. If it works, this fixes it at the source
and Fix A becomes belt-and-braces.
Touch: `image_pixels.py` `FRAGMENTED_MP4_MOVFLAGS`; re-run
`test_video_playback.py` (asserts on `iter_browser_mp4_chunks` /
`browser_mp4_ffmpeg_command`).

### C. Server: cache a faststart proxy MP4 as a derived artifact
The "central cleaning / import" option assessed in the 2026-08-28 session log.
Generate + cache a browser-playable faststart MP4 per video (like a thumbnail);
serve it static with range. Both surfaces then get a real duration and no
per-view ffmpeg. Medium effort — dominated by the `library_cleanliness.py`
audit-check + `make_library_clean_v2.py` backfill-repair + HEVC transcode
policy, not the import hook. Only worth it if the live proxy is a broader
UX/perf problem, not just this bug.

**Don't** blind-remux original library videos in place — changes every
`content_hash`, churns dedup.

---

## Shipped in

- `photos-light` `120df80` — source (`lightboxVideoControls.js`, `styles.css`,
  `index.html`, `build-share-viewer.sh`, this doc, plan-doc log)
- `photos-light` `bb56958` — regenerated `share-viewer/`
- `photos-light-sharing` `f5fcc2e` — deployed to GitHub Pages

## Files touched this session

| File | Change |
|---|---|
| `static/js/lightboxVideoControls.js` | items 2–8 above; the latch is the WIP |
| `static/css/styles.css` | ≤480 video-playhead block; icon size 30px; play-icon weight 200 |
| `static/index.html` | `styles.css?v=53`, `lightboxVideoControls.js?v=5` |
| `scripts/build-share-viewer.sh` | bundle `lightboxVideoControls.js`; `styles.css?v=16`, `shareBoot.js?v=15`, `lightboxVideoControls.js?v=5` |
| `share-viewer/**` | regenerated (`./scripts/build-share-viewer.sh`) |
| `docs/lightbox-480-plan.md` | session-log entries |

Deploy cadence when this lands: commit `static/` → `./scripts/build-share-viewer.sh`
→ commit regenerated `share-viewer/` → `./scripts/deploy-share-viewer.sh`.
Bump `?v=` on any changed asset.

## Key code map

- `static/js/lightboxVideoControls.js`
  - `durationIsFinal()` / `tryLatchDuration()` / `latchedDuration` — the latch (WIP)
  - `renderProgress()` — the one place the fill/scrubber/time are written; `maxPct` monotonic clamp
  - `progressTick()` / `startProgressLoop()` / `stopProgressLoop()` — rAF loop
  - `overlayHost()` — narrow vs wide overlay parent
  - listeners wired in `wireControls()`
- `static/js/photoSurface/lightboxMedia.js` — `loadIntoContent()` video branch calls `resolved.mountVideoControls(stage, video)`; also fires `resetTransport` on `loadedmetadata`
- `static/js/main.js` ~6700 (`buildLightboxLoadOptions`) + `static/js/shareBoot.js` ~493 (`buildShareLightboxLoadOptions`) — the two `mountVideoControls` adapters
- Server: `image_pixels.py` `browser_mp4_ffmpeg_command` / `FRAGMENTED_MP4_MOVFLAGS` / `needs_browser_video_proxy`; `app.py` `_browser_video_proxy_response` (~2083); `share_delivery.py` `plan_share_delivery`
- Tests: `test_share_viewer_build.py` (12, passing), `test_video_playback.py` (server remux)

## Verification method note
The Browser pane used for testing runs **hidden** (`document.visibilityState
=== "hidden"`), so `<video>` playback is suspended — `currentTime` never
advances. All playhead verification was done via **explicit `video.currentTime`
seeks** + **stubbed `duration`/`buffered`/`networkState`**, never real
continuous playback. The next agent should verify on a real device / visible
browser with a real proxied video.
