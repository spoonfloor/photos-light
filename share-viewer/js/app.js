(() => {
  const config = window.SHARE_VIEWER_CONFIG;
  const state = {
    slug: null,
    album: null,
    photos: [],
    sortOrder: 'newest',
    clusterMode: 'day',
    filters: { starred: false, video: false, selected: false },
    selected: new Set(),
    starred: new Set(),
    unstarredPublished: new Set(),
    lightboxPhotoId: null,
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
    groupByDayBtn: document.getElementById('groupByDayBtn'),
    groupByMonthBtn: document.getElementById('groupByMonthBtn'),
    selectedFilterChip: document.getElementById('selectedFilterChip'),
    lightboxOverlay: document.getElementById('lightboxOverlay'),
    lightboxStage: document.getElementById('lightboxStage'),
    lightboxBackBtn: document.getElementById('lightboxBackBtn'),
    lightboxStarBtn: document.getElementById('lightboxStarBtn'),
    lightboxInfoBtn: document.getElementById('lightboxInfoBtn'),
    lightboxDownloadBtn: document.getElementById('lightboxDownloadBtn'),
    lightboxPrevBtn: document.getElementById('lightboxPrevBtn'),
    lightboxNextBtn: document.getElementById('lightboxNextBtn'),
  };

  function storageKey(suffix) {
    return `photos-light-share:${state.slug}:${suffix}`;
  }

  function loadLocalState() {
    try {
      state.starred = new Set(JSON.parse(localStorage.getItem(storageKey('starred')) || '[]'));
      state.selected = new Set(JSON.parse(localStorage.getItem(storageKey('selected')) || '[]'));
      state.unstarredPublished = new Set(
        JSON.parse(localStorage.getItem(storageKey('unstarredPublished')) || '[]'),
      );
      state.sortOrder = localStorage.getItem(storageKey('sort')) || 'newest';
      state.clusterMode = localStorage.getItem(storageKey('cluster')) || 'day';
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
    localStorage.setItem(storageKey('cluster'), state.clusterMode);
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
    return state.photos.find((photo) => photo.id === id);
  }

  function isStarred(photo) {
    if (state.unstarredPublished.has(photo.id)) {
      return state.starred.has(photo.id);
    }
    if (state.starred.has(photo.id)) {
      return true;
    }
    return photo.rating === 5;
  }

  function starredEffectiveSet() {
    const ids = new Set();
    for (const photo of state.photos) {
      if (isStarred(photo)) {
        ids.add(photo.id);
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
      photos = photos.filter((photo) => state.selected.has(photo.id));
    }
    photos.sort(comparePhotos);
    return photos;
  }

  function visibleLightboxPhotos() {
    return filteredPhotos();
  }

  function clusterLabel(date, mode) {
    if (!date) {
      return 'Undated';
    }
    if (mode === 'month') {
      return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function clusterKey(date, mode) {
    if (!date) {
      return 'undated';
    }
    if (mode === 'month') {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }
    return date.toISOString().slice(0, 10);
  }

  function buildGridStarBadgeHTML(starred) {
    return starred
      ? '<span class="grid-star-badge material-symbols-outlined filled" aria-hidden="true">star</span>'
      : '';
  }

  function buildGridVideoBadgeHTML(isVideo) {
    return isVideo
      ? '<span class="grid-video-badge material-symbols-outlined" aria-hidden="true">play_circle</span>'
      : '';
  }

  function renderGrid() {
    const photos = filteredPhotos();
    els.photoContainer.innerHTML = '';
    els.shareEmpty.hidden = photos.length > 0;

    if (!photos.length) {
      updateChrome();
      return;
    }

    let currentKey = null;
    let gridEl = null;

    for (const photo of photos) {
      const date = parseDate(photo.date_taken);
      const key = clusterKey(date, state.clusterMode);
      if (key !== currentKey) {
        currentKey = key;
        const header = document.createElement('div');
        header.className = state.clusterMode === 'month' ? 'month-header' : 'day-header';
        header.textContent = clusterLabel(date, state.clusterMode);
        els.photoContainer.appendChild(header);

        gridEl = document.createElement('div');
        gridEl.className = 'photo-grid';
        els.photoContainer.appendChild(gridEl);
      }

      const card = document.createElement('div');
      card.className = 'photo-card';
      if (state.selected.has(photo.id)) {
        card.classList.add('is-selected');
      }
      card.dataset.id = photo.id;

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = photo.original_filename || 'Shared photo';
      img.src = publicUrl(photo.thumb_path);
      card.appendChild(img);
      card.insertAdjacentHTML('beforeend', buildGridStarBadgeHTML(isStarred(photo)));
      card.insertAdjacentHTML('beforeend', buildGridVideoBadgeHTML(photo.file_type === 'video'));

      card.addEventListener('click', (event) => {
        if (event.shiftKey || event.metaKey || event.ctrlKey || state.selected.size > 0) {
          toggleSelection(photo.id);
          return;
        }
        openLightbox(photo.id);
      });

      gridEl.appendChild(card);
    }

    updateChrome();
  }

  function updateChrome() {
    const selectedCount = state.selected.size;
    els.deselectAllBtn.classList.toggle('inactive', selectedCount === 0);
    els.selectedFilterChip.textContent = `selected (${selectedCount})`;
    els.sortIcon.textContent =
      state.sortOrder === 'newest' ? 'hourglass_arrow_down' : 'hourglass_arrow_up';
    els.sortToggleBtn.title = state.sortOrder === 'newest' ? 'Newest first' : 'Oldest first';

    document.querySelectorAll('.filter-chip').forEach((chip) => {
      const key = chip.dataset.filter;
      chip.setAttribute('aria-pressed', state.filters[key] ? 'true' : 'false');
    });

    const starredCount = starredEffectiveSet().size;
    els.clearStarsBtn.classList.toggle('disabled', starredCount === 0);
    saveLocalState();
  }

  function toggleSelection(photoId) {
    if (state.selected.has(photoId)) {
      state.selected.delete(photoId);
    } else {
      state.selected.add(photoId);
    }
    renderGrid();
  }

  function clearSelection() {
    state.selected.clear();
    renderGrid();
  }

  function toggleStar(photoId) {
    const photo = photoById(photoId);
    if (!photo) {
      return;
    }
    const starred = isStarred(photo);
    if (starred) {
      state.starred.delete(photoId);
      if (photo.rating === 5) {
        state.unstarredPublished.add(photoId);
      }
    } else {
      state.starred.add(photoId);
      state.unstarredPublished.delete(photoId);
    }
    renderGrid();
    if (state.lightboxPhotoId === photoId) {
      updateLightboxStarButton();
    }
  }

  function clearStars() {
    state.starred.clear();
    state.unstarredPublished = new Set(
      state.photos.filter((photo) => photo.rating === 5).map((photo) => photo.id),
    );
    renderGrid();
  }

  function openLightbox(photoId) {
    state.lightboxPhotoId = photoId;
    els.lightboxOverlay.style.display = 'flex';
    renderLightbox();
  }

  function closeLightbox() {
    state.lightboxPhotoId = null;
    els.lightboxOverlay.style.display = 'none';
    els.lightboxStage.innerHTML = '';
  }

  function renderLightbox() {
    const photo = photoById(state.lightboxPhotoId);
    if (!photo) {
      closeLightbox();
      return;
    }
    els.lightboxStage.innerHTML = '';
    if (photo.file_type === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.src = publicUrl(photo.original_path);
      els.lightboxStage.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = publicUrl(photo.original_path);
      img.alt = photo.original_filename || 'Shared photo';
      els.lightboxStage.appendChild(img);
    }
    updateLightboxStarButton();
  }

  function updateLightboxStarButton() {
    const photo = photoById(state.lightboxPhotoId);
    els.lightboxStarBtn.classList.toggle('active', photo ? isStarred(photo) : false);
  }

  function stepLightbox(delta) {
    const photos = visibleLightboxPhotos();
    const index = photos.findIndex((photo) => photo.id === state.lightboxPhotoId);
    if (index < 0) {
      return;
    }
    const next = photos[index + delta];
    if (!next) {
      return;
    }
    state.lightboxPhotoId = next.id;
    renderLightbox();
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
      return state.photos.filter((photo) => state.selected.has(photo.id));
    }
    return filteredPhotos();
  }

  function hideUtilitiesMenu() {
    els.utilitiesMenu.style.display = 'none';
  }

  function wireEvents() {
    els.sortToggleBtn.addEventListener('click', () => {
      state.sortOrder = state.sortOrder === 'newest' ? 'oldest' : 'newest';
      renderGrid();
    });

    els.downloadBtn.addEventListener('click', () => {
      void downloadPhotos(resolveDownloadTargets());
    });

    els.deselectAllBtn.addEventListener('click', clearSelection);

    els.utilitiesBtn.addEventListener('click', () => {
      const open = els.utilitiesMenu.style.display === 'block';
      els.utilitiesMenu.style.display = open ? 'none' : 'block';
    });

    document.addEventListener('click', (event) => {
      if (
        !els.utilitiesMenu.contains(event.target) &&
        !els.utilitiesBtn.contains(event.target)
      ) {
        hideUtilitiesMenu();
      }
    });

    els.clearStarsBtn.addEventListener('click', () => {
      hideUtilitiesMenu();
      clearStars();
    });

    els.groupByDayBtn.addEventListener('click', () => {
      hideUtilitiesMenu();
      state.clusterMode = 'day';
      renderGrid();
    });

    els.groupByMonthBtn.addEventListener('click', () => {
      hideUtilitiesMenu();
      state.clusterMode = 'month';
      renderGrid();
    });

    document.querySelectorAll('.filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const key = chip.dataset.filter;
        state.filters[key] = !state.filters[key];
        renderGrid();
      });
    });

    els.lightboxBackBtn.addEventListener('click', closeLightbox);
    els.lightboxStarBtn.addEventListener('click', () => toggleStar(state.lightboxPhotoId));
    els.lightboxDownloadBtn.addEventListener('click', () => {
      const photo = photoById(state.lightboxPhotoId);
      if (photo) {
        void downloadPhotos([photo]);
      }
    });
    els.lightboxInfoBtn.addEventListener('click', () => {
      const photo = photoById(state.lightboxPhotoId);
      if (!photo) {
        return;
      }
      const date = parseDate(photo.date_taken);
      window.alert(
        [
          photo.original_filename || 'Photo',
          date ? date.toLocaleString() : 'Undated',
          photo.file_type === 'video' ? 'Video' : 'Photo',
        ].join('\n'),
      );
    });
    els.lightboxPrevBtn.addEventListener('click', () => stepLightbox(-1));
    els.lightboxNextBtn.addEventListener('click', () => stepLightbox(1));
  }

  async function boot() {
    state.slug = parseSlug();
    if (!state.slug) {
      els.shareError.hidden = false;
      els.shareError.textContent = 'Missing share link.';
      return;
    }

    loadLocalState();

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
      renderGrid();
      wireEvents();
    } catch (error) {
      els.shareError.hidden = false;
      els.shareError.textContent = error.message || 'Could not load share.';
    }
  }

  void boot();
})();
