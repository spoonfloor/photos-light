/**
 * Scroll target recipe — copy iron-clad checkpoints via keyboard.
 *
 * Workflow:
 *   1. Scroll to position
 *   2. Ctrl+Cmd+A — copies checkpoint JSON to clipboard (no labels)
 *   3. Click sort swap
 *   4. Scroll to next position
 *   5. Ctrl+Cmd+A again
 *   … repeat, then paste all checkpoints to your agent
 */
const GridScrollTargetRecipe = (() => {
  const RECIPE_VERSION = 1;
  const DEFAULT_TOLERANCE = Object.freeze({
    midScrollTop: 15,
    midRowViewportY: 5,
    edgeScrollTop: 0,
  });

  /** @type {{ setup: object|null, steps: object[] }} */
  let recipe = { setup: null, steps: [] };

  function getScrollElement() {
    return document.scrollingElement || document.documentElement;
  }

  function normalizeFrozenAnchor(anchor) {
    if (!anchor || anchor.kind === GridScrollAnchor.KIND.NONE) {
      return null;
    }
    if (anchor.kind === GridScrollAnchor.KIND.FREEZE_ROW) {
      return {
        kind: 'freeze-row',
        month: anchor.month,
        rowIndex: anchor.rowIndex,
        anchorViewportY: Math.round(anchor.anchorViewportY),
      };
    }
    if (anchor.kind === GridScrollAnchor.KIND.DATE_THEN_ROW) {
      return {
        kind: 'date-then-row',
        row: anchor.row
          ? {
              month: anchor.row.month,
              rowIndex: anchor.row.rowIndex,
            }
          : null,
      };
    }
    if (anchor.kind === GridScrollAnchor.KIND.MONTH_HEADER) {
      return { kind: 'month-header', month: anchor.month };
    }
    return { kind: anchor.kind };
  }

  function captureSetup(layout) {
    const container = document.getElementById('photoContainer');
    const columnLayout = layout?.columnLayout;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight || 0;
    const scrollTop = getScrollElement().scrollTop;
    const totalHeight = layout?.totalHeight ?? 0;
    const monthIndex = VirtualGrid.getMonthIndex?.() || null;

    return {
      containerWidth: Math.round(container?.clientWidth ?? 0),
      viewportHeight: Math.round(viewportHeight),
      columns: columnLayout?.columns ?? null,
      cellPx: columnLayout?.trackWidth ?? null,
      appBarOffset: GridScrollAnchor.APP_BAR_OFFSET,
      maxScrollTop: Math.max(0, Math.round(totalHeight - viewportHeight)),
      catalogRevision: monthIndex?.catalog_revision ?? null,
      monthIndexTotal: monthIndex?.total ?? layout?.totalPhotos ?? null,
    };
  }

  function captureReadout(layout, scrollTop, sort) {
    const topVisible = GridLayout.findTopVisibleRowAnchor(
      layout,
      scrollTop,
      GridScrollAnchor.APP_BAR_OFFSET,
    );
    return {
      scrollTop: Math.round(scrollTop),
      sort,
      headMonth: layout?.sections?.[0]?.month ?? null,
      anchorMonth: topVisible?.month ?? null,
      row: topVisible?.rowIndex ?? null,
      rowViewportY: topVisible ? Math.round(topVisible.anchorViewportY) : null,
    };
  }

  function captureSnapshot() {
    const layout = VirtualGrid.getLayout?.();
    if (!layout || layout.provisional || !VirtualGrid.isActive?.()) {
      throw new Error('Virtual grid must be active with refined layout before copying.');
    }

    const scrollTop = getScrollElement().scrollTop;
    const sort =
      typeof state !== 'undefined' && state.currentSortOrder
        ? state.currentSortOrder
        : layout.sort || 'newest';

    const frozenAnchor = normalizeFrozenAnchor(
      GridScrollAnchor.resolveScrollAnchor({
        trigger: GridScrollAnchor.TRIGGER.SORT_TOGGLE,
        scrollTop,
        layout,
        preserveScroll: true,
        isSortChange: true,
      }),
    );

    return {
      setup: captureSetup(layout),
      readout: captureReadout(layout, scrollTop, sort),
      frozenAnchor,
    };
  }

  function buildCheckpointPayload(snapshot) {
    return {
      setup: snapshot.setup,
      expect: { ...snapshot.readout },
      frozenAnchor: snapshot.frozenAnchor,
    };
  }

  function copyTextFallback(text) {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.focus();
    el.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    document.body.removeChild(el);
    return copied;
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return copyTextFallback(text);
      }
    }
    return copyTextFallback(text);
  }

  function appendCheckpoint(snapshot) {
    if (!recipe.setup) {
      recipe.setup = snapshot.setup;
    }

    const stepNumber = recipe.steps.length + 1;
    const step = {
      id: `step-${stepNumber}`,
      expect: { ...snapshot.readout },
      frozenAnchor: snapshot.frozenAnchor,
    };
    recipe.steps.push(step);
    return step;
  }

  async function copyScrollCheckpoint() {
    const snapshot = captureSnapshot();
    const payload = buildCheckpointPayload(snapshot);
    const step = appendCheckpoint(snapshot);
    const json = JSON.stringify(payload);

    const copied = await copyTextToClipboard(json);
    console.log(
      `[scroll target] checkpoint ${step.id}  scrollTop=${step.expect.scrollTop}  sort=${step.expect.sort}${copied ? '  (clipboard)' : '  (clipboard blocked)'}`,
    );
    if (!copied) {
      console.log(json);
    }
    return payload;
  }

  function buildRecipeExport() {
    const monthIndex = VirtualGrid.getMonthIndex?.() || null;
    if (!recipe.steps.length) {
      throw new Error('No checkpoints copied yet — scroll to a position and press Ctrl+Cmd+A.');
    }

    return {
      recipeVersion: RECIPE_VERSION,
      tolerance: { ...DEFAULT_TOLERANCE },
      setup: recipe.setup,
      monthIndex: monthIndex
        ? {
            catalog_revision: monthIndex.catalog_revision ?? null,
            total: monthIndex.total ?? null,
            sort: monthIndex.sort ?? null,
            months: (monthIndex.months || []).map((entry) => ({
              month: entry.month,
              count: entry.count,
            })),
          }
        : null,
      steps: recipe.steps.map((step) => JSON.parse(JSON.stringify(step))),
    };
  }

  async function copyScrollTargetRecipe() {
    const exportRecipe = buildRecipeExport();
    const json = JSON.stringify(exportRecipe);
    const copied = await copyTextToClipboard(json);
    console.log(
      `[scroll target] full recipe (${exportRecipe.steps.length} steps)${copied ? ' copied' : ' — clipboard blocked'}:`,
    );
    if (!copied) {
      console.log(json);
    }
    return exportRecipe;
  }

  function dumpScrollTargetRecipe() {
    const exportRecipe = buildRecipeExport();
    const json = JSON.stringify(exportRecipe, null, 2);
    console.log(json);
    return exportRecipe;
  }

  function clearScrollTargetRecipe() {
    recipe = { setup: null, steps: [] };
    console.log('[scroll target] Checkpoints cleared.');
  }

  function listScrollTargetSteps() {
    return recipe.steps.map((step) => step.id);
  }

  function getScrollTargetRecipe() {
    return recipe.steps.length ? buildRecipeExport() : null;
  }

  function shouldHandleCopyShortcut(event) {
    if (!event.ctrlKey || !event.metaKey || event.shiftKey || event.altKey) {
      return false;
    }
    if (event.key !== 'a' && event.key !== 'A' && event.code !== 'KeyA') {
      return false;
    }
    const target = event.target;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return false;
    }
    if (typeof state !== 'undefined' && state.lightboxOpen) {
      return false;
    }
    return true;
  }

  function handleCopyShortcut(event) {
    if (!shouldHandleCopyShortcut(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    copyScrollCheckpoint().catch((error) => {
      console.warn('[scroll target]', error.message);
    });
  }

  document.addEventListener('keydown', handleCopyShortcut, true);

  return {
    copyScrollCheckpoint,
    copyScrollTargetRecipe,
    dumpScrollTargetRecipe,
    clearScrollTargetRecipe,
    listScrollTargetSteps,
    getScrollTargetRecipe,
  };
})();

window.copyScrollCheckpoint = () => GridScrollTargetRecipe.copyScrollCheckpoint();
window.copyScrollTargetRecipe = () => GridScrollTargetRecipe.copyScrollTargetRecipe();
window.dumpScrollTargetRecipe = () => GridScrollTargetRecipe.dumpScrollTargetRecipe();
window.getScrollTargetRecipe = () => GridScrollTargetRecipe.getScrollTargetRecipe();
window.clearScrollTargetRecipe = () => GridScrollTargetRecipe.clearScrollTargetRecipe();
window.listScrollTargetSteps = () => GridScrollTargetRecipe.listScrollTargetSteps();
console.log('[scroll target] Ctrl+Cmd+A listener bound');
