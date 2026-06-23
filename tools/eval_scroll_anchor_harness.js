#!/usr/bin/env node
/**
 * Autonomous scroll-anchor eval harness (offline, no browser).
 *
 * Loads gridLayout.js + gridScrollAnchor.js in Node, mirrors virtualGrid restore
 * helpers, and runs sort-toggle scenarios matching manual smoke Cases 1 & 2.
 *
 * Tiers:
 *   required  — must pass; exit 1 on failure
 *   guard     — documents a known anti-pattern still present; pass = pattern found
 *   known_bug — expected failure until product bug is fixed; does not fail the run
 *
 * Usage:
 *   node tools/eval_scroll_anchor_harness.js
 *   node tools/eval_scroll_anchor_harness.js --json
 *   node tools/eval_scroll_anchor_harness.js --verbose
 *
 * Exit 0 when all required + guard cases pass and no unexpected failures.
 * Exit 1 on required failure or harness error.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const APP_BAR_OFFSET = 80;
const VIEWPORT_HEIGHT = 900;
const CONTAINER_WIDTH = 1200;
const EPSILON = 2;

const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const VERBOSE = args.has('--verbose') || JSON_OUT;

/** @typedef {'required'|'guard'|'known_bug'} EvalTier */
/** @typedef {{ id: string, group: string, tier: EvalTier, status: 'pass'|'fail'|'expected_fail', detail?: string }} EvalResult */

/** Synthetic month histogram — stable, small, sort-reversible. */
const FIXTURE_INDEX = Object.freeze({
  total: 51,
  sort: 'newest',
  months: Object.freeze([
    { month: '2026-04', count: 15 },
    { month: '2024-06', count: 12 },
    { month: '2024-01', count: 24 },
  ]),
});

function loadGridModules() {
  const scrollState = { scrollY: 0 };
  const sandbox = {
    console,
    parseInt,
    parseFloat,
    Math,
    Number,
    Object,
    Array,
    JSON,
    window: {
      scrollTo({ top }) {
        scrollState.scrollY = top;
      },
      get scrollY() {
        return scrollState.scrollY;
      },
      innerHeight: VIEWPORT_HEIGHT,
    },
    document: {
      documentElement: { clientHeight: VIEWPORT_HEIGHT },
    },
    getComputedStyle() {
      return {
        getPropertyValue(prop) {
          const defaults = {
            '--grid-header-height-px': '44px',
            '--grid-header-gap-px': '12px',
            '--grid-header-band-px': '56px',
            '--grid-month-section-margin-px': '48px',
            '--grid-gap-px': '4px',
            '--grid-min-col-px': '200px',
            '--grid-comfort-full-rows': '12',
            '--grid-comfort-partial-col-offset': '2',
            '--grid-comfort-partial-min-cols': '1',
          };
          return defaults[prop] || '';
        },
      };
    },
  };
  vm.createContext(sandbox);
  const jsDir = path.join(REPO_ROOT, 'static', 'js');
  const asGlobalVar = (source) => source.replace(/^const (GridLayout|GridScrollAnchor) =/m, 'var $1 =');
  vm.runInContext(asGlobalVar(fs.readFileSync(path.join(jsDir, 'gridLayout.js'), 'utf8')), sandbox);
  vm.runInContext(asGlobalVar(fs.readFileSync(path.join(jsDir, 'gridScrollAnchor.js'), 'utf8')), sandbox);
  if (!sandbox.GridLayout || !sandbox.GridScrollAnchor) {
    throw new Error('Failed to load GridLayout / GridScrollAnchor');
  }
  return {
    GridLayout: sandbox.GridLayout,
    GridScrollAnchor: sandbox.GridScrollAnchor,
    scrollState,
  };
}

function fakeContainer(width = CONTAINER_WIDTH) {
  return { clientWidth: width };
}

function reindexForSort(indexPayload, sortOrderNext) {
  return {
    ...indexPayload,
    sort: sortOrderNext,
    months: GridLayout.sortMonthEntries(indexPayload.months || [], sortOrderNext),
  };
}

function buildLayoutFromIndex(indexPayload, container = fakeContainer()) {
  const columnLayout = GridLayout.computeColumnLayout(container);
  const sort = indexPayload?.sort || 'newest';
  const months = GridLayout.sortMonthEntries(indexPayload.months || [], sort);
  return GridLayout.buildVirtualLayout(months, columnLayout);
}

