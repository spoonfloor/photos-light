/**
 * Share viewer skeleton — title reserve + shared SurfaceSkeletonGrid shell (day clusters).
 */
const ShareSkeletonGrid = (() => {
  const PLACEHOLDER_TITLE = 'Shared Photos';
  const CLUSTER_GRANULARITY = 'day';

  function dayKeyFromDateTaken(dateTaken) {
    if (!dateTaken) {
      return 'undated';
    }
    const date = new Date(dateTaken);
    if (Number.isNaN(date.getTime())) {
      return 'undated';
    }
    return MonthGrid.dayKeyFromDate(date);
  }

  function renderInstantBoot(titleEl, container) {
    if (titleEl) {
      titleEl.textContent = PLACEHOLDER_TITLE;
      titleEl.classList.add('surface-layout-placeholder');
    }
    SurfaceSkeletonGrid.renderInstantShell(container, { granularity: CLUSTER_GRANULARITY });
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

    const dayKey =
      meta?.first_cluster?.day_key ??
      dayKeyFromDateTaken(meta?.first_cluster?.date_taken) ??
      SurfaceSkeletonGrid.currentDayKey();
    SurfaceSkeletonGrid.applyMeta(container, {
      monthKey: dayKey,
      photoCount,
      granularity: CLUSTER_GRANULARITY,
    });
  }

  return {
    dayKeyFromDateTaken,
    estimateViewportCellCount: SurfaceSkeletonGrid.estimateViewportCellCount,
    renderInstantBoot,
    applyMeta,
    render: SurfaceSkeletonGrid.render,
  };
})();
