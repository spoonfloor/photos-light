/**
 * Share viewer boot — Supabase data adapter wired into shared PhotoSurface modules.
 */
(() => {
  ViewCapabilities.setSurface('share');
  GridSelection.setPhotoIdNormalizer((id) => String(id));

  const config = window.SHARE_VIEWER_CONFIG;
  const caps = ViewCapabilities.SHARE;

  const state = {
    slug: null,
    album: null,
    photos: [],
    sortOrder: 'newest',
    filters: { starred: false, video: false, selected: false },
    selected: new Set(),
    starred: new Set(),
    unstarredPublished: new Set(),
    lightboxPhotoId: null,
    lastClickedIndex: null,
  };

  const els = {
    photoContainer: document.getElementById('photoContainer'),
    sharePageTitle: document.getElementById('sharePageTitle'),
    shareEmpty: document.getElementById('shareEmpty'),
    shareError: document.getElementById('shareError'),
    sortToggleBtn: document.getElementById('sortToggleBtn'),
    sortIcon: document.getElementById('sortIcon'),
    downloadBtn: document.getElementById('downloadBtn'),
    deselectAllBtn: document.getElementById('deselectAllBtn'),
    utilitiesBtn: document.getElementById('utilitiesBtn'),
    utilitiesMenu: document.getElementById('utilitiesMenu'),
    clearStarsBtn: document.getElementById('clearStarsBtn'),
    filterChipScroll: document.querySelector('.filter-chip-rail-scroll'),
    lightboxContent: document.getElementById('lightboxContent'),
  };

  function storageKey(suffix) {
    return `photos-light-share:${state.slug}:${suffix}`;
  }

  function loadLocalState() {
    try {
      state.starred = new Set(
        JSON.parse(localStorage.getItem(storageKey('starred')) || '[]').map(String),
      );
      state.selected = new Set(
        JSON.parse(localStorage.getItem(storageKey('selected')) || '[]').map(String),
      );
      state.unstarredPublished = new Set(
        JSON.parse(localStorage.getItem(storageKey('unstarredPublished')) || '[]').map(
          String,
        ),
      );
      state.sortOrder = localStorage.getItem(storageKey('sort')) || 'newest';
    } catch {
      state.starred = new Set();
      state.selected = new Set();
      state.unstarredPublished = new Set();
    }
  }

  function saveLocalState() {
    localStorage.setItem(storageKey('starred'), JSON.stringify([...state.starred]));
    localStorage.setItem(storageKey('selected'), JSON.stringify([...state.selected]));
    localStorage.setItem(
      storageKey('unstarredPublished'),
      JSON.stringify([...state.unstarredPublished]),
    );
    localStorage.setItem(storageKey('sort'), state.sortOrder);
  }

  function parseSlug() {
    return new URLSearchParams(window.location.search).get('s');
  }

  async function supabaseFetch(path) {
    const response = await fetch(`${config.supabaseUrl}${path}`, {
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Could not load share (${response.status})`);
    }
    return response.json();
  }

  function publicUrl(storagePath) {
    const encoded = storagePath
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    return `${config.supabaseUrl}/storage/v1/object/public/${config.storageBucket}/${encoded}`;
  }

  function parseDate(value) {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function photoById(id) {
    const key = String(id);
    return state.photos.find((photo) => String(photo.id) === key);
  }

  function isStarred(photo) {
    const id = String(photo.id);
    if (state.unstarredPublished.has(id)) {
      return state.starred.has(id);
    }
    if (state.starred.has(id)) {
      return true;
    }
    return photo.rating === 5;
  }

  function starredEffectiveSet() {
    const ids = new Set();
    for (const photo of state.photos) {
      if (isStarred(photo)) {
        ids.add(String(photo.id));
      }
    }
    return ids;
  }

  function comparePhotos(a, b) {
    const aDate = parseDate(a.date_taken)?.getTime() ?? 0;
    const bDate = parseDate(b.date_taken)?.getTime() ?? 0;
    if (aDate !== bDate) {
      return state.sortOrder === 'newest' ? bDate - aDate : aDate - bDate;
    }
    return state.sortOrder === 'newest' ? b.position - a.position : a.position - b.position;
  }

  function filteredPhotos() {
    let photos = [...state.photos];
    if (state.filters.starred) {
      const starred = starredEffectiveSet();
      photos = photos.filter((photo) => starred.has(photo.id));
    }
    if (state.filters.video) {
      photos = photos.filter((photo) => photo.file_type === 'video');
    }
    if (state.filters.selected) {
      photos = photos.filter((photo) => state.selected.has(String(photo.id)));
    }
    photos.sort(comparePhotos);
    return photos;
  }

  const gridCtx = {
    getCapabilities: () => caps,
    getSelectedIds: () => state.selected,
    parseDate,
    isStarred: (photo) => isStarred(photo),
    isSelected: (photoId) => state.selected.has(String(photoId)),
    thumbUrl: (photo) => publicUrl(photo.thumb_path),
    onAfterRender: () => {
      GridInteractions.wireContainer(els.photoContainer, interactionCtx);
      updateChrome();
    },
  };

  const interactionCtx = {
    getCapabilities: () => caps,
    getSelectedCount: () => state.selected.size,
    isSelected: (photoId) => state.selected.has(String(photoId)),
    onToggleSelection: (_photoId, { event, card }) => {
      state.lastClickedIndex = GridSelection.toggleCard(
        els.photoContainer,
        state.selected,
        card,
        event,
        state.lastClickedIndex,
      );
      syncSelectionView();
    },
    onMonthCircleClick: (circle, event) => {
      state.lastClickedIndex = GridSelection.handleMonthCircleClick(
        els.photoContainer,
        state.selected,
        circle,
        event,
        state.lastClickedIndex,
      );
      syncSelectionView();
    },
    onToggleStar: (photoId) => toggleStar(photoId),
    onOpenLightbox: (photoId) => openLightbox(photoId),
  };

  function rebuildPhotoGrid() {
    state.lastClickedIndex = null;
    const photos = filteredPhotos();
    els.shareEmpty.hidden = photos.length > 0;
    SimplePhotoGrid.render(els.photoContainer, photos, gridCtx);
  }

  function syncSelectionView() {
    if (state.selected.size === 0 && state.filters.selected) {
      state.filters.selected = false;
      rebuildPhotoGrid();
      return;
    }

    if (state.filters.selected) {
      els.photoContainer.querySelectorAll('.photo-card').forEach((card) => {
        const id = GridSelection.parseCardId(card);
        if (id != null && !state.selected.has(id)) {
          card.remove();
        }
      });
      els.shareEmpty.hidden = filteredPhotos().length > 0;
      GridSelection.updateMonthCircleStates(els.photoContainer, state.selected);
    }

    updateChrome();
  }

  function patchStarOnGrid(photoId) {
    const photo = photoById(photoId);
    if (!photo) {
      return;
    }
    const id = String(photoId);
    const card = els.photoContainer.querySelector(
      `.photo-card[data-id="${CSS.escape(id)}"]`,
    );
    if (!card) {
      return;
    }

    const starred = isStarred(photo);
    if (state.filters.starred && !starred) {
      card.remove();
      els.shareEmpty.hidden = filteredPhotos().length > 0;
      GridSelection.updateMonthCircleStates(els.photoContainer, state.selected);
      updateChrome();
      return;
    }

    GridTile.applyStarBadgeState(card, starred, caps);
    card.classList.toggle('is-starred', starred);
  }

  function updateChrome() {
    const selectedCount = state.selected.size;
    els.deselectAllBtn.classList.toggle('inactive', selectedCount === 0);
    els.sortIcon.textContent =
      state.sortOrder === 'newest' ? 'hourglass_arrow_down' : 'hourglass_arrow_up';
    els.sortToggleBtn.title = state.sortOrder === 'newest' ? 'Newest first' : 'Oldest first';

    PhotoChrome.updateFilterChips({
      scroll: els.filterChipScroll,
      activeFilters: state.filters,
      selectedCount,
      showSelectedChip: caps.selectedFilterChip,
      onToggle: (filterKey) => {
        if (filterKey === 'selected' && state.selected.size === 0) {
          return;
        }
        state.filters[filterKey] = !state.filters[filterKey];
        state.lastClickedIndex = null;
        rebuildPhotoGrid();
      },
    });

    const starredCount = starredEffectiveSet().size;
    if (els.clearStarsBtn) {
      els.clearStarsBtn.disabled = starredCount === 0;
    }
    saveLocalState();
  }

  function clearSelection() {
    state.lastClickedIndex = null;
    GridSelection.clearSelection(els.photoContainer, state.selected);
    syncSelectionView();
  }

  function updateLightboxStarButton() {
    const photo = photoById(state.lightboxPhotoId);
    const starIcon = document
      .getElementById('lightboxStarBtn')
      ?.querySelector('.material-symbols-outlined');
    if (starIcon) {
      starIcon.classList.toggle('filled', photo ? isStarred(photo) : false);
    }
  }

  function updateLightboxNavArrows() {
    const photos = filteredPhotos();
    const index = photos.findIndex(
      (photo) => String(photo.id) === String(state.lightboxPhotoId),
    );
    LightboxShell.setNavArrows(index > 0, index >= 0 && index < photos.length - 1);
  }

  function formatShareLightboxInfo(photo) {
    const date = parseDate(photo.date_taken);
    if (date) {
      const dateString = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const timeString = date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      return {
        dateText: `${dateString} at ${timeString}`,
        filenameText: photo.original_filename || 'Unknown',
      };
    }
    return {
      dateText: 'No date in library',
      filenameText: photo.original_filename || 'Unknown',
    };
  }

  function renderLightboxMedia() {
    const photo = photoById(state.lightboxPhotoId);
    if (!photo) {
      closeLightbox();
      return;
    }
    els.lightboxContent.innerHTML = '';
    if (photo.file_type === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.src = publicUrl(photo.original_path);
      els.lightboxContent.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = publicUrl(photo.original_path);
      img.alt = photo.original_filename || 'Shared photo';
      els.lightboxContent.appendChild(img);
    }
  }

  function closeLightbox() {
    state.lightboxPhotoId = null;
    els.lightboxContent.innerHTML = '';
    LightboxShell.hide();
  }

  function openLightbox(photoId) {
    state.lightboxPhotoId = photoId;
    renderLightboxMedia();
    LightboxShell.show();
    LightboxShell.refreshChrome();
  }

  function stepLightbox(delta) {
    const photos = filteredPhotos();
    const index = photos.findIndex(
      (photo) => String(photo.id) === String(state.lightboxPhotoId),
    );
    if (index < 0) {
      return;
    }
    const next = photos[index + delta];
    if (!next) {
      return;
    }
    state.lightboxPhotoId = next.id;
    renderLightboxMedia();
    LightboxShell.refreshChrome();
  }

  function toggleStar(photoId) {
    const photo = photoById(photoId);
    if (!photo) {
      return;
    }
    const id = String(photoId);
    const starred = isStarred(photo);
    if (starred) {
      state.starred.delete(id);
      if (photo.rating === 5) {
        state.unstarredPublished.add(id);
      }
    } else {
      state.starred.add(id);
      state.unstarredPublished.delete(id);
    }
    patchStarOnGrid(id);
    saveLocalState();
    if (els.clearStarsBtn) {
      els.clearStarsBtn.disabled = starredEffectiveSet().size === 0;
    }
    if (state.lightboxPhotoId != null && String(state.lightboxPhotoId) === id) {
      updateLightboxStarButton();
    }
  }

  function clearStars() {
    state.starred.clear();
    state.unstarredPublished = new Set(
      state.photos.filter((photo) => photo.rating === 5).map((photo) => String(photo.id)),
    );
    if (state.filters.starred) {
      rebuildPhotoGrid();
      return;
    }
    els.photoContainer.querySelectorAll('.photo-card').forEach((card) => {
      const id = GridSelection.parseCardId(card);
      const photo = id != null ? photoById(id) : null;
      if (!photo) {
        return;
      }
      GridTile.applyStarBadgeState(card, isStarred(photo), caps);
      card.classList.toggle('is-starred', isStarred(photo));
    });
    updateChrome();
  }

  async function downloadPhotos(photos) {
    if (!photos.length) {
      return;
    }
    if (photos.length >= (config.zipThreshold || 6)) {
      const zip = new JSZip();
      for (const photo of photos) {
        const response = await fetch(publicUrl(photo.original_path));
        const blob = await response.blob();
        zip.file(photo.original_filename || `${photo.id}.bin`, blob);
      }
      const archive = await zip.generateAsync({ type: 'blob' });
      triggerDownload(archive, `${state.album.title || state.slug}.zip`);
      return;
    }
    for (const photo of photos) {
      const response = await fetch(publicUrl(photo.original_path));
      const blob = await response.blob();
      triggerDownload(blob, photo.original_filename || `${photo.id}.bin`);
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function resolveDownloadTargets() {
    if (state.selected.size > 0) {
      return state.photos.filter((photo) => state.selected.has(String(photo.id)));
    }
    return filteredPhotos();
  }

  function wireLightbox() {
    LightboxShell.wire({
      isOpen: () => state.lightboxPhotoId != null,
      getPhoto: () => photoById(state.lightboxPhotoId),
      close: closeLightbox,
      onBack: closeLightbox,
      navigate: stepLightbox,
      onStar: () => toggleStar(state.lightboxPhotoId),
      onDownload: () => {
        const photo = photoById(state.lightboxPhotoId);
        if (photo) {
          void downloadPhotos([photo]);
        }
      },
      formatInfo: formatShareLightboxInfo,
      updateNavArrows: updateLightboxNavArrows,
      updateStarButton: updateLightboxStarButton,
    });
  }

  function wireEvents() {
    els.sortToggleBtn.addEventListener('click', () => {
      state.sortOrder = state.sortOrder === 'newest' ? 'oldest' : 'newest';
      rebuildPhotoGrid();
    });

    els.downloadBtn.addEventListener('click', () => {
      void downloadPhotos(resolveDownloadTargets());
    });

    els.deselectAllBtn.addEventListener('click', clearSelection);

    els.utilitiesBtn.addEventListener('click', () => {
      PhotoChrome.toggleUtilitiesMenu(els.utilitiesBtn, els.utilitiesMenu);
    });
    PhotoChrome.wireUtilitiesDismiss(els.utilitiesMenu, els.utilitiesBtn);

    els.clearStarsBtn.addEventListener('click', () => {
      PhotoChrome.hideUtilitiesMenu(els.utilitiesMenu);
      clearStars();
    });
  }

  async function boot() {
    state.slug = parseSlug();
    if (!state.slug) {
      els.shareError.hidden = false;
      els.shareError.textContent = 'Missing share link.';
      return;
    }

    loadLocalState();
    wireLightbox();
    wireEvents();

    try {
      const albums = await supabaseFetch(
        `/rest/v1/albums?slug=eq.${encodeURIComponent(state.slug)}&select=*`,
      );
      if (!albums.length) {
        throw new Error('Share not found.');
      }
      state.album = albums[0];
      state.photos = await supabaseFetch(
        `/rest/v1/album_photos?album_id=eq.${encodeURIComponent(state.album.id)}&select=*&order=position.asc`,
      );

      const title = state.album.title || 'Shared Photos';
      document.title = title;
      els.sharePageTitle.textContent = title;
      rebuildPhotoGrid();
    } catch (error) {
      els.shareError.hidden = false;
      els.shareError.textContent = error.message || 'Could not load share.';
    }
  }

  void boot();
})();
