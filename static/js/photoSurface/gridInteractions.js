/**
 * Shared grid click routing (selection, star, lightbox).
 */
const GridInteractions = (() => {
  /** @type {WeakMap<HTMLElement, { handler: (event: MouseEvent) => void, onTouchStart: Function, onTouchMove: Function, onTouchEnd: Function, onContextMenu: Function, dispose: Function, ctx: object }>} */
  const wired = new WeakMap();

  // --- Long-press → select mode (touch only) ---
  // Desktop reveals .select-circle/.star-badge via :hover (styles.css);
  // touch has no hover, so a long-press on a card reveals them on every
  // card instead — tracked as a `.select-mode` class on the container.
  // Narrow (≤480px) only, same convention as lightboxShell.js's chevron
  // auto-hide: width is checked at press-start (arm-time), not chased
  // continuously across a live resize.
  const NARROW_QUERY = '(max-width: 480px)';
  const LONG_PRESS_MS = 500;
  // Matches lightboxShell.js's TAP_MAX_MOVEMENT — a press that drifts this
  // far is a scroll attempt, not a long-press.
  const LONG_PRESS_MAX_MOVEMENT = 10; // px

  function parsePhotoId(card) {
    if (typeof GridSelection !== 'undefined') {
      return GridSelection.parseCardId(card);
    }
    const raw = card?.dataset?.id;
    if (raw == null || raw === '') {
      return null;
    }
    return raw;
  }

  function isSelectModeActive(container) {
    return Boolean(container?.classList.contains('select-mode'));
  }

  // Every select-mode entry/exit funnels through these two — long-press,
  // the utilities "Select & star" CTA (via PhotoChrome.toggleSelectMode),
  // tap-outside, card-tap, and GridSelection.clearSelection. So this is the
  // one place to notify the host that the mode changed. ctx comes from the
  // wireContainer() call for this container; onSelectModeChange is optional.
  function notifySelectMode(container, active) {
    wired.get(container)?.ctx?.onSelectModeChange?.(active);
  }

  function enterSelectMode(container) {
    if (!container || container.classList.contains('select-mode')) {
      return;
    }
    container.classList.add('select-mode');
    notifySelectMode(container, true);
  }

  function exitSelectMode(container) {
    if (!container || !container.classList.contains('select-mode')) {
      return;
    }
    container.classList.remove('select-mode');
    notifySelectMode(container, false);
  }

  function handleCardClick(ctx, card, event, container) {
    const photoId = parsePhotoId(card);
    if (photoId == null) {
      return;
    }

    const selectCircle = card.querySelector('.select-circle');
    const clickedSelectCircle =
      selectCircle &&
      (event.target === selectCircle || selectCircle.contains(event.target));

    // Select mode (long-press-revealed overlay): the circle keeps
    // accumulating the selection; a tap anywhere else on the card exits
    // the mode and opens that photo, regardless of what's already
    // selected — mobile has no shift-click, so this is the whole model.
    if (isSelectModeActive(container)) {
      if (clickedSelectCircle) {
        event.stopPropagation();
        ctx.onToggleSelection?.(photoId, { event, card });
        return;
      }
      exitSelectMode(container);
      ctx.onOpenLightbox?.(photoId);
      return;
    }

    const selectedCount = ctx.getSelectedCount?.() ?? 0;

    if (selectedCount > 0) {
      if (
        ctx.isSelected?.(photoId) &&
        !event.shiftKey &&
        !clickedSelectCircle
      ) {
        ctx.onOpenLightbox?.(photoId);
        return;
      }
      ctx.onToggleSelection?.(photoId, { event, card });
      return;
    }

    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.stopPropagation();
      ctx.onToggleSelection?.(photoId, { event, card });
      return;
    }

    if (clickedSelectCircle) {
      event.stopPropagation();
      ctx.onToggleSelection?.(photoId, { event, card });
      return;
    }

    ctx.onOpenLightbox?.(photoId);
  }

  function createClickHandler(container, ctx) {
    return (event) => {
      const monthCircle = event.target.closest('.month-select-circle');
      if (monthCircle && container.contains(monthCircle)) {
        event.stopPropagation();
        event.preventDefault();
        ctx.onMonthCircleClick?.(monthCircle, event);
        return;
      }

      const starBadge = event.target.closest('.star-badge');
      if (starBadge && container.contains(starBadge)) {
        if (starBadge.classList.contains('star-badge--readonly')) {
          return;
        }
        event.stopPropagation();
        event.preventDefault();
        const caps = ctx.getCapabilities?.();
        if (caps?.gridStarBadge !== 'interactive') {
          return;
        }
        const photoId = parsePhotoId(starBadge.closest('.photo-card'));
        if (photoId != null) {
          ctx.onToggleStar?.(photoId);
        }
        return;
      }

      const card = event.target.closest('.photo-card');
      if (card && container.contains(card)) {
        handleCardClick(ctx, card, event, container);
        return;
      }

      // Tap outside any photo card (grid gutter, month header text, empty
      // space below the last row) exits select mode without opening
      // anything — the third leg of the long-press mechanism.
      if (isSelectModeActive(container)) {
        exitSelectMode(container);
      }
    };
  }

  // Long-press timer + native-gesture suppression for one container.
  // Returned handlers close over per-press state (timer/start point), so
  // each wireContainer() call gets its own instance — see wireContainer's
  // dispose of the previous instance on rewire.
  function createLongPressHandlers(container) {
    let timer = null;
    let startX = 0;
    let startY = 0;
    // True once this press has already opened select mode, so touchend
    // knows to swallow the trailing synthetic click (see onTouchEnd).
    let entered = false;

    function clearTimer() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function onTouchStart(event) {
      clearTimer();
      entered = false;
      if (event.touches.length !== 1 || !window.matchMedia(NARROW_QUERY).matches) {
        return;
      }
      const card = event.target.closest?.('.photo-card');
      if (!card || !container.contains(card)) {
        return;
      }
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      timer = setTimeout(() => {
        timer = null;
        entered = true;
        enterSelectMode(container);
      }, LONG_PRESS_MS);
    }

    function onTouchMove(event) {
      if (timer === null) {
        return;
      }
      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      if (
        Math.abs(touch.clientX - startX) > LONG_PRESS_MAX_MOVEMENT ||
        Math.abs(touch.clientY - startY) > LONG_PRESS_MAX_MOVEMENT
      ) {
        clearTimer();
      }
    }

    function onTouchEnd(event) {
      clearTimer();
      if (entered) {
        // This touch already opened select mode via the timer above;
        // suppress the browser's post-touch compatibility click (same
        // trick as lightboxShell.js's onOverlayTouchEnd) so it doesn't
        // immediately re-fire handleCardClick and exit the mode it just
        // entered.
        event.preventDefault();
      }
      entered = false;
    }

    function onContextMenu(event) {
      if (!window.matchMedia(NARROW_QUERY).matches) {
        return;
      }
      if (event.target.closest?.('.photo-card') && container.contains(event.target)) {
        event.preventDefault();
      }
    }

    return {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onContextMenu,
      dispose: clearTimer,
    };
  }

  function wireContainer(container, ctx) {
    if (!container) {
      return;
    }

    const existing = wired.get(container);
    if (existing) {
      existing.dispose?.();
      container.removeEventListener('click', existing.handler);
      container.removeEventListener('touchstart', existing.onTouchStart);
      container.removeEventListener('touchmove', existing.onTouchMove);
      container.removeEventListener('touchend', existing.onTouchEnd);
      container.removeEventListener('touchcancel', existing.onTouchEnd);
      container.removeEventListener('contextmenu', existing.onContextMenu);
    }

    const handler = createClickHandler(container, ctx);
    const longPress = createLongPressHandlers(container);

    container.addEventListener('click', handler);
    container.addEventListener('touchstart', longPress.onTouchStart, { passive: true });
    container.addEventListener('touchmove', longPress.onTouchMove, { passive: true });
    container.addEventListener('touchend', longPress.onTouchEnd);
    container.addEventListener('touchcancel', longPress.onTouchEnd);
    container.addEventListener('contextmenu', longPress.onContextMenu);

    wired.set(container, { handler, ...longPress, ctx });
  }

  return {
    wireContainer,
    handleCardClick,
    parsePhotoId,
    isSelectModeActive,
    enterSelectMode,
    exitSelectMode,
  };
})();
