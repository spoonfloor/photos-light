/**
 * Shared month section helpers — eager (share) and virtual (library) grids.
 */
const MonthGrid = (() => {
  function monthKeyFromDate(date) {
    if (!date) {
      return 'undated';
    }
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthLabel(monthKey) {
    if (!monthKey || monthKey === 'undated') {
      return 'Undated';
    }
    if (typeof GridLayout !== 'undefined' && GridLayout.monthLabel) {
      return GridLayout.monthLabel(monthKey);
    }
    const [year, monthNum] = monthKey.split('-');
    const sample = new Date(parseInt(year, 10), parseInt(monthNum, 10) - 1, 1);
    return sample.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function buildMonthHeaderBand(monthKey) {
    const band = document.createElement('div');
    band.className = 'month-header-band';
    const header = document.createElement('div');
    header.className = 'month-header';
    header.innerHTML =
      `<span class="month-label">${monthLabel(monthKey)}</span>` +
      `<div class="month-select-circle"></div>`;
    band.appendChild(header);
    return band;
  }

  function createMonthSection(monthKey, { extraSectionClasses = [] } = {}) {
    const sectionEl = document.createElement('div');
    sectionEl.className = ['month-section', ...extraSectionClasses]
      .filter(Boolean)
      .join(' ');
    sectionEl.dataset.month = monthKey;
    sectionEl.appendChild(buildMonthHeaderBand(monthKey));
    const gridEl = document.createElement('div');
    gridEl.className = 'photo-grid';
    sectionEl.appendChild(gridEl);
    return { sectionEl, gridEl };
  }

  return {
    monthKeyFromDate,
    monthLabel,
    buildMonthHeaderBand,
    createMonthSection,
  };
})();
