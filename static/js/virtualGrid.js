/**
 * GridView + GridController — timeline virtual grid (single DOM owner).
 */
const VirtualGrid = (() => {
  const monthCache = new Map();
  const monthInflight = new Map();
  let spacer = null;
  let canvas = null;
  let tileLayer = null;
  let contentLayer = null;
  let layout = null;
  let monthIndex = null;
  let sortOrder = 'newest';
  let generation = 0;
  let resizeObserver = null;
  let scrollRaf = null;
  let tileRaf = null;
  let mountedMonths = new Set();
  let committedMonths = new Set();
  /** Months fully hydrated this session — survives virtual unmount for warm revisit. */
  let hydratedMonths = new Set();
  let provisionalYears = [];
  let hooks = {};
  let comfortAnchorY = 0;
  let anchorMonthKey = null;
  let anchorSectionEl = null;
  /** Grid DOM mount deferred while library transition overlay is up (legacy no-op). */
  let pendingContainerMount = null;
  /** Canonical unfiltered month histogram — restored when filters clear. */
  let unfilteredMonthIndex = null;
  /** Catalog filter matched zero photos — overlay inside grid, not alternate renderer. */
  let catalogFilterZeroActive = false;

  function getContainer() {
    return document.getElementById('photoContainer');
  }

  function getScrollElement() {
    return document.scrollingElement || document.documentElement;
  }

  function gridCatalogApiRoot() {
    return hooks.gridCatalogApiRoot || hooks.photosApiRoot || '/api/photos';
  }

  function photosListApiRoot() {
    return hooks.photosApiRoot || '/api/photos';
  }

  function yearsApiUrl() {
    return hooks.yearsApiUrl || '/api/years';
  }

  function mergePhotosIntoState(photos) {
    if (!hooks.mergePhotos || !photos?.length) {
      return;
    }
    hooks.mergePhotos(photos);
  }

  /** Library timeline sort — never adopt import-cluster index sort (recently_added). */
  function librarySortOrder() {
    return hooks.getLibrarySortOrder?.() || sortOrder || 'newest';
  }

  function clearCatalogFilterZeroOverlay() {
    catalogFilterZeroActive = false;
    contentLayer?.querySelector('.catalog-filter-zero')?.remove();
  }

  function mountCatalogFilterZeroOverlay(options = {}) {
    if (!contentLayer) {
      return;
    }
    clearCatalogFilterZeroOverlay();
    const recentImports = Boolean(options.recentImports);
    const heading = recentImports ? 'No recent imports' : 'No results found';
    const detail = recentImports
      ? 'No import dates are available yet.'
      : 'No images match the current filters.';
    const overlay = document.createElement('div');
    overlay.className = 'catalog-filter-zero';
    overlay.innerHTML = `
      <div class="catalog-filter-zero-inner">
        <div class="catalog-filter-zero-copy">
          <div class="catalog-filter-zero-heading">${heading}</div>
          <div class="catalog-filter-zero-detail">${detail}</div>
        </div>
        <button type="button" class="btn btn-primary catalog-filter-zero-clear">Clear filters</button>
      </div>
    `;
    overlay.querySelector('.catalog-filter-zero-clear')?.addEventListener('click', () => {
      hooks.onClearCatalogFilters?.();
    });
    contentLayer.appendChild(overlay);
    catalogFilterZeroActive = true;
    if (spacer) {
      spacer.style.height = '0px';
    }
    if (canvas) {
      canvas.style.height = '0px';
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function applyCatalogFilterZeroMatch(indexPayload, filterOptions = {}) {
    const container = getContainer();
    if (!container || !contentLayer) {
      return false;
    }

    monthInflight.clear();
    hydratedMonths = new Set();
    clearMountedMonths();
    clearComfortLayer();

    monthIndex = indexPayload;
    sortOrder = librarySortOrder();
    const columnLayout = GridLayout.computeColumnLayout(container);
    layout = GridLayout.toLayoutSnapshot(
      GridLayout.buildVirtualLayout([], columnLayout),
    );
    GridLayout.publishCssVars(container, layout);
    updateLabelGate();

    mountCatalogFilterZeroOverlay({
      recentImports: Boolean(filterOptions.importSets),
    });

    if (hooks.onIndexReady) {
      hooks.onIndexReady(indexPayload);
    }
    if (hooks.onLayoutApplied) {
      hooks.onLayoutApplied(layout);
    }
    return true;
  }

  async function fetchMonthPhotos(monthKey) {
    if (monthCache.has(monthKey)) {
      return monthCache.get(monthKey);
    }
    if (monthInflight.has(monthKey)) {
      return monthInflight.get(monthKey);
    }

    const promise = (async () => {
      const response = await fetch(
        `${gridCatalogApiRoot()}/month?month=${encodeURIComponent(monthKey)}&sort=${librarySortOrder()}`,
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Failed to load month ${monthKey}`);
      }
      const photos = data.photos || [];
      monthCache.set(monthKey, photos);
      mergePhotosIntoState(photos);
      return photos;
    })();

    monthInflight.set(monthKey, promise);
    try {
      return await promise;
    } finally {
      monthInflight.delete(monthKey);
    }
  }

  function buildPlaceholderCells(section, grid) {
    grid.replaceChildren();
    for (let i = 0; i < section.count; i += 1) {
      const card = document.createElement('div');
      card.className = 'photo-card virtual-placeholder-card';
      card.dataset.index = String(section.globalStart + i);
      grid.appendChild(card);
    }
  }

  function resetHandoffState() {
    committedMonths = new Set();
  }

  function monthSectionSelector(monthKey) {
    const escaped =
      typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(monthKey)
        : monthKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `.virtual-month-section[data-month="${escaped}"]`;
  }

  function getMountedMonthSection(monthKey) {
    return contentLayer?.querySelector(monthSectionSelector(monthKey)) || null;
  }

  function clearComfortLayer({ hide = true } = {}) {
    if (!tileLayer) {
      return;
    }
    tileLayer.replaceChildren();
    tileLayer.style.height = '0px';
    tileLayer.classList.toggle('grid-comfort-off', hide);
  }

  function publishGridThumbSync(source, detail = {}) {
    if (typeof window === 'undefined') {
      return;
    }
    if (!window.__gridThumbSync) {
      window.__gridThumbSync = { events: [] };
    }
    window.__gridThumbSync.events.push({
      t: Date.now(),
      source,
      ...detail,
    });
    if (window.__gridThumbSync.events.length > 80) {
      window.__gridThumbSync.events.shift();
    }
    window.__gridThumbSync.last = source;
    if (typeof ThumbnailQueue !== 'undefined') {
      window.__gridThumbSync.queue = ThumbnailQueue.getDebugSnapshot();
    }
  }

  function applyThumbnailsToGrid(grid) {
    if (!grid || typeof ThumbnailQueue === 'undefined') {
      return;
    }
    publishGridThumbSync('syncGridAfterLayout', {
      month: grid.closest('[data-month]')?.dataset?.month || null,
    });
    ThumbnailQueue.syncGridAfterLayout(grid);
  }

  function syncStrictThumbnails() {
    if (typeof ThumbnailQueue === 'undefined') {
      return;
    }
    publishGridThumbSync('syncStrictViewport');
    ThumbnailQueue.syncStrictViewport();
  }

  function buildMonthHeaderBand(monthKey) {
    const band = document.createElement('div');
    band.className = 'month-header-band';
    const header = document.createElement('div');
    header.className = 'month-header';
    header.innerHTML = `
      <span class="month-label">${GridLayout.monthLabel(monthKey)}</span>
      <div class="month-select-circle"></div>
    `;
    band.appendChild(header);
    return band;
  }

  function buildPlaceholderMonthSection(section, { pending = false } = {}) {
    const monthKey = section.month;
    const wrapper = document.createElement('div');
    wrapper.className =
      'month-section virtual-month-section virtual-month-placeholder';
    if (pending) {
      wrapper.classList.add('grid-section-pending');
    }
    wrapper.id = `month-${monthKey}`;
    wrapper.dataset.month = monthKey;
    wrapper.style.top = `${section.yStart}px`;

    wrapper.appendChild(buildMonthHeaderBand(monthKey));

    const grid = document.createElement('div');
    grid.className = 'photo-grid';
    buildPlaceholderCells(section, grid);
    wrapper.appendChild(grid);
    return wrapper;
  }

  function buildHydratedGrid(section, photos, filterPhoto) {
    const grid = document.createElement('div');
    grid.className = 'photo-grid';

    const visiblePhotos = filterPhoto ? photos.filter(filterPhoto) : photos;
    visiblePhotos.forEach((photo, localIndex) => {
      const globalIndex = section.globalStart + localIndex;
      const card = document.createElement('div');
      card.className = 'photo-card';
      card.dataset.id = String(photo.id);
      card.dataset.index = String(globalIndex);

      const videoBadgeHTML =
        photo.file_type === 'video'
          ? '<div class="video-badge"><span class="material-symbols-outlined">play_circle</span></div>'
          : '';

      card.innerHTML = `
        <img data-photo-id="${photo.id}" alt="" class="photo-thumb">
        ${typeof buildGridStarBadgeHTML === 'function' ? buildGridStarBadgeHTML(photo.rating === 5) : ''}
        ${videoBadgeHTML}
      `;
      if (typeof applyGridStarBadgeState === 'function') {
        applyGridStarBadgeState(card, photo.rating === 5);
      }
      grid.appendChild(card);
    });
    return grid;
  }

  function hydrateMonthSection(monthKey, section, photos) {
    const wrapper = getMountedMonthSection(monthKey);
    if (!wrapper) {
      return;
    }
    wrapper.classList.remove('virtual-month-placeholder');
    const existingGrid = wrapper.querySelector('.photo-grid');
    const grid = buildHydratedGrid(section, photos, hooks.filterPhoto);
    if (existingGrid) {
      existingGrid.replaceWith(grid);
    } else {
      wrapper.appendChild(grid);
    }
    hydratedMonths.add(monthKey);
    publishGridThumbSync('hydrateMonthSection', { month: monthKey });
    applyThumbnailsToGrid(grid);
  }

  function mountHydratedMonthSection(section) {
    const monthKey = section.month;
    const existing = getMountedMonthSection(monthKey);
    if (existing) {
      mountedMonths.add(monthKey);
      committedMonths.add(monthKey);
      if (existing.classList.contains('virtual-month-placeholder')) {
        const photos = monthCache.get(monthKey);
        if (photos) {
          hydrateMonthSection(monthKey, section, photos);
        }
      }
      return true;
    }

    const photos = monthCache.get(monthKey);
    if (!photos) {
      return false;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'month-section virtual-month-section';
    wrapper.id = `month-${monthKey}`;
    wrapper.dataset.month = monthKey;
    wrapper.style.top = `${section.yStart}px`;

    wrapper.appendChild(buildMonthHeaderBand(monthKey));
    wrapper.appendChild(buildHydratedGrid(section, photos, hooks.filterPhoto));

    contentLayer.appendChild(wrapper);
    mountedMonths.add(monthKey);
    committedMonths.add(monthKey);
    hydratedMonths.add(monthKey);
    applyThumbnailsToGrid(wrapper.querySelector('.photo-grid'));
    if (hooks.onMonthMounted) {
      hooks.onMonthMounted(monthKey);
    }
    return true;
  }

  function unmountMonth(monthKey) {
    const node = getMountedMonthSection(monthKey);
    if (node) {
      node.remove();
    }
    mountedMonths.delete(monthKey);
  }

  function clearMountedMonths() {
    if (contentLayer) {
      contentLayer.innerHTML = '';
    }
    anchorSectionEl = null;
    mountedMonths.clear();
    resetHandoffState();
  }

  function mountPlaceholderSection(section, { pending = true } = {}) {
    const monthKey = section.month;
    const existing = getMountedMonthSection(monthKey);
    if (existing) {
      mountedMonths.add(monthKey);
      if (pending && !committedMonths.has(monthKey)) {
        existing.classList.add('grid-section-pending');
      }
      return true;
    }
    if (mountedMonths.has(monthKey)) {
      return true;
    }

    const placeholder = buildPlaceholderMonthSection(section, { pending });
    contentLayer.appendChild(placeholder);
    mountedMonths.add(monthKey);
    return true;
  }

  function revealCommittedSections(monthKeys) {
    monthKeys.forEach((monthKey) => {
      const node = getMountedMonthSection(monthKey);
      if (!node) {
        return;
      }
      node.classList.remove('grid-section-pending');
      committedMonths.add(monthKey);
    });
  }

  function setSectionsPending(monthKeys, pending) {
    monthKeys.forEach((monthKey) => {
      const node = getMountedMonthSection(monthKey);
      if (!node) {
        return;
      }
      if (pending) {
        node.classList.add('grid-section-pending');
      } else {
        node.classList.remove('grid-section-pending');
      }
    });
  }

  function setComfortVisible(visible) {
    if (!tileLayer) {
      return;
    }
    tileLayer.classList.toggle('grid-comfort-off', !visible);
    if (visible) {
      syncTileLayer();
    }
  }

  async function hydrateMonthIfNeeded(section) {
    const monthKey = section.month;
    if (layout?.provisional) {
      return;
    }
    if (!committedMonths.has(monthKey)) {
      return;
    }

    const wrapper = getMountedMonthSection(monthKey);
    if (!wrapper || !wrapper.classList.contains('virtual-month-placeholder')) {
      return;
    }

    let photos;
    try {
      photos = await fetchMonthPhotos(monthKey);
    } catch (error) {
      console.error(`❌ Failed to load month ${monthKey}:`, error);
      return;
    }

    if (generation !== hooks.getGeneration?.()) {
      return;
    }

    const liveSection = GridLayout.findSectionForMonth(layout, monthKey) || section;
    hydrateMonthSection(monthKey, liveSection, photos);
    syncStrictThumbnails();
    if (hooks.onMonthMounted) {
      hooks.onMonthMounted(monthKey);
    }
  }

  function clearAnchorMonthSection() {
    if (anchorSectionEl) {
      anchorSectionEl.remove();
      anchorSectionEl = null;
    }
  }

  function clearProvisionalArtifacts() {
    clearMountedMonths();
    clearAnchorMonthSection();
    anchorMonthKey = null;
    clearComfortLayer({ hide: true });
  }

  /** Truth-gated month section at scroll 0 during provisional layout (limit=1 month). */
  function buildAnchorMonthSection(monthKey) {
    const wrapper = document.createElement('div');
    wrapper.className = 'month-section grid-anchor-month-section';
    wrapper.id = `anchor-month-${monthKey}`;
    wrapper.dataset.month = monthKey;
    wrapper.dataset.gridAnchorTruth = 'true';
    wrapper.style.top = '0px';

    wrapper.appendChild(buildMonthHeaderBand(monthKey));
    return wrapper;
  }

  function mountAnchorMonthSection() {
    if (!contentLayer || !anchorMonthKey || !layout?.provisional) {
      clearAnchorMonthSection();
      return null;
    }

    if (
      anchorSectionEl &&
      anchorSectionEl.dataset.month === anchorMonthKey &&
      anchorSectionEl.isConnected
    ) {
      return anchorSectionEl;
    }

    clearAnchorMonthSection();
    anchorSectionEl = buildAnchorMonthSection(anchorMonthKey);
    contentLayer.prepend(anchorSectionEl);
    return anchorSectionEl;
  }

  function syncComfortAndContent() {
    if (!layout || catalogFilterZeroActive) {
      return;
    }

    const scrollTop = getScrollElement().scrollTop;
    const viewportHeight = window.innerHeight;
    const mountBuffer = GridLayout.findSectionsInViewport(
      layout,
      scrollTop,
      viewportHeight,
    );
    const strictVisible = GridLayout.findSectionsInStrictViewport(
      layout,
      scrollTop,
      viewportHeight,
    );
    const mountKeys = new Set(mountBuffer.map((section) => section.month));
    const strictKeys = strictVisible.map((section) => section.month);

    if (layout.provisional) {
      mountAnchorMonthSection();
      mountedMonths.forEach((monthKey) => {
        if (!mountKeys.has(monthKey)) {
          unmountMonth(monthKey);
          committedMonths.delete(monthKey);
        }
      });
      mountBuffer.forEach((section) => {
        if (
          hydratedMonths.has(section.month) &&
          monthCache.has(section.month) &&
          mountHydratedMonthSection(section)
        ) {
          return;
        }
        mountPlaceholderSection(section, { pending: true });
      });
      setSectionsPending(strictKeys, true);
      setComfortVisible(true);
      scheduleTileSync();
      publishPhaseATestState('provisional');
      return;
    }

    if (anchorMonthKey) {
      anchorMonthKey = null;
    }
    clearAnchorMonthSection();

    mountedMonths.forEach((monthKey) => {
      if (!mountKeys.has(monthKey)) {
        unmountMonth(monthKey);
        if (!hydratedMonths.has(monthKey)) {
          committedMonths.delete(monthKey);
        }
      }
    });

    mountBuffer.forEach((section) => {
      if (
        hydratedMonths.has(section.month) &&
        monthCache.has(section.month) &&
        mountHydratedMonthSection(section)
      ) {
        return;
      }
      mountPlaceholderSection(section, {
        pending: !committedMonths.has(section.month),
      });
    });

    const strictReady =
      strictKeys.length > 0 &&
      strictKeys.every((monthKey) => mountedMonths.has(monthKey));
    const strictNeedsCommit = strictKeys.some(
      (monthKey) => !committedMonths.has(monthKey),
    );

    if (strictReady && strictNeedsCommit) {
      revealCommittedSections(strictKeys);
      setComfortVisible(false);
      strictVisible.forEach((section) => {
        if (hooks.onMonthMounted) {
          hooks.onMonthMounted(section.month);
        }
        void hydrateMonthIfNeeded(section);
      });
      syncStrictThumbnails();
      return;
    }

    if (strictNeedsCommit || !strictReady) {
      setSectionsPending(strictKeys, true);
      setComfortVisible(true);
      return;
    }

    setSectionsPending(strictKeys, false);
    setComfortVisible(false);
    strictVisible.forEach((section) => {
      void hydrateMonthIfNeeded(section);
    });
    syncStrictThumbnails();
  }

  function buildTileRow(cellsInRow) {
    const row = document.createElement('div');
    row.className = 'grid-tile-row';
    for (let i = 0; i < cellsInRow; i += 1) {
      const cell = document.createElement('div');
      cell.className = 'grid-tile-cell';
      row.appendChild(cell);
    }
    return row;
  }

  function buildTileChunk(yStart, columnLayout) {
    const columns = columnLayout.columns;
    const rhythm = columnLayout.rhythm || GridLayout.readGridRhythmTokens(getContainer());
    const fullRows = rhythm.comfortFullRows;
    const partialCells = GridLayout.comfortPartialCellCount(columnLayout);

    const chunk = document.createElement('div');
    chunk.className = 'grid-tile-chunk';
    chunk.style.top = `${yStart}px`;

    const headerGap = document.createElement('div');
    headerGap.className = 'grid-tile-header-gap';
    chunk.appendChild(headerGap);

    const fullGrid = document.createElement('div');
    fullGrid.className = 'grid-tile-grid';
    for (let row = 0; row < fullRows; row += 1) {
      fullGrid.appendChild(buildTileRow(columns));
    }
    chunk.appendChild(fullGrid);

    const partialGrid = document.createElement('div');
    partialGrid.className = 'grid-tile-grid grid-tile-grid-partial';
    partialGrid.appendChild(buildTileRow(partialCells));
    chunk.appendChild(partialGrid);

    const sectionGap = document.createElement('div');
    sectionGap.className = 'grid-tile-section-gap';
    chunk.appendChild(sectionGap);

    return chunk;
  }

  function syncTileLayer() {
    if (!tileLayer || !layout?.columnLayout || tileLayer.classList.contains('grid-comfort-off')) {
      return;
    }

    const scrollTop = getScrollElement().scrollTop;
    const viewportHeight = window.innerHeight;
    const bufferPx = 1200;
    const chunkHeight = GridLayout.tileChunkHeight(layout.columnLayout);
    if (!chunkHeight) {
      tileLayer.replaceChildren();
      return;
    }

    comfortAnchorY = layout.sections[0]?.yStart ?? 0;
    tileLayer.style.height = `${Math.max(0, layout.totalHeight)}px`;

    const viewStart = Math.max(0, scrollTop - bufferPx);
    const viewEnd = scrollTop + viewportHeight + bufferPx;
    const firstChunk = Math.max(
      0,
      Math.floor((viewStart - comfortAnchorY) / chunkHeight) - 1,
    );
    const lastChunk =
      Math.ceil((viewEnd - comfortAnchorY) / chunkHeight) + 1;

    tileLayer.replaceChildren();
    for (let index = firstChunk; index <= lastChunk; index += 1) {
      tileLayer.appendChild(
        buildTileChunk(comfortAnchorY + index * chunkHeight, layout.columnLayout),
      );
    }
  }

  function scheduleTileSync() {
    if (tileRaf) {
      return;
    }
    tileRaf = window.requestAnimationFrame(() => {
      tileRaf = null;
      syncTileLayer();
    });
  }

  function scheduleSync() {
    if (scrollRaf) {
      return;
    }
    scrollRaf = window.requestAnimationFrame(() => {
      scrollRaf = null;
      syncComfortAndContent();
    });
  }

  function updateLabelGate() {
    const container = getContainer();
    if (!container) {
      return;
    }
    container.classList.toggle('grid-labels-gated', Boolean(layout?.provisional));
  }

  function publishPhaseATestState(phase = 'unknown') {
    if (typeof window === 'undefined') {
      return;
    }
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    const datePickerContainer = document.querySelector('.date-picker');
    const gridLabelEl = contentLayer?.querySelector(
      '.grid-anchor-month-section .month-label',
    );
    const comfortOn = tileLayer && !tileLayer.classList.contains('grid-comfort-off');

    window.__gridPhaseA = {
      phase,
      provisional: Boolean(layout?.provisional),
      anchorMonth: anchorMonthKey,
      comfortVisible: comfortOn,
      gridLabel: gridLabelEl?.textContent?.trim() || null,
      pickerVisible: datePickerContainer?.style.visibility !== 'hidden',
      pickerMonth:
        monthPicker && yearPicker
          ? `${yearPicker.value}-${String(monthPicker.value).padStart(2, '0')}`
          : null,
    };
  }

  function setSnapshot(nextLayout, { remount = false } = {}) {
    const previousLayout = layout;
    layout = GridLayout.toLayoutSnapshot(nextLayout);
    const container = getContainer();
    if (container) {
      GridLayout.publishCssVars(container, layout);
      updateLabelGate();
    }
    if (!spacer || !contentLayer) {
      return;
    }

    const totalHeight = Math.max(0, layout.totalHeight);
    spacer.style.height = `${totalHeight}px`;
    if (canvas) {
      canvas.style.height = `${totalHeight}px`;
    }

    if (
      remount ||
      GridLayout.layoutGeometryChanged(previousLayout, layout)
    ) {
      clearMountedMonths();
    } else {
      resetHandoffState();
    }

    syncComfortAndContent();

    if (hooks.onLayoutApplied) {
      hooks.onLayoutApplied(layout);
    }
  }

  function rememberUnfilteredIndex(indexPayload) {
    if (indexPayload && !indexPayload.filtered) {
      unfilteredMonthIndex = indexPayload;
    }
  }

  function buildMonthIndexUrl(
    _sortOrderNext,
    { starred = false, video = false, importSets = null } = {},
  ) {
    const params = new URLSearchParams({
      sort: librarySortOrder(),
    });
    if (starred) {
      params.set('starred', '1');
    }
    if (video) {
      params.set('video', '1');
    }
    if (importSets) {
      params.set('import_sets', String(importSets));
    }
    return `${gridCatalogApiRoot()}/month_index?${params.toString()}`;
  }

  function catalogFilterActive({ starred = false, video = false, importSets = null } = {}) {
    return Boolean(starred || video || importSets);
  }

  function rebuildLayoutFromIndex(indexPayload, container, options = {}) {
    if (layout?.provisional && !options.keepMounted) {
      clearMountedMonths();
    }
    rememberUnfilteredIndex(indexPayload);
    monthIndex = indexPayload;
    sortOrder = librarySortOrder();
    const columnLayout = GridLayout.computeColumnLayout(container);
    const nextLayout = GridLayout.buildVirtualLayout(
      indexPayload?.months || [],
      columnLayout,
    );
    setSnapshot(nextLayout, {
      remount: options.remount === true,
    });
    return layout;
  }

  function ensureDom() {
    const container = getContainer();
    if (!container) {
      return false;
    }

    container.classList.add('grid-root');
    container.classList.remove('grid-paged');
    GridLayout.invalidateRhythmTokenCache();
    container.innerHTML = `
      <div class="grid-spacer" aria-hidden="true"></div>
      <div class="grid-canvas">
        <div class="grid-tile-layer" aria-hidden="true"></div>
        <div class="grid-content-layer"></div>
      </div>
    `;
    spacer = container.querySelector('.grid-spacer');
    canvas = container.querySelector('.grid-canvas');
    tileLayer = container.querySelector('.grid-tile-layer');
    contentLayer = container.querySelector('.grid-content-layer');
    resetHandoffState();
    return Boolean(spacer && canvas && tileLayer && contentLayer);
  }

  function bindResize(container) {
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
    resizeObserver = new ResizeObserver(() => {
      GridLayout.invalidateRhythmTokenCache();
      const width = container.clientWidth;
      if (monthIndex) {
        const columnLayout = GridLayout.computeColumnLayout(container);
        const nextLayout = GridLayout.toLayoutSnapshot(
          GridLayout.buildVirtualLayout(monthIndex.months || [], columnLayout),
        );
        rebuildLayoutFromIndex(monthIndex, container, {
          remount: GridLayout.layoutGeometryChanged(layout, nextLayout),
        });
        return;
      }
      if (layout?.provisional && layout.totalPhotos > 0) {
        const years =
          provisionalYears.length > 0
            ? provisionalYears
            : GridLayout.defaultProvisionalYears();
        setSnapshot(
          GridLayout.buildProvisionalLayout(
            layout.totalPhotos,
            years,
            GridLayout.computeColumnLayout(container),
            sortOrder,
          ),
          { remount: true },
        );
      }
    });
    resizeObserver.observe(container);
  }

  function bindScroll() {
    window.addEventListener('scroll', scheduleSync, { passive: true });
  }

  function unbindScroll() {
    window.removeEventListener('scroll', scheduleSync);
  }

  function applyProvisionalMount(plan) {
    const container = getContainer();
    if (!container || !ensureDom()) {
      return false;
    }

    sortOrder = plan.sort;
    provisionalYears = plan.provisionalYears || [];
    anchorMonthKey = plan.anchorMonth || null;

    const columnLayout = GridLayout.computeColumnLayout(container);
    GridLayout.publishCssVars(
      container,
      GridLayout.toLayoutSnapshot({ columnLayout, sections: [], totalHeight: 0 }),
    );

    setSnapshot(
      GridLayout.buildProvisionalLayout(
        plan.provisionalTotal,
        plan.provisionalYears,
        columnLayout,
        plan.sort,
      ),
    );

    if (anchorMonthKey) {
      void fetchMonthPhotos(anchorMonthKey);
    }

    bindResize(container);
    bindScroll();
    window.scrollTo({ top: 0, behavior: 'instant' });
    syncComfortAndContent();
    syncTileLayer();
    publishPhaseATestState('phase-a-ready');

    if (hooks.onProvisionalReady) {
      hooks.onProvisionalReady(plan.provisionalMeta);
    }
    return true;
  }

  function applyRefinedIndex(indexPayload) {
    const container = getContainer();
    if (!container) {
      return false;
    }
    if (!contentLayer && !ensureDom()) {
      return false;
    }

    monthIndex = indexPayload;
    sortOrder = indexPayload?.sort || sortOrder;
    const handoffMonth =
      anchorMonthKey || indexPayload?.months?.[0]?.month || null;
    const wasProvisional = Boolean(layout?.provisional);
    if (wasProvisional) {
      clearProvisionalArtifacts();
    }
    rebuildLayoutFromIndex(indexPayload, container, {
      remount: wasProvisional,
    });
    scheduleSync();

    if (wasProvisional) {
      if (handoffMonth) {
        scrollToMonth(handoffMonth);
      } else {
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
    }

    if (hooks.onReady) {
      hooks.onReady(indexPayload, layout);
    }
    return true;
  }

  function applyContainerMount(plan) {
    if (plan.hasProvisional) {
      applyProvisionalMount(plan);
    } else if (!contentLayer) {
      const container = getContainer();
      if (!container || !ensureDom()) {
        return false;
      }
      bindResize(container);
      bindScroll();
    }

    return applyRefinedIndex(plan.indexPayload);
  }

  function commitContainerMount() {
    if (pendingContainerMount) {
      const plan = pendingContainerMount;
      pendingContainerMount = null;
      return applyContainerMount(plan);
    }
    return Boolean(layout && contentLayer);
  }

  function cancelPendingContainerMount() {
    pendingContainerMount = null;
  }

  async function init(options = {}) {
    destroy();
    hooks = options;
    generation = hooks.getGeneration?.() ?? 0;
    const deferContainerMount = !!options.deferContainerMount;

    const container = getContainer();
    if (!container) {
      return false;
    }
    if (!deferContainerMount && !ensureDom()) {
      return false;
    }

    const sort = options.sortOrder || 'newest';
    let provisionalTotal = 0;
    let anchorMonth = null;
    provisionalYears = [];

    try {
      const [countResponse, yearsResponse] = await Promise.all([
        fetch(`${photosListApiRoot()}?limit=1&sort=${encodeURIComponent(sort)}`, {
          signal: options.signal,
        }),
        fetch(yearsApiUrl(), { signal: options.signal }),
      ]);
      const countPayload = await countResponse.json();
      if (!countResponse.ok) {
        throw new Error(countPayload.error || 'Failed to load photo count');
      }
      provisionalTotal = countPayload.total ?? 0;

      const anchorPhoto = countPayload.photos?.[0];
      if (anchorPhoto?.month && /^\d{4}-\d{2}$/.test(anchorPhoto.month)) {
        anchorMonth = anchorPhoto.month;
      }
      if (anchorPhoto) {
        mergePhotosIntoState([anchorPhoto]);
      }

      if (yearsResponse.ok) {
        const yearsPayload = await yearsResponse.json();
        if (Array.isArray(yearsPayload?.years)) {
          provisionalYears = yearsPayload.years;
        }
      }
    } catch (error) {
      if (options.signal?.aborted || error.name === 'AbortError') {
        throw error;
      }
      console.warn('Provisional grid bootstrap unavailable:', error);
    }

    if (generation !== hooks.getGeneration?.()) {
      return false;
    }

    const yearsForProvisional =
      provisionalYears.length > 0
        ? provisionalYears
        : provisionalTotal > 0
          ? GridLayout.defaultProvisionalYears()
          : [];
    const hasProvisional =
      provisionalTotal > 0 && yearsForProvisional.length > 0;

    if (hasProvisional) {
      if (options.onPhaseAAnchor) {
        options.onPhaseAAnchor({
          total: provisionalTotal,
          years: yearsForProvisional,
          anchorMonth,
        });
      }

      applyProvisionalMount({
        sort,
        provisionalTotal,
        anchorMonth,
        provisionalYears: yearsForProvisional,
        provisionalMeta: {
          total: provisionalTotal,
          years: yearsForProvisional,
          anchorMonth,
        },
      });
    }

    const indexResponse = await fetch(
      `${gridCatalogApiRoot()}/month_index?sort=${encodeURIComponent(sort)}`,
      { signal: options.signal },
    );
    const indexPayload = await indexResponse.json();
    if (!indexResponse.ok) {
      throw new Error(indexPayload.error || 'Failed to load month index');
    }

    if (generation !== hooks.getGeneration?.()) {
      return false;
    }

    if (options.onIndexReady) {
      options.onIndexReady(indexPayload);
    }

    if (deferContainerMount && !hasProvisional) {
      pendingContainerMount = {
        sort,
        provisionalTotal,
        anchorMonth,
        provisionalYears: [],
        hasProvisional: false,
        indexPayload,
      };
      return true;
    }

    return applyRefinedIndex(indexPayload);
  }

  function destroy() {
    cancelPendingContainerMount();
    if (scrollRaf) {
      window.cancelAnimationFrame(scrollRaf);
      scrollRaf = null;
    }
    if (tileRaf) {
      window.cancelAnimationFrame(tileRaf);
      tileRaf = null;
    }
    unbindScroll();
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    const container = getContainer();
    if (container) {
      container.classList.remove('grid-root', 'grid-paged', 'grid-labels-gated');
      container.style.removeProperty('--grid-cols');
      container.style.removeProperty('--grid-cell-px');
    }
    GridLayout.invalidateRhythmTokenCache();
    if (canvas) {
      canvas.style.removeProperty('height');
    }
    spacer = null;
    canvas = null;
    tileLayer = null;
    contentLayer = null;
    layout = null;
    monthIndex = null;
    anchorMonthKey = null;
    clearAnchorMonthSection();
    provisionalYears = [];
    mountedMonths = new Set();
    committedMonths = new Set();
    hydratedMonths = new Set();
    monthCache.clear();
    if (typeof ThumbnailQueue !== 'undefined') {
      ThumbnailQueue.clear();
    }
    monthInflight.clear();
    hooks = {};
    unfilteredMonthIndex = null;
    catalogFilterZeroActive = false;
  }

  function jumpToMonth(monthKey, options = {}) {
    if (!layout || !monthKey) {
      return false;
    }

    const resolvedMonth = GridLayout.resolveJumpMonth(
      layout,
      monthKey,
      monthIndex,
      librarySortOrder(),
    );
    if (!resolvedMonth) {
      return false;
    }

    const top = GridLayout.scrollTopForMonth(
      layout,
      resolvedMonth,
      options.appBarOffset,
    );
    if (top === null) {
      return false;
    }

    const behavior = options.behavior ?? 'instant';
    window.scrollTo({ top, behavior });
    scheduleSync();
    publishGridThumbSync('jumpToMonth', {
      month: monthKey,
      resolvedMonth,
      behavior,
    });
    return true;
  }

  function scrollToMonth(monthKey, behavior = 'instant') {
    return jumpToMonth(monthKey, { behavior });
  }

  function invalidateMonth(monthKey) {
    monthCache.delete(monthKey);
    committedMonths.delete(monthKey);
    hydratedMonths.delete(monthKey);
    if (mountedMonths.has(monthKey)) {
      unmountMonth(monthKey);
      const section = GridLayout.findSectionForMonth(layout, monthKey);
      if (section) {
        mountPlaceholderSection(section, { pending: true });
        scheduleSync();
      }
    }
  }

  function patchCachedPhotos(patches) {
    if (!patches?.length) {
      return;
    }
    const patchById = new Map(patches.map((patch) => [patch.id, patch]));
    for (const [monthKey, photos] of monthCache.entries()) {
      for (const photo of photos) {
        const patch = patchById.get(photo.id);
        if (!patch) {
          continue;
        }
        if (patch.rating !== undefined) {
          photo.rating = patch.rating;
        }
        if (patch.path !== undefined) {
          photo.path = patch.path;
        }
        if (patch.date !== undefined) {
          photo.date = patch.date;
        }
        if (patch.month !== undefined) {
          photo.month = patch.month;
        }
      }
    }

    for (const [photoId, patch] of patchById) {
      if (patch.rating === undefined) {
        continue;
      }
      const card = contentLayer?.querySelector(
        `.photo-card[data-id="${photoId}"]`,
      );
      if (!card) {
        continue;
      }
      if (typeof applyGridStarBadgeState === 'function') {
        applyGridStarBadgeState(card, patch.rating === 5);
      }
    }
  }

  function findCachedPhoto(photoId) {
    for (const [monthKey, photos] of monthCache.entries()) {
      const photo = photos.find((item) => item.id === photoId);
      if (photo) {
        return { monthKey, photo, photos };
      }
    }
    return null;
  }

  function monthIndexCount(monthKey) {
    return (
      (monthIndex?.months || []).find((entry) => entry.month === monthKey)
        ?.count || 0
    );
  }

  function sortMonthPhotos(photos) {
    if (!photos?.length || typeof hooks.comparePhotos !== 'function') {
      return photos ? [...photos] : [];
    }
    return [...photos].sort(hooks.comparePhotos);
  }

  function insertPhotoInMonthCache(monthKey, photo) {
    const existing = monthCache.get(monthKey) || [];
    const without = existing.filter((entry) => entry.id !== photo.id);
    const next = sortMonthPhotos([...without, photo]);
    monthCache.set(monthKey, next);
    return next;
  }

  async function fetchMonthPhotosFresh(monthKey) {
    monthCache.delete(monthKey);
    monthInflight.delete(monthKey);
    return fetchMonthPhotos(monthKey);
  }

  async function hydrateDestinationMonthAfterMove(newMonth, movedPhoto, photoId) {
    try {
      const serverPhotos = await fetchMonthPhotosFresh(newMonth);
      const without = serverPhotos.filter((entry) => entry.id !== photoId);
      monthCache.set(newMonth, sortMonthPhotos([...without, movedPhoto]));
    } catch (error) {
      console.error(`Failed to hydrate ${newMonth} after month move:`, error);
      monthCache.set(newMonth, [movedPhoto]);
    }
    rebuildMountedHydratedMonth(newMonth);
    scheduleSync();
  }

  function applyLayoutGeometryFromIndex(indexPayload) {
    const container = getContainer();
    if (!container || !indexPayload) {
      return null;
    }

    monthIndex = indexPayload;
    const columnLayout = GridLayout.computeColumnLayout(container);
    const nextLayout = GridLayout.toLayoutSnapshot(
      GridLayout.buildVirtualLayout(indexPayload.months || [], columnLayout),
    );

    layout = nextLayout;
    GridLayout.publishCssVars(container, layout);

    const totalHeight = Math.max(0, layout.totalHeight);
    if (spacer) {
      spacer.style.height = `${totalHeight}px`;
    }
    if (canvas) {
      canvas.style.height = `${totalHeight}px`;
    }

    const activeMonths = new Set((layout.sections || []).map((section) => section.month));
    for (const monthKey of [...mountedMonths]) {
      if (!activeMonths.has(monthKey)) {
        unmountMonth(monthKey);
      }
    }

    for (const section of layout.sections || []) {
      const wrapper = getMountedMonthSection(section.month);
      if (wrapper) {
        wrapper.style.top = `${section.yStart}px`;
      }
    }

    if (hooks.onIndexReady) {
      hooks.onIndexReady(indexPayload);
    }
    if (hooks.onLayoutApplied) {
      hooks.onLayoutApplied(layout);
    }

    scheduleSync();
    return layout;
  }

  function applyFilterRowChange(photoId) {
    if (!hooks.filterPhoto || !layout || !monthIndex) {
      return false;
    }

    const cached = findCachedPhoto(photoId);
    if (!cached) {
      return false;
    }

    const card = contentLayer?.querySelector(`.photo-card[data-id="${photoId}"]`);
    const shouldShow = hooks.filterPhoto(cached.photo);
    let delta = 0;
    if (shouldShow && !card) {
      delta = 1;
    } else if (!shouldShow && card) {
      delta = -1;
    } else {
      return true;
    }

    const patchedIndex = GridLayout.patchMonthIndexDelta(
      monthIndex,
      cached.monthKey,
      delta,
    );
    if ((patchedIndex.total ?? 0) === 0) {
      applyCatalogFilterZeroMatch(
        patchedIndex,
        hooks.getCatalogFilterOptions?.() || {},
      );
      return 'zero';
    }

    if (!applyLayoutGeometryFromIndex(patchedIndex)) {
      return false;
    }

    const section = GridLayout.findSectionForMonth(layout, cached.monthKey);
    if (!section) {
      return true;
    }

    const wrapper = getMountedMonthSection(cached.monthKey);
    const existingGrid = wrapper?.querySelector('.photo-grid');
    if (!wrapper || !existingGrid) {
      return true;
    }

    const visiblePhotos = visibleMonthPhotos(cached.photos);
    if (!visiblePhotos.length) {
      unmountMonth(cached.monthKey);
      return true;
    }

    const grid = buildHydratedGrid(section, cached.photos, hooks.filterPhoto);
    existingGrid.replaceWith(grid);
    applyThumbnailsToGrid(grid);
    if (hooks.onMonthMounted) {
      hooks.onMonthMounted(cached.monthKey);
    }
    return true;
  }

  function isPhotoVisibleInCurrentIndex(photo) {
    return hooks.filterPhoto ? hooks.filterPhoto(photo) : true;
  }

  function rebuildMountedHydratedMonth(monthKey) {
    const section = GridLayout.findSectionForMonth(layout, monthKey);
    const wrapper = getMountedMonthSection(monthKey);
    const existingGrid = wrapper?.querySelector('.photo-grid');
    if (!section) {
      unmountMonth(monthKey);
      return true;
    }
    if (!wrapper || !existingGrid) {
      return true;
    }

    const photos = monthCache.get(monthKey) || [];
    const visiblePhotos = visibleMonthPhotos(photos);
    if (!visiblePhotos.length) {
      unmountMonth(monthKey);
      return true;
    }

    const grid = buildHydratedGrid(section, photos, hooks.filterPhoto);
    existingGrid.replaceWith(grid);
    applyThumbnailsToGrid(grid);
    if (hooks.onMonthMounted) {
      hooks.onMonthMounted(monthKey);
    }
    return true;
  }

  function applyPhotoDeletes(photoIds) {
    if (!layout || !monthIndex) {
      return null;
    }

    const idSet = new Set((photoIds || []).map((id) => Number(id)));
    if (!idSet.size) {
      return null;
    }

    const token = {
      months: [],
    };
    const monthCounts = new Map();
    const affectedMonths = new Set();

    for (const [monthKey, photos] of monthCache.entries()) {
      const removedPhotos = photos.filter((photo) => idSet.has(photo.id));
      if (!removedPhotos.length) {
        continue;
      }

      affectedMonths.add(monthKey);
      token.months.push({
        monthKey,
        beforePhotos: [...photos],
        removedPhotos,
      });
      monthCache.set(
        monthKey,
        photos.filter((photo) => !idSet.has(photo.id)),
      );

      const visibleRemoved = removedPhotos.filter(isPhotoVisibleInCurrentIndex).length;
      if (visibleRemoved > 0) {
        monthCounts.set(monthKey, visibleRemoved);
      }
    }

    if (!token.months.length) {
      return null;
    }

    if (monthCounts.size) {
      const patchedIndex = GridLayout.patchPhotoDeletes(monthIndex, monthCounts);
      if (!applyLayoutGeometryFromIndex(patchedIndex)) {
        return null;
      }
    } else {
      scheduleSync();
    }

    affectedMonths.forEach(rebuildMountedHydratedMonth);
    return token;
  }

  function restorePhotoDeletes(token, photoIds) {
    if (!token?.months?.length || !layout || !monthIndex) {
      return false;
    }

    const idSet = new Set(
      (photoIds?.length
        ? photoIds
        : token.months.flatMap((entry) => entry.removedPhotos.map((photo) => photo.id))
      ).map((id) => Number(id)),
    );
    if (!idSet.size) {
      return false;
    }

    const monthCounts = new Map();
    const affectedMonths = new Set();

    token.months.forEach(({ monthKey, beforePhotos, removedPhotos }) => {
      const restorePhotos = removedPhotos.filter((photo) => idSet.has(photo.id));
      if (!restorePhotos.length) {
        return;
      }

      const currentPhotos = monthCache.get(monthKey) || [];
      const currentIds = new Set(currentPhotos.map((photo) => photo.id));
      const restoreIds = new Set(restorePhotos.map((photo) => photo.id));
      const beforeIds = new Set(beforePhotos.map((photo) => photo.id));
      const nextPhotos = beforePhotos.filter(
        (photo) => currentIds.has(photo.id) || restoreIds.has(photo.id),
      );

      currentPhotos.forEach((photo) => {
        if (!beforeIds.has(photo.id) && !restoreIds.has(photo.id)) {
          nextPhotos.push(photo);
        }
      });

      monthCache.set(monthKey, nextPhotos);
      affectedMonths.add(monthKey);

      const visibleRestored = restorePhotos.filter(isPhotoVisibleInCurrentIndex).length;
      if (visibleRestored > 0) {
        monthCounts.set(monthKey, visibleRestored);
      }
    });

    if (!affectedMonths.size) {
      return false;
    }

    if (monthCounts.size) {
      let patchedIndex = monthIndex;
      monthCounts.forEach((delta, monthKey) => {
        patchedIndex = GridLayout.patchMonthIndexDelta(
          patchedIndex,
          monthKey,
          delta,
        );
      });
      if (!applyLayoutGeometryFromIndex(patchedIndex)) {
        return false;
      }
    } else {
      scheduleSync();
    }

    affectedMonths.forEach(rebuildMountedHydratedMonth);
    return true;
  }

  function applyDateMonthMove(photoId, oldMonth, newMonth, updatedPhoto = {}) {
    if (!layout || !monthIndex || !oldMonth || !newMonth || oldMonth === newMonth) {
      return null;
    }

    const id = Number(photoId);
    let sourceMonth = oldMonth;
    let sourcePhotos = monthCache.get(oldMonth) || [];
    let sourceIndex = sourcePhotos.findIndex((photo) => photo.id === id);

    if (sourceIndex === -1) {
      const cached = findCachedPhoto(id);
      if (!cached) {
        return null;
      }
      sourceMonth = cached.monthKey;
      sourcePhotos = cached.photos;
      sourceIndex = sourcePhotos.findIndex((photo) => photo.id === id);
      if (sourceIndex === -1) {
        return null;
      }
    }

    const beforeOldPhotos = [...sourcePhotos];
    const movedPhoto = { ...sourcePhotos[sourceIndex], ...updatedPhoto };
    const afterOldPhotos = sourcePhotos.filter((photo) => photo.id !== id);
    monthCache.set(sourceMonth, afterOldPhotos);

    const newMonthPhotos = monthCache.get(newMonth) || [];
    const beforeNewPhotos = [...newMonthPhotos];
    const destCountBefore = monthIndexCount(newMonth);
    let destHydrateAsync = false;

    if (monthCache.has(newMonth)) {
      insertPhotoInMonthCache(newMonth, movedPhoto);
    } else if (destCountBefore === 0) {
      monthCache.set(newMonth, [movedPhoto]);
    } else {
      destHydrateAsync = true;
    }

    const token = {
      moves: [
        {
          photoId: id,
          oldMonth: sourceMonth,
          newMonth,
          movedPhoto: beforeOldPhotos[sourceIndex],
          oldMonthBeforePhotos: beforeOldPhotos,
          newMonthBeforePhotos: beforeNewPhotos,
        },
      ],
    };

    const visibleRemoved = isPhotoVisibleInCurrentIndex(beforeOldPhotos[sourceIndex])
      ? 1
      : 0;
    const visibleAdded = isPhotoVisibleInCurrentIndex(movedPhoto) ? 1 : 0;
    let patchedIndex = monthIndex;

    if (visibleRemoved > 0) {
      patchedIndex = GridLayout.patchMonthIndexDelta(
        patchedIndex,
        sourceMonth,
        -visibleRemoved,
      );
    }
    if (visibleAdded > 0) {
      patchedIndex = GridLayout.patchMonthIndexDelta(
        patchedIndex,
        newMonth,
        visibleAdded,
      );
    }

    if (visibleRemoved > 0 || visibleAdded > 0) {
      if (!applyLayoutGeometryFromIndex(patchedIndex)) {
        monthCache.set(sourceMonth, beforeOldPhotos);
        monthCache.set(newMonth, beforeNewPhotos);
        return null;
      }
    } else {
      scheduleSync();
    }

    rebuildMountedHydratedMonth(sourceMonth);
    if (destHydrateAsync) {
      void hydrateDestinationMonthAfterMove(newMonth, movedPhoto, id);
    } else {
      rebuildMountedHydratedMonth(newMonth);
    }
    return token;
  }

  function resortMonthCachePhoto(photoId) {
    const cached = findCachedPhoto(Number(photoId));
    if (!cached) {
      return false;
    }
    monthCache.set(cached.monthKey, sortMonthPhotos(cached.photos));
    return rebuildMountedHydratedMonth(cached.monthKey);
  }

  function restoreDateMonthMove(token, photoIds) {
    if (!token?.moves?.length || !layout || !monthIndex) {
      return false;
    }

    const idSet = new Set(
      (photoIds?.length
        ? photoIds
        : token.moves.map((entry) => entry.photoId)
      ).map((id) => Number(id)),
    );
    if (!idSet.size) {
      return false;
    }

    const monthCounts = new Map();
    const affectedMonths = new Set();

    token.moves.forEach(
      ({
        photoId,
        oldMonth,
        newMonth,
        movedPhoto,
        oldMonthBeforePhotos,
      }) => {
        if (!idSet.has(photoId)) {
          return;
        }

        const currentNewPhotos = monthCache.get(newMonth) || [];
        monthCache.set(
          newMonth,
          currentNewPhotos.filter((photo) => photo.id !== photoId),
        );
        monthCache.set(oldMonth, [...oldMonthBeforePhotos]);
        affectedMonths.add(oldMonth);
        affectedMonths.add(newMonth);

        if (isPhotoVisibleInCurrentIndex(movedPhoto)) {
          monthCounts.set(newMonth, (monthCounts.get(newMonth) || 0) - 1);
          monthCounts.set(oldMonth, (monthCounts.get(oldMonth) || 0) + 1);
        }
      },
    );

    if (!affectedMonths.size) {
      return false;
    }

    if (monthCounts.size) {
      let patchedIndex = monthIndex;
      monthCounts.forEach((delta, monthKey) => {
        patchedIndex = GridLayout.patchMonthIndexDelta(
          patchedIndex,
          monthKey,
          delta,
        );
      });
      if (!applyLayoutGeometryFromIndex(patchedIndex)) {
        return false;
      }
    } else {
      scheduleSync();
    }

    affectedMonths.forEach(rebuildMountedHydratedMonth);
    return true;
  }

  function rebuildMountedMonthForPhoto(photoId) {
    const cached = findCachedPhoto(Number(photoId));
    if (!cached) {
      return false;
    }
    return rebuildMountedHydratedMonth(cached.monthKey);
  }

  function invalidateAllMonths() {
    monthCache.clear();
    monthInflight.clear();
    hydratedMonths = new Set();
    clearMountedMonths();
    scheduleSync();
  }

  function setFilterPhoto(filterPhoto) {
    hooks.filterPhoto = typeof filterPhoto === 'function' ? filterPhoto : null;
  }

  function resolvePhotoForSelectionScope(photoId) {
    const normalizedId = Number(photoId);
    const cached = findCachedPhoto(normalizedId);
    if (cached?.photo) {
      return cached.photo;
    }
    if (typeof hooks.findPhotoInState === 'function') {
      const fromState = hooks.findPhotoInState(normalizedId);
      if (fromState) {
        return fromState;
      }
    }
    const card = contentLayer?.querySelector(
      `.photo-card[data-id="${normalizedId}"]`,
    );
    if (card) {
      const monthKey = card.closest('.month-section')?.dataset?.month;
      if (monthKey) {
        return { id: normalizedId, month: monthKey };
      }
    }
    return null;
  }

  function buildSelectionScopeIndex(selectedIds, catalogFilterPhoto = null) {
    const idSet = new Set([...selectedIds].map((id) => Number(id)));
    const monthCounts = new Map();
    let total = 0;

    for (const photoId of idSet) {
      const photo = resolvePhotoForSelectionScope(photoId);
      if (!photo) {
        continue;
      }
      if (catalogFilterPhoto && !catalogFilterPhoto(photo)) {
        continue;
      }
      const monthKey = photo.month || 'undated';
      monthCounts.set(monthKey, (monthCounts.get(monthKey) || 0) + 1);
      total += 1;
    }

    const sort = librarySortOrder();
    const months = GridLayout.sortMonthEntries(
      [...monthCounts.entries()].map(([month, count]) => ({ month, count })),
      sort,
    );
    const undatedEntry = months.find((entry) => entry.month === 'undated');
    return {
      months,
      total,
      undated_count: undatedEntry?.count || 0,
      sort,
      section_axis: monthIndex?.section_axis || 'date_taken',
      filtered: true,
      selectionScope: true,
    };
  }

  /**
   * Rebuild layout from a client-built index of selected photo IDs (no server round-trip).
   */
  async function applySelectionScope(selectedIds, catalogFilterPhoto = null) {
    const container = getContainer();
    if (!container || !layout) {
      return false;
    }

    clearCatalogFilterZeroOverlay();

    const previousScrollTop = getScrollElement().scrollTop;
    const preserveMonth = layout.provisional
      ? null
      : GridLayout.findMonthAtScrollTop(layout, previousScrollTop, 80);

    const indexPayload = buildSelectionScopeIndex(
      selectedIds,
      catalogFilterPhoto,
    );
    if ((indexPayload.total ?? 0) === 0) {
      applyCatalogFilterZeroMatch(indexPayload, {});
      return 'zero';
    }

    if (monthCache.size > 0 && !layout.provisional) {
      if (applyCatalogFilterWarm(indexPayload, preserveMonth)) {
        if (hooks.onIndexReady) {
          hooks.onIndexReady(indexPayload);
        }
        return true;
      }
    }

    monthInflight.clear();
    hydratedMonths = new Set();
    clearMountedMonths();
    rebuildLayoutFromIndex(indexPayload, container, { remount: true });
    if (hooks.onIndexReady) {
      hooks.onIndexReady(indexPayload);
    }
    scheduleSync();
    restoreScrollMonthAfterLayoutChange(indexPayload, preserveMonth);
    return true;
  }

  function restoreScrollMonthAfterLayoutChange(indexPayload, preserveMonth) {
    if (preserveMonth) {
      const resolvedMonth = GridLayout.resolveJumpMonth(
        layout,
        preserveMonth,
        indexPayload,
        sortOrder,
      );
      if (resolvedMonth) {
        scrollToMonth(resolvedMonth);
        return;
      }
    }
    const anchor = indexPayload?.months?.[0]?.month || null;
    if (anchor) {
      scrollToMonth(anchor);
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }

  /**
   * Update layout + mounted sections in place. Month hydration cache stays warm.
   */
  function applyCatalogFilterWarm(indexPayload, preserveMonth) {
    if (!applyLayoutGeometryFromIndex(indexPayload)) {
      return false;
    }

    rememberUnfilteredIndex(indexPayload);

    const activeMonths = new Set(
      (layout?.sections || []).map((section) => section.month),
    );

    for (const monthKey of [...mountedMonths]) {
      if (!activeMonths.has(monthKey)) {
        unmountMonth(monthKey);
        hydratedMonths.delete(monthKey);
        continue;
      }
      if (hydratedMonths.has(monthKey) && monthCache.has(monthKey)) {
        rebuildMountedHydratedMonth(monthKey);
      } else {
        unmountMonth(monthKey);
      }
    }

    scheduleSync();
    restoreScrollMonthAfterLayoutChange(indexPayload, preserveMonth);
    return true;
  }

  /**
   * Rebuild layout from filtered (or restored unfiltered) month_index — no grid destroy.
   * Returns 'zero' when the active catalog filter matches zero photos (in-grid overlay).
   */
  async function applyCatalogFilter({
    starred = false,
    video = false,
    importSets = null,
  } = {}) {
    const filterOptions = { starred, video, importSets };
    const container = getContainer();
    if (!container || !layout) {
      return false;
    }

    clearCatalogFilterZeroOverlay();

    const hasFilter = catalogFilterActive(filterOptions);
    const previousScrollTop = getScrollElement().scrollTop;
    const previousAxis = monthIndex?.section_axis || 'date_taken';
    const preserveMonth = layout.provisional
      ? null
      : GridLayout.findMonthAtScrollTop(layout, previousScrollTop, 80);

    let indexPayload;
    if (!hasFilter) {
      if (unfilteredMonthIndex) {
        indexPayload = unfilteredMonthIndex;
      } else {
        const response = await fetch(buildMonthIndexUrl(librarySortOrder(), {}));
        indexPayload = await response.json();
        if (!response.ok) {
          throw new Error(indexPayload.error || 'Failed to restore month index');
        }
      }
    } else {
      const response = await fetch(
        buildMonthIndexUrl(librarySortOrder(), filterOptions),
      );
      indexPayload = await response.json();
      if (!response.ok) {
        throw new Error(indexPayload.error || 'Failed to load filtered month index');
      }
      if ((indexPayload.total ?? 0) === 0) {
        applyCatalogFilterZeroMatch(indexPayload, filterOptions);
        return 'zero';
      }
    }

    const nextAxis = indexPayload?.section_axis || 'date_taken';
    const axisChanged = previousAxis !== nextAxis;
    const scrollPreserveMonth = axisChanged ? null : preserveMonth;

    const canWarmRestore =
      !hasFilter &&
      unfilteredMonthIndex &&
      indexPayload === unfilteredMonthIndex &&
      !layout.provisional;
    const canWarmApply =
      hasFilter && monthCache.size > 0 && !layout.provisional && !axisChanged;

    if (canWarmRestore || canWarmApply) {
      if (applyCatalogFilterWarm(indexPayload, scrollPreserveMonth)) {
        if (hooks.onIndexReady) {
          hooks.onIndexReady(indexPayload);
        }
        return true;
      }
    }

    monthInflight.clear();
    hydratedMonths = new Set();
    clearMountedMonths();
    rebuildLayoutFromIndex(indexPayload, container, { remount: true });
    if (hooks.onIndexReady) {
      hooks.onIndexReady(indexPayload);
    }
    scheduleSync();
    restoreScrollMonthAfterLayoutChange(indexPayload, scrollPreserveMonth);
    return true;
  }

  async function refreshMonthIndex(sortOrderNext = sortOrder, options = {}) {
    const {
      scrollTargetMonth = null,
      preserveScroll = true,
      starred = false,
      video = false,
      importSets = null,
    } = options;
    const filterOptions = { starred, video, importSets };
    const container = getContainer();
    if (!container) {
      return false;
    }
    const wasProvisional = Boolean(layout?.provisional);
    const previousScrollTop = getScrollElement().scrollTop;
    const previousHeight = layout?.totalHeight ?? 0;
    const preserveMonth =
      preserveScroll && layout && !wasProvisional
        ? GridLayout.findMonthAtScrollTop(layout, previousScrollTop, 80)
        : null;
    const handoffMonth =
      scrollTargetMonth ||
      anchorMonthKey ||
      null;

    const response = await fetch(
      buildMonthIndexUrl(sortOrderNext || librarySortOrder(), filterOptions),
    );
    const indexPayload = await response.json();
    if (!response.ok) {
      throw new Error(indexPayload.error || 'Failed to refresh month index');
    }
    const hasFilter = catalogFilterActive(filterOptions);
    if (hasFilter && (indexPayload.total ?? 0) === 0) {
      applyCatalogFilterZeroMatch(indexPayload, filterOptions);
      return 'zero';
    }
    clearCatalogFilterZeroOverlay();
    sortOrder = sortOrderNext || librarySortOrder();
    monthCache.clear();
    monthInflight.clear();
    hydratedMonths = new Set();
    clearMountedMonths();
    rebuildLayoutFromIndex(indexPayload, container, { remount: true });
    if (hooks.onIndexReady) {
      hooks.onIndexReady(indexPayload);
    }
    scheduleSync();

    const nextHeight = layout?.totalHeight ?? 0;
    const maxScrollTop = Math.max(
      0,
      nextHeight - (window.innerHeight || document.documentElement.clientHeight),
    );

    if (scrollTargetMonth) {
      scrollToMonth(scrollTargetMonth);
    } else if (wasProvisional) {
      const anchor = handoffMonth || indexPayload?.months?.[0]?.month || null;
      if (anchor) {
        scrollToMonth(anchor);
      } else {
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
    } else if (preserveMonth) {
      restoreScrollMonthAfterLayoutChange(indexPayload, preserveMonth);
    } else if (previousScrollTop > maxScrollTop + 1) {
      const anchor = indexPayload?.months?.[0]?.month || null;
      if (anchor) {
        scrollToMonth(anchor);
      } else {
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
    }

    return true;
  }

  function visibleMonthPhotos(photos) {
    return hooks.filterPhoto ? photos.filter(hooks.filterPhoto) : photos;
  }

  function globalIndexInSection(section, photos, photoId) {
    const localIndex = visibleMonthPhotos(photos).findIndex(
      (photo) => photo.id === photoId,
    );
    if (localIndex === -1) {
      return null;
    }
    return section.globalStart + localIndex;
  }

  /** Grid timeline index for a photo (DOM or loaded month cache). */
  function getGlobalIndexForPhotoId(photoId) {
    const card = document.querySelector(`.photo-card[data-id="${photoId}"]`);
    if (card) {
      const index = parseInt(card.dataset.index, 10);
      if (!Number.isNaN(index)) {
        return index;
      }
    }
    if (!layout?.sections) {
      return null;
    }
    for (const section of layout.sections) {
      const photos = monthCache.get(section.month);
      if (!photos) {
        continue;
      }
      const globalIndex = globalIndexInSection(section, photos, photoId);
      if (globalIndex !== null) {
        return globalIndex;
      }
    }
    return null;
  }

  /** Load month if needed, then resolve grid timeline index. */
  async function resolveGlobalIndexForPhotoId(photoId, monthKey) {
    const cached = getGlobalIndexForPhotoId(photoId);
    if (cached !== null) {
      return cached;
    }
    if (!layout?.sections || !monthKey) {
      return null;
    }
    const section = GridLayout.findSectionForMonth(layout, monthKey);
    if (!section) {
      return null;
    }
    let photos;
    try {
      photos = await fetchMonthPhotos(monthKey);
    } catch {
      return null;
    }
    return globalIndexInSection(section, photos, photoId);
  }

  /** Photo at a grid timeline index (loads month bucket on demand). */
  async function resolvePhotoAtGlobalIndex(globalIndex) {
    if (!layout?.sections || globalIndex < 0 || globalIndex >= layout.totalPhotos) {
      return null;
    }
    const section = GridLayout.findSectionForGlobalIndex(layout, globalIndex);
    if (!section) {
      return null;
    }
    let photos;
    try {
      photos = await fetchMonthPhotos(section.month);
    } catch {
      return null;
    }
    const visible = visibleMonthPhotos(photos);
    const localIndex = globalIndex - section.globalStart;
    if (localIndex < 0 || localIndex >= visible.length) {
      return null;
    }
    return visible[localIndex];
  }

  function getLayout() {
    return layout;
  }

  function getPhaseAState() {
    publishPhaseATestState(layout?.provisional ? 'provisional' : 'refined');
    return window.__gridPhaseA || null;
  }

  function isCatalogFilterZeroActive() {
    return catalogFilterZeroActive;
  }

  function isActive() {
    const container = getContainer();
    return Boolean(
      layout &&
        contentLayer &&
        contentLayer.isConnected &&
        container &&
        container.contains(contentLayer),
    );
  }

  return {
    init,
    destroy,
    commitContainerMount,
    cancelPendingContainerMount,
    jumpToMonth,
    scrollToMonth,
    invalidateMonth,
    invalidateAllMonths,
    patchCachedPhotos,
    applyFilterRowChange,
    applyPhotoDeletes,
    restorePhotoDeletes,
    applyDateMonthMove,
    restoreDateMonthMove,
    rebuildMountedMonthForPhoto,
    resortMonthCachePhoto,
    refreshMonthIndex,
    setFilterPhoto,
    applySelectionScope,
    applyCatalogFilter,
    scheduleSync,
    getLayout,
    getPhaseAState,
    isActive,
    isCatalogFilterZeroActive,
    fetchMonthPhotos,
    getGlobalIndexForPhotoId,
    resolveGlobalIndexForPhotoId,
    resolvePhotoAtGlobalIndex,
  };
})();
