/**
 * App bar collision layout — title (left), jumper (center-until-collision), actions (right).
 * Driven by measured widths + CSS variables; no viewport breakpoints.
 */
const AppBarLayout = (() => {
  const GAP_FALLBACK_PX = 12; // used only if the CSS custom property can't be read
  const ACTIONS_GAP_FALLBACK_PX = 12; // used only if the CSS custom property can't be read
  const TITLE_GAP_FALLBACK_PX = 12; // used only if the CSS custom property can't be read
  const ICON_W_FALLBACK = 44;

  let layer = null;
  let resizeObserver = null;
  let mutationObserver = null;
  let pendingRaf = null;
  let cachedJumperW = 0;
  let gapDefaultPx = GAP_FALLBACK_PX;
  let actionsGapDefaultPx = ACTIONS_GAP_FALLBACK_PX;
  // Dedicated "how close can the title get to the icons before truncating"
  // knob — deliberately separate from gapDefaultPx (--app-bar-gap), which
  // is also the jumper's buffer and the inter-icon gap fallback, so dialing
  // one doesn't move the others.
  let titleGapDefaultPx = TITLE_GAP_FALLBACK_PX;

  function queryElements() {
    layer = document.querySelector('.app-bar-elements-layer');
    return layer;
  }

  /**
   * Reads a gap default from a CSS custom property on the layer instead of
   * hardcoding it in JS, so there's a single source of truth and the two
   * can't drift apart. Temporarily clears any inline override first so the
   * read reflects the stylesheet cascade, not a previously-computed value.
   */
  function readGapDefault(propName, fallback) {
    if (!layer) {
      return fallback;
    }
    const inline = layer.style.getPropertyValue(propName);
    layer.style.removeProperty(propName);
    const computed = getComputedStyle(layer).getPropertyValue(propName);
    if (inline) {
      layer.style.setProperty(propName, inline);
    }
    const parsed = parseFloat(computed);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function isJumperEligible(el) {
    return (
      el &&
      !el.hidden &&
      el.classList.contains('date-jumper-active') &&
      el.getAttribute('aria-hidden') !== 'true'
    );
  }

  function barWidth() {
    if (!layer) {
      return 0;
    }
    const w = layer.clientWidth;
    if (w > 0) {
      return w;
    }
    return layer.parentElement?.clientWidth || 0;
  }

  function measureWidth(el) {
    if (!el) {
      return 0;
    }
    return Math.ceil(el.getBoundingClientRect().width) || el.offsetWidth || 0;
  }

  /** Intrinsic jumper width — never reads layout while suppressed/hidden. */
  function measureJumperWidth(jumperEl) {
    if (!jumperEl) {
      return 0;
    }

    const live = measureWidth(jumperEl);
    if (live > 0) {
      cachedJumperW = live;
      return live;
    }
    if (cachedJumperW > 0) {
      return cachedJumperW;
    }

    const style = jumperEl.style;
    const prev = {
      visibility: style.visibility,
      display: style.display,
      position: style.position,
      left: style.left,
    };

    style.visibility = 'hidden';
    style.display = 'flex';
    style.position = 'absolute';
    style.left = '-9999px';

    const measured = jumperEl.offsetWidth;
    cachedJumperW = measured;

    style.visibility = prev.visibility;
    style.display = prev.display;
    style.position = prev.position;
    style.left = prev.left;

    return measured;
  }

  function visibleActionButtons(actionsEl) {
    if (!actionsEl) {
      return [];
    }
    return [...actionsEl.querySelectorAll('.app-bar-icon-button')].filter((btn) => !btn.hidden);
  }

  function measureIconWidth(buttons) {
    if (buttons.length === 0) {
      return ICON_W_FALLBACK;
    }
    return Math.ceil(buttons[0].getBoundingClientRect().width) || ICON_W_FALLBACK;
  }

  function actionsWidth(count, iconW, gap) {
    if (count <= 0) {
      return 0;
    }
    if (count === 1) {
      return iconW;
    }
    return count * iconW + (count - 1) * gap;
  }

  /** Shrink gap to 0, then overlap down to a single icon column. */
  function squeezeActionsGap(count, iconW, budget) {
    if (count <= 1) {
      return actionsGapDefaultPx;
    }

    const naturalW = actionsWidth(count, iconW, actionsGapDefaultPx);
    if (naturalW <= budget) {
      return actionsGapDefaultPx;
    }

    const gap = (budget - count * iconW) / (count - 1);
    return Math.max(-iconW, gap);
  }

  /**
   * Sum of each visible icon's *actual* width, not count * a single sampled
   * width — icons aren't all the same size (#utilitiesBtn is narrower than
   * the rest), so assuming uniformity overreserved space and made the title
   * truncate earlier than the icons it's supposedly dodging actually need.
   */
  function actionsNaturalWidth(buttons, gap) {
    if (buttons.length === 0) {
      return 0;
    }
    const totalIconW = buttons.reduce((sum, btn) => sum + measureWidth(btn), 0);
    return totalIconW + Math.max(0, buttons.length - 1) * gap;
  }

  function resolveActionsLayout(actionsEl, barW) {
    const buttons = visibleActionButtons(actionsEl);
    const count = buttons.length;
    const naturalW = actionsNaturalWidth(buttons, actionsGapDefaultPx);

    if (naturalW <= barW) {
      return { count, gap: actionsGapDefaultPx, width: naturalW, squeezed: false };
    }

    // Squeeze path: icons themselves must shrink/overlap to fit. Rare —
    // only hit once the bar is too narrow for the icons at their normal
    // gap — so the uniform-width approximation here is an accepted
    // simplification, unlike the common case above.
    const iconW = measureIconWidth(buttons);
    const gap = squeezeActionsGap(count, iconW, barW);
    const width = actionsWidth(count, iconW, gap);

    return {
      count,
      gap,
      width,
      squeezed: gap < actionsGapDefaultPx - 0.5,
    };
  }

  function layout() {
    if (!queryElements()) {
      return;
    }

    const titleEl = layer.querySelector('.title-and-back');
    const actionsEl = layer.querySelector('.actions');
    const jumperEl = layer.querySelector('.date-picker');

    const barW = barWidth();

    if (barW === 0) {
      requestAnimationFrame(scheduleLayout);
      return;
    }

    const actionsLayout = resolveActionsLayout(actionsEl, barW);
    const actionsW = actionsLayout.width;

    let jumperW = 0;
    let jumperLeft = 0;
    let showJumper = false;
    let noFit = false;

    if (isJumperEligible(jumperEl)) {
      jumperW = measureJumperWidth(jumperEl);

      if (jumperW === 0) {
        requestAnimationFrame(scheduleLayout);
        return;
      }

      const attachedLeft = barW - actionsW - gapDefaultPx - jumperW;
      if (attachedLeft >= 0) {
        showJumper = true;
        const idealLeft = (barW - jumperW) / 2;
        jumperLeft = Math.min(idealLeft, attachedLeft);
      } else {
        noFit = true;
      }
    } else {
      cachedJumperW = 0;
    }

    let titleMaxW = Math.max(0, barW - actionsW - titleGapDefaultPx);
    if (showJumper) {
      titleMaxW = Math.min(titleMaxW, Math.max(0, jumperLeft - titleGapDefaultPx));
    }

    const showTitle = titleMaxW > 0;

    layer.style.setProperty('--app-bar-gap', `${gapDefaultPx}px`);
    layer.style.setProperty('--app-bar-actions-gap', `${actionsLayout.gap}px`);
    layer.style.setProperty('--app-bar-actions-w', `${actionsW}px`);
    layer.style.setProperty('--app-bar-jumper-w', `${showJumper ? jumperW : 0}px`);
    layer.style.setProperty('--app-bar-jumper-left', `${showJumper ? jumperLeft : 0}px`);
    layer.style.setProperty('--app-bar-title-max-w', `${titleMaxW}px`);

    layer.classList.toggle('app-bar-layout--jumper', showJumper);
    layer.classList.toggle('app-bar-layout--jumper-no-fit', noFit);
    layer.classList.toggle('app-bar-layout--title', showTitle);
    layer.classList.toggle('app-bar-layout--actions-squeezed', actionsLayout.squeezed);

    if (titleEl) {
      titleEl.hidden = !showTitle;
      titleEl.setAttribute('aria-hidden', showTitle ? 'false' : 'true');
    }
  }

  function scheduleLayout() {
    if (pendingRaf != null) {
      return;
    }
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = null;
      layout();
    });
  }

  function bindObservers() {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();

    if (!queryElements()) {
      return;
    }

    resizeObserver = new ResizeObserver(scheduleLayout);
    resizeObserver.observe(layer);

    const actionsEl = layer.querySelector('.actions');
    const jumperEl = layer.querySelector('.date-picker');
    const titleEl = layer.querySelector('.title-and-back');
    if (actionsEl) {
      resizeObserver.observe(actionsEl);
    }
    if (jumperEl) {
      resizeObserver.observe(jumperEl);
    }
    if (titleEl) {
      resizeObserver.observe(titleEl);
    }

    mutationObserver = new MutationObserver(scheduleLayout);
    const observeTarget = document.getElementById('appBarMount') || layer;
    mutationObserver.observe(observeTarget, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['hidden', 'class', 'aria-hidden'],
    });
  }

  function init() {
    disconnect();
    cachedJumperW = 0;
    if (!queryElements()) {
      return;
    }
    gapDefaultPx = readGapDefault('--app-bar-gap', GAP_FALLBACK_PX);
    actionsGapDefaultPx = readGapDefault('--app-bar-actions-gap', ACTIONS_GAP_FALLBACK_PX);
    titleGapDefaultPx = readGapDefault('--app-bar-title-gap', TITLE_GAP_FALLBACK_PX);
    bindObservers();
    scheduleLayout();
  }

  function disconnect() {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    resizeObserver = null;
    mutationObserver = null;
    cachedJumperW = 0;
    gapDefaultPx = GAP_FALLBACK_PX;
    actionsGapDefaultPx = ACTIONS_GAP_FALLBACK_PX;
    titleGapDefaultPx = TITLE_GAP_FALLBACK_PX;
    if (pendingRaf != null) {
      cancelAnimationFrame(pendingRaf);
      pendingRaf = null;
    }
  }

  return {
    init,
    disconnect,
    scheduleLayout,
  };
})();
