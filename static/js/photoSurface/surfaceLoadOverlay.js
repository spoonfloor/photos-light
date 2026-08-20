/**
 * Shared surface load overlay — scrim at t=0, bottom-left card after CARD_DELAY_MS.
 */
const SurfaceLoadOverlay = (() => {
  const CARD_DELAY_MS = 200;

  /** @type {number|null} */
  let cardTimer = null;
  let activeSession = 0;
  /** @type {string|null} */
  let activeOverlayId = null;
  /** @type {(() => void) | null} */
  let cancelHandler = null;
  /** @type {boolean} */
  let cardRevealed = false;

  function clearCardTimer() {
    if (cardTimer !== null) {
      window.clearTimeout(cardTimer);
      cardTimer = null;
    }
  }

  function getOverlay(overlayId) {
    return overlayId ? document.getElementById(overlayId) : null;
  }

  function readScrimStartedAt(overlay) {
    const fromWindow = window.__surfaceLoadScrimAt;
    if (typeof fromWindow === 'number' && Number.isFinite(fromWindow)) {
      return fromWindow;
    }
    const fromDataset = overlay?.dataset?.surfaceLoadScrimAt;
    if (fromDataset) {
      const parsed = Number(fromDataset);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return performance.now();
  }

  function setScrimOnly(overlay, scrimOnly) {
    if (!overlay) {
      return;
    }
    overlay.classList.toggle('import-overlay--scrim-only', scrimOnly);
    if (!scrimOnly) {
      cardRevealed = true;
    }
  }

  function applyCardContent({
    titleElId,
    statusElId,
    pathElId,
    actionsElId,
    cancelBtnId,
    title,
    message,
    libraryPath,
    showCancel,
    onCancel,
  }) {
    const titleEl = titleElId ? document.getElementById(titleElId) : null;
    const statusEl = document.getElementById(statusElId);
    const pathEl = pathElId ? document.getElementById(pathElId) : null;
    const actionsEl = actionsElId ? document.getElementById(actionsElId) : null;
    const cancelBtn = cancelBtnId ? document.getElementById(cancelBtnId) : null;

    if (titleEl) {
      titleEl.textContent = title;
    }
    if (statusEl) {
      statusEl.textContent = message;
    }
    if (pathEl) {
      if (libraryPath) {
        pathEl.textContent = libraryPath;
        pathEl.style.display = '';
      } else {
        pathEl.textContent = '';
        pathEl.style.display = 'none';
      }
    }
    if (actionsEl) {
      actionsEl.style.display = showCancel ? '' : 'none';
    }
    if (cancelBtn) {
      cancelBtn.disabled = false;
    }

    cancelHandler = showCancel && typeof onCancel === 'function' ? onCancel : null;
  }

  function handleCancelClick(event) {
    const cancelBtn = event?.currentTarget;
    if (cancelBtn?.disabled) {
      return;
    }
    if (cancelBtn) {
      cancelBtn.disabled = true;
    }
    if (typeof cancelHandler === 'function') {
      cancelHandler();
    }
  }

  function wireCancelButton(cancelBtnId) {
    if (!cancelBtnId) {
      return;
    }
    const cancelBtn = document.getElementById(cancelBtnId);
    if (!cancelBtn || cancelBtn.dataset.surfaceLoadWired === '1') {
      return;
    }
    cancelBtn.dataset.surfaceLoadWired = '1';
    cancelBtn.addEventListener('click', handleCancelClick);
  }

  function scheduleCardReveal(overlayId, session, scrimStartedAt) {
    clearCardTimer();
    const elapsed = Math.max(0, performance.now() - scrimStartedAt);
    const delayMs = Math.max(0, CARD_DELAY_MS - elapsed);

    cardTimer = window.setTimeout(() => {
      if (session !== activeSession) {
        return;
      }
      const current = getOverlay(overlayId);
      if (!current || current.style.display === 'none') {
        return;
      }
      setScrimOnly(current, false);
    }, delayMs);
  }

  /**
   * Show scrim immediately; reveal card after CARD_DELAY_MS if still active.
   */
  function begin({
    overlayId = 'surfaceLoadOverlay',
    titleElId = 'surfaceLoadTitle',
    statusElId = 'surfaceLoadStatusLabel',
    pathElId = null,
    actionsElId = 'surfaceLoadActions',
    cancelBtnId = 'surfaceLoadCancelBtn',
    title = 'Loading photos',
    message = 'Loading your media.',
    libraryPath = null,
    showCancel = false,
    onCancel = null,
    adoptScrim = false,
    scrimStartedAt = null,
  } = {}) {
    clearCardTimer();
    const session = ++activeSession;
    activeOverlayId = overlayId;
    cardRevealed = false;

    const overlay = getOverlay(overlayId);
    if (!overlay) {
      return false;
    }

    wireCancelButton(cancelBtnId);

    applyCardContent({
      titleElId,
      statusElId,
      pathElId,
      actionsElId,
      cancelBtnId,
      title,
      message,
      libraryPath,
      showCancel,
      onCancel,
    });

    const startedAt =
      typeof scrimStartedAt === 'number' && Number.isFinite(scrimStartedAt)
        ? scrimStartedAt
        : readScrimStartedAt(overlay);

    if (!adoptScrim || overlay.style.display === 'none') {
      setScrimOnly(overlay, true);
      overlay.style.display = 'flex';
      overlay.removeAttribute('aria-hidden');
      if (!overlay.dataset.surfaceLoadScrimAt) {
        overlay.dataset.surfaceLoadScrimAt = String(startedAt);
      }
      window.__surfaceLoadScrimAt = startedAt;
    } else if (overlay.classList.contains('import-overlay--scrim-only')) {
      scheduleCardReveal(overlayId, session, startedAt);
      return true;
    }

    scheduleCardReveal(overlayId, session, startedAt);
    return true;
  }

  function end({ overlayId = null, minCardVisibleMs = 0, immediate = false } = {}) {
    const id = overlayId || activeOverlayId;
    const overlay = id ? getOverlay(id) : null;
    const startedAt = overlay ? readScrimStartedAt(overlay) : performance.now();
    const elapsed = performance.now() - startedAt;
    const cardMinElapsed = cardRevealed ? CARD_DELAY_MS + minCardVisibleMs : CARD_DELAY_MS;

    if (!immediate && elapsed < cardMinElapsed) {
      const waitMs = cardMinElapsed - elapsed;
      window.setTimeout(() => {
        end({ overlayId: id, minCardVisibleMs: 0, immediate: true });
      }, waitMs);
      return;
    }

    clearCardTimer();
    activeSession += 1;
    cancelHandler = null;
    cardRevealed = false;

    if (!id) {
      return;
    }

    if (overlay) {
      overlay.style.display = 'none';
      setScrimOnly(overlay, true);
      overlay.setAttribute('aria-hidden', 'true');
      delete overlay.dataset.surfaceLoadScrimAt;
    }

    if (activeOverlayId === id) {
      activeOverlayId = null;
    }
    delete window.__surfaceLoadScrimAt;
  }

  function flushDomPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  }

  return {
    CARD_DELAY_MS,
    begin,
    end,
    flushDomPaint,
  };
})();
