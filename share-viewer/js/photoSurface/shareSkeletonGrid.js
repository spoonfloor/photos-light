/**
 * Instant share skeleton — gray grid at t=0 with invisible title/month reserving layout.
 */
const ShareSkeletonGrid = (() => {
  const PLACEHOLDER_TITLE = 'Shared Photos';
  const GRID_MIN_CELL_PX = 200;
  const GRID_GAP_PX = 4;
  const MONTH_HEADER_RESERVE_PX = 56;

  function monthKeyFromDateTaken(dateTaken) {
    if (!dateTaken) {
      return 'undated';
    }
    const date = new Date(dateTaken);
    if (Number.isNaN(date.getTime())) {
      return 'undated';
    }
    return MonthGrid.monthKeyFromDate(date);
  }

  function currentMonthKey() {
    return MonthGrid.monthKeyFromDate(new Date());
  }

  function estimateViewportCellCount(container) {
    const width =
      container?.clientWidth ||
      document.querySelector('.page-wrapper')?.clientWidth ||
      window.innerWidth;
    const cols = Math.max(
      1,
      Math.floor((width + GRID_GAP_PX) / (GRID_MIN_CELL_PX + GRID_GAP_PX)),
    );

    const top = container?.getBoundingClientRect?.().top ?? window.innerHeight * 0.25;
    const availableHeight = Math.max(
      GRID_MIN_CELL_PX * 2,
      window.innerHeight - top - MONTH_HEADER_RESERVE_PX,
    );
    const rows = Math.max(
      2,
      Math.ceil((availableHeight + GRID_GAP_PX) / (GRID_MIN_CELL_PX + GRID_GAP_PX)),
    );
    return cols * rows;
  }

  function render(container, { monthKey = 'undated', cellCount = 0, placeholderLabels = false } = {}) {
    if (!container) {
      return;
    }

    container.innerHTML = '';
    const count = Math.max(0, Number(cellCount) || 0);
    if (count === 0) {
      return;
    }

    const section = MonthGrid.createMonthSection(monthKey, {
      extraSectionClasses: ['share-skeleton-section'],
    });
    if (placeholderLabels) {
      section.sectionEl.classList.add('share-pl0');
    }
    const monthLabel = section.sectionEl.querySelector('.month-label');
    if (monthLabel) {
      monthLabel.textContent = MonthGrid.monthLabel(monthKey);
      monthLabel.classList.toggle('share-layout-placeholder', placeholderLabels);
    }

    const gridEl = section.gridEl;
    for (let i = 0; i < count; i += 1) {
      const card = document.createElement('div');
      card.className = 'photo-card virtual-placeholder-card share-skeleton-card';
      card.dataset.skeletonIndex = String(i);
      gridEl.appendChild(card);
    }

    container.appendChild(section.sectionEl);
  }

  function renderInstantBoot(titleEl, container) {
    if (titleEl) {
      titleEl.textContent = PLACEHOLDER_TITLE;
      titleEl.classList.add('share-layout-placeholder');
    }
    render(container, {
      monthKey: currentMonthKey(),
      cellCount: estimateViewportCellCount(container),
      placeholderLabels: true,
    });
  }

  function applyMeta(titleEl, container, meta, emptyEl = null) {
    const title = meta?.album?.title || PLACEHOLDER_TITLE;
    if (titleEl) {
      titleEl.textContent = title;
      titleEl.classList.remove('share-layout-placeholder');
    }

    const photoCount = meta?.album?.photo_count ?? 0;
    if (emptyEl) {
      emptyEl.hidden = photoCount > 0;
    }

    const monthKey = meta?.first_cluster?.month_key ?? currentMonthKey();
    render(container, {
      monthKey,
      cellCount: photoCount || estimateViewportCellCount(container),
      placeholderLabels: false,
    });
  }

  return {
    monthKeyFromDateTaken,
    estimateViewportCellCount,
    renderInstantBoot,
    applyMeta,
    render,
  };
})();
