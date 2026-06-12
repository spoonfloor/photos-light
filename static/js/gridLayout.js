/**
 * Virtual grid layout — pixel-aligned height model for month-grouped photo grid.
 */
const GridLayout = (() => {
  const GRID_GAP = 4;
  const GRID_MIN_COL = 200;
  const MONTH_HEADER_HEIGHT = 44;
  const MONTH_SECTION_MARGIN = 48;
  const HEADER_BAND_HEIGHT = MONTH_HEADER_HEIGHT + 20;

  function computeColumnLayout(containerWidth) {
    const width = Math.max(0, containerWidth);
    const columns = Math.max(
      1,
      Math.floor((width + GRID_GAP) / (GRID_MIN_COL + GRID_GAP)),
    );
    const trackWidth = Math.floor((width - (columns - 1) * GRID_GAP) / columns);
    return {
      containerWidth: width,
      columns,
      trackWidth,
      cellHeight: trackWidth,
      gap: GRID_GAP,
      gridTemplateColumns: `repeat(${columns}, 1fr)`,
    };
  }

  function monthGridHeight(photoCount, columnLayout) {
    if (!photoCount) {
      return 0;
    }
    const rows = Math.ceil(photoCount / columnLayout.columns);
    return (
      rows * columnLayout.cellHeight + Math.max(0, rows - 1) * columnLayout.gap
    );
  }

  function monthSectionHeight(photoCount, columnLayout) {
    const gridHeight = monthGridHeight(photoCount, columnLayout);
    if (!photoCount) {
      return 0;
    }
    return HEADER_BAND_HEIGHT + gridHeight + MONTH_SECTION_MARGIN;
  }

  /**
   * @param {{ month: string, count: number }[]} monthEntries
   */
  function buildVirtualLayout(monthEntries, columnLayout) {
    let y = 0;
    let globalStart = 0;
    const sections = [];

    monthEntries.forEach((entry) => {
      const count = entry.count || 0;
      if (!count) {
        return;
      }
      const height = monthSectionHeight(count, columnLayout);
      sections.push({
        month: entry.month,
        count,
        yStart: y,
        height,
        globalStart,
        globalEnd: globalStart + count - 1,
      });
      y += height;
      globalStart += count;
    });

    return {
      sections,
      totalHeight: y,
      totalPhotos: globalStart,
      columnLayout,
    };
  }

  /**
   * Spread total photos across calendar months for years that have media.
   * Used before month_index returns so scroll + placeholders are pixel-aligned.
   */
  function buildProvisionalMonthEntries(totalPhotos, years, sortOrder = 'newest') {
    const count = Math.max(0, totalPhotos || 0);
    if (!count || !years?.length) {
      return [];
    }

    const monthKeys = [];
    const sortedYears = sortOrder === 'newest' ? [...years].reverse() : [...years];
    sortedYears.forEach((year) => {
      const monthNums =
        sortOrder === 'newest'
          ? [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
          : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      monthNums.forEach((monthNum) => {
        monthKeys.push(`${year}-${String(monthNum).padStart(2, '0')}`);
      });
    });

    const bucketCount = monthKeys.length;
    const base = Math.floor(count / bucketCount);
    let remainder = count - base * bucketCount;

    return monthKeys
      .map((month) => {
        const extra = remainder > 0 ? 1 : 0;
        if (remainder > 0) {
          remainder -= 1;
        }
        const bucketCountForMonth = base + extra;
        return bucketCountForMonth > 0 ? { month, count: bucketCountForMonth } : null;
      })
      .filter(Boolean);
  }

  /** Pixel-aligned layout estimate before month_index returns. */
  function buildProvisionalLayout(totalPhotos, years, columnLayout, sortOrder = 'newest') {
    const months = buildProvisionalMonthEntries(totalPhotos, years, sortOrder);
    if (!months.length) {
      return {
        sections: [],
        totalHeight: 0,
        totalPhotos: 0,
        columnLayout,
        provisional: true,
      };
    }
    const nextLayout = buildVirtualLayout(months, columnLayout);
    nextLayout.provisional = true;
    return nextLayout;
  }

  function findSectionsInViewport(layout, scrollTop, viewportHeight, bufferPx = 1200) {
    if (!layout?.sections?.length) {
      return [];
    }
    const viewStart = Math.max(0, scrollTop - bufferPx);
    const viewEnd = scrollTop + viewportHeight + bufferPx;
    return layout.sections.filter(
      (section) =>
        section.yStart + section.height >= viewStart && section.yStart <= viewEnd,
    );
  }

  function findSectionForMonth(layout, monthKey) {
    return layout?.sections?.find((section) => section.month === monthKey) || null;
  }

  function findSectionForGlobalIndex(layout, globalIndex) {
    if (!layout?.sections?.length || globalIndex < 0) {
      return null;
    }
    return (
      layout.sections.find(
        (section) =>
          globalIndex >= section.globalStart && globalIndex <= section.globalEnd,
      ) || null
    );
  }

  function scrollTopForMonth(layout, monthKey, appBarOffset = 80) {
    const section = findSectionForMonth(layout, monthKey);
    if (!section) {
      return null;
    }
    return Math.max(0, section.yStart - appBarOffset);
  }

  /** Month header at the viewport anchor — independent of mounted DOM. */
  function findMonthAtScrollTop(layout, scrollTop, appBarOffset = 80) {
    const sections = layout?.sections;
    if (!sections?.length) {
      return null;
    }

    const anchorY = Math.max(0, scrollTop + appBarOffset);
    let candidate = sections[0];
    for (const section of sections) {
      if (section.yStart <= anchorY) {
        candidate = section;
      } else {
        break;
      }
    }
    return candidate.month;
  }

  function monthLabel(monthKey) {
    if (monthKey === 'undated') {
      return 'Undated';
    }
    const [year, monthNum] = monthKey.split('-');
    const monthName = new Date(
      parseInt(year, 10),
      parseInt(monthNum, 10) - 1,
    ).toLocaleString('default', { month: 'long' });
    return `${monthName} ${year}`;
  }

  /** Sections intersecting the visible viewport (no scroll buffer). */
  function findSectionsInStrictViewport(layout, scrollTop, viewportHeight) {
    if (!layout?.sections?.length) {
      return [];
    }
    const viewEnd = scrollTop + viewportHeight;
    return layout.sections.filter(
      (section) =>
        section.yStart + section.height >= scrollTop && section.yStart <= viewEnd,
    );
  }

  function defaultProvisionalYears() {
    const endYear = new Date().getFullYear();
    const years = [];
    for (let year = 1900; year <= endYear; year += 1) {
      years.push(year);
    }
    return years;
  }

  /** Canonical LayoutSnapshot fields on top of buildVirtualLayout output. */
  function toLayoutSnapshot(layout) {
    if (!layout) {
      return layout;
    }
    const columns = layout.columnLayout?.columns ?? 1;
    const cellSize = layout.columnLayout?.trackWidth ?? 0;
    const gap = layout.columnLayout?.gap ?? GRID_GAP;
    return {
      ...layout,
      columns,
      cellSize,
      gap,
    };
  }

  function publishCssVars(container, snapshot) {
    if (!container || !snapshot) {
      return;
    }
    container.style.setProperty('--grid-cols', String(snapshot.columns ?? 1));
    container.style.setProperty(
      '--grid-cell-px',
      `${snapshot.cellSize ?? snapshot.columnLayout?.trackWidth ?? 0}px`,
    );
    container.style.setProperty(
      '--grid-gap-px',
      `${snapshot.gap ?? snapshot.columnLayout?.gap ?? GRID_GAP}px`,
    );
  }

  function layoutGeometryChanged(previousLayout, nextLayout) {
    if (!previousLayout || !nextLayout) {
      return true;
    }
    const prevCols = previousLayout.columns ?? previousLayout.columnLayout?.columns;
    const nextCols = nextLayout.columns ?? nextLayout.columnLayout?.columns;
    const prevCell =
      previousLayout.cellSize ?? previousLayout.columnLayout?.trackWidth;
    const nextCell = nextLayout.cellSize ?? nextLayout.columnLayout?.trackWidth;
    return prevCols !== nextCols || prevCell !== nextCell;
  }

  function compareMonthKeys(a, b, sortOrder = 'newest') {
    if (a === 'undated') {
      return 1;
    }
    if (b === 'undated') {
      return -1;
    }
    if (sortOrder === 'newest') {
      return b.localeCompare(a);
    }
    return a.localeCompare(b);
  }

  function sortMonthEntries(entries, sortOrder = 'newest') {
    return [...entries].sort((a, b) =>
      compareMonthKeys(a.month, b.month, sortOrder),
    );
  }

  /** Apply +/- delta to one month bucket; returns new month_index payload. */
  function patchMonthIndexDelta(monthIndex, monthKey, delta) {
    if (!monthIndex || !monthKey || !delta) {
      return monthIndex;
    }
    const sort = monthIndex.sort || 'newest';
    const months = (monthIndex.months || []).map((entry) => ({ ...entry }));
    const idx = months.findIndex((entry) => entry.month === monthKey);
    if (idx >= 0) {
      months[idx].count += delta;
      if (months[idx].count <= 0) {
        months.splice(idx, 1);
      }
    } else if (delta > 0) {
      months.push({ month: monthKey, count: delta });
    }
    const ordered = sortMonthEntries(months, sort);
    const total = Math.max(0, (monthIndex.total || 0) + delta);
    const undatedEntry = ordered.find((entry) => entry.month === 'undated');
    return {
      ...monthIndex,
      months: ordered,
      total,
      undated_count: undatedEntry?.count || 0,
      sort,
    };
  }

  function patchPhotoMonthMove(monthIndex, oldMonth, newMonth) {
    if (!monthIndex || !oldMonth || !newMonth || oldMonth === newMonth) {
      return monthIndex;
    }
    let next = patchMonthIndexDelta(monthIndex, oldMonth, -1);
    next = patchMonthIndexDelta(next, newMonth, 1);
    return next;
  }

  function patchPhotoDeletes(monthIndex, monthCounts) {
    if (!monthIndex || !monthCounts?.size) {
      return monthIndex;
    }
    let next = monthIndex;
    monthCounts.forEach((delta, monthKey) => {
      next = patchMonthIndexDelta(next, monthKey, -delta);
    });
    return next;
  }

  function tileChunkHeight(columnLayout) {
    const cellSize = columnLayout.trackWidth;
    const gap = columnLayout.gap;
    const fullRowsHeight = 12 * cellSize + 11 * gap;
    const partialRowHeight = cellSize;
    return HEADER_BAND_HEIGHT + fullRowsHeight + partialRowHeight + MONTH_SECTION_MARGIN;
  }

  return {
    GRID_GAP,
    GRID_MIN_COL,
    MONTH_HEADER_HEIGHT,
    MONTH_SECTION_MARGIN,
    HEADER_BAND_HEIGHT,
    toLayoutSnapshot,
    publishCssVars,
    layoutGeometryChanged,
    compareMonthKeys,
    sortMonthEntries,
    patchMonthIndexDelta,
    patchPhotoMonthMove,
    patchPhotoDeletes,
    tileChunkHeight,
    computeColumnLayout,
    monthGridHeight,
    monthSectionHeight,
    buildVirtualLayout,
    buildProvisionalLayout,
    buildProvisionalMonthEntries,
    findSectionsInViewport,
    findSectionsInStrictViewport,
    defaultProvisionalYears,
    findSectionForMonth,
    findSectionForGlobalIndex,
    scrollTopForMonth,
    findMonthAtScrollTop,
    monthLabel,
  };
})();
