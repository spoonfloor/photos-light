/**
 * Shared filter chip lifecycle — auto-clear unavailable filters and toggle guards.
 */
const FilterChipLifecycle = (() => {
  const AUTO_CLEAR_KEYS = ['starred', 'video'];

  function filtersClearedByAvailability(activeFilters, filterAvailability) {
    return AUTO_CLEAR_KEYS.some(
      (key) =>
        filterAvailability[key] === false && Boolean(activeFilters[key]),
    );
  }

  function applyAutoClear(activeFilters, filterAvailability) {
    const filtersCleared = filtersClearedByAvailability(
      activeFilters,
      filterAvailability,
    );
    for (const key of AUTO_CLEAR_KEYS) {
      if (filterAvailability[key] === false) {
        activeFilters[key] = false;
      }
    }
    return filtersCleared;
  }

  function canToggleFilter(filterKey, { availability, selectedCount = 0 } = {}) {
    if (filterKey === 'selected' && selectedCount === 0) {
      return false;
    }
    if (filterKey === 'starred' && availability?.starred !== true) {
      return false;
    }
    if (filterKey === 'video' && availability?.video !== true) {
      return false;
    }
    return true;
  }

  return {
    AUTO_CLEAR_KEYS,
    applyAutoClear,
    canToggleFilter,
    filtersClearedByAvailability,
  };
})();
