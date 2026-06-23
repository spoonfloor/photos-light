#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const VIEWPORT_HEIGHT = 977;
const APP_BAR_OFFSET = 80;
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
  document: { documentElement: { clientHeight: VIEWPORT_HEIGHT } },
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
        };
        return defaults[prop] || '';
      },
    };
  },
};

vm.createContext(sandbox);
const jsDir = path.join(REPO_ROOT, 'static/js');
const asGlobalVar = (source) =>
  source.replace(/^const (GridLayout|GridScrollAnchor) =/m, 'var $1 =');
vm.runInContext(asGlobalVar(fs.readFileSync(path.join(jsDir, 'gridLayout.js'), 'utf8')), sandbox);
vm.runInContext(
  asGlobalVar(fs.readFileSync(path.join(jsDir, 'gridScrollAnchor.js'), 'utf8')),
  sandbox,
);

const { GridLayout, GridScrollAnchor } = sandbox;
const recipe = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/fixtures/scroll_anchor_recipe.json'), 'utf8'),
);
const monthIndex = { ...recipe.monthIndex, filtered: false };
const container = { clientWidth: recipe.setup.containerWidth };

function buildLayout(sort) {
  const months = GridLayout.sortMonthEntries(monthIndex.months, sort);
  const columnLayout = GridLayout.computeColumnLayout(container);
  return GridLayout.buildVirtualLayout(months, columnLayout);
}

function readout(layout, scrollTop, sort) {
  const row = GridLayout.findTopVisibleRowAnchor(layout, scrollTop, APP_BAR_OFFSET);
  return {
    scrollTop: Math.round(scrollTop),
    sort,
    headMonth: layout.sections[0]?.month ?? null,
    anchorMonth: row?.month ?? null,
    row: row?.rowIndex ?? null,
    rowViewportY: row ? Math.round(row.anchorViewportY) : null,
  };
}

function prepareSortScrollAnchor(anchor, layout) {
  if (
    anchor?.kind === GridScrollAnchor.KIND.DATE_THEN_ROW &&
    anchor.catalogHomeAfterSort &&
    !anchor.row &&
    layout?.sections?.[0]
  ) {
    return GridScrollAnchor.homeRowAnchor(layout.sections[0].month, 0);
  }
  if (
    anchor?.kind === GridScrollAnchor.KIND.FREEZE_ROW &&
    layout?.sections?.[0] &&
    anchor.month === layout.sections[0].month &&
    anchor.rowIndex === 0
  ) {
    return GridScrollAnchor.homeRowAnchor(anchor.month, 0);
  }
  return anchor;
}

function toggle(fromSort, toSort, scrollTopBefore) {
  const fromLayout = buildLayout(fromSort);
  const captured = GridScrollAnchor.resolveScrollAnchor({
    trigger: GridScrollAnchor.TRIGGER.SORT_TOGGLE,
    scrollTop: scrollTopBefore,
    layout: fromLayout,
    preserveScroll: true,
    isSortChange: true,
  });
  const toLayout = buildLayout(toSort);
  const anchor = prepareSortScrollAnchor(captured, toLayout);
  scrollState.scrollY = 0;
  GridScrollAnchor.applyScrollAnchor(anchor, toLayout, { sortOrder: toSort }, { behavior: 'instant' });
  return {
    captured,
    prepared: anchor,
    scrollTop: scrollState.scrollY,
    readout: readout(toLayout, scrollState.scrollY, toSort),
  };
}

console.log('step1 setup', readout(buildLayout('newest'), recipe.steps[0].expect.scrollTop, 'newest'));
const leg2 = toggle('newest', 'oldest', recipe.steps[0].expect.scrollTop);
console.log('leg2', JSON.stringify(leg2, null, 2));
console.log('leg2 expected', recipe.steps[1].expect);
const leg3 = toggle('oldest', 'newest', leg2.scrollTop);
console.log('leg3', JSON.stringify(leg3, null, 2));
console.log('leg3 expected', recipe.steps[2].expect);

const oldestLayout = buildLayout('oldest');
const newestLayout = buildLayout('newest');
const maxScroll = (layout) => Math.max(0, layout.totalHeight - VIEWPORT_HEIGHT);
console.log('maxScroll newest', maxScroll(newestLayout), 'oldest', maxScroll(oldestLayout));
for (const st of [10033, 10782, 885]) {
  console.log(`oldest@${st}`, readout(oldestLayout, st, 'oldest'));
}
const ratio = recipe.steps[0].expect.scrollTop / maxScroll(newestLayout);
const mapped = Math.round(ratio * maxScroll(oldestLayout));
console.log('ratio mapped scrollTop', mapped, readout(oldestLayout, mapped, 'oldest'));

function computeMirrorSlack(toLayout) {
  const maxTo = maxScroll(toLayout);
  let best = null;
  for (const section of toLayout.sections) {
    const rows = Math.ceil(section.count / toLayout.columnLayout.columns);
    for (let row = 0; row < rows; row++) {
      for (const y of [-17, -30, -50, -73, -158]) {
        const st = GridLayout.scrollTopToPreserveRowViewportY(
          toLayout,
          section.month,
          row,
          y,
        );
        if (st > maxTo) {
          const slack = st - maxTo;
          if (!best || slack < best.slack) {
            best = { slack, st, month: section.month, row, y };
          }
        }
      }
    }
  }
  return best;
}

function computeNearHeadMirrorScrollTop(sourceScrollTop, sourceRowViewportY, fromLayout, toLayout) {
  const maxTo = maxScroll(toLayout);
  const homeRowViewportY =
    GridLayout.findTopVisibleRowAnchor(fromLayout, 0, APP_BAR_OFFSET)?.anchorViewportY ?? 56;
  const slack = computeMirrorSlack(toLayout)?.slack ?? 0;
  return maxTo - sourceScrollTop - sourceRowViewportY + homeRowViewportY + slack;
}

console.log('mirrorSlack', computeMirrorSlack(buildLayout('oldest')));
console.log('nearHead 214', computeNearHeadMirrorScrollTop(214, -158, buildLayout('newest'), buildLayout('oldest')),
  readout(buildLayout('oldest'), computeNearHeadMirrorScrollTop(214, -158, buildLayout('newest'), buildLayout('oldest')), 'oldest'));
console.log('2080 row1 y-17 st', GridLayout.scrollTopToPreserveRowViewportY(buildLayout('oldest'), '2080-01', 1, -17));

for (const width of [812, 813]) {
  container.clientWidth = width;
  const ol = buildLayout('oldest');
  const st2080 = GridLayout.scrollTopToPreserveRowViewportY(ol, '2080-01', 1, -17);
  console.log(`width ${width} 2080-01 row1 y=-17 scrollTop`, st2080, readout(ol, st2080, 'oldest'));
  console.log(`width ${width} toggle 129→oldest`, toggle('newest', 'oldest', 129).readout);
  console.log(`width ${width} toggle 214→oldest`, toggle('newest', 'oldest', 214).readout);
}

  const l3 = toggle('oldest', 'newest', 10033);
  console.log('leg3', l3.readout, 'prepared', l3.prepared);
