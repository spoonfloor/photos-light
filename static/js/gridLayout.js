/**
 * Virtual grid layout — pixel-aligned height model for month-grouped photo grid.
 * Static rhythm tokens live on `.grid-root` in CSS; JS reads via getComputedStyle.
 */
const GridLayout = (() => {
  const DEFAULT_RHYTHM = {
    headerHeight: 44,
    headerGap: 12,
    headerBand: 56,
    sectionMargin: 48,
    gap: 4,
    minCol: 200,
    comfortFullRows: 12,
    comfortPartialColOffset: 2,
    comfortPartialMinCols: 1,
  };

  let rhythmCache = null;
  let rhythmCacheContainer = null;

  function parseTokenPx(value, fallback) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function parseTokenInt(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function readGridRhythmTokens(container) {
    if (!container) {
      return { ...DEFAULT_RHYTHM };
    }
    if (rhythmCacheContainer === container && rhythmCache) {
      return rhythmCache;
    }

    const style = getComputedStyle(container);
    const headerHeight = parseTokenPx(
      style.getPropertyValue('--grid-header-height-px'),
      DEFAULT_RHYTHM.headerHeight,
    );
    const headerGap = parseTokenPx(
      style.getPropertyValue('--grid-header-gap-px'),
      DEFAULT_RHYTHM.headerGap,
    );
    const headerBand = parseTokenPx(
      style.getPropertyValue('--grid-header-band-px'),
      headerHeight + headerGap,
    );

    rhythmCache = {
      headerHeight,
      headerGap,
      headerBand,
      sectionMargin: parseTokenPx(
        style.getPropertyValue('--grid-month-section-margin-px'),
        DEFAULT_RHYTHM.sectionMargin,
      ),
      gap: parseTokenPx(style.getPropertyValue('--grid-gap-px'), DEFAULT_RHYTHM.gap),
      minCol: parseTokenPx(
        style.getPropertyValue('--grid-min-col-px'),
        DEFAULT_RHYTHM.minCol,
      ),
      comfortFullRows: parseTokenInt(
        style.getPropertyValue('--grid-comfort-full-rows'),
        DEFAULT_RHYTHM.comfortFullRows,
      ),
      comfortPartialColOffset: parseTokenInt(
        style.getPropertyValue('--grid-comfort-partial-col-offset'),
        DEFAULT_RHYTHM.comfortPartialColOffset,
      ),
      comfortPartialMinCols: parseTokenInt(
        style.getPropertyValue('--grid-comfort-partial-min-cols'),
        DEFAULT_RHYTHM.comfortPartialMinCols,
      ),
    };
    rhythmCacheContainer = container;
    return rhythmCache;
  }

  function invalidateRhythmTokenCache() {
    rhythmCache = null;
    rhythmCacheContainer = null;
  }

  function computeColumnLayout(container) {
    const width = Math.max(0, container?.clientWidth ?? 0);
    const rhythm = readGridRhythmTokens(container);
    const gap = rhythm.gap;
    const minCol = rhythm.minCol;
    const columns = Math.max(1, Math.floor((width + gap) / (minCol + gap)));
    const trackWidth = Math.floor((width - (columns - 1) * gap) / columns);
    return {
      containerWidth: width,
      columns,
      trackWidth,
      cellHeight: trackWidth,
      gap,
      rhythm,
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
    const rhythm = columnLayout.rhythm || DEFAULT_RHYTHM;
    return rhythm.headerBand + gridHeight + rhythm.sectionMargin;
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

  /** Document Y of the first photo row when scrolled to timeline home (scrollTop 0). */
  function homeGridTopDocumentY(layout) {
    const section = layout?.sections?.[0];
    if (!section) {
      return 0;
    }
    const headerBand = layout.columnLayout?.rhythm?.headerBand ?? DEFAULT_RHYTHM.headerBand;
    return section.yStart + headerBand;
  }

  /** Document Y of a photo row within a month section (local index in full month order). */
  function rowDocumentY(layout, section, localIndex) {
    if (!section || localIndex < 0) {
      return null;
    }
    const columnLayout = layout?.columnLayout;
    if (!columnLayout) {
      return null;
    }
    const headerBand = columnLayout.rhythm?.headerBand ?? DEFAULT_RHYTHM.headerBand;
    const rowIndex = Math.floor(localIndex / columnLayout.columns);
    return (
      section.yStart +
      headerBand +
      rowIndex * (columnLayout.cellHeight + columnLayout.gap)
    );
  }

  /** scrollTop so row localIndex aligns with alignToDocumentY (e.g. home grid top). */
  function scrollTopToAlignRow(layout, section, localIndex, alignToDocumentY) {
    const rowY = rowDocumentY(layout, section, localIndex);
    if (rowY === null) {
      return null;
    }
    return Math.max(0, rowY - alignToDocumentY);
  }

  /** scrollTop so a month row (by row index) aligns with alignToDocumentY. */
  function scrollTopToAlignRowIndex(layout, month, rowIndex, alignToDocumentY) {
    const section = findSectionForMonth(layout, month);
    const columnLayout = layout?.columnLayout;
    if (!section || !columnLayout || rowIndex < 0) {
      return null;
    }
    const maxRows = Math.ceil(section.count / columnLayout.columns);
    const clampedRow = Math.min(
      Math.max(0, rowIndex),
      Math.max(0, maxRows - 1),
    );
    const localIndex = clampedRow * columnLayout.columns;
    return scrollTopToAlignRow(layout, section, localIndex, alignToDocumentY);
  }

  /** Top photo row at the viewport anchor line — for sort-order scroll freeze. */
  function findTopVisibleRowAnchor(layout, scrollTop, appBarOffset = 80) {
    const sections = layout?.sections;
    const columnLayout = layout?.columnLayout;
    if (!sections?.length || !columnLayout) {
      return null;
    }

    const anchorLine = Math.max(0, scrollTop + appBarOffset);
    let section = sections[0];
    for (const candidate of sections) {
      if (candidate.yStart <= anchorLine) {
        section = candidate;
      } else {
        break;
      }
    }

    const headerBand = columnLayout.rhythm?.headerBand ?? DEFAULT_RHYTHM.headerBand;
    const rowStride = columnLayout.cellHeight + columnLayout.gap;
    const gridTop = section.yStart + headerBand;
    let rowIndex = 0;
    if (anchorLine >= gridTop && rowStride > 0) {
      rowIndex = Math.floor((anchorLine - gridTop) / rowStride);
    }

    const maxRows = Math.ceil(section.count / columnLayout.columns);
    rowIndex = Math.min(Math.max(0, rowIndex), Math.max(0, maxRows - 1));

    const localIndex = rowIndex * columnLayout.columns;
    const rowY = rowDocumentY(layout, section, localIndex);
    if (rowY === null) {
      return null;
    }

    return {
      month: section.month,
      rowIndex,
      anchorViewportY: rowY - scrollTop,
    };
  }

  /** scrollTop that keeps the same month row at anchorViewportY after layout change. */
  function scrollTopToPreserveRowViewportY(
    layout,
    month,
    rowIndex,
    anchorViewportY,
  ) {
    const section = findSectionForMonth(layout, month);
    const columnLayout = layout?.columnLayout;
    if (!section || !columnLayout || anchorViewportY == null) {
      return null;
    }

    const maxRows = Math.ceil(section.count / columnLayout.columns);
    const clampedRow = Math.min(
      Math.max(0, rowIndex),
      Math.max(0, maxRows - 1),
    );
    const localIndex = clampedRow * columnLayout.columns;
    const rowY = rowDocumentY(layout, section, localIndex);
    if (rowY === null) {
      return null;
    }
    return Math.max(0, rowY - anchorViewportY);
  }

  function monthOrdinal(monthKey) {
    if (!monthKey || monthKey === 'undated') {
      return Number.NaN;
    }
    const [year, monthNum] = monthKey.split('-').map((part) => parseInt(part, 10));
    if (!year || !monthNum) {
      return Number.NaN;
    }
    return year * 12 + monthNum;
  }

  /**
   * Client-side mirror of GET /api/photos/nearest_month — no network on jump path.
   */
  function nearestMonthInIndex(targetMonth, availableMonths, sortOrder = 'newest') {
    if (!targetMonth || !availableMonths?.length) {
      return null;
    }

    const months = availableMonths.filter(
      (monthKey) => monthKey && monthKey !== 'undated',
    );
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
      return candidates.length
        ? candidates[candidates.length - 1]
        : yearMonths[0];
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

  /** Resolve picker month to a section present in the current snapshot. */
  function resolveJumpMonth(layout, monthKey, monthIndex, sortOrder = 'newest') {
    if (!layout || !monthKey) {
      return null;
    }
    if (findSectionForMonth(layout, monthKey)) {
      return monthKey;
    }

    const indexMonths = monthIndex?.months
      ?.map((entry) => entry.month)
      .filter((month) => month && month !== 'undated');
    if (indexMonths?.length) {
      return nearestMonthInIndex(monthKey, indexMonths, sortOrder);
    }

    const layoutMonths = layout.sections
      ?.map((section) => section.month)
      .filter((month) => month && month !== 'undated');
    if (layoutMonths?.length) {
      return nearestMonthInIndex(monthKey, layoutMonths, sortOrder);
    }

    return null;
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
    const importPrefix = 'import:';
    if (monthKey.startsWith(importPrefix)) {
      const monthToken = monthKey.slice(importPrefix.length);
      if (/^\d{4}-\d{2}$/.test(monthToken)) {
        const [year, monthNum] = monthToken.split('-');
        const monthName = new Date(
          parseInt(year, 10),
          parseInt(monthNum, 10) - 1,
        ).toLocaleString('default', { month: 'long' });
        return `Imported ${monthName} ${year}`;
      }
      return `Imported ${monthToken}`;
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
    const gap = layout.columnLayout?.gap ?? DEFAULT_RHYTHM.gap;
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
    const rhythm = columnLayout.rhythm || DEFAULT_RHYTHM;
    const fullRows = rhythm.comfortFullRows;
    const fullRowsHeight = fullRows * cellSize + Math.max(0, fullRows - 1) * gap;
    const partialRowHeight = cellSize;
    return rhythm.headerBand + fullRowsHeight + partialRowHeight + rhythm.sectionMargin;
  }

  function comfortPartialCellCount(columnLayout) {
    const rhythm = columnLayout.rhythm || DEFAULT_RHYTHM;
    return Math.max(
      rhythm.comfortPartialMinCols,
      columnLayout.columns - rhythm.comfortPartialColOffset,
    );
  }

  return {
    readGridRhythmTokens,
    invalidateRhythmTokenCache,
    toLayoutSnapshot,
    publishCssVars,
    layoutGeometryChanged,
    compareMonthKeys,
    sortMonthEntries,
    patchMonthIndexDelta,
    patchPhotoMonthMove,
    patchPhotoDeletes,
    tileChunkHeight,
    comfortPartialCellCount,
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
    homeGridTopDocumentY,
    rowDocumentY,
    scrollTopToAlignRow,
    scrollTopToAlignRowIndex,
    findTopVisibleRowAnchor,
    scrollTopToPreserveRowViewportY,
    nearestMonthInIndex,
    resolveJumpMonth,
    findMonthAtScrollTop,
    monthLabel,
  };
})();
