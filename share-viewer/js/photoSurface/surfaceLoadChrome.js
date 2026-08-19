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

  function applyBodyPhaseClasses(nextPhase) {
    document.body.classList.toggle('surface-load-active', nextPhase !== 'idle');
    document.body.classList.toggle(
      'surface-load-phase-loading',
      nextPhase === 'loading',
    );
    document.body.classList.toggle('surface-load-phase-meta', nextPhase === 'meta');
  }

  function syncChipRailLayout(show) {
    const rail = document.getElementById('filterChipRailMount');
    if (show) {
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
    if (
      !showScrimImmediate(overlayId || 'libraryTransitionOverlay') &&
      overlayId !== 'libraryTransitionOverlay'
    ) {
      showScrimImmediate('surfaceLoadOverlay');
    }
  }

  /** SS3 — metadata ready, still loading photos. */
  function enterMeta() {
    if (!active) {
      return;
    }
    phase = 'meta';
    applyBodyPhaseClasses('meta');
    syncChipRailLayout(true);
    hideDatePicker(false);
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
    beginLoading,
    enterMeta,
    complete,
    syncColdStart,
    syncChipRailLayout,
    showScrimImmediate,
    clearLegacyAppBarInlineStyles,
  };
})();