function maxScrollTopForLayout(layout, viewportHeight = VIEWPORT_HEIGHT) {
  return Math.max(0, (layout?.totalHeight ?? 0) - viewportHeight);
}

function prepareFilterScrollAnchor(anchor, indexPayload = null) {
  if (
    anchor?.kind !== GridScrollAnchor.KIND.DATE_THEN_ROW ||
    anchor.criteria?.kind !== 'first-visible-after-filter' ||
    anchor.row ||
    !indexPayload?.first_month
  ) {
    return anchor;
  }
  return {
    ...anchor,
    row: { month: indexPayload.first_month, rowIndex: 0 },
  };
}

function applyScrollAnchorToWindow(anchor, layout, sortOrder = 'newest', viewportHeight = VIEWPORT_HEIGHT, domMaxScrollTop = 0) {
  scrollState.scrollY = 0;
  const applied = GridScrollAnchor.applyScrollAnchor(
    anchor,
    layout,
    { sortOrder, monthIndex: null, viewportHeight, domMaxScrollTop },
    { behavior: 'instant' },
  );
  if (!applied) {
    return { applied: false, scrollTop: null };
  }
  return { applied: true, scrollTop: scrollState.scrollY };
}

/** Mirror virtualGrid.restoreScrollAfterLayoutChange (sort/filter warm path). */
function restoreScrollAfterLayoutChange(
  indexPayload,
  layout,
  scrollAnchor,
  {
    previousScrollTop = 0,
    maxScrollTop = 0,
    domMaxScrollTop = 0,
    sortOrder = 'newest',
    allowPixelFallback = true,
    viewportHeight = VIEWPORT_HEIGHT,
  } = {},
) {
  const anchor = prepareFilterScrollAnchor(
    scrollAnchor || { kind: GridScrollAnchor.KIND.NONE },
    indexPayload,
  );

  const direct = applyScrollAnchorToWindow(
    anchor,
    layout,
    sortOrder,
    viewportHeight,
    domMaxScrollTop,
  );
  if (direct.applied) {
    return {
      path: 'apply',
      anchor,
      scrollTop: direct.scrollTop,
      applied: true,
    };
  }

  if (anchor.kind === GridScrollAnchor.KIND.DATE_THEN_ROW) {
    return {
      path: 'date_then_row_queue',
      anchor,
      scrollTop: previousScrollTop,
      applied: false,
    };
  }

  if (previousScrollTop > maxScrollTop + 1) {
    const month = indexPayload?.months?.[0]?.month || null;
    const fallbackAnchor = month
      ? { kind: GridScrollAnchor.KIND.MONTH_HEADER, month }
      : { kind: GridScrollAnchor.KIND.NONE };
    const fallback = applyScrollAnchorToWindow(fallbackAnchor, layout, sortOrder);
    return {
      path: 'fallback_month_header',
      anchor,
      scrollTop: fallback.scrollTop ?? 0,
      applied: fallback.applied,
    };
  }

  if (previousScrollTop > 0 && allowPixelFallback) {
    return {
      path: 'pixel_fallback',
      anchor,
      scrollTop: Math.min(previousScrollTop, maxScrollTop),
      applied: false,
    };
  }

  return {
    path: 'none',
    anchor,
    scrollTop: previousScrollTop,
    applied: false,
  };
}

function captureSortAnchor(layout, scrollTop) {
  return GridScrollAnchor.resolveScrollAnchor({
    trigger: GridScrollAnchor.TRIGGER.SORT_TOGGLE,
    scrollTop,
    layout,
    preserveScroll: true,
    isSortChange: true,
  });
}

function rowViewportY(layout, scrollTop, month, rowIndex) {
  const section = layout.sections.find((entry) => entry.month === month);
  if (!section) {
    return null;
  }
  const localIndex = rowIndex * layout.columnLayout.columns;
  const rowY = GridLayout.rowDocumentY(layout, section, localIndex);
  if (rowY === null) {
    return null;
  }
  return rowY - scrollTop;
}

function topVisibleRowAnchor(layout, scrollTop) {
  return GridLayout.findTopVisibleRowAnchor(layout, scrollTop, APP_BAR_OFFSET);
}

