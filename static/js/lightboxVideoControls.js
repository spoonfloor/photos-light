/**
 * Custom lightbox video transport controls (POC parity).
 * Session-scoped loop/mute; hover-gated overlay with idle hide; fullscreen on stage.
 */
const LightboxVideoControls = (() => {
  const CONTROLS_HIDE_MS = 3000;

  const session = {
    loopEnabled: true,
    muted: false,
  };

  let active = null;
  let controlsHideTimer = null;
  let isPointerOverStage = false;
  let scrubbing = false;
  let wasPlayingBeforeScrub = false;

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

  function updateTimeDisplay() {
    if (!active) return;
    active.timeDisplay.textContent = `${formatTime(active.video.currentTime)} / ${formatTime(active.video.duration)}`;
  }

  function updateProgress() {
    if (!active || !active.video.duration) return;
    const pct = (active.video.currentTime / active.video.duration) * 100;
    active.progressFill.style.width = `${pct}%`;
    if (!scrubbing) {
      active.scrubber.value = String(
        Math.round((active.video.currentTime / active.video.duration) * 1000),
      );
    }
    updateTimeDisplay();
  }

  function resetTransport() {
    if (!active) return;
    setPlayIcon(false);
    active.scrubber.value = '0';
    active.progressFill.style.width = '0%';
    active.timeDisplay.textContent = '0:00 / 0:00';
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

    addListener(video, 'play', () => setPlayIcon(true));
    addListener(video, 'pause', () => setPlayIcon(false));
    addListener(video, 'ended', () => setPlayIcon(false));
    addListener(video, 'timeupdate', updateProgress);

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
      if (!video.duration) return;
      const t = (Number(scrubber.value) / 1000) * video.duration;
      video.currentTime = t;
      progressFill.style.width = `${(video.currentTime / video.duration) * 100}%`;
      updateTimeDisplay();
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
      togglePlay();
    });

    addListener(document, 'fullscreenchange', onFullscreenChange);
  }

  function mount(stage, video) {
    unmount();
    const overlay = createControlsOverlay();
    stage.appendChild(overlay);
    wireControls(stage, video, overlay);
  }

  function unmount() {
    if (!active) return;

    clearControlsHideTimer();
    isPointerOverStage = false;
    scrubbing = false;
    wasPlayingBeforeScrub = false;

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
