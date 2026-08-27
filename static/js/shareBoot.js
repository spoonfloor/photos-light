/**
 * Share viewer boot — Supabase data adapter wired into shared PhotoSurface modules.
 */
(() => {
  ViewCapabilities.setSurface('share');
  GridSelection.setPhotoIdNormalizer((id) => String(id));

  const config = window.SHARE_VIEWER_CONFIG;
  const caps = ViewCapabilities.SHARE;

  const state = {
    token: null,
    album: null,
    photos: [],
    sortOrder: 'oldest',
    filters: { starred: false, video: false, selected: false },
    selected: new Set(),
    starred: new Set(),
    unstarredPublished: new Set(),
    lightboxPhotoId: null,
    lastClickedIndex: null,
    filterCatalogReady: false,
  };

  const TOAST_DURATION_MS = 3000;

  const els = {
    photoContainer: document.getElementById('photoContainer'),
    sharePageTitle: document.getElementById('sharePageTitle'),
    shareEmpty: document.getElementById('shareEmpty'),
    shareError: document.getElementById('shareError'),
    shareErrorRetryBtn: document.getElementById('shareErrorRetryBtn'),
    sortToggleBtn: document.getElementById('sortToggleBtn'),
    sortIcon: document.getElementById('sortIcon'),
    downloadBtn: document.getElementById('downloadBtn'),
    deselectAllBtn: document.getElementById('deselectAllBtn'),
    utilitiesBtn: document.getElementById('utilitiesBtn'),
    utilitiesMenu: document.getElementById('utilitiesMenu'),
    selectModeBtn: document.getElementById('selectModeBtn'),
    clearStarsBtn: document.getElementById('clearStarsBtn'),
    copyShareLinkBtn: document.getElementById('copyShareLinkBtn'),
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
      state.sortOrder = localStorage.getItem(storageKey('sort')) || 'oldest';
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

  function applyShareTitle(title) {
    const resolved = title || 'Shared Photos';
    document.title = resolved;
    els.sharePageTitle.textContent = resolved;
    els.sharePageTitle.classList.remove('surface-layout-placeholder');
  }

  const BROWSER_NATIVE_STILL_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
  ]);

  function stillExtension(filename) {
    if (!filename) {
      return '';
    }
    const dot = filename.lastIndexOf('.');
    if (dot < 0) {
      return '';
    }
    return filename.slice(dot).toLowerCase();
  }

  /**
   * Lightbox/video display tier — mirrors share-resolve display_url rules.
   * Grid uses thumb_url; download uses original_url.
   */
  function shareDisplayUrl(photo) {
    if (!photo) {
      return null;
    }
    if (photo.display_url) {
      return photo.display_url;
    }
    if (!photo.original_url) {
      return null;
    }
    if (LightboxMedia.isVideoPhoto(photo)) {
      return photo.original_url;
    }
    if (BROWSER_NATIVE_STILL_EXTENSIONS.has(stillExtension(photo.original_filename))) {
      return photo.original_url;
    }
    return null;
  }

  function mediaUrl(photo, kind) {
    if (kind === 'thumb') {
      if (!photo.thumb_url) {
        throw new Error('Share thumb URL is missing.');
      }
      return photo.thumb_url;
    }
    if (kind === 'display') {
      const url = shareDisplayUrl(photo);
      if (!url) {
        throw new Error('Share display URL is missing.');
      }
      return url;
    }
    if (!photo.original_url) {
      throw new Error('Share original URL is missing.');
    }
    return photo.original_url;
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

  function getFilterChipAvailability() {
    if (!state.filterCatalogReady) {
      return { starred: null, video: null };
    }
    const starredCount = starredEffectiveSet().size;
    const videoCount = state.photos.filter(
      (photo) => photo.file_type === 'video',
    ).length;
    return {
      starred: starredCount > 0,
      video: videoCount > 0,
    };
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
    onAfterRender: () => {
      ShareDatePicker.refreshCatalog(filteredPhotos(), parseDate);
      ShareDatePicker.afterGridRender();
      updateChrome();
    },
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

    const filterAvailability = getFilterChipAvailability();
    const filtersCleared = FilterChipLifecycle.applyAutoClear(
      state.filters,
      filterAvailability,
    );

    PhotoChrome.updateFilterChips({
      scroll: els.filterChipScroll,
      activeFilters: state.filters,
      selectedCount,
      showSelectedChip: caps.selectedFilterChip,
      filterAvailability,
      onToggle: (filterKey) => {
        if (
          !FilterChipLifecycle.canToggleFilter(filterKey, {
            availability: getFilterChipAvailability(),
            selectedCount: state.selected.size,
          })
        ) {
          return;
        }
        state.filters[filterKey] = !state.filters[filterKey];
        state.lastClickedIndex = null;
        rebuildPhotoGrid();
      },
    });

    if (filtersCleared) {
      rebuildPhotoGrid();
      return;
    }

    const starredCount = starredEffectiveSet().size;
    if (els.clearStarsBtn) {
      els.clearStarsBtn.disabled = starredCount === 0;
    }
    if (els.selectModeBtn) {
      els.selectModeBtn.disabled = state.photos.length === 0;
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

  // Date only — share's info panel has no filename row (infoFilename
  // capability off; see docs/share-ui-deltas.md).
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
      };
    }
    return {
      dateText: 'No date in library',
    };
  }

  function showToast(message, duration = TOAST_DURATION_MS) {
    const toast = document.getElementById('toast');
    const messageEl = document.getElementById('toastMessage');
    const undoBtn = document.getElementById('toastUndoBtn');
    const closeBtn = document.getElementById('toastCloseBtn');
    if (!toast || !messageEl) {
      return;
    }

    messageEl.textContent = message;

    if (undoBtn) {
      undoBtn.style.display = 'none';
    }

    if (closeBtn && !closeBtn.dataset.shareToastWired) {
      closeBtn.dataset.shareToastWired = 'true';
      closeBtn.addEventListener('click', hideToast);
    }

    toast.style.display = 'flex';
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(hideToast, duration);
  }

  function hideToast() {
    const toast = document.getElementById('toast');
    if (toast) {
      toast.style.display = 'none';
    }
  }

  function sharePageUrl() {
    return window.location.href;
  }

  async function copyShareLink() {
    const url = sharePageUrl();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const input = document.createElement('textarea');
        input.value = url;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      showToast('Link copied to clipboard');
    } catch {
      showToast('Could not copy link');
    }
  }

  function buildShareLightboxLoadOptions(photo) {
    return {
      isVideo: LightboxMedia.isVideoPhoto(photo),
      getMediaUrl: () => mediaUrl(photo, 'display'),
      getAltText: (p) => p.original_filename || 'Shared photo',
      nativeVideoControls: true,
      onImageError: () => {
        showToast('Preview unavailable for this photo');
      },
      onVideoError: () => {
        showToast('Preview unavailable for this video');
      },
    };
  }

  function preloadAdjacentShareLightboxImages() {
    const photos = filteredPhotos();
    const index = photos.findIndex(
      (photo) => String(photo.id) === String(state.lightboxPhotoId),
    );
    if (index < 0) {
      return;
    }
    LightboxMediaCache.prefetchAdjacent(photos, index, (entry) => {
      try {
        return mediaUrl(entry, 'display');
      } catch {
        return null;
      }
    });
  }

  function renderLightboxMedia() {
    const photo = photoById(state.lightboxPhotoId);
    if (!photo) {
      return false;
    }
    if (!shareDisplayUrl(photo)) {
      showToast(
        LightboxMedia.isVideoPhoto(photo)
          ? 'Preview unavailable for this video'
          : 'Preview unavailable for this photo',
      );
      els.lightboxContent.innerHTML = '';
      return false;
    }
    LightboxMedia.prepareContentSwap(els.lightboxContent);
    els.lightboxContent.innerHTML = '';
    els.lightboxContent.style.backgroundColor = 'transparent';
    LightboxMedia.loadIntoContent(
      els.lightboxContent,
      photo,
      buildShareLightboxLoadOptions(photo),
    );
    preloadAdjacentShareLightboxImages();
    return true;
  }

  function closeLightbox() {
    state.lightboxPhotoId = null;
    LightboxMedia.prepareContentSwap(els.lightboxContent);
    els.lightboxContent.innerHTML = '';
    LightboxMediaCache.clear();
    LightboxShell.hide();
  }

  function openLightbox(photoId) {
    state.lightboxPhotoId = photoId;
    if (!renderLightboxMedia()) {
      state.lightboxPhotoId = null;
      return;
    }
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
    if (!renderLightboxMedia()) {
      closeLightbox();
      return;
    }
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
    updateChrome();
    if (state.lightboxPhotoId != null && String(state.lightboxPhotoId) === id) {
      updateLightboxStarButton();
    }
  }

  function clearStars() {
    state.starred.clear();
    state.unstarredPublished = new Set(
      state.photos.filter((photo) => photo.rating === 5).map((photo) => String(photo.id)),
    );
    const hadStarredFilter = state.filters.starred;
    state.filters.starred = false;
    if (hadStarredFilter || state.filters.selected) {
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
    try {
      if (DownloadExport.shouldZip(photos.length, config.zipThreshold)) {
        await DownloadExport.downloadAsZip({
          items: photos,
          archiveName: DownloadExport.buildShareArchiveFilename(
            state.album?.title,
            state.album?.created_at,
          ),
          fetchBlob: async (photo, signal) => {
            const response = await fetch(mediaUrl(photo, 'original'), { signal });
            if (!response.ok) {
              throw new Error(`Download failed (${response.status})`);
            }
            return response.blob();
          },
          getEntryName: (photo) => photo.original_filename || `${photo.id}.bin`,
          isVideo: LightboxMedia.isVideoPhoto,
          deliverArchive: (archive, name) => {
            DownloadExport.triggerBrowserDownload(archive, name);
            DownloadExport.hidePrepModal();
          },
        });
        return;
      }
      for (const photo of photos) {
        const response = await fetch(mediaUrl(photo, 'original'));
        if (!response.ok) {
          throw new Error(`Download failed (${response.status})`);
        }
        const blob = await response.blob();
        DownloadExport.triggerBrowserDownload(
          blob,
          photo.original_filename || `${photo.id}.bin`,
        );
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        return;
      }
      DownloadExport.hidePrepModal();
      showToast('Download failed');
    }
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

    LightboxMedia.wireResizeUpgrade({
      isOpen: () => state.lightboxPhotoId != null,
      getPhoto: () => photoById(state.lightboxPhotoId),
      getContent: () => els.lightboxContent,
      getLoadOptions: () => {
        const photo = photoById(state.lightboxPhotoId);
        return photo ? buildShareLightboxLoadOptions(photo) : null;
      },
    });
  }

  function wireEvents() {
    els.sortToggleBtn.addEventListener('click', () => {
      state.sortOrder = state.sortOrder === 'newest' ? 'oldest' : 'newest';
      ShareDatePicker.setSortOrder(state.sortOrder);
      rebuildPhotoGrid();
    });

    // #5 — the shared appBar.html ships #downloadBtn `inactive` (the app's
    // rule: download needs a selection, and main.js updateAppBar toggles it).
    // In share, download is always usable — resolveDownloadTargets() falls
    // back to the whole filtered album when nothing is selected — so clear it
    // once here. Nothing in share re-adds `inactive` (updateChrome doesn't
    // touch it; applySurfaceChrome only toggles `hidden`). See
    // docs/share-ui-deltas.md.
    els.downloadBtn.classList.remove('inactive');
    els.downloadBtn.addEventListener('click', () => {
      void downloadPhotos(resolveDownloadTargets());
    });

    els.deselectAllBtn.addEventListener('click', clearSelection);

    els.utilitiesBtn.addEventListener('click', () => {
      PhotoChrome.toggleUtilitiesMenu(els.utilitiesBtn, els.utilitiesMenu, {
        onBeforeShow: () => {
          PhotoChrome.updateSelectModeButton(els.photoContainer, els.selectModeBtn);
        },
      });
    });
    PhotoChrome.wireUtilitiesDismiss(els.utilitiesMenu, els.utilitiesBtn);

    if (els.selectModeBtn) {
      els.selectModeBtn.addEventListener('click', () => {
        PhotoChrome.hideUtilitiesMenu(els.utilitiesMenu);
        PhotoChrome.toggleSelectMode(els.photoContainer);
        PhotoChrome.updateSelectModeButton(els.photoContainer, els.selectModeBtn);
      });
    }

    els.clearStarsBtn.addEventListener('click', () => {
      PhotoChrome.hideUtilitiesMenu(els.utilitiesMenu);
      clearStars();
    });

    if (els.copyShareLinkBtn) {
      els.copyShareLinkBtn.addEventListener('click', () => {
        PhotoChrome.hideUtilitiesMenu(els.utilitiesMenu);
        void copyShareLink();
      });
    }
  }

  function hideShareErrorState() {
    document.body.classList.remove('share-view--not-found');
    const chromeMount = document.getElementById('appChromeMount');
    if (chromeMount) {
      chromeMount.hidden = false;
    }
    if (els.sharePageTitle) {
      els.sharePageTitle.hidden = false;
    }
    if (els.shareError) {
      els.shareError.hidden = true;
      els.shareError.textContent = '';
    }
    if (els.shareErrorRetryBtn) {
      els.shareErrorRetryBtn.hidden = true;
    }
  }

  function showShareFailure(message, { notFound = false, retryable = false } = {}) {
    if (typeof SurfaceLoadChrome !== 'undefined') {
      SurfaceLoadChrome.complete();
    }
    SurfaceLoadOverlay.end({ overlayId: 'surfaceLoadOverlay', immediate: true });
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

    if (els.shareErrorRetryBtn) {
      els.shareErrorRetryBtn.hidden = !retryable;
    }
  }

  function wireShareErrorRetry() {
    if (!els.shareErrorRetryBtn || els.shareErrorRetryBtn.dataset.shareRetryWired) {
      return;
    }
    els.shareErrorRetryBtn.dataset.shareRetryWired = 'true';
    els.shareErrorRetryBtn.addEventListener('click', () => {
      void loadShareContent();
    });
  }

  function finishShareSurfaceLoad() {
    if (typeof SurfaceLoadChrome !== 'undefined') {
      SurfaceLoadChrome.complete();
    }
    SurfaceLoadOverlay.end({ overlayId: 'surfaceLoadOverlay' });
    DatePickerChrome.onSurfaceLoadComplete();
    ShareDatePicker.refreshCatalog(filteredPhotos(), parseDate);
  }

  async function loadShareContent() {
    hideShareErrorState();

    ShareSkeletonGrid.renderInstantBoot(els.sharePageTitle, els.photoContainer);
    if (typeof SurfaceLoadChrome !== 'undefined') {
      SurfaceLoadChrome.adoptLoading({ overlayId: 'surfaceLoadOverlay' });
    }
    updateChrome();
    await SurfaceLoadOverlay.flushDomPaint();

    const loadAbort = new AbortController();
    const scrimStartedAt =
      typeof window.__surfaceLoadScrimAt === 'number'
        ? window.__surfaceLoadScrimAt
        : performance.now();
    SurfaceLoadOverlay.begin({
      overlayId: 'surfaceLoadOverlay',
      title: 'Loading share page',
      message: 'Retrieving shared photos and videos.',
      showCancel: true,
      adoptScrim: true,
      scrimStartedAt,
      onCancel: () => {
        loadAbort.abort();
        showShareFailure(ShareResolveClient.MESSAGES.cancelled);
      },
    });

    let loadSucceeded = false;
    try {
      const metaPromise = ShareResolveClient.resolveMeta(state.token, {
        sort: state.sortOrder,
        signal: loadAbort.signal,
      });
      const fullPromise = ShareResolveClient.resolveFull(state.token, {
        signal: loadAbort.signal,
      });

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
      updateChrome();
      document.title = els.sharePageTitle.textContent || 'Shared Photos';

      const payload = await fullPromise;
      state.album = payload.album;
      state.photos = payload.photos || [];
      state.filterCatalogReady = true;
      applyShareTitle(state.album?.title);
      ShareDatePicker.applyFromPhotos(
        state.photos,
        parseDate,
        state.sortOrder,
        meta.first_cluster?.month_key,
      );
      surface.renderGrid({ deferThumbSrc: true });
      surface.hydrateThumbs();
      loadSucceeded = true;
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      const code = error instanceof ShareResolveClient.ShareResolveError ? error.code : null;
      const retryable =
        error instanceof ShareResolveClient.ShareResolveError && error.retryable;
      const notFound = ShareResolveClient.isPermanentFailure(code);
      const message =
        error.message ||
        ShareResolveClient.messageForCode(code, ShareResolveClient.MESSAGES.generic);
      showShareFailure(message, { notFound, retryable });
    } finally {
      if (loadSucceeded) {
        finishShareSurfaceLoad();
      }
    }
  }

  async function boot() {
    state.token = parseShareToken();
    if (!state.token) {
      showShareFailure(ShareResolveClient.MESSAGES.missing_token, { notFound: true });
      return;
    }

    loadLocalState();
    PhotoSurface.mountChrome(caps);
    if (typeof AppBarLayout !== 'undefined') {
      AppBarLayout.init();
    }
    ShareDatePicker.wire({ sortOrderGetter: () => state.sortOrder });
    wireLightbox();
    wireEvents();
    wireShareErrorRetry();

    await loadShareContent();
  }

  void boot();
})();
