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
  let provisionalYears = [];
  let hooks = {};
  let comfortAnchorY = 0;
  let anchorMonthKey = null;
  let anchorSectionEl = null;

  function getContainer() {
    return document.getElementById('photoContainer');
  }

  function getScrollElement() {
    return document.scrollingElement || document.documentElement;
  }

  function mergePhotosIntoState(photos) {
    if (!hooks.mergePhotos || !photos?.length) {
      return;
    }
    hooks.mergePhotos(photos);
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
        `/api/photos/month?month=${encodeURIComponent(monthKey)}&sort=${sortOrder}`,
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

  function applyGridColumnsToElement(grid) {
    if (!layout?.columnLayout) {
      return;
    }
    grid.style.gridTemplateColumns = layout.cssGridTemplate;
  }

  function buildPlaceholderCells(section, grid) {
    applyGridColumnsToElement(grid);
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
    if (tileLayer) {
      tileLayer.classList.remove('grid-comfort-off');
    }
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

    const header = document.createElement('div');
    header.className = 'month-header';
    header.innerHTML = `
      <span class="month-label">${GridLayout.monthLabel(monthKey)}</span>
      <div class="month-select-circle"></div>
    `;
    wrapper.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'photo-grid';
    buildPlaceholderCells(section, grid);
    wrapper.appendChild(grid);
    return wrapper;
  }

  function buildHydratedGrid(section, photos, filterPhoto) {
    const grid = document.createElement('div');
    grid.className = 'photo-grid';
    applyGridColumnsToElement(grid);

    const visiblePhotos = filterPhoto ? photos.filter(filterPhoto) : photos;
    visiblePhotos.forEach((photo, localIndex) => {
      const globalIndex = section.globalStart + localIndex;
      const card = document.createElement('div');
      card.className = 'photo-card';
      card.dataset.id = String(photo.id);
      card.dataset.index = String(globalIndex);

      const starBadgeHTML =
        photo.rating === 5
          ? '<div class="star-badge"><span class="material-symbols-outlined">star</span></div>'
          : '';
      const videoBadgeHTML =
        photo.file_type === 'video'
          ? '<div class="video-badge"><span class="material-symbols-outlined">play_circle</span></div>'
          : '';

      card.innerHTML = `
        <img data-photo-id="${photo.id}" alt="" class="photo-thumb">
        ${starBadgeHTML}
        ${videoBadgeHTML}
      `;
      grid.appendChild(card);
    });
    return grid;
  }

  function hydrateMonthSection(monthKey, section, photos) {
    const wrapper = contentLayer?.querySelector(`[data-month="${monthKey}"]`);
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
  }

  function unmountMonth(monthKey) {
    const node = contentLayer?.querySelector(`[data-month="${monthKey}"]`);
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
    const existing = contentLayer?.querySelector(`[data-month="${monthKey}"]`);
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
      const node = contentLayer?.querySelector(`[data-month="${monthKey}"]`);
      if (!node) {
        return;
      }
      node.classList.remove('grid-section-pending');
      committedMonths.add(monthKey);
    });
  }

  function setSectionsPending(monthKeys, pending) {
    monthKeys.forEach((monthKey) => {
      const node = contentLayer?.querySelector(`[data-month="${monthKey}"]`);
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

    const wrapper = contentLayer?.querySelector(`[data-month="${monthKey}"]`);
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

  /** Truth-gated month section at scroll 0 during provisional layout (limit=1 month). */
  function buildAnchorMonthSection(monthKey) {
    const wrapper = document.createElement('div');
    wrapper.className = 'month-section grid-anchor-month-section';
    wrapper.id = `anchor-month-${monthKey}`;
    wrapper.dataset.month = monthKey;
    wrapper.dataset.gridAnchorTruth = 'true';
    wrapper.style.top = '0px';

    const header = document.createElement('div');
    header.className = 'month-header';
    header.innerHTML = `
      <span class="month-label">${GridLayout.monthLabel(monthKey)}</span>
      <div class="month-select-circle"></div>
    `;
    wrapper.appendChild(header);
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
    if (!layout) {
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
        committedMonths.delete(monthKey);
      }
    });

    mountBuffer.forEach((section) => {
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
    const gap = columnLayout.gap;
    const partialCells = Math.max(1, columns - 2);

    const chunk = document.createElement('div');
    chunk.className = 'grid-tile-chunk';
    chunk.style.top = `${yStart}px`;

    const headerGap = document.createElement('div');
    headerGap.className = 'grid-tile-header-gap';
    headerGap.style.height = `${GridLayout.HEADER_BAND_HEIGHT}px`;
    chunk.appendChild(headerGap);

    const fullGrid = document.createElement('div');
    fullGrid.className = 'grid-tile-grid';
    for (let row = 0; row < 12; row += 1) {
      fullGrid.appendChild(buildTileRow(columns));
    }
    chunk.appendChild(fullGrid);

    const partialGrid = document.createElement('div');
    partialGrid.className = 'grid-tile-grid grid-tile-grid-partial';
    partialGrid.appendChild(buildTileRow(partialCells));
    chunk.appendChild(partialGrid);

    const sectionGap = document.createElement('div');
    sectionGap.className = 'grid-tile-section-gap';
    sectionGap.style.height = `${GridLayout.MONTH_SECTION_MARGIN}px`;
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

  function rebuildLayoutFromIndex(indexPayload, containerWidth, options = {}) {
    if (layout?.provisional && !options.keepMounted) {
      clearMountedMonths();
    }
    monthIndex = indexPayload;
    sortOrder = indexPayload?.sort || sortOrder;
    const columnLayout = GridLayout.computeColumnLayout(containerWidth);
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
      const width = container.clientWidth;
      if (monthIndex) {
        const columnLayout = GridLayout.computeColumnLayout(width);
        const nextLayout = GridLayout.toLayoutSnapshot(
          GridLayout.buildVirtualLayout(monthIndex.months || [], columnLayout),
        );
        const geometryChanged = GridLayout.layoutGeometryChanged(layout, nextLayout);
        rebuildLayoutFromIndex(monthIndex, width, { remount: geometryChanged });
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
            GridLayout.computeColumnLayout(width),
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

  async function init(options = {}) {
    destroy();
    hooks = options;
    generation = hooks.getGeneration?.() ?? 0;

    const container = getContainer();
    if (!container || !ensureDom()) {
      return false;
    }

    const sort = options.sortOrder || 'newest';
    let provisionalTotal = 0;
    let anchorMonth = null;
    provisionalYears = [];

    try {
      const [countResponse, yearsResponse] = await Promise.all([
        fetch(`/api/photos?limit=1&sort=${encodeURIComponent(sort)}`, {
          signal: options.signal,
        }),
        fetch('/api/years', { signal: options.signal }),
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

    sortOrder = sort;
    const yearsForProvisional =
      provisionalYears.length > 0
        ? provisionalYears
        : provisionalTotal > 0
          ? GridLayout.defaultProvisionalYears()
          : [];

    if (provisionalTotal > 0 && yearsForProvisional.length > 0) {
      provisionalYears = yearsForProvisional;
      anchorMonthKey = anchorMonth;

      if (options.onPhaseAAnchor) {
        options.onPhaseAAnchor({
          total: provisionalTotal,
          years: provisionalYears,
          anchorMonth,
        });
      }

      const columnLayout = GridLayout.computeColumnLayout(container.clientWidth);
      GridLayout.publishCssVars(
        container,
        GridLayout.toLayoutSnapshot({ columnLayout, sections: [], totalHeight: 0 }),
      );

      setSnapshot(
        GridLayout.buildProvisionalLayout(
          provisionalTotal,
          provisionalYears,
          columnLayout,
          sort,
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

      if (options.onProvisionalReady) {
        options.onProvisionalReady({
          total: provisionalTotal,
          years: provisionalYears,
          anchorMonth,
        });
      }
    }

    const indexResponse = await fetch(
      `/api/photos/month_index?sort=${encodeURIComponent(sort)}`,
      { signal: options.signal },
    );
    const indexPayload = await indexResponse.json();
    if (!indexResponse.ok) {
      throw new Error(indexPayload.error || 'Failed to load month index');
    }

    if (generation !== hooks.getGeneration?.()) {
      return false;
    }

    monthIndex = indexPayload;
    sortOrder = sort;
    if (options.onIndexReady) {
      options.onIndexReady(indexPayload);
    }

    rebuildLayoutFromIndex(indexPayload, container.clientWidth);
    if (!provisionalTotal) {
      window.scrollTo({ top: 0, behavior: 'instant' });
      bindResize(container);
      bindScroll();
    }
    scheduleSync();

    if (options.onReady) {
      options.onReady(indexPayload, layout);
    }
    return true;
  }

  function destroy() {
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
      container.classList.remove('grid-root', 'grid-labels-gated');
      container.style.removeProperty('--grid-cols');
      container.style.removeProperty('--grid-cell-px');
      container.style.removeProperty('--grid-gap-px');
    }
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
    monthCache.clear();
    monthInflight.clear();
    hooks = {};
  }

  function scrollToMonth(monthKey, behavior = 'smooth') {
    if (!layout) {
      return false;
    }
    const top = GridLayout.scrollTopForMonth(layout, monthKey);
    if (top === null) {
      return false;
    }
    window.scrollTo({ top, behavior });
    scheduleSync();
    return true;
  }

  function invalidateMonth(monthKey) {
    monthCache.delete(monthKey);
    committedMonths.delete(monthKey);
    if (mountedMonths.has(monthKey)) {
      unmountMonth(monthKey);
      const section = GridLayout.findSectionForMonth(layout, monthKey);
      if (section) {
        mountPlaceholderSection(section, { pending: true });
        scheduleSync();
      }
    }
  }

  function invalidateAllMonths() {
    monthCache.clear();
    monthInflight.clear();
    clearMountedMonths();
    scheduleSync();
  }

  function applyLocalIndex(nextIndex, affectedMonths = []) {
    if (!nextIndex) {
      return false;
    }
    monthIndex = nextIndex;
    const container = getContainer();
    if (!container) {
      return false;
    }
    affectedMonths.forEach((monthKey) => {
      monthCache.delete(monthKey);
    });
    clearMountedMonths();
    rebuildLayoutFromIndex(nextIndex, container.clientWidth, { keepMounted: true });
    scheduleSync();
    if (hooks.onIndexReady) {
      hooks.onIndexReady(nextIndex);
    }
    return true;
  }

  /**
   * Incremental grid update — no full month_index round trip.
   * @param {{ oldMonth?: string, newMonth?: string, monthCounts?: Map<string, number> }} patch
   */
  function applyMutationPatch(patch = {}) {
    if (!monthIndex || !layout) {
      return false;
    }

    let nextIndex = monthIndex;
    const affected = [];

    if (patch.monthCounts?.size) {
      nextIndex = GridLayout.patchPhotoDeletes(nextIndex, patch.monthCounts);
      patch.monthCounts.forEach((_count, monthKey) => {
        affected.push(monthKey);
      });
    } else if (patch.oldMonth && patch.newMonth) {
      nextIndex = GridLayout.patchPhotoMonthMove(
        nextIndex,
        patch.oldMonth,
        patch.newMonth,
      );
      affected.push(patch.oldMonth, patch.newMonth);
    } else if (patch.newMonth) {
      nextIndex = GridLayout.patchMonthIndexDelta(nextIndex, patch.newMonth, 1);
      affected.push(patch.newMonth);
    } else if (patch.oldMonth) {
      nextIndex = GridLayout.patchMonthIndexDelta(nextIndex, patch.oldMonth, -1);
      affected.push(patch.oldMonth);
    }

    return applyLocalIndex(nextIndex, affected);
  }

  async function refreshMonthIndex(sortOrderNext = sortOrder) {
    const container = getContainer();
    if (!container) {
      return false;
    }
    const response = await fetch(
      `/api/photos/month_index?sort=${encodeURIComponent(sortOrderNext)}`,
    );
    const indexPayload = await response.json();
    if (!response.ok) {
      throw new Error(indexPayload.error || 'Failed to refresh month index');
    }
    sortOrder = sortOrderNext;
    monthCache.clear();
    monthInflight.clear();
    clearMountedMonths();
    rebuildLayoutFromIndex(indexPayload, container.clientWidth, { remount: true });
    if (hooks.onIndexReady) {
      hooks.onIndexReady(indexPayload);
    }
    scheduleSync();
    return true;
  }

  function getLayout() {
    return layout;
  }

  function getPhaseAState() {
    publishPhaseATestState(layout?.provisional ? 'provisional' : 'refined');
    return window.__gridPhaseA || null;
  }

  function isActive() {
    return Boolean(layout && contentLayer);
  }

  return {
    init,
    destroy,
    scrollToMonth,
    invalidateMonth,
    invalidateAllMonths,
    applyMutationPatch,
    refreshMonthIndex,
    scheduleSync,
    getLayout,
    getPhaseAState,
    isActive,
    fetchMonthPhotos,
  };
})();