function scrollTopForRowAtViewportY(layout, month, rowIndex, anchorViewportY) {
  return GridLayout.scrollTopToPreserveRowViewportY(
    layout,
    month,
    rowIndex,
    anchorViewportY,
  );
}

function scrollTopAlignHomeRow(layout, month, rowIndex = 0) {
  const homeTopY = GridLayout.homeGridTopDocumentY(layout);
  return GridLayout.scrollTopToAlignRowIndex(layout, month, rowIndex, homeTopY);
}

/** Find scrollTop where the last row of a month sits just above the viewport bottom. */
function scrollTopForLastRowAboveFold(layout, month) {
  const section = layout.sections.find((entry) => entry.month === month);
  if (!section) {
    return null;
  }
  const columns = layout.columnLayout.columns;
  const maxRows = Math.ceil(section.count / columns);
  const lastRowIndex = Math.max(0, maxRows - 1);
  const anchorViewportY = VIEWPORT_HEIGHT - layout.columnLayout.cellHeight - 40;
  return scrollTopForRowAtViewportY(layout, month, lastRowIndex, anchorViewportY);
}

function monthAtViewportAnchorLine(layout, scrollTop) {
  return GridLayout.findMonthAtScrollTop(layout, scrollTop, APP_BAR_OFFSET);
}

// --- Eval cases ---

const results = [];

function record(id, group, tier, status, detail = '') {
  results.push({ id, group, tier, status, detail });
  if (VERBOSE && !JSON_OUT) {
    const tag =
      status === 'pass'
        ? tier === 'guard'
          ? 'GUARD'
          : 'PASS'
        : status === 'expected_fail'
          ? 'XFAIL'
          : 'FAIL';
    console.log(`${tag}: [${group}/${tier}] ${id}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertNear(label, actual, expected, tolerance = EPSILON) {
  if (actual === null || expected === null) {
    throw new Error(`${label}: null value (actual=${actual}, expected=${expected})`);
  }
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: ${actual} != ${expected} (±${tolerance})`);
  }
}

function evalResolverMidScrollPicksFreezeRow() {
  const index = { ...FIXTURE_INDEX, sort: 'newest' };
  const layout = buildLayoutFromIndex(index);
  const scrollTop = scrollTopForLastRowAboveFold(layout, '2024-01');
  const anchor = captureSortAnchor(layout, scrollTop);
  if (anchor.kind !== GridScrollAnchor.KIND.FREEZE_ROW) {
    throw new Error(`expected FREEZE_ROW, got ${anchor.kind}`);
  }
  if (anchor.month !== '2024-01') {
    throw new Error(`expected animals month 2024-01, got ${anchor.month}`);
  }
}

function evalResolverCatalogHeadPicksFreezeRow() {
  const index = { ...FIXTURE_INDEX, sort: 'newest' };
  const layout = buildLayoutFromIndex(index);
  const anchor = captureSortAnchor(layout, 0);
  if (anchor.kind !== GridScrollAnchor.KIND.FREEZE_ROW) {
    throw new Error(`expected FREEZE_ROW, got ${anchor.kind}`);
  }
  if (anchor.month !== layout.sections[0].month || anchor.rowIndex !== 0) {
    throw new Error(`expected head row freeze, got ${JSON.stringify(anchor)}`);
  }
}

function evalResolverNearHeadPicksFreezeRow() {
  const index = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, 'tools/fixtures/scroll_anchor_month_index.json'),
      'utf8',
    ),
  );
  const layout = buildLayoutFromIndex(
    { ...index, sort: 'newest' },
    fakeContainer(812),
  );
  const anchor = captureSortAnchor(layout, 129);
  if (anchor.kind !== GridScrollAnchor.KIND.FREEZE_ROW) {
    throw new Error(`expected FREEZE_ROW at scrollTop=129, got ${anchor.kind}`);
  }
  if (anchor.month !== layout.sections[0].month || anchor.anchorViewportY !== -73) {
    throw new Error(`unexpected near-head freeze source ${JSON.stringify(anchor)}`);
  }
}

