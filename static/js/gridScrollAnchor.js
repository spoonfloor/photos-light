/**
 * Grid scroll anchor policies — single resolver + apply for all grid redraws.
 *
 * | Kind            | Priority   | Use when |
 * |-----------------|------------|----------|
 * | date-home       | date       | Date jumper |
 * | date-then-row   | date→content | Filter toggle from home (starred on/off) |
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
    DATE_HOME: 'date-home',
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

  function wasStarredFilterActive(previousMonthIndex) {
    return Boolean(previousMonthIndex?.starred && previousMonthIndex?.filtered);
  }

  function isStarredFilterTransition(filterOptions, previousMonthIndex) {
    const starTurningOn =
      !wasStarredFilterActive(previousMonthIndex) && Boolean(filterOptions.starred);
    const starTurningOff =
      wasStarredFilterActive(previousMonthIndex) && !filterOptions.starred;
    return starTurningOn || starTurningOff;
  }

  function starFilterTurningOn(filterOptions, previousMonthIndex) {
    return (
      !wasStarredFilterActive(previousMonthIndex) && Boolean(filterOptions.starred)
    );
  }

  function starFilterTurningOff(filterOptions, previousMonthIndex) {
    return (
      wasStarredFilterActive(previousMonthIndex) && !filterOptions.starred
    );
  }

  function isStarredFilterToggle(
    trigger,
    filterOptions,
    previousMonthIndex,
    viewportZone,
  ) {
    return (
      trigger === TRIGGER.FILTER_TOGGLE &&
      viewportZone === 'timeline-home' &&
      isStarredFilterTransition(filterOptions, previousMonthIndex)
    );
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
      viewportZone = scrollTop <= HOME_SCROLL_EPSILON ? 'timeline-home' : 'mid-scroll',
    } = context;

    if (!layout || layout.provisional) {
      return { kind: KIND.NONE };
    }

    if (trigger === TRIGGER.DATE_JUMP) {
      const month = targetMonth || scrollTargetMonth;
      if (!month) {
        return { kind: KIND.NONE };
      }
      return {
        kind: alignToHomeGridTop ? KIND.DATE_HOME : KIND.MONTH_HEADER,
        month,
      };
    }

    if (
      isStarredFilterToggle(
        trigger,
        filterOptions,
        previousMonthIndex,
        viewportZone,
      )
    ) {
      return { kind: KIND.DATE_THEN_ROW, criteria: 'first-starred' };
    }

    const wantsFreezeRow =
      trigger === TRIGGER.SORT_TOGGLE ||
      trigger === TRIGGER.MUTATION ||
      (trigger === TRIGGER.CATALOG_TRANSITION && isSortChange);

    if (
      wantsFreezeRow &&
      preserveScroll &&
      !scrollTargetMonth &&
      !isStarredFilterToggle(
        trigger,
        filterOptions,
        previousMonthIndex,
        viewportZone,
      )
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
      case KIND.DATE_HOME: {
        const resolved = GridLayout.resolveJumpMonth(
          layout,
          anchor.month,
          monthIndex,
          sortOrder,
        );
        const top = resolved
          ? GridLayout.scrollTopForMonthAtHomeGridTop(layout, resolved)
          : null;
        return scrollToTop(top);
      }
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
    starFilterTurningOn,
    starFilterTurningOff,
    isStarredFilterToggle,
    resolveScrollAnchor,
    effectiveScrollAnchor,
    applyScrollAnchor,
    fallbackScrollAfterLayout,
  };
})();
