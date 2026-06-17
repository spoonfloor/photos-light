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
