/**
 * Load-phase chrome — single source of truth via body classes (SS1–SS4).
 * Do not set per-button inline opacity/pointer-events here; CSS wins over legacy JS.
 */
const SurfaceLoadChrome = (() => {
  let active = false;
  /** @type {'idle' | 'loading' | 'meta'} */
  let phase = 'idle';

  function isActive() {
    return active;
  }

  function getPhase() {
    return phase;
  }

  function isActiveFromDom() {
    return document.body.classList.contains('surface-load-active');
  }

  function applyBodyPhaseClasses(nextPhase) {
    document.body.classList.toggle('surface-load-active', nextPhase !== 'idle');
    document.body.classList.toggle(
      'surface-load-phase-loading',
      nextPhase === 'loading',
    );
    document.body.classList.toggle('surface-load-phase-meta', nextPhase === 'meta');
  }

  function syncChipRailLayout(show) {
    const railMount = document.getElementById('filterChipRailMount');
    const rail = document.getElementById('filterChipRail');
    if (show) {
      if (railMount) {
        railMount.removeAttribute('hidden');
      }
      if (rail) {
        rail.removeAttribute('hidden');
      }
      document.body.classList.add('filter-chip-rail-visible');
    }
  }

  /** Scrim at t=0 — overlay must already be in DOM (inlined in index.html). */
  function showScrimImmediate(overlayId = 'libraryTransitionOverlay') {
    const overlay = document.getElementById(overlayId);
    if (!overlay) {
      return false;
    }
    overlay.classList.add('import-overlay--scrim-only');
    overlay.style.display = 'flex';
    overlay.removeAttribute('aria-hidden');
    return true;
  }

  function isScrimVisible(overlayId) {
    const overlay = document.getElementById(overlayId);
    if (!overlay) {
      return false;
    }
    return overlay.style.display !== 'none' && !overlay.hasAttribute('hidden');
  }

  function hideDatePicker(hide) {
    const datePickerContainer = document.querySelector('.date-picker');
    if (!datePickerContainer) {
      return;
    }
    if (hide) {
      datePickerContainer.style.visibility = 'hidden';
      datePickerContainer.setAttribute('aria-hidden', 'true');
    } else {
      datePickerContainer.style.visibility = 'visible';
      datePickerContainer.removeAttribute('aria-hidden');
    }
  }

  function clearLegacyAppBarInlineStyles() {
    document.querySelectorAll('.app-bar-icon-button').forEach((btn) => {
      btn.style.removeProperty('opacity');
      btn.style.removeProperty('pointer-events');
    });
  }

  /** SS2 — load triggered: skeleton, scrim at t=0, locked chrome, chip rail reserved. */
  function beginLoading({ overlayId = null } = {}) {
    document.body.classList.remove('surface-chrome-cold-start');
    active = true;
    phase = 'loading';
    applyBodyPhaseClasses('loading');
    syncChipRailLayout(true);
    hideDatePicker(true);
    const resolvedOverlayId = overlayId || 'libraryTransitionOverlay';
    if (!isScrimVisible(resolvedOverlayId)) {
      if (
        !showScrimImmediate(resolvedOverlayId) &&
        resolvedOverlayId !== 'libraryTransitionOverlay'
      ) {
        showScrimImmediate('surfaceLoadOverlay');
      }
    }
  }

  /**
   * Adopt HTML-first SS2 (share hard reload) — sync module state without re-showing scrim.
   */
  function adoptLoading({ overlayId = 'surfaceLoadOverlay' } = {}) {
    if (!isActiveFromDom() && !isScrimVisible(overlayId)) {
      beginLoading({ overlayId });
      return;
    }
    document.body.classList.remove('surface-chrome-cold-start');
    active = true;
    phase = document.body.classList.contains('surface-load-phase-meta')
      ? 'meta'
      : 'loading';
    applyBodyPhaseClasses(phase);
    syncChipRailLayout(true);
    hideDatePicker(phase === 'loading');
  }

  /** SS3 — metadata ready, still loading photos. */
  function enterMeta() {
    if (!active) {
      return;
    }
    phase = 'meta';
    applyBodyPhaseClasses('meta');
    syncChipRailLayout(true);
  }

  /** SS4 — load complete; caller runs enableAppBarButtons() next. */
  function complete() {
    active = false;
    phase = 'idle';
    applyBodyPhaseClasses('idle');
    clearLegacyAppBarInlineStyles();
  }

  /** SS1 — cold start / welcome. */
  function syncColdStart() {
    active = false;
    phase = 'idle';
    document.body.classList.add('surface-chrome-cold-start');
    document.body.classList.remove(
      'surface-load-active',
      'surface-load-phase-loading',
      'surface-load-phase-meta',
    );
    hideDatePicker(true);
    clearLegacyAppBarInlineStyles();
  }

  return {
    isActive,
    getPhase,
    isActiveFromDom,
    beginLoading,
    adoptLoading,
    enterMeta,
    complete,
    syncColdStart,
    syncChipRailLayout,
    showScrimImmediate,
    clearLegacyAppBarInlineStyles,
  };
})();
