/**
 * Instant surface skeleton — standard gray grid + metadata reserve boxes at t=0.
 * Shared by library boot and share viewer (share adds title chrome via ShareSkeletonGrid).
 */
const SurfaceSkeletonGrid = (() => {
  const MONTH_LABEL_PLACEHOLDER = 'Month & Year';
  const GRID_MIN_CELL_PX = 200;
  const GRID_GAP_PX = 4;
  const MONTH_HEADER_RESERVE_PX = 56;

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

  function render(container, { monthKey = 'undated', cellCount = 0, reserveMonthLabel = false } = {}) {
    if (!container) {
      return;
    }

    container.innerHTML = '';
    container.classList.remove('grid-root', 'grid-paged', 'grid-labels-gated');
    container.style.removeProperty('--grid-cols');
    container.style.removeProperty('--grid-cell-px');

    const count = Math.max(0, Number(cellCount) || 0);
    if (count === 0) {
      return;
    }

    const section = MonthGrid.createMonthSection(monthKey, {
      extraSectionClasses: ['surface-skeleton-section'],
    });
    const monthLabel = section.sectionEl.querySelector('.month-label');
    if (monthLabel) {
      if (reserveMonthLabel) {
        monthLabel.textContent = MONTH_LABEL_PLACEHOLDER;
        monthLabel.classList.add('surface-layout-placeholder');
      } else {
        monthLabel.textContent = MonthGrid.monthLabel(monthKey);
        monthLabel.classList.remove('surface-layout-placeholder');
      }
    }

    const gridEl = section.gridEl;
    for (let i = 0; i < count; i += 1) {
      const card = document.createElement('div');
      card.className = 'photo-card virtual-placeholder-card surface-skeleton-card';
      card.dataset.skeletonIndex = String(i);
      gridEl.appendChild(card);
    }

    container.appendChild(section.sectionEl);
  }

  function renderInstantShell(container) {
    render(container, {
      monthKey: currentMonthKey(),
      cellCount: estimateViewportCellCount(container),
      reserveMonthLabel: true,
    });
  }

  function applyMeta(container, { monthKey = currentMonthKey(), photoCount = 0 } = {}) {
    const section = container?.querySelector('.surface-skeleton-section');
    const monthLabel = section?.querySelector('.month-label');
    if (monthLabel) {
      monthLabel.textContent = MonthGrid.monthLabel(monthKey || currentMonthKey());
      monthLabel.classList.remove('surface-layout-placeholder');
      return;
    }

    const count = photoCount > 0 ? photoCount : estimateViewportCellCount(container);
    render(container, {
      monthKey: monthKey || currentMonthKey(),
      cellCount: count,
      reserveMonthLabel: false,
    });
  }

  function showDatePickerPlaceholder() {
    const datePickerContainer = document.querySelector('.date-picker');
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!datePickerContainer || !monthPicker || !yearPicker) {
      return;
    }

    const now = new Date();
    datePickerContainer.style.visibility = 'visible';
    datePickerContainer.removeAttribute('aria-hidden');
    datePickerContainer.classList.add('surface-date-picker-loading');

    monthPicker.value = String(now.getMonth() + 1);
    monthPicker.classList.add('surface-layout-placeholder');
    monthPicker.disabled = true;

    yearPicker.innerHTML = '';
    const option = document.createElement('option');
    option.value = String(now.getFullYear());
    option.textContent = String(now.getFullYear());
    yearPicker.appendChild(option);
    yearPicker.value = String(now.getFullYear());
    yearPicker.classList.add('surface-layout-placeholder');
    yearPicker.disabled = true;
  }

  function clearDatePickerPlaceholder() {
    const datePickerContainer = document.querySelector('.date-picker');
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (datePickerContainer) {
      datePickerContainer.classList.remove('surface-date-picker-loading');
    }
    if (monthPicker) {
      monthPicker.classList.remove('surface-layout-placeholder');
      monthPicker.disabled = false;
    }
    if (yearPicker) {
      yearPicker.classList.remove('surface-layout-placeholder');
      yearPicker.disabled = false;
    }
  }

  return {
    MONTH_LABEL_PLACEHOLDER,
    currentMonthKey,
    estimateViewportCellCount,
    renderInstantShell,
    applyMeta,
    render,
    showDatePickerPlaceholder,
    clearDatePickerPlaceholder,
  };
})();
