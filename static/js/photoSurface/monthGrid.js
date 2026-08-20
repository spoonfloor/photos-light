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

  function dayKeyFromDate(date) {
    if (!date) {
      return 'undated';
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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

  function dayLabel(dayKey) {
    if (!dayKey || dayKey === 'undated') {
      return 'Undated';
    }
    const [year, monthNum, dayNum] = dayKey.split('-');
    const sample = new Date(
      parseInt(year, 10),
      parseInt(monthNum, 10) - 1,
      parseInt(dayNum, 10),
    );
    return sample.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function clusterLabel(clusterKey, granularity = 'month') {
    return granularity === 'day' ? dayLabel(clusterKey) : monthLabel(clusterKey);
  }

  function buildMonthHeaderBand(clusterKey, { granularity = 'month' } = {}) {
    const band = document.createElement('div');
    band.className = 'month-header-band';
    const header = document.createElement('div');
    header.className = 'month-header';
    header.innerHTML =
      `<span class="month-label">${clusterLabel(clusterKey, granularity)}</span>` +
      `<div class="month-select-circle"></div>`;
    band.appendChild(header);
    return band;
  }

  function createMonthSection(clusterKey, { extraSectionClasses = [], granularity = 'month' } = {}) {
    const sectionEl = document.createElement('div');
    sectionEl.className = ['month-section', ...extraSectionClasses]
      .filter(Boolean)
      .join(' ');
    sectionEl.dataset.month = clusterKey;
    sectionEl.appendChild(buildMonthHeaderBand(clusterKey, { granularity }));
    const gridEl = document.createElement('div');
    gridEl.className = 'photo-grid';
    sectionEl.appendChild(gridEl);
    return { sectionEl, gridEl };
  }

  return {
    monthKeyFromDate,
    dayKeyFromDate,
    monthLabel,
    dayLabel,
    clusterLabel,
    buildMonthHeaderBand,
    createMonthSection,
  };
})();