function evalFreezeRowSurvivesSortReversal() {
  const newestIndex = { ...FIXTURE_INDEX, sort: 'newest' };
  const newestLayout = buildLayoutFromIndex(newestIndex);
  const scrollTopBefore = scrollTopForLastRowAboveFold(newestLayout, '2024-01');
  const captured = captureSortAnchor(newestLayout, scrollTopBefore);
  if (captured.kind !== GridScrollAnchor.KIND.FREEZE_ROW) {
    throw new Error(`capture kind ${captured.kind}`);
  }

  const oldestIndex = reindexForSort(newestIndex, 'oldest');
  const oldestLayout = buildLayoutFromIndex(oldestIndex);
  const restored = applyScrollAnchorToWindow(captured, oldestLayout, 'oldest');
  if (!restored.applied) {
    throw new Error('FREEZE_ROW apply failed after sort reversal');
  }

  const viewportYBefore = captured.anchorViewportY;
  const viewportYAfter = rowViewportY(
    oldestLayout,
    restored.scrollTop,
    captured.month,
    captured.rowIndex,
  );
  assertNear('viewport Y preserved', viewportYAfter, viewportYBefore, 1);
}

function evalMidScrollSortRestoreDoesNotJumpToCatalogHead() {
  const newestIndex = { ...FIXTURE_INDEX, sort: 'newest' };
  const newestLayout = buildLayoutFromIndex(newestIndex);
  const scrollTopBefore = scrollTopForLastRowAboveFold(newestLayout, '2024-01');
  const captured = captureSortAnchor(newestLayout, scrollTopBefore);

  const oldestIndex = reindexForSort(newestIndex, 'oldest');
  const oldestLayout = buildLayoutFromIndex(oldestIndex);
  const maxScrollTop = maxScrollTopForLayout(oldestLayout);

  const outcome = restoreScrollAfterLayoutChange(
    oldestIndex,
    oldestLayout,
    captured,
    {
      previousScrollTop: scrollTopBefore,
      maxScrollTop,
      sortOrder: 'oldest',
      allowPixelFallback: false,
    },
  );

  if (outcome.path === 'pixel_fallback') {
    throw new Error(
      `mid-scroll used pixel fallback (scrollTop=${outcome.scrollTop}) — Case 2 regression`,
    );
  }
  if (!outcome.applied) {
    throw new Error(`restore did not apply anchor (path=${outcome.path})`);
  }

  const headMonth = oldestLayout.sections[0].month;
  const topRow = topVisibleRowAnchor(oldestLayout, outcome.scrollTop);
  if (topRow?.month === headMonth && topRow.rowIndex === 0) {
    const animalsY = rowViewportY(
      oldestLayout,
      outcome.scrollTop,
      captured.month,
      captured.rowIndex,
    );
    if (animalsY === null || animalsY > VIEWPORT_HEIGHT) {
      throw new Error(
        `catalog head at top but animals row off-screen (path=${outcome.path})`,
      );
    }
  }
}

function evalDateThenRowWithoutRowDoesNotApply() {
  const layout = buildLayoutFromIndex(FIXTURE_INDEX);
  const anchor = {
    kind: GridScrollAnchor.KIND.DATE_THEN_ROW,
  };
  const outcome = applyScrollAnchorToWindow(anchor, layout);
  if (outcome.applied) {
    throw new Error('DATE_THEN_ROW without row should not apply');
  }
}

function evalPixelFallbackDisabledOnSortRestore() {
  const outcome = restoreScrollAfterLayoutChange(
    reindexForSort(FIXTURE_INDEX, 'oldest'),
    buildLayoutFromIndex(reindexForSort(FIXTURE_INDEX, 'oldest')),
    {
      kind: GridScrollAnchor.KIND.FREEZE_ROW,
      month: '2099-12',
      rowIndex: 0,
      anchorViewportY: 120,
    },
    {
      previousScrollTop: 3337,
      maxScrollTop: 5000,
      sortOrder: 'oldest',
      allowPixelFallback: false,
    },
  );
  if (outcome.path === 'pixel_fallback') {
    throw new Error('sort restore must not use pixel fallback');
  }
}

function evalPixelFallbackStillAvailableForFilterWarm() {
  const outcome = restoreScrollAfterLayoutChange(
    reindexForSort(FIXTURE_INDEX, 'oldest'),
    buildLayoutFromIndex(reindexForSort(FIXTURE_INDEX, 'oldest')),
    {
      kind: GridScrollAnchor.KIND.FREEZE_ROW,
      month: '2099-12',
      rowIndex: 0,
      anchorViewportY: 120,
    },
    {
      previousScrollTop: 3337,
      maxScrollTop: 5000,
      sortOrder: 'oldest',
      allowPixelFallback: true,
    },
  );
  if (outcome.path !== 'pixel_fallback') {
    throw new Error('filter warm path should still allow pixel fallback');
  }
}

