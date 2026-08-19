/**
 * Share viewer boot — Supabase data adapter wired into shared PhotoSurface modules.
 */
(() => {
  ViewCapabilities.setSurface('share');
  GridSelection.setPhotoIdNormalizer((id) => String(id));

  const config = window.SHARE_VIEWER_CONFIG;
  const caps = ViewCapabilities.SHARE;
  const SHARE_NOT_FOUND_MESSAGE =
    'This link is no longer valid and the requested photos are unavailable.';

  const state = {
    token: null,
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
    return `photos-light-share:${state.token}:${suffix}`;
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

  function parseShareToken() {
    const params = new URLSearchParams(window.location.search);
    return params.get('t') || params.get('s');
  }

  function shareResolveUrl() {
    if (config.shareResolveUrl) {
      return config.shareResolveUrl;
    }
    return `${config.supabaseUrl}/functions/v1/share-resolve`;
  }

  async function fetchShareResolve(searchParams, { signal } = {}) {
    const params = new URLSearchParams(searchParams);
    params.set('token', state.token);
    const response = await fetch(`${shareResolveUrl()}?${params.toString()}`, {
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
      },
      signal,
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(SHARE_NOT_FOUND_MESSAGE);
      }
      throw new Error(`Could not load share (${response.status})`);
    }
    return response.json();
  }

  async function resolveShareMeta(options = {}) {
    return fetchShareResolve(
      {
        phase: 'meta',
        sort: state.sortOrder,
      },
      options,
    );
  }

  async function resolveShareFull(options = {}) {
    return fetchShareResolve({}, options);
  }

  function applyShareTitle(title) {
    const resolved = title || 'Shared Photos';
    document.title = resolved;
    els.sharePageTitle.textContent = resolved;
    els.sharePageTitle.classList.remove('surface-layout-placeholder');
  }

  function mediaUrl(photo, kind) {
    const url = kind === 'thumb' ? photo.thumb_url : photo.original_url;
    if (!url) {
      throw new Error('Share media URL is missing.');
    }
    return url;
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

  const surface = PhotoSurface.init({
    caps,
    container: els.photoContainer,
    emptyEl: els.shareEmpty,
    getPhotos: filteredPhotos,
    adapters: {
      getSelectedIds: () => state.selected,
      getSelectedCount: () => state.selected.size,
      isSelected: (photoId) => state.selected.has(String(photoId)),
      parseDate,
      isStarred: (photo) => isStarred(photo),
      thumbUrl: (photo) => mediaUrl(photo, 'thumb'),
    },
    interactionHandlers: {
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
    },
    onAfterRender: updateChrome,
  });

  function rebuildPhotoGrid({ deferThumbSrc = false } = {}) {
    state.lastClickedIndex = null;
    surface.renderGrid({ deferThumbSrc });
    if (deferThumbSrc) {
      surface.hydrateThumbs();
    }
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
    els.lightboxContent.style.backgroundColor = 'transparent';
    LightboxMedia.loadIntoContent(els.lightboxContent, photo, {
      isVideo: LightboxMedia.isVideoPhoto(photo),
      getMediaUrl: () => mediaUrl(photo, 'original'),
      getAltText: (p) => p.original_filename || 'Shared photo',
      nativeVideoControls: true,
    });
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
        const response = await fetch(mediaUrl(photo, 'original'));
        const blob = await response.blob();
        zip.file(photo.original_filename || `${photo.id}.bin`, blob);
      }
      const archive = await zip.generateAsync({ type: 'blob' });
      triggerDownload(archive, `${state.album.title || state.token}.zip`);
      return;
    }
    for (const photo of photos) {
      const response = await fetch(mediaUrl(photo, 'original'));
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

  function showShareFailure(message, { notFound = false } = {}) {
    if (typeof SurfaceLoadChrome !== 'undefined') {
      SurfaceLoadChrome.complete();
    }
    SurfaceLoadOverlay.end({ overlayId: 'surfaceLoadOverlay' });
    document.body.classList.toggle('share-view--not-found', notFound);

    const chromeMount = document.getElementById('appChromeMount');
    if (chromeMount) {
      chromeMount.hidden = notFound;
    }

    if (els.photoContainer) {
      els.photoContainer.innerHTML = '';
    }

    if (els.sharePageTitle) {
      els.sharePageTitle.hidden = notFound;
      if (!notFound) {
        els.sharePageTitle.textContent = 'Shared Photos';
        els.sharePageTitle.classList.add('surface-layout-placeholder');
      }
    }

    if (els.shareEmpty) {
      els.shareEmpty.hidden = true;
    }

    if (els.shareError) {
      els.shareError.hidden = false;
      els.shareError.textContent = message;
    }
  }

  async function boot() {
    state.token = parseShareToken();
    if (!state.token) {
      showShareFailure('Missing share link.', { notFound: true });
      return;
    }

    loadLocalState();
    PhotoSurface.mountChrome(caps);
    wireLightbox();
    wireEvents();

    ShareSkeletonGrid.renderInstantBoot(els.sharePageTitle, els.photoContainer);
    if (typeof SurfaceLoadChrome !== 'undefined') {
      SurfaceLoadChrome.beginLoading({ overlayId: 'surfaceLoadOverlay' });
    }
    await SurfaceLoadOverlay.flushDomPaint();

    const loadAbort = new AbortController();
    SurfaceLoadOverlay.begin({
      overlayId: 'surfaceLoadOverlay',
      title: 'Loading photos',
      message: 'Loading shared media.',
      showCancel: true,
      onCancel: () => {
        loadAbort.abort();
        SurfaceLoadOverlay.end({ overlayId: 'surfaceLoadOverlay' });
        showShareFailure('Loading cancelled.');
      },
    });

    try {
      const metaPromise = resolveShareMeta({ signal: loadAbort.signal });
      const fullPromise = resolveShareFull({ signal: loadAbort.signal });

      const meta = await metaPromise;
      state.album = meta.album;
      ShareSkeletonGrid.applyMeta(
        els.sharePageTitle,
        els.photoContainer,
        meta,
        els.shareEmpty,
      );
      if (typeof SurfaceLoadChrome !== 'undefined') {
        SurfaceLoadChrome.enterMeta();
      }
      document.title = els.sharePageTitle.textContent || 'Shared Photos';

      const payload = await fullPromise;
      state.album = payload.album;
      state.photos = payload.photos || [];
      applyShareTitle(state.album?.title);
      surface.renderGrid({ deferThumbSrc: true });
      surface.hydrateThumbs();
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      const message = error.message || 'Could not load share.';
      const notFound = message === SHARE_NOT_FOUND_MESSAGE;
      showShareFailure(message, { notFound });
    } finally {
      if (typeof SurfaceLoadChrome !== 'undefined') {
        SurfaceLoadChrome.complete();
      }
      SurfaceLoadOverlay.end({ overlayId: 'surfaceLoadOverlay' });
    }
  }

  void boot();
})();
