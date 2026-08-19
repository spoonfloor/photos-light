/**
 * View capability profiles — single registry for app, share, and trash surfaces.
 */
const ViewCapabilities = (() => {
  const LIBRARY = Object.freeze({
    rotate: true,
    star: true,
    editDate: true,
    download: true,
    downloadInAppBar: false,
    downloadInUtilities: true,
    shareLink: true,
    libraryMenu: true,
    restore: false,
    import: true,
    catalogFilters: true,
    gridStarBadge: 'interactive',
    deleteKind: 'soft',
    deleteAppBarLabel: 'Delete selected',
    deleteLightboxLabel: 'Delete',
    appBarTitle: true,
    dateJumper: true,
    recentImportsFilter: true,
    selectedFilterChip: true,
    virtual: true,
    surface: 'library',
  });

  const SHARE = Object.freeze({
    rotate: false,
    star: true,
    editDate: false,
    download: true,
    downloadInAppBar: true,
    downloadInUtilities: false,
    shareLink: false,
    libraryMenu: false,
    restore: false,
    import: false,
    catalogFilters: true,
    gridStarBadge: 'interactive',
    deleteKind: null,
    deleteAppBarLabel: null,
    deleteLightboxLabel: null,
    appBarTitle: true,
    dateJumper: false,
    recentImportsFilter: false,
    selectedFilterChip: true,
    virtual: false,
    surface: 'share',
  });

  /** @type {'library' | 'share'} */
  let activeSurface = 'library';

  function setSurface(surface) {
    activeSurface = surface === 'share' ? 'share' : 'library';
  }

  function getSurface() {
    return activeSurface;
  }

  function get() {
    if (activeSurface === 'share') {
      return SHARE;
    }
    if (
      typeof TrashView !== 'undefined' &&
      typeof TrashView.isActive === 'function' &&
      TrashView.isActive()
    ) {
      return TrashView.getViewCapabilities();
    }
    return LIBRARY;
  }

  return {
    LIBRARY,
    SHARE,
    setSurface,
    getSurface,
    get,
  };
})();