function evalSortToggleDisablesPixelFallbackGuard() {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'static', 'js', 'virtualGrid.js'),
    'utf8',
  );
  if (!source.includes('allowPixelFallback: false')) {
    throw new Error('applySortOrderInstant must disable sort pixel fallback');
  }
}

function evalQueuePendingIgnoresResolvedRow() {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'static', 'js', 'virtualGrid.js'),
    'utf8',
  );
  const body = source.slice(
    source.indexOf('function queuePendingScrollAnchor'),
    source.indexOf('function applyGridScrollAnchor'),
  );
  if (!body.includes('findHotRowInCatalog(anchor.criteria')) {
    throw new Error('queuePendingScrollAnchor no longer uses criteria-only lookup');
  }
  if (body.includes('anchor.row')) {
    throw new Error('queuePendingScrollAnchor now uses anchor.row — update guard eval');
  }
}

function loadGoldenMonthIndex() {
  const recipe = loadScrollTargetRecipe();
  if (recipe?.monthIndex?.months?.length) {
    return loadMonthIndexForRecipe(recipe);
  }
  return JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, 'tools/fixtures/scroll_anchor_month_index.json'),
      'utf8',
    ),
  );
}

function readScrollState(layout, scrollTop, sort) {
  const row = topVisibleRowAnchor(layout, scrollTop);
  return {
    scrollTop: Math.round(scrollTop),
    sort,
    headMonth: layout.sections[0]?.month ?? null,
    anchorMonth: row?.month ?? null,
    row: row?.rowIndex ?? null,
    rowViewportY: row ? Math.round(row.anchorViewportY) : null,
  };
}

function isEdgeScrollTop(scrollTop, layout) {
  const maxScrollTop = maxScrollTopForLayout(layout);
  return scrollTop <= GridScrollAnchor.HOME_SCROLL_EPSILON
    || scrollTop >= maxScrollTop - GridScrollAnchor.HOME_SCROLL_EPSILON;
}

function assertReadout(actual, expect, golden, layout) {
  const edge = isEdgeScrollTop(expect.scrollTop, layout);
  const scrollTol = edge ? golden.tolerance.edgeScrollTop : golden.tolerance.midScrollTop;
  const vpTol = edge ? golden.tolerance.edgeScrollTop : golden.tolerance.midRowViewportY;

  assertNear('scrollTop', actual.scrollTop, expect.scrollTop, scrollTol);
  if (actual.sort !== expect.sort) {
    throw new Error(`sort ${actual.sort} != ${expect.sort}`);
  }
  if (actual.headMonth !== expect.headMonth) {
    throw new Error(`headMonth ${actual.headMonth} != ${expect.headMonth}`);
  }
  if (actual.anchorMonth !== expect.anchorMonth) {
    throw new Error(`anchorMonth ${actual.anchorMonth} != ${expect.anchorMonth}`);
  }
  if (actual.row !== expect.row) {
    throw new Error(`row ${actual.row} != ${expect.row}`);
  }
  assertNear('rowViewportY', actual.rowViewportY, expect.rowViewportY, vpTol);

  if (expect.mustNot) {
    const bad = expect.mustNot;
    const matches =
      (bad.scrollTop === undefined || actual.scrollTop === bad.scrollTop)
      && (bad.anchorMonth === undefined || actual.anchorMonth === bad.anchorMonth)
      && (bad.row === undefined || actual.row === bad.row)
      && (bad.rowViewportY === undefined || actual.rowViewportY === bad.rowViewportY);
    if (matches) {
      throw new Error(`readout matched forbidden state ${JSON.stringify(bad)}`);
    }
  }
}

