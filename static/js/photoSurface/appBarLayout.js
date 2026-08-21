/**
 * App bar collision layout — title (left), jumper (center-until-collision), actions (right).
 * Driven by measured widths + CSS variables; no viewport breakpoints.
 */
const AppBarLayout = (() => {
  const GAP_PX = 12;

  let layer = null;
  let resizeObserver = null;
  let mutationObserver = null;
  let pendingRaf = null;
  let cachedJumperW = 0;

  function queryElements() {
    layer = document.querySelector('.app-bar-elements-layer');
    return layer;
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

  function layout() {
    if (!queryElements()) {
      return;
    }

    const titleEl = layer.querySelector('.title-and-back');
    const actionsEl = layer.querySelector('.actions');
    const jumperEl = layer.querySelector('.date-picker');

    const barW = barWidth();
    const actionsW = measureWidth(actionsEl);

    if (barW === 0) {
      requestAnimationFrame(scheduleLayout);
      return;
    }

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

      const attachedLeft = barW - actionsW - GAP_PX - jumperW;
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

    let titleMaxW = Math.max(0, barW - actionsW - GAP_PX);
    if (showJumper) {
      titleMaxW = Math.min(titleMaxW, Math.max(0, jumperLeft - GAP_PX));
    }

    const showTitle = titleMaxW > 0;

    layer.style.setProperty('--app-bar-gap', `${GAP_PX}px`);
    layer.style.setProperty('--app-bar-actions-w', `${actionsW}px`);
    layer.style.setProperty('--app-bar-jumper-w', `${showJumper ? jumperW : 0}px`);
    layer.style.setProperty('--app-bar-jumper-left', `${showJumper ? jumperLeft : 0}px`);
    layer.style.setProperty('--app-bar-title-max-w', `${titleMaxW}px`);

    layer.classList.toggle('app-bar-layout--jumper', showJumper);
    layer.classList.toggle('app-bar-layout--jumper-no-fit', noFit);
    layer.classList.toggle('app-bar-layout--title', showTitle);

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
    bindObservers();
    scheduleLayout();
  }

  function disconnect() {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    resizeObserver = null;
    mutationObserver = null;
    cachedJumperW = 0;
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
