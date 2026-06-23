#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(VH) {
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
      innerHeight: VH,
    },
    document: { documentElement: { clientHeight: VH } },
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
  const jsDir = path.join(__dirname, '..', 'static/js');
  const asGlobalVar = (source) =>
    source.replace(/^const (GridLayout|GridScrollAnchor) =/m, 'var $1 =');
  vm.runInContext(asGlobalVar(fs.readFileSync(path.join(jsDir, 'gridLayout.js'), 'utf8')), sandbox);
  vm.runInContext(
    asGlobalVar(fs.readFileSync(path.join(jsDir, 'gridScrollAnchor.js'), 'utf8')),
    sandbox,
  );
  return { ...sandbox, scrollState };
}

const recipe = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../tools/fixtures/scroll_anchor_recipe.json'), 'utf8'),
);
const mi = { ...recipe.monthIndex, filtered: false };

for (const VH of [900, 977]) {
  const { GridLayout, GridScrollAnchor, scrollState } = load(VH);
  const c = { clientWidth: 813 };
  const bl = (s) =>
    GridLayout.buildVirtualLayout(
      GridLayout.sortMonthEntries(mi.months, s),
      GridLayout.computeColumnLayout(c),
    );
  const cap = GridScrollAnchor.resolveScrollAnchor({
    trigger: GridScrollAnchor.TRIGGER.SORT_TOGGLE,
    scrollTop: 214,
    layout: bl('newest'),
    preserveScroll: true,
    isSortChange: true,
  });
  const ol = bl('oldest');
  console.log('landing', GridScrollAnchor.findSortMirrorLandingRow(ol));
  scrollState.scrollY = 0;
  GridScrollAnchor.applyScrollAnchor(cap, ol, { viewportHeight: VH }, { behavior: 'instant' });
  const row = GridLayout.findTopVisibleRowAnchor(ol, scrollState.scrollY, 80);
  console.log('VH', VH, 'kind', cap.kind, 'scrollTop', scrollState.scrollY, {
    anchorMonth: row?.month,
    row: row?.rowIndex,
    y: row ? Math.round(row.anchorViewportY) : null,
  });
}