function sortToggleStep(fromSort, toSort, scrollTop, golden, monthIndex, action = {}) {
  const container = fakeContainer(golden.containerWidth);
  const viewportHeight = golden.viewportHeight ?? VIEWPORT_HEIGHT;
  const domMaxScrollTop = golden.domMaxScrollTop ?? 0;
  const fromIndex = { ...monthIndex, sort: fromSort };
  const fromLayout = buildLayoutFromIndex(fromIndex, container);
  const captured = action.sourceAnchor
    ? {
        kind: GridScrollAnchor.KIND.FREEZE_ROW,
        month: action.sourceAnchor.month,
        rowIndex: action.sourceAnchor.row,
        anchorViewportY: action.sourceAnchor.rowViewportY,
        domScrollSlack: action.sourceAnchor.domScrollSlack || 0,
      }
    : captureSortAnchor(fromLayout, scrollTop);
  const toIndex = reindexForSort({ ...monthIndex, sort: fromSort }, toSort);
  const toLayout = buildLayoutFromIndex(toIndex, container);
  const outcome = restoreScrollAfterLayoutChange(toIndex, toLayout, captured, {
    previousScrollTop: scrollTop,
    maxScrollTop: maxScrollTopForLayout(toLayout, viewportHeight),
    domMaxScrollTop,
    sortOrder: toSort,
    allowPixelFallback: false,
    previousLayout: fromLayout,
    previousSort: fromSort,
    viewportHeight,
  });
  if (!outcome.applied) {
    throw new Error(`sort toggle ${fromSort}->${toSort} did not apply (path=${outcome.path})`);
  }
  return readScrollState(toLayout, outcome.scrollTop, toSort);
}

