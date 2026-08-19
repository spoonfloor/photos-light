/**
 * Share viewer skeleton — title reserve + shared SurfaceSkeletonGrid shell.
 */
const ShareSkeletonGrid = (() => {
  const PLACEHOLDER_TITLE = 'Shared Photos';

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

  function renderInstantBoot(titleEl, container) {
    if (titleEl) {
      titleEl.textContent = PLACEHOLDER_TITLE;
      titleEl.classList.add('surface-layout-placeholder');
    }
    SurfaceSkeletonGrid.renderInstantShell(container);
  }

  function applyMeta(titleEl, container, meta, emptyEl = null) {
    const title = meta?.album?.title || PLACEHOLDER_TITLE;
    if (titleEl) {
      titleEl.textContent = title;
      titleEl.classList.remove('surface-layout-placeholder');
    }

    const photoCount = meta?.album?.photo_count ?? 0;
    if (emptyEl) {
      emptyEl.hidden = photoCount > 0;
    }

    const monthKey = meta?.first_cluster?.month_key ?? SurfaceSkeletonGrid.currentMonthKey();
    SurfaceSkeletonGrid.applyMeta(container, { monthKey, photoCount });
  }

  return {
    monthKeyFromDateTaken,
    estimateViewportCellCount: SurfaceSkeletonGrid.estimateViewportCellCount,
    renderInstantBoot,
    applyMeta,
    render: SurfaceSkeletonGrid.render,
  };
})();
