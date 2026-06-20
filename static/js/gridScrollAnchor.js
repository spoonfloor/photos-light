/**
 * Grid scroll anchor policies — single resolver + apply for all grid redraws.
 *
 * | Kind            | Priority   | Use when |
 * |-----------------|------------|----------|
 * | date-then-row   | date→content | Date jumper, filter chip toggle |
 * | freeze-row      | content    | Sort toggle, mutations, undo |
 * | month-header    | legacy     | Default catalog preserve, histogram month target |
 */
const GridScrollAnchor = (() => {
  const HOME_SCROLL_EPSILON = 8;
  const APP_BAR_OFFSET = 80;

  const TRIGGER = Object.freeze({
    DATE_JUMP: 'date-jump',
    FILTER_TOGGLE: 'filter-toggle',
    SORT_TOGGLE: 'sort-toggle',
    CATALOG_TRANSITION: 'catalog-transition',
    MUTATION: 'mutation',
  });

  const KIND = Object.freeze({
    DATE_THEN_ROW: 'date-then-row',
    FREEZE_ROW: 'freeze-row',
    MONTH_HEADER: 'month-header',
    NONE: 'none',
  });

  function catalogFilterActive(filterOptions = {}) {
    return Boolean(
      filterOptions.starred || filterOptions.video || filterOptions.importSets,
    );
  }

  const FILTER_HOT_ROW_MATCHERS = Object.freeze({
    starred: Object.freeze({
      wasActive: (previousMonthIndex) =>
        Boolean(previousMonthIndex?.starred && previousMonthIndex?.filtered),
      isActive: (filterOptions) => Boolean(filterOptions.starred),
      criteria: Object.freeze({ kind: 'first-matching', match: 'starred' }),
    }),
    video: Object.freeze({
      wasActive: (previousMonthIndex) =>
        Boolean(previousMonthIndex?.video && previousMonthIndex?.filtered),
      isActive: (filterOptions) => Boolean(filterOptions.video),
      criteria: Object.freeze({ kind: 'first-matching', match: 'video' }),
    }),
  });

  function wasPhotoFilterActive(match, previousMonthIndex) {
    return Boolean(FILTER_HOT_ROW_MATCHERS[match]?.wasActive(previousMonthIndex));
  }

  function isPhotoFilterTransition(match, filterOptions, previousMonthIndex) {
    const matcher = FILTER_HOT_ROW_MATCHERS[match];
    if (!matcher) {
      return false;
    }
    const wasActive = matcher.wasActive(previousMonthIndex);
    const isActive = matcher.isActive(filterOptions);
    return (!wasActive && isActive) || (wasActive && !isActive);
  }

  function wasStarredFilterActive(previousMonthIndex) {
    return wasPhotoFilterActive('starred', previousMonthIndex);
  }

  function isStarredFilterTransition(filterOptions, previousMonthIndex) {
    return isPhotoFilterTransition('starred', filterOptions, previousMonthIndex);
  }

  function wasVideoFilterActive(previousMonthIndex) {
    return wasPhotoFilterActive('video', previousMonthIndex);
  }

  function isVideoFilterTransition(filterOptions, previousMonthIndex) {
    return isPhotoFilterTransition('video', filterOptions, previousMonthIndex);
  }

  function wasSelectionFilterActive(previousMonthIndex) {
    return Boolean(previousMonthIndex?.selectionScope);
  }

  function isSelectionFilterTransition(previousMonthIndex, selectionActive) {
    const turningOn =
      !wasSelectionFilterActive(previousMonthIndex) && Boolean(selectionActive);
    const turningOff =
      wasSelectionFilterActive(previousMonthIndex) && !selectionActive;
    return turningOn || turningOff;
  }

  function isFilterHotRowToggle(trigger) {
    return trigger === TRIGGER.FILTER_TOGGLE;
  }

  const FIRST_VISIBLE_FILTER_ROW = Object.freeze({
    kind: 'first-visible-after-filter',
  });

  function filterActiveAfterToggle(filterOptions, selectionActive) {
    return catalogFilterActive(filterOptions) || Boolean(selectionActive);
  }

  function collectRemovedFilterCriteria({
    filterOptions = {},
    previousMonthIndex = null,
    selectionActive = false,
    selectedAnchorIds = null,
  } = {}) {
    const removed = [];

    Object.values(FILTER_HOT_ROW_MATCHERS).forEach((matcher) => {
      if (matcher.wasActive(previousMonthIndex) && !matcher.isActive(filterOptions)) {
        removed.push(matcher.criteria);
      }
    });

    if (
      wasSelectionFilterActive(previousMonthIndex) &&
      !selectionActive &&
      selectedAnchorIds?.size
    ) {
      removed.push({
        kind: 'first-matching',
        match: 'selected',
        selectedIds: selectedAnchorIds,
      });
    }

    return removed;
  }

  /** Filter chip toggle → resulting catalog's hot row; last-filter OFF → removed filter's row. */
  function resolveFilterHotRowCriteria(context = {}) {
    const {
      trigger,
      filterOptions = {},
      previousMonthIndex = null,
      selectionActive = false,
      selectedAnchorIds = null,
    } = context;

    if (!isFilterHotRowToggle(trigger)) {
      return null;
    }

    if (filterActiveAfterToggle(filterOptions, selectionActive)) {
      return {
        kind: KIND.DATE_THEN_ROW,
        criteria: FIRST_VISIBLE_FILTER_ROW,
      };
    }

    const removed = collectRemovedFilterCriteria({
      filterOptions,
      previousMonthIndex,
      selectionActive,
      selectedAnchorIds,
    });

    if (removed.length !== 1) {
      return null;
    }

    return {
      kind: KIND.DATE_THEN_ROW,
      criteria: removed[0],
    };
  }

  function resolveScrollAnchor(context = {}) {
    const {
      trigger = TRIGGER.CATALOG_TRANSITION,
      scrollTop = 0,
      layout = null,
      filterOptions = {},
      previousMonthIndex = null,
      scrollTargetMonth = null,
      preserveScroll = true,
      isSortChange = false,
      alignToHomeGridTop = false,
      targetMonth = null,
      axisChanged = false,
      selectionActive = false,
      selectedAnchorIds = null,
    } = context;

    if (!layout || layout.provisional) {
      return { kind: KIND.NONE };
    }

    if (trigger === TRIGGER.DATE_JUMP) {
      const month = targetMonth || scrollTargetMonth;
      if (!month) {
        return { kind: KIND.NONE };
      }
      if (alignToHomeGridTop) {
        return {
          kind: KIND.DATE_THEN_ROW,
          row: { month, rowIndex: 0 },
        };
      }
      return {
        kind: KIND.MONTH_HEADER,
        month,
      };
    }

    const filterHotRowAnchor = resolveFilterHotRowCriteria({
      trigger,
      filterOptions,
      previousMonthIndex,
      selectionActive,
      selectedAnchorIds,
    });
    if (filterHotRowAnchor) {
      return filterHotRowAnchor;
    }

    const wantsFreezeRow =
      trigger === TRIGGER.SORT_TOGGLE ||
      trigger === TRIGGER.MUTATION ||
      (trigger === TRIGGER.CATALOG_TRANSITION && isSortChange);

    if (
      wantsFreezeRow &&
      preserveScroll &&
      !scrollTargetMonth &&
      !filterHotRowAnchor
    ) {
      const rowAnchor = GridLayout.findTopVisibleRowAnchor(
        layout,
        scrollTop,
        APP_BAR_OFFSET,
      );
      if (rowAnchor) {
        return { kind: KIND.FREEZE_ROW, ...rowAnchor };
      }
    }

    if (axisChanged) {
      return { kind: KIND.NONE };
    }

    if (scrollTargetMonth) {
      return { kind: KIND.MONTH_HEADER, month: scrollTargetMonth };
    }

    if (preserveScroll) {
      const month = GridLayout.findMonthAtScrollTop(
        layout,
        scrollTop,
        APP_BAR_OFFSET,
      );
      if (month) {
        return { kind: KIND.MONTH_HEADER, month };
      }
    }

    return { kind: KIND.NONE };
  }

  function effectiveScrollAnchor(anchor, axisChanged) {
    if (!anchor || anchor.kind === KIND.NONE) {
      return anchor;
    }
    if (axisChanged && anchor.kind !== KIND.FREEZE_ROW && anchor.kind !== KIND.DATE_THEN_ROW) {
      return { kind: KIND.NONE };
    }
    return anchor;
  }

  function applyScrollAnchor(anchor, layout, helpers = {}, options = {}) {
    if (!layout || !anchor || anchor.kind === KIND.NONE) {
      return false;
    }

    const behavior = options.behavior ?? 'instant';
    const { sortOrder = 'newest', monthIndex = null } = helpers;

    const scrollToTop = (top) => {
      if (top === null) {
        return false;
      }
      window.scrollTo({ top, behavior });
      return true;
    };

    switch (anchor.kind) {
      case KIND.DATE_THEN_ROW: {
        const homeTopY = GridLayout.homeGridTopDocumentY(layout);
        if (anchor.row) {
          const top = GridLayout.scrollTopToAlignRowIndex(
            layout,
            anchor.row.month,
            anchor.row.rowIndex,
            homeTopY,
          );
          return scrollToTop(top);
        }
        return false;
      }
      case KIND.FREEZE_ROW: {
        const top = GridLayout.scrollTopToPreserveRowViewportY(
          layout,
          anchor.month,
          anchor.rowIndex,
          anchor.anchorViewportY,
        );
        return scrollToTop(top);
      }
      case KIND.MONTH_HEADER: {
        const resolved = GridLayout.resolveJumpMonth(
          layout,
          anchor.month,
          monthIndex,
          sortOrder,
        );
        const top = resolved
          ? GridLayout.scrollTopForMonth(layout, resolved, APP_BAR_OFFSET)
          : null;
        return scrollToTop(top);
      }
      default:
        return false;
    }
  }

  function fallbackScrollAfterLayout(indexPayload, layout, helpers = {}) {
    const month = indexPayload?.months?.[0]?.month || null;
    if (month) {
      return applyScrollAnchor({ kind: KIND.MONTH_HEADER, month }, layout, helpers);
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    return true;
  }

  return {
    TRIGGER,
    KIND,
    HOME_SCROLL_EPSILON,
    APP_BAR_OFFSET,
    wasStarredFilterActive,
    wasVideoFilterActive,
    wasSelectionFilterActive,
    isStarredFilterTransition,
    isVideoFilterTransition,
    isSelectionFilterTransition,
    resolveFilterHotRowCriteria,
    resolveScrollAnchor,
    effectiveScrollAnchor,
    applyScrollAnchor,
    fallbackScrollAfterLayout,
  };
})();
