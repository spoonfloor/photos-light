/**
 * Shared grid click routing (selection, star, lightbox).
 */
const GridInteractions = (() => {
  /** @type {WeakMap<HTMLElement, { handler: (event: MouseEvent) => void, ctx: object }>} */
  const wired = new WeakMap();

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

  function handleCardClick(ctx, card, event) {
    const photoId = parsePhotoId(card);
    if (photoId == null) {
      return;
    }

    const selectCircle = card.querySelector('.select-circle');
    const clickedSelectCircle =
      selectCircle &&
      (event.target === selectCircle || selectCircle.contains(event.target));

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
        handleCardClick(ctx, card, event);
      }
    };
  }

  function wireContainer(container, ctx) {
    if (!container) {
      return;
    }

    const existing = wired.get(container);
    if (existing) {
      container.removeEventListener('click', existing.handler);
    }

    const handler = createClickHandler(container, ctx);
    container.addEventListener('click', handler);
    wired.set(container, { handler, ctx });
  }

  return {
    wireContainer,
    handleCardClick,
    parsePhotoId,
  };
})();
