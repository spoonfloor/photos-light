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

  function measureWidth(el) {
    if (!el) {
      return 0;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 ? rect.width : el.offsetWidth;
  }

  function measureJumperWidth(jumperEl) {
    if (!jumperEl) {
      return 0;
    }
    const width = measureWidth(jumperEl);
    if (width > 0) {
      return width;
    }
    const prevVisibility = jumperEl.style.visibility;
    jumperEl.style.visibility = 'hidden';
    jumperEl.style.display = 'flex';
    const measured = jumperEl.offsetWidth;
    jumperEl.style.visibility = prevVisibility;
    jumperEl.style.removeProperty('display');
    return measured;
  }

  function layout() {
    if (!queryElements()) {
      return;
    }

    const titleEl = layer.querySelector('.title-and-back');
    const actionsEl = layer.querySelector('.actions');
    const jumperEl = layer.querySelector('.date-picker');

    const barW = layer.clientWidth;
    const actionsW = measureWidth(actionsEl);

    let jumperW = 0;
    let jumperLeft = 0;
    let showJumper = false;

    if (isJumperEligible(jumperEl)) {
      jumperW = measureJumperWidth(jumperEl);
      const trailingMin = actionsW + GAP_PX;
      const roomForJumper = barW - trailingMin;

      if (jumperW > 0 && roomForJumper >= jumperW) {
        showJumper = true;
        const idealLeft = (barW - jumperW) / 2;
        const attachedLeft = barW - actionsW - GAP_PX - jumperW;
        jumperLeft = Math.max(0, Math.min(idealLeft, attachedLeft));
      }
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
    layer.classList.toggle(
      'app-bar-layout--jumper-suppressed',
      isJumperEligible(jumperEl) && !showJumper,
    );
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
      attributeFilter: ['hidden', 'class', 'aria-hidden', 'style'],
    });
  }

  function init() {
    disconnect();
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
