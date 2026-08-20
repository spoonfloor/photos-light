/**
 * Date jumper chrome — shared catalog, visibility, and single-year static rules.
 * App (main.js) and share (shareDatePicker.js) both delegate here.
 */
const DatePickerChrome = (() => {
  let lastCatalog = [];
  let pendingReveal = false;
  let visible = false;

  function isCalendarMonthKey(monthKey) {
    return typeof monthKey === 'string' && /^\d{4}-\d{2}$/.test(monthKey);
  }

  function monthKeyFromClusterKey(clusterKey) {
    if (!clusterKey || clusterKey === 'undated') {
      return 'undated';
    }
    if (isCalendarMonthKey(clusterKey)) {
      return clusterKey;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(clusterKey)) {
      return clusterKey.slice(0, 7);
    }
    return 'undated';
  }

  function normalizeMonthCatalog(rawMonths) {
    const months = new Set();
    for (const entry of rawMonths || []) {
      const monthKey = monthKeyFromClusterKey(entry);
      if (isCalendarMonthKey(monthKey)) {
        months.add(monthKey);
      }
    }
    return [...months].sort((a, b) => a.localeCompare(b));
  }

  function catalogMonths(months) {
    return normalizeMonthCatalog(months).filter((monthKey) => monthKey !== 'undated');
  }

  function yearsFromMonths(months) {
    const years = new Set();
    for (const monthKey of catalogMonths(months)) {
      years.add(parseInt(monthKey.slice(0, 4), 10));
    }
    return [...years].sort((a, b) => a - b);
  }

  function monthsFromPhotos(photos, parseDate) {
    const months = new Set();
    for (const photo of photos || []) {
      const date = parseDate?.(photo.date_taken);
      if (date) {
        months.add(MonthGrid.monthKeyFromDate(date));
      }
    }
    return [...months].sort((a, b) => a.localeCompare(b));
  }

  function shouldShowJumper(months) {
    return catalogMonths(months).length > 1;
  }

  function monthOrdinal(monthKey) {
    const [year, month] = monthKey.split('-');
    return parseInt(year, 10) * 12 + parseInt(month, 10);
  }

  function nearestMonthInIndex(targetMonth, availableMonths, sortOrder = 'newest') {
    if (
      typeof GridLayout !== 'undefined' &&
      typeof GridLayout.nearestMonthInIndex === 'function'
    ) {
      return GridLayout.nearestMonthInIndex(targetMonth, availableMonths, sortOrder);
    }

    if (!targetMonth || !availableMonths?.length) {
      return null;
    }

    const months = catalogMonths(availableMonths);
    if (!months.length) {
      return null;
    }
    if (months.includes(targetMonth)) {
      return targetMonth;
    }

    const targetYear = targetMonth.slice(0, 4);
    const targetMonthNum = parseInt(targetMonth.slice(5, 7), 10);
    const yearMonths = months
      .filter((monthKey) => monthKey.slice(0, 4) === targetYear)
      .sort((a, b) => a.localeCompare(b));

    if (yearMonths.length) {
      if (sortOrder === 'newest') {
        const candidates = yearMonths.filter(
          (monthKey) => parseInt(monthKey.slice(5, 7), 10) >= targetMonthNum,
        );
        return candidates.length ? candidates[0] : yearMonths[yearMonths.length - 1];
      }
      const candidates = yearMonths.filter(
        (monthKey) => parseInt(monthKey.slice(5, 7), 10) <= targetMonthNum,
      );
      return candidates.length ? candidates[candidates.length - 1] : yearMonths[0];
    }

    const targetOrdinal = monthOrdinal(targetMonth);
    let bestMonth = months[0];
    let bestDistance = Infinity;
    months.forEach((monthKey) => {
      const distance = Math.abs(monthOrdinal(monthKey) - targetOrdinal);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMonth = monthKey;
      }
    });
    return bestMonth;
  }

  function orderedYears(years, sortOrder) {
    if (sortOrder === 'newest') {
      return [...years].reverse();
    }
    return years;
  }

  function setYearStaticMode(yearPicker, isStatic) {
    if (!yearPicker) {
      return;
    }
    yearPicker.classList.toggle('date-picker-select--static', isStatic);
    yearPicker.tabIndex = isStatic ? -1 : 0;
    yearPicker.setAttribute('aria-disabled', isStatic ? 'true' : 'false');
  }

  function populateYearPicker(years, sortOrder) {
    const yearPicker = document.getElementById('yearPicker');
    if (!yearPicker || !years.length) {
      return yearPicker;
    }

    const sorted = orderedYears(years, sortOrder);
    yearPicker.innerHTML = '';
    sorted.forEach((year) => {
      const option = document.createElement('option');
      option.value = String(year);
      option.textContent = String(year);
      yearPicker.appendChild(option);
    });

    setYearStaticMode(yearPicker, sorted.length === 1);
    return yearPicker;
  }

  function applyMonthDisabledState(year, availableMonths) {
    const monthPicker = document.getElementById('monthPicker');
    if (!monthPicker) {
      return;
    }

    const months = catalogMonths(availableMonths);
    if (!months.length) {
      for (const option of monthPicker.options) {
        option.disabled = false;
      }
      return;
    }

    const activeMonthsInYear = new Set(
      months
        .filter((monthKey) => monthKey.slice(0, 4) === String(year))
        .map((monthKey) => parseInt(monthKey.slice(5, 7), 10)),
    );
    const hasAnyInYear = activeMonthsInYear.size > 0;

    for (const option of monthPicker.options) {
      const monthNum = parseInt(option.value, 10);
      option.disabled = hasAnyInYear && !activeMonthsInYear.has(monthNum);
    }
  }

  function resolvePickerMonth(months, sortOrder, anchorMonth) {
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    const catalog = catalogMonths(months);

    if (monthPicker && yearPicker && yearPicker.value && monthPicker.value) {
      const current = `${yearPicker.value}-${monthPicker.value.padStart(2, '0')}`;
      const selectedOption = monthPicker.options[monthPicker.selectedIndex];
      if (catalog.includes(current) && !selectedOption?.disabled) {
        return current;
      }
    }

    const seed =
      anchorMonth && isCalendarMonthKey(anchorMonth) ? anchorMonth : catalog[0];
    return nearestMonthInIndex(seed, catalog, sortOrder) || seed;
  }

  function setPickerValues(monthKey, availableMonths) {
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!monthPicker || !yearPicker || !isCalendarMonthKey(monthKey)) {
      return null;
    }

    const [year, month] = monthKey.split('-');
    yearPicker.value = year;
    monthPicker.value = String(parseInt(month, 10));
    applyMonthDisabledState(year, availableMonths);
    return monthKey;
  }

  function capAllowsJumper() {
    return !!ViewCapabilities.get().dateJumper;
  }

  function setJumperVisible(show) {
    const el = document.querySelector('.date-picker');
    if (!el) {
      visible = false;
      return;
    }

    visible = show && capAllowsJumper();
    if (!visible) {
      el.hidden = true;
      el.style.visibility = 'hidden';
      el.setAttribute('aria-hidden', 'true');
      el.classList.remove('date-jumper-active');
      return;
    }

    el.hidden = false;
    el.style.visibility = 'visible';
    el.removeAttribute('aria-hidden');
    el.classList.add('date-jumper-active');
  }

  function syncCatalog(availableMonths, { sortOrder = 'newest', anchorMonth = null, reveal = true } = {}) {
    const months = normalizeMonthCatalog(availableMonths);
    lastCatalog = months;

    if (!shouldShowJumper(months)) {
      pendingReveal = false;
      setJumperVisible(false);
      return { shown: false, catalogKnown: true, resolvedMonth: null };
    }

    const years = yearsFromMonths(months);
    if (!years.length) {
      pendingReveal = false;
      setJumperVisible(false);
      return { shown: false, catalogKnown: false, resolvedMonth: null };
    }

    populateYearPicker(years, sortOrder);

    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (monthPicker) {
      monthPicker.disabled = false;
      monthPicker.classList.remove('surface-layout-placeholder');
    }
    if (yearPicker) {
      yearPicker.classList.remove('surface-layout-placeholder');
    }

    const resolved = resolvePickerMonth(months, sortOrder, anchorMonth);
    setPickerValues(resolved, months);

    if (reveal) {
      pendingReveal = false;
      setJumperVisible(true);
    } else {
      pendingReveal = true;
      setJumperVisible(false);
    }

    return {
      shown: reveal && visible,
      catalogKnown: true,
      resolvedMonth: resolved,
    };
  }

  function onSurfaceLoadComplete() {
    if (pendingReveal && shouldShowJumper(lastCatalog)) {
      setJumperVisible(true);
      pendingReveal = false;
    }
  }

  function hideUntilCatalogKnown() {
    lastCatalog = [];
    pendingReveal = false;
    setJumperVisible(false);
  }

  function isYearStatic() {
    const yearPicker = document.getElementById('yearPicker');
    return yearPicker?.classList.contains('date-picker-select--static') ?? false;
  }

  function isVisible() {
    return visible;
  }

  function getLastCatalog() {
    return [...lastCatalog];
  }

  return {
    isCalendarMonthKey,
    monthKeyFromClusterKey,
    normalizeMonthCatalog,
    catalogMonths,
    yearsFromMonths,
    monthsFromPhotos,
    shouldShowJumper,
    nearestMonthInIndex,
    populateYearPicker,
    applyMonthDisabledState,
    setPickerValues,
    resolvePickerMonth,
    syncCatalog,
    onSurfaceLoadComplete,
    hideUntilCatalogKnown,
    isYearStatic,
    isVisible,
    getLastCatalog,
    setJumperVisible,
  };
})();
