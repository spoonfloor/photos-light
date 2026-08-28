/**
 * Shared photo grid tile HTML and affordances (app + share).
 */
const GridTile = (() => {
  /* Star + video badges are inline SVG (sized/positioned by the CSS badge
     tokens, per breakpoint). Star: 5-point centreline star (inner radius
     0.45x), stroked — filled via .photo-card.is-starred. Video: filled
     play_circle disc. */
  const STAR_SVG =
    '<svg class="star-glyph" viewBox="2.45 0 95.11 90.45" preserveAspectRatio="none" aria-hidden="true">' +
    '<path d="M50 0L63.23 31.8L97.55 34.55L71.4 56.95L79.39 90.45L50 72.5L20.61 90.45L28.6 56.95L2.45 34.55L36.77 31.8Z"/></svg>';
  const PLAY_SVG =
    '<svg class="video-glyph" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill-rule="evenodd" d="M12 0A12 12 0 1 0 12 24A12 12 0 1 0 12 0ZM9.2 6.6L9.2 17.4L18 12Z"/></svg>';

  function buildStarBadgeHTML(caps, favorited = false) {
    const mode = caps?.gridStarBadge;
    if (!mode) {
      return '';
    }
    if (mode === 'readonly') {
      if (!favorited) {
        return '';
      }
      return (
        '<span class="star-badge star-badge--readonly" aria-hidden="true">' +
        STAR_SVG +
        '</span>'
      );
    }
    return (
      `<button type="button" class="star-badge" aria-label="Star photo" aria-pressed="${favorited ? 'true' : 'false'}">` +
      STAR_SVG +
      '</button>'
    );
  }

  function buildVideoBadgeHTML(isVideo) {
    if (!isVideo) {
      return '';
    }
    return (
      '<div class="video-badge" aria-hidden="true">' + PLAY_SVG + '</div>'
    );
  }

  function ensureSelectCircle(card) {
    if (!card || card.querySelector('.select-circle')) {
      return;
    }
    const circle = document.createElement('div');
    circle.className = 'select-circle';
    card.insertBefore(circle, card.firstChild);
  }

  function markThumbLoaded(img) {
    const card = img?.closest?.('.photo-card');
    if (!card) {
      return;
    }
    ensureSelectCircle(card);
    card.classList.add('loaded');
  }

  function applyStarBadgeState(card, favorited, caps) {
    const mode = caps?.gridStarBadge;
    if (!mode || !card) {
      return;
    }

    if (mode === 'readonly') {
      card.classList.toggle('is-starred', favorited);
      const badge = card.querySelector('.star-badge');
      if (!favorited) {
        badge?.remove();
        return;
      }
      if (!badge) {
        card.insertAdjacentHTML('beforeend', buildStarBadgeHTML(caps, true));
      }
      return;
    }

    // .is-starred on the card drives the star fill (styles.css).
    card.classList.toggle('is-starred', favorited);
    let badge = card.querySelector('.star-badge');
    if (!badge) {
      card.insertAdjacentHTML('beforeend', buildStarBadgeHTML(caps, favorited));
      badge = card.querySelector('.star-badge');
    }
    if (!badge) {
      return;
    }
    badge.setAttribute('aria-pressed', favorited ? 'true' : 'false');
  }

  function buildCardInnerHTML({
    caps,
    favorited = false,
    isVideo = false,
    photoId = null,
    thumbSrc = null,
    thumbAlt = '',
  }) {
    const idAttr = photoId != null ? ` data-photo-id="${photoId}"` : '';
    const srcAttr = thumbSrc ? ` src="${thumbSrc}"` : '';
    return (
      `<img${idAttr}${srcAttr} alt="${thumbAlt}" loading="lazy" draggable="false" class="photo-thumb">` +
      buildStarBadgeHTML(caps, favorited) +
      buildVideoBadgeHTML(isVideo)
    );
  }

  function createCard({
    caps,
    photoId,
    favorited = false,
    isVideo = false,
    selected = false,
    thumbSrc = null,
    thumbAlt = '',
    index = null,
  }) {
    const card = document.createElement('div');
    card.className = 'photo-card';
    if (selected) {
      card.classList.add('selected');
    }
    if (favorited) {
      card.classList.add('is-starred');
    }
    card.dataset.id = String(photoId);
    if (index != null) {
      card.dataset.index = String(index);
    }
    card.innerHTML = buildCardInnerHTML({
      caps,
      favorited,
      isVideo,
      photoId,
      thumbSrc,
      thumbAlt,
    });
    applyStarBadgeState(card, favorited, caps);
    ensureSelectCircle(card);
    return card;
  }

  function attachThumbLoadHandler(img) {
    if (!img) {
      return;
    }
    const onLoad = () => markThumbLoaded(img);
    if (img.complete) {
      onLoad();
    } else {
      img.addEventListener('load', onLoad, { once: true });
    }
  }

  return {
    buildStarBadgeHTML,
    buildVideoBadgeHTML,
    ensureSelectCircle,
    markThumbLoaded,
    applyStarBadgeState,
    buildCardInnerHTML,
    createCard,
    attachThumbLoadHandler,
  };
})();
