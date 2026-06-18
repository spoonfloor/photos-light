// Picker Utilities - Shared helpers for FolderPicker and PhotoPicker
//
// Provides common functionality used by both picker components

const PickerUtils = (() => {
  const VIRTUAL_ROOT = '__LOCATIONS__';
  // Keep in sync with picker_sort.DEFAULT_PICKER_SORT
  const PICKER_DEFAULT_SORT = { mode: 'name_asc' };

  function getPickerSortKey(value) {
    return `${value ?? ''}`.toLocaleLowerCase();
  }

  function sortPickerItems(
    items,
    {
      mode = PICKER_DEFAULT_SORT.mode,
      getKey = (item) => item?.name ?? item,
    } = {},
  ) {
    const sorted = [...items].sort((left, right) =>
      getPickerSortKey(getKey(left)).localeCompare(
        getPickerSortKey(getKey(right)),
        undefined,
        { sensitivity: 'base' },
      ),
    );

    return mode === 'name_desc' ? sorted.reverse() : sorted;
  }

  /**
   * Gets the default picker path, trying Desktop first, then home, then first location
   * @param {Array} topLevelLocations - Array of location objects from get-locations API
   * @param {Function} listDirectory - Async function to test if a path is accessible
   * @returns {Promise<string>} - The default path to use
   */
  async function getDefaultPath(topLevelLocations, listDirectory) {
    // Try Desktop first
    for (const loc of topLevelLocations) {
      if (loc.path.includes('/Users/') && !loc.path.includes('Shared')) {
        const desktopPath = loc.path + '/Desktop';
        
        try {
          await listDirectory(desktopPath);
          
          return desktopPath;
        } catch (error) {
          // Desktop doesn't exist or not accessible, try home folder as fallback
          
          
          return loc.path;
        }
      }
    }
    
    // If still at virtual root, force to first non-Shared location
    if (topLevelLocations.length > 0) {
      const firstLocation = topLevelLocations.find(loc => !loc.path.includes('Shared'));
      if (firstLocation) {
        
        return firstLocation.path;
      }
    }
    
    // Last resort
    return VIRTUAL_ROOT;
  }

  const OVERLAY_SELECTORS = [
    '.picker-overlay',
    '.import-overlay',
    '.dialog-overlay',
    '.date-editor-overlay',
  ].join(',');

  const ACTION_BAR_SELECTORS =
    '.import-actions, .dialog-actions, .picker-actions';

  function isTypingTarget(target) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    if (target.isContentEditable) {
      return true;
    }

    const tagName = target.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
  }

  function isOverlayVisible(el) {
    if (!(el instanceof HTMLElement)) {
      return false;
    }
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function isActionButtonVisible(btn) {
    if (!(btn instanceof HTMLButtonElement) || btn.disabled) {
      return false;
    }
    const style = getComputedStyle(btn);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function getTopmostVisibleOverlay() {
    return [...document.querySelectorAll(OVERLAY_SELECTORS)]
      .filter(isOverlayVisible)
      .sort(
        (left, right) =>
          (parseInt(getComputedStyle(right).zIndex, 10) || 0) -
          (parseInt(getComputedStyle(left).zIndex, 10) || 0),
      )[0];
  }

  function findOverlayPrimaryButton(overlay) {
    if (!(overlay instanceof HTMLElement)) {
      return null;
    }

    const actionBar = overlay.querySelector(ACTION_BAR_SELECTORS);
    const scope = actionBar ?? overlay;

    const primary = scope.querySelector('.btn-primary');
    if (primary && isActionButtonVisible(primary)) {
      return primary;
    }

    const buttons = [...scope.querySelectorAll('button')].filter(
      isActionButtonVisible,
    );
    return buttons.length > 0 ? buttons[buttons.length - 1] : null;
  }

  function findPagePrimaryButton() {
    for (const btn of document.querySelectorAll('.btn-primary:not(:disabled)')) {
      if (btn.offsetParent !== null) {
        return btn;
      }
    }
    return null;
  }

  /**
   * Trigger the primary CTA for Enter key: scoped to the topmost visible
   * overlay when one is open, otherwise the first page-level primary button.
   * @returns {boolean} true if a button was activated
   */
  function activatePrimaryActionForEnter() {
    const overlay = getTopmostVisibleOverlay();
    const activeElement = document.activeElement;

    if (overlay) {
      if (
        overlay.id === 'nameLibraryOverlay' &&
        overlay.classList.contains('expanded')
      ) {
        return false;
      }

      if (
        isTypingTarget(activeElement) &&
        !overlay.contains(activeElement)
      ) {
        return false;
      }

      const overlayPrimary = findOverlayPrimaryButton(overlay);
      if (overlayPrimary) {
        overlayPrimary.click();
        return true;
      }
      return false;
    }

    if (isTypingTarget(activeElement)) {
      return false;
    }

    const pagePrimary = findPagePrimaryButton();
    if (pagePrimary) {
      pagePrimary.click();
      return true;
    }
    return false;
  }

  function getNavigableRows(container, selector) {
    if (!container) {
      return [];
    }

    return Array.from(container.querySelectorAll(selector)).filter(
      (row) => row instanceof HTMLElement,
    );
  }

  function getNextFocusIndex(currentIndex, direction, totalCount) {
    if (!Number.isInteger(totalCount) || totalCount <= 0) {
      return null;
    }

    if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= totalCount) {
      return direction < 0 ? totalCount - 1 : 0;
    }

    const nextIndex = currentIndex + direction;
    return Math.max(0, Math.min(totalCount - 1, nextIndex));
  }

  function scrollRowIntoView(row) {
    if (!(row instanceof HTMLElement)) {
      return;
    }

    row.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }

  const PICKER_REFRESH_INTERVAL_MS = 5000;

  function buildLocationsSignature(locations) {
    return locations
      .map((loc) => `${loc.name}\t${loc.path}`)
      .sort()
      .join('\n');
  }

  function buildFolderListSignature(
    currentPath,
    { folders, has_db, has_openable_db },
  ) {
    const names = folders
      .map((folder) => (typeof folder === 'string' ? folder : folder.name))
      .slice()
      .sort()
      .join('\n');
    return `${currentPath}|${names}|db:${has_db ? 1 : 0}|open:${has_openable_db ? 1 : 0}`;
  }

  function buildPhotoListSignature(currentPath, { folders, files }) {
    const folderNames = folders
      .map((folder) => folder.name)
      .slice()
      .sort()
      .join('\n');
    const fileKeys = files
      .map((file) => `${file.name}:${file.type}:${file.size ?? 0}`)
      .slice()
      .sort()
      .join('\n');
    return `${currentPath}|f:${folderNames}|files:${fileKeys}`;
  }

  function createPickerAutoRefresh({
    intervalMs = PICKER_REFRESH_INTERVAL_MS,
    focusDebounceMs = 200,
    isVisible,
    onRefresh,
  }) {
    let timerId = null;
    let refreshInFlight = false;
    let focusTimerId = null;

    async function runRefresh() {
      if (refreshInFlight) {
        return;
      }
      if (typeof isVisible === 'function' && !isVisible()) {
        return;
      }
      refreshInFlight = true;
      try {
        await onRefresh();
      } catch (error) {
        console.warn('Picker auto-refresh failed:', error);
      } finally {
        refreshInFlight = false;
      }
    }

    function onWindowFocus() {
      if (focusTimerId) {
        clearTimeout(focusTimerId);
      }
      focusTimerId = setTimeout(() => {
        focusTimerId = null;
        void runRefresh();
      }, focusDebounceMs);
    }

    function start() {
      stop();
      timerId = setInterval(() => {
        void runRefresh();
      }, intervalMs);
      window.addEventListener('focus', onWindowFocus);
    }

    function stop() {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
      if (focusTimerId) {
        clearTimeout(focusTimerId);
        focusTimerId = null;
      }
      window.removeEventListener('focus', onWindowFocus);
      refreshInFlight = false;
    }

    return { start, stop };
  }

  return {
    VIRTUAL_ROOT,
    PICKER_DEFAULT_SORT,
    PICKER_REFRESH_INTERVAL_MS,
    sortPickerItems,
    getDefaultPath,
    isTypingTarget,
    isOverlayVisible,
    getTopmostVisibleOverlay,
    findOverlayPrimaryButton,
    activatePrimaryActionForEnter,
    getNavigableRows,
    getNextFocusIndex,
    scrollRowIntoView,
    buildLocationsSignature,
    buildFolderListSignature,
    buildPhotoListSignature,
    createPickerAutoRefresh,
  };
})();

// Export for use in other modules
window.PickerUtils = PickerUtils;
