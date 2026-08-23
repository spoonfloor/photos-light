/**
 * Single source of truth for which app-bar action buttons should be
 * visible, given the current view's capabilities.
 *
 * Step 1 of replacing three independent, duplicated hidden-toggling
 * mechanisms — chrome.js's [data-cap] loop, trashView.js's
 * updateAppBarForMode(), and a manually-maintained CSS [hidden]
 * allowlist — with one. For now this module only *observes*: resolve()
 * is pure and unused by any live path yet, and devDiff() just logs
 * where the old mechanisms disagree with it. Nothing here changes
 * behavior until the old paths are migrated onto resolve() and removed.
 */
const AppBarVisibility = (() => {
  // Button id -> capability key. Buttons not listed here have no
  // capability gate and are always shown (sortToggleBtn, deselectAllBtn,
  // utilitiesBtn) — their enabled/disabled state is handled separately
  // via the .inactive class, not visibility.
  const GATED_BUTTONS = {
    addPhotoBtn: 'import',
    downloadBtn: 'downloadInAppBar',
    editDateBtn: 'editDate',
    restoreBtn: 'restore',
    deleteBtn: 'deleteKind',
  };

  // Mirrors chrome.js's capEnabled(): deleteKind is a string enum
  // ('soft' | 'permanent' | null), not a boolean, so it needs its own
  // truthiness rule.
  function capEnabled(caps, capName) {
    const value = caps?.[capName];
    if (capName === 'deleteKind') {
      return value != null && value !== false;
    }
    return !!value;
  }

  /** Pure: capability object -> { btnId: shouldBeVisible } */
  function resolve(caps) {
    const result = {};
    for (const [btnId, capName] of Object.entries(GATED_BUTTONS)) {
      result[btnId] = capEnabled(caps, capName);
    }
    return result;
  }

  /**
   * Dev-only: compares resolve()'s answer against the DOM's actual
   * current hidden state and warns on any mismatch. Call this after an
   * old mechanism (chrome.js or trashView.js) finishes its sync, tagged
   * with `source` so mismatches can be traced to which path produced
   * them. Not an assertion — the two old paths can legitimately disagree
   * with each other transiently depending on call order, which is
   * exactly the bug being investigated.
   */
  function devDiff(caps, source) {
    const expected = resolve(caps);
    const mismatches = [];
    for (const [btnId, shouldShow] of Object.entries(expected)) {
      const el = document.getElementById(btnId);
      if (!el) continue;
      const actuallyShown = !el.hidden;
      if (actuallyShown !== shouldShow) {
        mismatches.push({ btnId, expected: shouldShow, actual: actuallyShown });
      }
    }
    if (mismatches.length) {
      console.warn(
        `[AppBarVisibility] resolver disagrees with DOM after ${source}:`,
        mismatches,
      );
    }
    return mismatches;
  }

  return { resolve, devDiff, GATED_BUTTONS };
})();
