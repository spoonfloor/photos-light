/**
 * Non-virtual month-grouped grid renderer (share viewer + library fallback).
 */
const SimplePhotoGrid = (() => {
  function monthKey(date) {
    return MonthGrid.monthKeyFromDate(date);
  }

  function monthHeaderLabel(date) {
    return MonthGrid.monthLabel(monthKey(date));
  }

  function render(container, photos, ctx) {
    if (!container) {
      return;
    }

    container.innerHTML = '';
    const caps = ctx.getCapabilities?.() ?? ViewCapabilities.get();

    if (!photos.length) {
      if (ctx.interactionCtx && typeof GridInteractions !== 'undefined') {
        GridInteractions.wireContainer(container, ctx.interactionCtx);
      }
      ctx.onAfterRender?.(photos);
      return;
    }

    let currentKey = null;
    let gridEl = null;

    photos.forEach((photo, index) => {
      const date = ctx.parseDate?.(photo.date_taken) ?? null;
      const key = monthKey(date);
      if (key !== currentKey) {
        currentKey = key;
        const section = MonthGrid.createMonthSection(key);
        gridEl = section.gridEl;
        container.appendChild(section.sectionEl);
      }

      const thumbSrc = ctx.deferThumbSrc
        ? null
        : (ctx.thumbUrl?.(photo) ?? null);
      const card = GridTile.createCard({
        caps,
        photoId: photo.id,
        favorited: ctx.isStarred?.(photo) ?? false,
        isVideo: photo.file_type === 'video',
        selected: ctx.isSelected?.(photo.id) ?? false,
        thumbSrc,
        thumbAlt: photo.original_filename || 'Photo',
        index,
      });

      const thumb = card.querySelector('.photo-thumb');
      if (thumbSrc) {
        GridTile.attachThumbLoadHandler(thumb);
      }
      gridEl.appendChild(card);
    });

    if (typeof GridSelection !== 'undefined' && ctx.getSelectedIds) {
      GridSelection.applyToDom(container, ctx.getSelectedIds());
    }

    if (ctx.interactionCtx && typeof GridInteractions !== 'undefined') {
      GridInteractions.wireContainer(container, ctx.interactionCtx);
    }

    ctx.onAfterRender?.(photos);
  }

  function hydrateThumbs(container, photos, ctx) {
    if (!container || typeof ctx.thumbUrl !== 'function') {
      return;
    }

    const photoById = new Map(photos.map((photo) => [String(photo.id), photo]));
    container.querySelectorAll('.photo-thumb').forEach((img) => {
      if (img.getAttribute('src')) {
        return;
      }
      const photo = photoById.get(String(img.dataset.photoId));
      if (!photo) {
        return;
      }
      GridTile.attachThumbLoadHandler(img);
      img.src = ctx.thumbUrl(photo);
    });
  }

  return {
    monthKey,
    monthHeaderLabel,
    render,
    hydrateThumbs,
  };
})();
