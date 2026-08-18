/**
 * Non-virtual month-grouped grid renderer (share viewer).
 */
const SimplePhotoGrid = (() => {
  function monthKey(date) {
    if (!date) {
      return 'undated';
    }
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthHeaderLabel(date) {
    if (!date) {
      return 'Undated';
    }
    if (typeof GridLayout !== 'undefined' && GridLayout.monthLabel) {
      return GridLayout.monthLabel(monthKey(date));
    }
    return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function render(container, photos, ctx) {
    if (!container) {
      return;
    }

    container.innerHTML = '';
    const caps = ctx.getCapabilities?.() ?? ViewCapabilities.get();

    if (!photos.length) {
      ctx.onAfterRender?.(photos);
      return;
    }

    let currentKey = null;
    let gridEl = null;
    let sectionEl = null;

    photos.forEach((photo, index) => {
      const date = ctx.parseDate?.(photo.date_taken) ?? null;
      const key = monthKey(date);
      if (key !== currentKey) {
        currentKey = key;
        sectionEl = document.createElement('div');
        sectionEl.className = 'month-section';
        sectionEl.dataset.month = key;

        const headerBand = document.createElement('div');
        headerBand.className = 'month-header-band';
        headerBand.innerHTML =
          `<div class="month-header">` +
          `<span class="month-label">${monthHeaderLabel(date)}</span>` +
          `<div class="month-select-circle"></div>` +
          `</div>`;
        sectionEl.appendChild(headerBand);

        gridEl = document.createElement('div');
        gridEl.className = 'photo-grid';
        sectionEl.appendChild(gridEl);
        container.appendChild(sectionEl);
      }

      const card = GridTile.createCard({
        caps,
        photoId: photo.id,
        favorited: ctx.isStarred?.(photo) ?? false,
        isVideo: photo.file_type === 'video',
        selected: ctx.isSelected?.(photo.id) ?? false,
        thumbSrc: ctx.thumbUrl?.(photo) ?? null,
        thumbAlt: photo.original_filename || 'Photo',
        index,
      });

      const img = card.querySelector('.photo-thumb');
      GridTile.attachThumbLoadHandler(img);
      gridEl.appendChild(card);
    });

    if (typeof GridSelection !== 'undefined' && ctx.getSelectedIds) {
      GridSelection.applyToDom(container, ctx.getSelectedIds());
    }

    ctx.onAfterRender?.(photos);
  }

  return {
    monthKey,
    monthHeaderLabel,
    render,
  };
})();
