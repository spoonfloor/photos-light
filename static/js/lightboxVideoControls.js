/**
 * Custom lightbox video transport controls (POC parity).
 * Session-scoped loop/mute; hover-gated overlay with idle hide; fullscreen on stage.
 */
const LightboxVideoControls = (() => {
  const CONTROLS_HIDE_MS = 3000;
  const NARROW_QUERY = '(max-width: 480px)';

  const session = {
    loopEnabled: true,
    // Audio defaults off: it's also the only autoplay mobile allows without
    // a gesture. Session-scoped, so an explicit unmute persists for the rest
    // of the session.
    muted: true,
  };

  let active = null;
  let controlsHideTimer = null;
  let isPointerOverStage = false;
  let scrubbing = false;
  let wasPlayingBeforeScrub = false;
  // rAF handle for the progress-bar loop (runs only while playing) — see
  // startProgressLoop. timeupdate alone fires ~4x/sec, which reads as a
  // low frame rate and lags the loop-restart boundary.
  let progressRaf = null;
  // The video's duration, latched once it's provably FINAL — see
  // durationIsFinal(). Fragmented/streamed MP4 (the pipeline's format) has no
  // declared duration; `video.duration` starts unknown and, worse, can report
  // a small-and-growing finite value mid-download. Latching the first finite
  // number made the bar race to 100% early; latching only when fully buffered
  // means the number has stopped moving. Until then the fill holds at 0.
  // Cleared per video in unmount(); later changes are ignored on purpose.
  let latchedDuration = null;
  // Highest fill % shown in the current play-through — the bar is monotonic
  // within a pass, so any stray late duration correction can only stall it,
  // never rewind it. Reset on loop-wrap / backward seek (currentTime jumps
  // back) and on each latch. Belt to durationIsFinal's braces.
  let maxPct = 0;
  let lastRenderTime = 0;
  // networkState === 1 (NETWORK_IDLE): resource selected, not fetching — i.e.
  // done. Named here since the HTMLMediaElement constant isn't always handy.
  const NETWORK_IDLE = 1;

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function isLightboxOpen() {
    const overlay = document.getElementById('lightboxOverlay');
    return !!overlay && overlay.style.display === 'flex';
  }

  function isVideoFullscreen() {
    return !!active && document.fullscreenElement === active.stage;
  }

  function clearControlsHideTimer() {
    if (controlsHideTimer !== null) {
      clearTimeout(controlsHideTimer);
      controlsHideTimer = null;
    }
  }

  function showPlayControls() {
    if (!active) return;
    if (!scrubbing && !isVideoFullscreen() && !isPointerOverStage) {
      return;
    }
    active.overlay.classList.remove('lightbox-video-controls-hidden');
  }

  function hidePlayControls() {
    if (!active) return;
    active.overlay.classList.add('lightbox-video-controls-hidden');
  }

  function scheduleControlsHide() {
    clearControlsHideTimer();
    if (
      !isLightboxOpen() ||
      scrubbing ||
      (!isVideoFullscreen() && !isPointerOverStage)
    ) {
      return;
    }
    controlsHideTimer = setTimeout(hidePlayControls, CONTROLS_HIDE_MS);
  }

  function onStagePointerActivity() {
    if (!active) return;
    if (isVideoFullscreen()) {
      showPlayControls();
      scheduleControlsHide();
      return;
    }
    if (!isPointerOverStage) return;
    showPlayControls();
    scheduleControlsHide();
  }

  function onStageEnter() {
    isPointerOverStage = true;
    if (isVideoFullscreen()) return;
    showPlayControls();
    scheduleControlsHide();
  }

  function onStageLeave() {
    isPointerOverStage = false;
    if (isVideoFullscreen()) return;
    clearControlsHideTimer();
    hidePlayControls();
  }

  function resetControlsAfterFullscreenChange() {
    if (!active) return;
    clearControlsHideTimer();
    isPointerOverStage = active.stage.matches(':hover');
    if (isVideoFullscreen()) {
      hidePlayControls();
      return;
    }
    if (isPointerOverStage) {
      showPlayControls();
      scheduleControlsHide();
    } else {
      hidePlayControls();
    }
  }

  function setPlayIcon(playing) {
    if (!active) return;
    active.playIcon.textContent = playing ? 'pause' : 'play_arrow';
    active.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function setVolumeIcon() {
    if (!active) return;
    const icon =
      session.muted || active.video.volume === 0
        ? 'volume_off'
        : active.video.volume < 0.5
          ? 'volume_down'
          : 'volume_up';
    active.volumeIcon.textContent = icon;
    active.volumeBtn.setAttribute('aria-label', session.muted ? 'Unmute' : 'Mute');
  }

  function applyLoopState() {
    if (!active) return;
    active.video.loop = session.loopEnabled;
    active.loopIcon.textContent = session.loopEnabled
      ? 'repeat'
      : 'horizontal_align_right';
    active.loopBtn.setAttribute('aria-pressed', String(session.loopEnabled));
    active.loopBtn.setAttribute(
      'aria-label',
      session.loopEnabled ? 'Loop on' : 'Loop off',
    );
  }

  // True once video.duration can be trusted not to change again: it's finite
  // AND the media is fully loaded (buffered range reaches it, or the element
  // has stopped using the network). Before this, a finite duration is just
  // "parsed so far" and will grow.
  function durationIsFinal(video) {
    const d = video.duration;
    if (!Number.isFinite(d) || d <= 0) return false;
    const b = video.buffered;
    if (b && b.length && b.end(b.length - 1) >= d - 0.25) return true;
    return video.networkState === NETWORK_IDLE;
  }

  // Latch the duration once it's final and snap the fill to the current
  // position. No-op once latched or while duration is still in flux.
  function tryLatchDuration() {
    if (!active || latchedDuration != null) return;
    if (durationIsFinal(active.video)) {
      latchedDuration = active.video.duration;
      maxPct = 0;
      lastRenderTime = 0;
      renderProgress();
    }
  }

  function renderProgress() {
    if (!active) return;
    const { video } = active;
    // Duration not known yet: hold the bar at 0, keep the elapsed readout
    // live. This is also the permanent fallback if a duration never arrives.
    if (latchedDuration == null) {
      active.progressFill.style.width = '0%';
      if (!scrubbing) active.scrubber.value = '0';
      active.timeDisplay.textContent = formatTime(video.currentTime);
      return;
    }
    // currentTime jumped back → loop wrap or a backward seek; let the bar
    // follow it down by dropping the monotonic ceiling.
    if (video.currentTime < lastRenderTime - 0.25) {
      maxPct = 0;
    }
    lastRenderTime = video.currentTime;
    const raw = Math.min(
      100,
      Math.max(0, (video.currentTime / latchedDuration) * 100),
    );
    maxPct = Math.max(maxPct, raw);
    active.progressFill.style.width = `${maxPct}%`;
    if (!scrubbing) {
      active.scrubber.value = String(Math.round((maxPct / 100) * 1000));
    }
    active.timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(latchedDuration)}`;
  }

  function progressTick() {
    if (!active || active.video.paused) {
      progressRaf = null;
      return;
    }
    renderProgress();
    progressRaf = requestAnimationFrame(progressTick);
  }

  function startProgressLoop() {
    if (progressRaf == null) {
      progressRaf = requestAnimationFrame(progressTick);
    }
  }

  function stopProgressLoop() {
    if (progressRaf != null) {
      cancelAnimationFrame(progressRaf);
      progressRaf = null;
    }
  }

  function resetTransport() {
    if (!active) return;
    setPlayIcon(false);
    // Paint from live state, not a hard zero — this also fires on
    // loadedmetadata (via lightboxMedia.js), by which point the duration may
    // already be latched and playback already advanced; a blind zero here
    // would undo the latch snap for a frame.
    renderProgress();
    if (isVideoFullscreen()) {
      hidePlayControls();
    } else if (!isPointerOverStage) {
      hidePlayControls();
    } else {
      onStagePointerActivity();
    }
  }

  function togglePlay() {
    if (!active) return;
    onStagePointerActivity();
    if (active.video.paused) {
      active.video.play().catch(() => {});
    } else {
      active.video.pause();
    }
  }

  function createControlsOverlay() {
    const overlay = document.createElement('div');
    overlay.className =
      'lightbox-video-controls-overlay lightbox-video-controls-hidden';
    overlay.innerHTML = `
      <div class="lightbox-video-controls-gradient"></div>
      <div class="lightbox-video-controls-inner">
        <div class="lightbox-video-controls-top-row">
          <button type="button" class="lightbox-video-ctrl-btn" data-action="play" aria-label="Play">
            <span class="material-symbols-outlined lightbox-video-play-icon" data-role="play-icon">play_arrow</span>
          </button>
          <span class="lightbox-video-time-display" data-role="time">0:00 / 0:00</span>
          <div class="lightbox-video-controls-spacer"></div>
          <button type="button" class="lightbox-video-ctrl-btn" data-action="loop" aria-label="Loop on" aria-pressed="true">
            <span class="material-symbols-outlined" data-role="loop-icon">repeat</span>
          </button>
          <button type="button" class="lightbox-video-ctrl-btn" data-action="volume" aria-label="Mute">
            <span class="material-symbols-outlined" data-role="volume-icon">volume_up</span>
          </button>
          <button type="button" class="lightbox-video-ctrl-btn" data-action="fullscreen" aria-label="Full screen">
            <span class="material-symbols-outlined" data-role="fullscreen-icon">fullscreen</span>
          </button>
        </div>
        <div class="lightbox-video-progress-track">
          <div class="lightbox-video-progress-fill" data-role="progress-fill"></div>
          <input class="lightbox-video-progress-input" data-role="scrubber" type="range" min="0" max="1000" value="0" />
        </div>
      </div>
    `;
    return overlay;
  }

  function addListener(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    active.listeners.push({ target, type, handler, options });
  }

  function onFullscreenChange() {
    if (!active) return;
    active.fullscreenIcon.textContent = document.fullscreenElement
      ? 'fullscreen_exit'
      : 'fullscreen';
    resetControlsAfterFullscreenChange();
  }

  function wireControls(stage, video, overlay) {
    const playBtn = overlay.querySelector('[data-action="play"]');
    const loopBtn = overlay.querySelector('[data-action="loop"]');
    const volumeBtn = overlay.querySelector('[data-action="volume"]');
    const fullscreenBtn = overlay.querySelector('[data-action="fullscreen"]');
    const playIcon = overlay.querySelector('[data-role="play-icon"]');
    const loopIcon = overlay.querySelector('[data-role="loop-icon"]');
    const volumeIcon = overlay.querySelector('[data-role="volume-icon"]');
    const fullscreenIcon = overlay.querySelector('[data-role="fullscreen-icon"]');
    const timeDisplay = overlay.querySelector('[data-role="time"]');
    const progressFill = overlay.querySelector('[data-role="progress-fill"]');
    const scrubber = overlay.querySelector('[data-role="scrubber"]');

    active = {
      stage,
      video,
      overlay,
      playBtn,
      loopBtn,
      volumeBtn,
      fullscreenBtn,
      playIcon,
      loopIcon,
      volumeIcon,
      fullscreenIcon,
      timeDisplay,
      progressFill,
      scrubber,
      listeners: [],
    };

    video.muted = session.muted;
    applyLoopState();
    setVolumeIcon();
    resetTransport();
    // Cached/fast sources can already have a duration by the time we wire up.
    tryLatchDuration();

    addListener(playBtn, 'click', (e) => {
      e.stopPropagation();
      togglePlay();
    });

    addListener(loopBtn, 'click', (e) => {
      e.stopPropagation();
      session.loopEnabled = !session.loopEnabled;
      applyLoopState();
      onStagePointerActivity();
    });

    addListener(volumeBtn, 'click', (e) => {
      e.stopPropagation();
      session.muted = !session.muted;
      video.muted = session.muted;
      setVolumeIcon();
      onStagePointerActivity();
    });

    addListener(fullscreenBtn, 'click', (e) => {
      e.stopPropagation();
      onStagePointerActivity();
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        stage.requestFullscreen().catch(() => {});
      }
    });

    addListener(video, 'play', () => {
      setPlayIcon(true);
      startProgressLoop();
    });
    addListener(video, 'pause', () => {
      setPlayIcon(false);
      stopProgressLoop();
      renderProgress();
    });
    addListener(video, 'ended', () => {
      setPlayIcon(false);
      stopProgressLoop();
    });
    // Backstop for the paused state (seeks, loop-to-pause); the rAF loop
    // owns the smooth playing-state updates.
    addListener(video, 'timeupdate', renderProgress);
    addListener(video, 'seeked', renderProgress);
    // Re-test "is the duration final yet" as metadata arrives and as the
    // buffered range grows. `progress` is the one that fires repeatedly
    // during download, so it catches the moment buffering completes.
    addListener(video, 'loadedmetadata', tryLatchDuration);
    addListener(video, 'durationchange', tryLatchDuration);
    addListener(video, 'progress', tryLatchDuration);
    addListener(video, 'canplaythrough', tryLatchDuration);

    addListener(scrubber, 'pointerdown', (e) => {
      e.stopPropagation();
      scrubbing = true;
      wasPlayingBeforeScrub = !video.paused;
      video.pause();
      showPlayControls();
      clearControlsHideTimer();
    });

    addListener(scrubber, 'input', (e) => {
      e.stopPropagation();
      onStagePointerActivity();
      if (latchedDuration == null) return;
      video.currentTime = (Number(scrubber.value) / 1000) * latchedDuration;
      renderProgress();
    });

    addListener(scrubber, 'pointerup', (e) => {
      e.stopPropagation();
      scrubbing = false;
      if (wasPlayingBeforeScrub) video.play().catch(() => {});
      scheduleControlsHide();
    });

    addListener(stage, 'mouseenter', onStageEnter);
    addListener(stage, 'mouseleave', onStageLeave);
    addListener(stage, 'mousemove', onStagePointerActivity);

    addListener(stage, 'click', (e) => {
      if (e.target.closest('.lightbox-video-controls-inner')) return;
      // Narrow/touch bundles the playhead with the app-bar chrome: a tap on
      // the video toggles chrome visibility (handled by LightboxShell's
      // gesture recognizer), not playback — play/pause is the dedicated
      // button there. Wide keeps tap-anywhere-to-toggle-play.
      if (window.matchMedia(NARROW_QUERY).matches) return;
      togglePlay();
    });

    addListener(document, 'fullscreenchange', onFullscreenChange);
  }

  // Where the controls overlay is parented (its containing block, since it's
  // position:absolute; bottom:0). Narrow: the content box — a flex sibling of
  // the info panel — so the playhead sits at the true bottom of the frame and
  // the info panel pushes it up, instead of hugging the letterboxed media
  // box. Wide: the stage, so it stays inside requestFullscreen() (the
  // fullscreen button is narrow-hidden anyway). Decided at mount time, like
  // every other breakpoint delta here — a resize across 480px mid-video is
  // reconciled on the next load.
  function overlayHost(stage) {
    if (window.matchMedia(NARROW_QUERY).matches) {
      return stage.closest('.lightbox-content') || stage;
    }
    return stage;
  }

  function mount(stage, video) {
    unmount();
    const overlay = createControlsOverlay();
    overlayHost(stage).appendChild(overlay);
    wireControls(stage, video, overlay);
  }

  function unmount() {
    if (!active) return;

    clearControlsHideTimer();
    stopProgressLoop();
    latchedDuration = null;
    maxPct = 0;
    lastRenderTime = 0;
    isPointerOverStage = false;
    scrubbing = false;
    wasPlayingBeforeScrub = false;

    if (active.overlay?.parentNode) {
      active.overlay.parentNode.removeChild(active.overlay);
    }

    if (document.fullscreenElement === active.stage) {
      document.exitFullscreen().catch(() => {});
    }

    for (const { target, type, handler, options } of active.listeners) {
      target.removeEventListener(type, handler, options);
    }

    active = null;
  }

  return {
    mount,
    unmount,
    resetTransport,
    togglePlay,
    hidePlayControls,
  };
})();
