/**
 * PhotoSurface — shared grid mount for library and share hosts.
 * Virtual libraries use VirtualGrid.init from main.js; eager hosts use PhotoGrid.render.
 */
const PhotoSurface = (() => {
  function mountChrome(caps) {
    if (typeof PhotoChrome !== 'undefined') {
      PhotoChrome.applySurfaceChrome(caps);
    }
  }

  function init({
    caps,
    container,
    emptyEl = null,
    getPhotos,
    adapters,
    interactionHandlers,
    onAfterRender,
  }) {
    if (!container || typeof getPhotos !== 'function') {
      throw new Error('PhotoSurface.init requires container and getPhotos');
    }

    const interactionCtx = {
      getCapabilities: () => caps,
      getSelectedCount: () => adapters.getSelectedCount?.() ?? 0,
      isSelected: (photoId) => adapters.isSelected?.(photoId) ?? false,
      onToggleSelection: interactionHandlers.onToggleSelection,
      onMonthCircleClick: interactionHandlers.onMonthCircleClick,
      onToggleStar: interactionHandlers.onToggleStar,
      onOpenLightbox: interactionHandlers.onOpenLightbox,
      onSelectModeChange: interactionHandlers.onSelectModeChange,
    };

    const gridCtx = {
      getCapabilities: () => caps,
      getSelectedIds: () => adapters.getSelectedIds?.() ?? new Set(),
      parseDate: adapters.parseDate,
      isStarred: adapters.isStarred,
      isSelected: adapters.isSelected,
      thumbUrl: adapters.thumbUrl,
      interactionCtx,
      onAfterRender: () => {
        onAfterRender?.();
      },
    };

    function renderGrid(options = {}) {
      const photos = getPhotos();
      if (emptyEl) {
        emptyEl.hidden = photos.length > 0;
      }
      if (typeof PhotoGrid === 'undefined') {
        throw new Error('PhotoGrid is not loaded');
      }
      PhotoGrid.render(container, photos, {
        ...gridCtx,
        deferThumbSrc: Boolean(options.deferThumbSrc),
      });
    }

    function hydrateThumbs() {
      if (typeof PhotoGrid === 'undefined') {
        return;
      }
      PhotoGrid.hydrateThumbs(container, getPhotos(), gridCtx);
    }

    if (typeof GridLayout !== 'undefined') {
      GridLayout.observeContainerGeometry(container);
    }

    function destroyGridLayout() {
      if (typeof GridLayout !== 'undefined') {
        GridLayout.disconnectContainerGeometry(container);
      }
    }

    return {
      renderGrid,
      hydrateThumbs,
      destroyGridLayout,
      gridCtx,
      interactionCtx,
      getContainer: () => container,
    };
  }

  return {
    mountChrome,
    init,
  };
})();
