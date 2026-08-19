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

  function clearCardTimer() {
    if (cardTimer !== null) {
      window.clearTimeout(cardTimer);
      cardTimer = null;
    }
  }

  function getOverlay(overlayId) {
    return overlayId ? document.getElementById(overlayId) : null;
  }

  function setScrimOnly(overlay, scrimOnly) {
    if (!overlay) {
      return;
    }
    overlay.classList.toggle('import-overlay--scrim-only', scrimOnly);
  }

  function applyCardContent({
    overlayId,
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
    const titleEl = document.getElementById(titleElId);
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
  } = {}) {
    clearCardTimer();
    const session = ++activeSession;
    activeOverlayId = overlayId;

    const overlay = getOverlay(overlayId);
    if (!overlay) {
      return false;
    }

    wireCancelButton(cancelBtnId);

    applyCardContent({
      overlayId,
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

    setScrimOnly(overlay, true);
    overlay.style.display = 'flex';
    overlay.removeAttribute('aria-hidden');

    cardTimer = window.setTimeout(() => {
      if (session !== activeSession) {
        return;
      }
      const current = getOverlay(overlayId);
      if (!current || current.style.display === 'none') {
        return;
      }
      setScrimOnly(current, false);
    }, CARD_DELAY_MS);

    return true;
  }

  function end({ overlayId = null } = {}) {
    clearCardTimer();
    activeSession += 1;
    cancelHandler = null;

    const id = overlayId || activeOverlayId;
    if (!id) {
      return;
    }

    const overlay = getOverlay(id);
    if (overlay) {
      overlay.style.display = 'none';
      setScrimOnly(overlay, true);
      overlay.setAttribute('aria-hidden', 'true');
    }

    if (activeOverlayId === id) {
      activeOverlayId = null;
    }
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
