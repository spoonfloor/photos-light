/**
 * Share viewer date jumper — scroll/jump wiring; catalog rules live in DatePickerChrome.
 */
const ShareDatePicker = (() => {
  const APP_BAR_OFFSET = 80;

  let wired = false;
  let updatingFromScroll = false;
  let lastSyncedMonthKey = null;
  let scrollRaf = null;
  let getSortOrder = () => 'oldest';

  function syncCatalog(photos, parseDate, { anchorMonth = null, reveal = true } = {}) {
    const months = DatePickerChrome.monthsFromPhotos(photos, parseDate);
    const result = DatePickerChrome.syncCatalog(months, {
      sortOrder: getSortOrder(),
      anchorMonth: anchorMonth ?? lastSyncedMonthKey,
      reveal,
    });
    if (result.resolvedMonth) {
      lastSyncedMonthKey = result.resolvedMonth;
    }
    return result;
  }

  function scrollToMonthSection(monthKey) {
    if (!DatePickerChrome.isCalendarMonthKey(monthKey)) {
      return false;
    }

    const sections = document.querySelectorAll('.month-section[data-month]');
    for (const section of sections) {
      const clusterKey = section.dataset.month;
      if (clusterKey === monthKey || clusterKey.startsWith(`${monthKey}-`)) {
        const targetY = section.offsetTop - APP_BAR_OFFSET;
        window.scrollTo({ top: Math.max(0, targetY), behavior: 'instant' });
        return true;
      }
    }
    return false;
  }

  function monthFromScroll() {
    let bestMonth = null;
    let bestTop = -Infinity;

    document.querySelectorAll('.month-section[data-month]').forEach((section) => {
      const monthKey = DatePickerChrome.monthKeyFromClusterKey(section.dataset.month);
      if (!DatePickerChrome.isCalendarMonthKey(monthKey)) {
        return;
      }
      const top = section.getBoundingClientRect().top;
      if (top <= APP_BAR_OFFSET && top > bestTop) {
        bestTop = top;
        bestMonth = monthKey;
      }
    });

    if (bestMonth) {
      return bestMonth;
    }

    let firstBelow = null;
    let firstBelowTop = Infinity;
    document.querySelectorAll('.month-section[data-month]').forEach((section) => {
      const monthKey = DatePickerChrome.monthKeyFromClusterKey(section.dataset.month);
      if (!DatePickerChrome.isCalendarMonthKey(monthKey)) {
        return;
      }
      const top = section.getBoundingClientRect().top;
      if (top > APP_BAR_OFFSET && top < firstBelowTop) {
        firstBelowTop = top;
        firstBelow = monthKey;
      }
    });

    return firstBelow;
  }

  function syncFromScroll() {
    if (!DatePickerChrome.isVisible()) {
      return;
    }

    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!monthPicker || !yearPicker || monthPicker.disabled) {
      return;
    }

    const monthKey = monthFromScroll();
    if (!monthKey || monthKey === lastSyncedMonthKey) {
      return;
    }

    updatingFromScroll = true;
    DatePickerChrome.setPickerValues(monthKey, DatePickerChrome.getLastCatalog());
    lastSyncedMonthKey = monthKey;
    requestAnimationFrame(() => {
      updatingFromScroll = false;
    });
  }

  function scheduleSyncFromScroll() {
    if (scrollRaf) {
      return;
    }
    scrollRaf = window.requestAnimationFrame(() => {
      scrollRaf = null;
      syncFromScroll();
    });
  }

  function coSelectForYearChange() {
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!monthPicker || !yearPicker) {
      return null;
    }

    const catalog = DatePickerChrome.getLastCatalog();
    const year = yearPicker.value;
    const monthNum = parseInt(monthPicker.value, 10);
    const preferred = `${year}-${String(monthNum).padStart(2, '0')}`;

    if (!catalog.length) {
      DatePickerChrome.applyMonthDisabledState(year, catalog);
      return preferred;
    }

    const resolved =
      DatePickerChrome.nearestMonthInIndex(preferred, catalog, getSortOrder()) || preferred;
    updatingFromScroll = true;
    DatePickerChrome.setPickerValues(resolved, catalog);
    lastSyncedMonthKey = resolved;
    requestAnimationFrame(() => {
      updatingFromScroll = false;
    });
    return resolved;
  }

  function handleMonthChange() {
    if (updatingFromScroll || !DatePickerChrome.isVisible()) {
      return;
    }
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!monthPicker || !yearPicker) {
      return;
    }
    const month = monthPicker.value.padStart(2, '0');
    const monthKey = `${yearPicker.value}-${month}`;
    scrollToMonthSection(monthKey);
    lastSyncedMonthKey = monthKey;
  }

  function handleYearChange() {
    if (updatingFromScroll || DatePickerChrome.isYearStatic()) {
      return;
    }
    const targetMonth = coSelectForYearChange();
    if (targetMonth) {
      scrollToMonthSection(targetMonth);
    }
  }

  function wire({ sortOrderGetter } = {}) {
    if (sortOrderGetter) {
      getSortOrder = sortOrderGetter;
    }

    DatePickerChrome.hideUntilCatalogKnown();

    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!monthPicker || !yearPicker) {
      return;
    }

    if (!wired) {
      wired = true;
      monthPicker.addEventListener('change', handleMonthChange);
      yearPicker.addEventListener('change', handleYearChange);
      window.addEventListener('scroll', scheduleSyncFromScroll, { passive: true });
    }
  }

  function applyFromPhotos(photos, parseDate, sortOrder, anchorMonthKey = null) {
    if (sortOrder) {
      getSortOrder = () => sortOrder;
    }
    const reveal =
      typeof SurfaceLoadChrome === 'undefined' || !SurfaceLoadChrome.isActive();
    return syncCatalog(photos, parseDate, {
      anchorMonth: anchorMonthKey,
      reveal,
    });
  }

  function refreshCatalog(photos, parseDate) {
    const reveal =
      typeof SurfaceLoadChrome === 'undefined' || !SurfaceLoadChrome.isActive();
    return syncCatalog(photos, parseDate, { reveal });
  }

  function afterGridRender() {
    lastSyncedMonthKey = null;
    scheduleSyncFromScroll();
  }

  function setSortOrder(sortOrder) {
    getSortOrder = () => sortOrder;
    const catalog = DatePickerChrome.getLastCatalog();
    if (!catalog.length) {
      return;
    }
    DatePickerChrome.syncCatalog(catalog, {
      sortOrder,
      anchorMonth: lastSyncedMonthKey,
      reveal: DatePickerChrome.isVisible(),
    });
  }

  return {
    applyFromPhotos,
    refreshCatalog,
    wire,
    afterGridRender,
    setSortOrder,
    syncFromScroll,
  };
})();
