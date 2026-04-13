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

  return {
    VIRTUAL_ROOT,
    getDefaultPath
  };
})();

// Export for use in other modules
window.PickerUtils = PickerUtils;
