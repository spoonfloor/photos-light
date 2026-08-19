/**
 * Photo grid entry point — routes eager share rendering vs virtual library grid.
 */
const PhotoGrid = (() => {
  function render(container, photos, ctx) {
    const caps = ctx.getCapabilities?.() ?? ViewCapabilities.get();
    if (caps.virtual) {
      throw new Error('PhotoGrid.render is for non-virtual surfaces; use PhotoGrid.initVirtual');
    }
    if (typeof SimplePhotoGrid === 'undefined') {
      throw new Error('SimplePhotoGrid is not loaded');
    }
    SimplePhotoGrid.render(container, photos, ctx);
  }

  function initVirtual(hooks) {
    if (typeof VirtualGrid === 'undefined') {
      throw new Error('VirtualGrid is not loaded');
    }
    return VirtualGrid.init(hooks);
  }

  function isVirtualActive() {
    return typeof VirtualGrid !== 'undefined' && VirtualGrid.isActive();
  }

  function destroyVirtual(options = {}) {
    if (typeof VirtualGrid !== 'undefined') {
      VirtualGrid.destroy(options);
    }
  }

  function hydrateThumbs(container, photos, ctx) {
    if (typeof SimplePhotoGrid === 'undefined') {
      return;
    }
    SimplePhotoGrid.hydrateThumbs(container, photos, ctx);
  }

  return {
    render,
    hydrateThumbs,
    initVirtual,
    isVirtualActive,
    destroyVirtual,
  };
})();
