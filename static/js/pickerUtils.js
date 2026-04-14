// Picker Utilities - Shared helpers for FolderPicker and PhotoPicker
//
// Provides common functionality used by both picker components

const PickerUtils = (() => {
  const VIRTUAL_ROOT = '__LOCATIONS__';

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

  return {
    VIRTUAL_ROOT,
    getDefaultPath,
    isTypingTarget,
    getNavigableRows,
    getNextFocusIndex,
    scrollRowIntoView,
  };
})();

// Export for use in other modules
window.PickerUtils = PickerUtils;