function loadScrollTargetRecipe() {
  const recipePath = path.join(REPO_ROOT, 'tools/fixtures/scroll_anchor_recipe.json');
  if (!fs.existsSync(recipePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(recipePath, 'utf8'));
}

function loadMonthIndexForRecipe(recipe) {
  if (recipe?.monthIndex?.months?.length) {
    return {
      ...recipe.monthIndex,
      filtered: false,
      sort: recipe.monthIndex.sort || 'newest',
    };
  }
  return loadGoldenMonthIndex();
}

function recipeGoldenContext(recipe) {
  return {
    containerWidth: recipe.setup.containerWidth,
    viewportHeight: recipe.setup.viewportHeight ?? VIEWPORT_HEIGHT,
    domMaxScrollTop: recipe.setup.domMaxScrollTop ?? 0,
    tolerance: recipe.tolerance || {
      midScrollTop: 15,
      midRowViewportY: 5,
      edgeScrollTop: 0,
    },
  };
}

function assertStepReadout(actual, step, golden, layout) {
  assertReadout(actual, step.expect, golden, layout);
  if (step.mustNot) {
    const bad = step.mustNot;
    const matches =
      (bad.scrollTop === undefined || actual.scrollTop === bad.scrollTop)
      && (bad.anchorMonth === undefined || actual.anchorMonth === bad.anchorMonth)
      && (bad.row === undefined || actual.row === bad.row)
      && (bad.rowViewportY === undefined || actual.rowViewportY === bad.rowViewportY);
    if (matches) {
      throw new Error(`readout matched forbidden state ${JSON.stringify(bad)}`);
    }
  }
}

function runScrollTargetRecipe(recipe) {
  const golden = recipeGoldenContext(recipe);
  const monthIndex = loadMonthIndexForRecipe(recipe);
  let scrollTop = null;

  for (const step of recipe.steps) {
    const container = fakeContainer(golden.containerWidth);
    if (step.action?.type === 'sort-toggle') {
      const actual = sortToggleStep(
        step.action.fromSort,
        step.action.toSort,
        scrollTop,
        golden,
        monthIndex,
        step.action,
      );
      const layout = buildLayoutFromIndex(
        { ...monthIndex, sort: step.action.toSort },
        container,
      );
      assertStepReadout(actual, step, golden, layout);
      scrollTop = actual.scrollTop;
      continue;
    }

    scrollTop = step.expect.scrollTop;
    const layout = buildLayoutFromIndex(
      { ...monthIndex, sort: step.expect.sort },
      container,
    );
    const actual = readScrollState(layout, scrollTop, step.expect.sort);
    assertStepReadout(actual, step, golden, layout);
  }
}

function evalUserScrollTargetRecipe() {
  const recipe = loadScrollTargetRecipe();
  if (!recipe?.steps?.length) {
    throw new Error('tools/fixtures/scroll_anchor_recipe.json missing or empty');
  }
  if (!recipe.setup?.containerWidth) {
    throw new Error('recipe.setup.containerWidth required');
  }
  runScrollTargetRecipe(recipe);
}

function evalMidScrollFreezeFailureMustNotUsePixelFallback() {
  evalPixelFallbackDisabledOnSortRestore();
}

const EVALS = [
  {
    id: 'resolver_mid_scroll_freeze_row',
    group: 'resolver',
    tier: 'required',
    run: evalResolverMidScrollPicksFreezeRow,
  },
  {
    id: 'resolver_near_head_freeze_row',
    group: 'resolver',
    tier: 'required',
    run: evalResolverNearHeadPicksFreezeRow,
  },
  {
    id: 'resolver_catalog_head_freeze_row',
    group: 'resolver',
    tier: 'required',
    run: evalResolverCatalogHeadPicksFreezeRow,
  },
  {
    id: 'freeze_row_survives_sort_reversal',
    group: 'math',
    tier: 'required',
    run: evalFreezeRowSurvivesSortReversal,
  },
  {
    id: 'mid_scroll_sort_no_catalog_head_jump',
    group: 'scenario',
    tier: 'required',
    run: evalMidScrollSortRestoreDoesNotJumpToCatalogHead,
  },
  {
    id: 'user_scroll_target_recipe',
    group: 'recipe',
    tier: 'required',
    run: evalUserScrollTargetRecipe,
  },
  {
    id: 'date_then_row_without_row_no_apply',
    group: 'apply',
    tier: 'required',
    run: evalDateThenRowWithoutRowDoesNotApply,
  },
  {
    id: 'sort_restore_no_pixel_fallback',
    group: 'regression_guard',
    tier: 'required',
    run: evalPixelFallbackDisabledOnSortRestore,
  },
  {
    id: 'filter_warm_keeps_pixel_fallback',
    group: 'regression_guard',
    tier: 'required',
    run: evalPixelFallbackStillAvailableForFilterWarm,
  },
  {
    id: 'sort_toggle_disables_pixel_fallback',
    group: 'contract',
    tier: 'guard',
    run: evalSortToggleDisablesPixelFallbackGuard,
  },
  {
    id: 'queue_pending_ignores_resolved_row',
    group: 'contract',
    tier: 'guard',
    run: evalQueuePendingIgnoresResolvedRow,
  },
];

let GridLayout;
let GridScrollAnchor;
/** @type {{ scrollY: number }} */
let scrollState;

function main() {
  ({ GridLayout, GridScrollAnchor, scrollState } = loadGridModules());

  for (const evalCase of EVALS) {
    try {
      evalCase.run();
      record(evalCase.id, evalCase.group, evalCase.tier, 'pass');
    } catch (error) {
      const status =
        evalCase.tier === 'known_bug' ? 'expected_fail' : 'fail';
      record(evalCase.id, evalCase.group, evalCase.tier, status, error.message);
    }
  }

  const passed = results.filter((row) => row.status === 'pass').length;
  const failed = results.filter((row) => row.status === 'fail').length;
  const expectedFail = results.filter((row) => row.status === 'expected_fail').length;
  const requiredFailed = results.filter(
    (row) => row.status === 'fail' && row.tier === 'required',
  ).length;
  const guardFailed = results.filter(
    (row) => row.status === 'fail' && row.tier === 'guard',
  ).length;

  const summary = {
    passed,
    failed,
    expected_fail: expectedFail,
    required_failed: requiredFailed,
    guard_failed: guardFailed,
    total: results.length,
    cases: results,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('\n=== Scroll anchor eval summary ===');
    console.log(
      `pass: ${passed}  fail: ${failed}  expected_fail: ${expectedFail}`,
    );
    console.log(
      `required_failed: ${requiredFailed}  guard_failed: ${guardFailed}`,
    );
    for (const row of results) {
      const tag =
        row.status === 'pass'
          ? row.tier === 'guard'
            ? 'GUARD'
            : 'PASS'
          : row.status === 'expected_fail'
            ? 'XFAIL'
            : 'FAIL';
      console.log(
        `  ${tag}  [${row.tier}] ${row.id}${row.detail ? ` — ${row.detail}` : ''}`,
      );
    }
    console.log(
      '\nNote: offline math can pass while packaged UI still fails (hydration/timing).',
    );
    console.log(
      'Guard cases document anti-patterns to remove when fixing sort scroll.',
    );
  }

  if (requiredFailed > 0 || guardFailed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
