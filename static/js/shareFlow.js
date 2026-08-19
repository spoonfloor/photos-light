/**
 * Share-by-link flow — Get link modal + Supabase publish.
 */
const ShareFlow = (() => {
  let overlayLoaded = false;
  let manageOverlayLoaded = false;
  let publishInProgress = false;
  /** @type {Map<string, { album: object, index: number }>} */
  const pendingDeletes = new Map();
  let session = null;
  let manageAlbums = [];
  let progressStartedAtMs = null;
  let progressCompleted = 0;
  let remainingLabelState = null;
  let progressEtaTimer = null;

  function isPublishInProgress() {
    return publishInProgress;
  }

  function isManageBusy() {
    return pendingDeletes.size > 0;
  }

  function isAlbumDeletePending(albumId) {
    return pendingDeletes.has(albumId);
  }

  function getManageEl(id) {
    return document.getElementById(id);
  }

  async function ensureManageOverlayLoaded() {
    if (manageOverlayLoaded) {
      return;
    }
    const response = await fetch(
      versionedStaticUrl('fragments/shareManageOverlay.html'),
    );
    if (!response.ok) {
      throw new Error('Failed to load manage links dialog');
    }
    document.body.insertAdjacentHTML('beforeend', await response.text());
    wireManageOverlayControls();
    manageOverlayLoaded = true;
  }

  async function ensureOverlayLoaded() {
    if (overlayLoaded) {
      return;
    }
    const response = await fetch(
      versionedStaticUrl('fragments/shareOverlay.html'),
    );
    if (!response.ok) {
      throw new Error('Failed to load share dialog');
    }
    document.body.insertAdjacentHTML('beforeend', await response.text());
    wireOverlayControls();
    overlayLoaded = true;
  }

  function getOverlayEl(id) {
    return document.getElementById(id);
  }

  function setButtonVisible(id, visible) {
    const button = getOverlayEl(id);
    if (button) {
      button.hidden = !visible;
    }
  }

  function setActionsVisible(visible) {
    const actions = getOverlayEl('shareOverlayActions');
    if (actions) {
      actions.hidden = !visible;
    }
  }

  function setShareButtonDisabled(disabled) {
    const shareBtn = getOverlayEl('shareOverlayShareBtn');
    if (shareBtn) {
      shareBtn.disabled = disabled;
    }
  }

  function showPreflightActions() {
    setActionsVisible(true);
    setButtonVisible('shareOverlayCancelBtn', true);
    setButtonVisible('shareOverlayShareBtn', true);
    setButtonVisible('shareOverlayDoneBtn', false);
    setShareButtonDisabled(false);
  }

  function showProgressActions() {
    setActionsVisible(true);
    setButtonVisible('shareOverlayCancelBtn', true);
    setButtonVisible('shareOverlayShareBtn', true);
    setButtonVisible('shareOverlayDoneBtn', false);
    setShareButtonDisabled(true);
  }

  function showCompleteActions() {
    setActionsVisible(true);
    setButtonVisible('shareOverlayCancelBtn', false);
    setButtonVisible('shareOverlayShareBtn', false);
    setButtonVisible('shareOverlayDoneBtn', true);
    setShareButtonDisabled(false);
  }

  function setPreflightVisible(visible) {
    getOverlayEl('shareOverlayPreflight').hidden = !visible;
  }

  function setCompleteVisible(visible) {
    getOverlayEl('shareOverlayComplete').hidden = !visible;
  }

  function setProgressVisible(visible) {
    getOverlayEl('shareOverlayProgress').hidden = !visible;
  }

  function isTitleFieldVisible() {
    const input = getOverlayEl('shareOverlayTitleInput');
    return Boolean(input && !input.hidden);
  }

  function setTitleTogglePressed(pressed) {
    const toggle = getOverlayEl('shareOverlayTitleToggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    }
  }

  function setTitleInputVisible(visible) {
    const input = getOverlayEl('shareOverlayTitleInput');
    if (input) {
      input.hidden = !visible;
    }
    setTitleTogglePressed(visible);
  }

  function stopProgressEtaTicker() {
    if (progressEtaTimer) {
      clearInterval(progressEtaTimer);
      progressEtaTimer = null;
    }
  }

  function resetProgressTiming() {
    progressStartedAtMs = Date.now();
    progressCompleted = 0;
    remainingLabelState =
      typeof createInflightRemainingLabelState === 'function'
        ? createInflightRemainingLabelState()
        : null;
  }

  function computeShareRemainingSec(completed, total) {
    if (completed <= 0 || !progressStartedAtMs) {
      return null;
    }
    const elapsed = (Date.now() - progressStartedAtMs) / 1000;
    if (elapsed <= 0) {
      return null;
    }
    return Math.max(5, (total - completed) * (elapsed / completed));
  }

  function formatShareRemainingLine(remainingSec) {
    if (remainingSec === null) {
      return 'Time remaining: Calculating…';
    }

    if (typeof formatInflightRemainingLabel === 'function') {
      const formatted = formatInflightRemainingLabel(
        remainingSec,
        remainingLabelState,
      );
      remainingLabelState = formatted.state;
      return `Time remaining: ${formatted.label}`;
    }

    const label =
      typeof formatAboutDurationFromSeconds === 'function'
        ? formatAboutDurationFromSeconds(remainingSec)
        : 'Calculating…';
    return `Time remaining: ${label}`;
  }

  function updateProgressDisplay(completed, total) {
    progressCompleted = completed;
    const text = getOverlayEl('shareOverlayProgressText');
    if (text) {
      text.textContent = `Uploading ${completed} of ${total}…`;
    }

    const remainingEl = getOverlayEl('shareOverlayProgressRemaining');
    if (!remainingEl) {
      return;
    }

    remainingEl.textContent = formatShareRemainingLine(
      computeShareRemainingSec(completed, total),
    );
  }

  function startProgressEtaTicker(total) {
    stopProgressEtaTicker();
    progressEtaTimer = setInterval(() => {
      if (!publishInProgress) {
        return;
      }
      updateProgressDisplay(progressCompleted, total);
    }, 1000);
  }

  function closeOverlay() {
    stopProgressEtaTicker();
    const overlay = getOverlayEl('shareOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
    session = null;
    if (typeof updateUtilityMenuAvailability === 'function') {
      updateUtilityMenuAvailability();
    }
  }

  function showPreflightState() {
    stopProgressEtaTicker();
    setPreflightVisible(true);
    setCompleteVisible(false);
    setProgressVisible(false);
    showPreflightActions();
  }

  function showCompleteState(result) {
    stopProgressEtaTicker();
    setPreflightVisible(false);
    setCompleteVisible(true);
    setProgressVisible(false);
    showCompleteActions();

    const count = result.photo_count || session?.photoIds?.length || 0;
    const title = result.title || null;
    const messageEl = getOverlayEl('shareOverlayCompleteMessage');
    if (messageEl) {
      if (title) {
        messageEl.textContent = `${title} (${count} photo${count === 1 ? '' : 's'}) has been shared!`;
      } else {
        messageEl.textContent = `${count} photo${count === 1 ? '' : 's'} have been shared!`;
      }
    }
    getOverlayEl('shareOverlayCompleteUrl').textContent =
      result.url || session?.url || '';
  }

  function showProgressState(completed, total) {
    setPreflightVisible(false);
    setCompleteVisible(false);
    setProgressVisible(true);
    showProgressActions();
    updateProgressDisplay(completed, total);
  }

  async function copyShareUrl(url) {
    const value =
      url || getOverlayEl('shareOverlayCompleteUrl')?.textContent || '';
    if (!value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      showToast('Link copied', null, 2500);
    } catch {
      showToast('Could not copy link', 'error');
    }
  }

  async function fetchShareAlbums() {
    const { response, data } = await apiFetchJson('/api/share/albums');
    if (!response.ok) {
      throw new Error(data.error || 'Could not load shared links');
    }
    return Array.isArray(data.albums) ? data.albums : [];
  }

  async function deleteShareAlbum(albumId) {
    const { response, data } = await apiFetchJson(
      `/api/share/albums/${encodeURIComponent(albumId)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) {
      throw new Error(data.error || 'Could not delete link');
    }
  }

  function setManageLoading(visible) {
    const loadingEl = getManageEl('shareManageLoading');
    if (loadingEl) {
      loadingEl.hidden = !visible;
    }
  }

  function setManageEmpty(visible) {
    const emptyEl = getManageEl('shareManageEmpty');
    if (emptyEl) {
      emptyEl.hidden = !visible;
    }
  }

  function setManageListDisabled(disabled) {
    const listEl = getManageEl('shareManageList');
    if (!listEl) {
      return;
    }
    listEl.querySelectorAll('button').forEach((button) => {
      button.disabled = disabled;
    });
  }

  function updateManageTitle() {
    const titleEl = getManageEl('shareManageTitle');
    if (!titleEl) {
      return;
    }
    const loading = getManageEl('shareManageLoading');
    if (loading && !loading.hidden) {
      titleEl.textContent = 'Manage links';
      return;
    }
    titleEl.textContent = `Manage links (${manageAlbums.length})`;
  }

  function updateManageScrollHint() {
    const body = getManageEl('shareManageBody');
    if (!body) {
      return;
    }
    requestAnimationFrame(() => {
      const scrollable = body.scrollHeight > body.clientHeight + 1;
      body.classList.toggle('share-manage-body--scrollable', scrollable);
    });
  }

  function renderManageList() {
    const listEl = getManageEl('shareManageList');
    if (!listEl) {
      return;
    }

    listEl.innerHTML = '';
    setManageEmpty(manageAlbums.length === 0);

    manageAlbums.forEach((album) => {
      const row = document.createElement('li');
      row.className = 'share-manage-row';
      row.dataset.albumId = album.id;

      const label = document.createElement('span');
      label.className = 'share-manage-label';
      label.textContent = album.label || album.url || 'Shared link';
      label.title = label.textContent;
      row.appendChild(label);

      const actions = document.createElement('div');
      actions.className = 'share-manage-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'share-manage-icon-btn';
      copyBtn.setAttribute('aria-label', 'Copy link');
      copyBtn.innerHTML =
        '<span class="material-symbols-outlined" aria-hidden="true">link</span>';
      copyBtn.addEventListener('click', () => {
        void copyShareUrl(album.url);
      });
      actions.appendChild(copyBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'share-manage-icon-btn';
      deleteBtn.setAttribute('aria-label', 'Delete link');
      deleteBtn.innerHTML =
        '<span class="material-symbols-outlined" aria-hidden="true">delete</span>';
      deleteBtn.addEventListener('click', () => {
        void handleManageDelete(album);
      });
      actions.appendChild(deleteBtn);

      row.appendChild(actions);
      listEl.appendChild(row);
    });

    updateManageTitle();
    updateManageScrollHint();
  }

  async function refreshManageList({ background = false } = {}) {
    if (!background) {
      setManageLoading(true);
      setManageEmpty(false);
      setManageListDisabled(true);
      updateManageTitle();
    }
    try {
      manageAlbums = await fetchShareAlbums();
      renderManageList();
    } catch (error) {
      if (!background) {
        throw error;
      }
      console.error('Manage links refresh failed:', error);
    } finally {
      if (!background) {
        setManageLoading(false);
        updateManageTitle();
        setManageListDisabled(false);
        updateManageScrollHint();
      } else {
        updateManageTitle();
        updateManageScrollHint();
      }
    }
  }

  function closeManageOverlay() {
    const overlay = getManageEl('shareManageOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
    if (typeof updateUtilityMenuAvailability === 'function') {
      updateUtilityMenuAvailability();
    }
  }

  function restorePendingDelete(albumId) {
    const pending = pendingDeletes.get(albumId);
    pendingDeletes.delete(albumId);
    if (!pending) {
      return;
    }
    const insertAt = Math.min(pending.index, manageAlbums.length);
    manageAlbums.splice(insertAt, 0, pending.album);
    renderManageList();
  }

  async function handleManageDelete(album) {
    if (!album?.id || isAlbumDeletePending(album.id)) {
      return;
    }

    const label = album.label || 'this link';
    let confirmed = false;
    if (typeof showDialog === 'function') {
      confirmed = await showDialog(
        'Delete link?',
        `Delete ${label}? This will remove the share link and delete the shared media from the cloud. Your photo libraries won't be affected. This action cannot be undone.`,
        [
          { text: 'Cancel', value: false },
          { text: 'Delete', value: true, primary: true },
        ],
        { overImport: true },
      );
    }
    if (!confirmed) {
      return;
    }

    const index = manageAlbums.findIndex((entry) => entry.id === album.id);
    if (index === -1) {
      return;
    }

    pendingDeletes.set(album.id, { album, index });
    manageAlbums = manageAlbums.filter((entry) => entry.id !== album.id);
    renderManageList();

    void deleteShareAlbum(album.id)
      .then(() => {
        pendingDeletes.delete(album.id);
        showToast('Link deleted', null, 2500);
      })
      .catch((error) => {
        console.error('Share delete failed:', error);
        restorePendingDelete(album.id);
        showToast(error.message || 'Could not delete link', 'error');
      });
  }

  async function openManageLinks() {
    if (!getViewCapabilities().shareLink || publishInProgress) {
      return;
    }

    try {
      await ensureManageOverlayLoaded();
      getManageEl('shareManageOverlay').style.display = 'flex';
      if (manageAlbums.length > 0) {
        renderManageList();
        void refreshManageList({ background: true });
      } else {
        await refreshManageList();
      }
    } catch (error) {
      console.error('Manage links failed:', error);
      showToast(error.message || 'Could not load shared links', 'error');
    }
  }

  function preloadManageOverlay() {
    void ensureManageOverlayLoaded();
  }

  function wireManageOverlayControls() {
    getManageEl('shareManageCloseBtn')?.addEventListener('click', closeManageOverlay);
    getManageEl('shareManageDoneBtn')?.addEventListener('click', closeManageOverlay);
  }

  async function prepareShare(photoIds) {
    const { response, data } = await apiFetchJson('/api/share/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: photoIds }),
    });
    if (!response.ok) {
      throw new Error(data.error || 'Could not prepare share link');
    }
    return data;
  }

  async function publishShare(payload) {
    const response = await fetch('/api/share/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Share failed');
    }
    return consumeSseStream(response, {
      onMessage: async ({ event, dataText }) => {
        const data = JSON.parse(dataText || '{}');
        if (event === 'progress') {
          showProgressState(
            data.completed || 0,
            data.total || session?.photoCount || 0,
          );
          return null;
        }
        if (event === 'complete') {
          return { done: true, result: data };
        }
        if (event === 'error') {
          throw new Error(data.error || 'Share failed');
        }
        return null;
      },
    });
  }

  async function openFromSelection() {
    if (!getViewCapabilities().download) {
      return;
    }
    const photoIds = Array.from(state.selectedPhotos);
    if (publishInProgress || photoIds.length === 0) {
      return;
    }

    try {
      await ensureOverlayLoaded();
      const prepared = await prepareShare(photoIds);
      session = {
        slug: prepared.slug,
        accessToken: prepared.access_token,
        url: prepared.url,
        photoIds,
        suggestedTitle: prepared.suggested_title || 'Shared Photos',
        photoCount: prepared.photo_count || photoIds.length,
      };

      getOverlayEl('shareOverlayLead').textContent =
        `Share ${session.photoCount} selected photo${session.photoCount === 1 ? '' : 's'}?`;

      const titleInput = getOverlayEl('shareOverlayTitleInput');
      titleInput.value = '';
      titleInput.placeholder = session.suggestedTitle;
      setTitleInputVisible(false);

      showPreflightState();
      getOverlayEl('shareOverlay').style.display = 'flex';
    } catch (error) {
      console.error('Share prepare failed:', error);
      showToast(error.message || 'Share failed', 'error');
    }
  }

  async function handleShareConfirm() {
    if (!session || publishInProgress) {
      return;
    }
    publishInProgress = true;
    if (typeof updateUtilityMenuAvailability === 'function') {
      updateUtilityMenuAvailability();
    }

    const titleInput = getOverlayEl('shareOverlayTitleInput');
    const useTitle = isTitleFieldVisible();
    const typedTitle = (titleInput?.value || '').trim();
    const title = useTitle
      ? typedTitle || session?.suggestedTitle || null
      : null;

    resetProgressTiming();
    showProgressState(0, session.photoCount);
    startProgressEtaTicker(session.photoCount);

    try {
      const streamResult = await publishShare({
        slug: session.slug,
        access_token: session.accessToken,
        photo_ids: session.photoIds,
        use_title: useTitle,
        title: useTitle ? title : null,
      });
      showCompleteState(
        streamResult || {
          url: session.url,
          photo_count: session.photoCount,
          title: useTitle ? title : null,
        },
      );
    } catch (error) {
      console.error('Share publish failed:', error);
      showToast(error.message || 'Share failed', 'error');
      showPreflightState();
    } finally {
      publishInProgress = false;
      stopProgressEtaTicker();
      if (typeof updateUtilityMenuAvailability === 'function') {
        updateUtilityMenuAvailability();
      }
    }
  }

  function wireOverlayControls() {
    getOverlayEl('shareOverlayCloseBtn')?.addEventListener('click', closeOverlay);
    getOverlayEl('shareOverlayCancelBtn')?.addEventListener('click', closeOverlay);
    getOverlayEl('shareOverlayDoneBtn')?.addEventListener('click', closeOverlay);
    getOverlayEl('shareOverlayShareBtn')?.addEventListener('click', () => {
      void handleShareConfirm();
    });
    getOverlayEl('shareOverlayCopyBtn')?.addEventListener('click', () => {
      void copyShareUrl();
    });

    getOverlayEl('shareOverlayTitleToggle')?.addEventListener('click', () => {
      const input = getOverlayEl('shareOverlayTitleInput');
      if (!input) {
        return;
      }
      const nextVisible = input.hidden;
      setTitleInputVisible(nextVisible);
      if (nextVisible) {
        input.focus();
      }
    });
  }

  function setShareMenuItemEnabled(btn, enabled) {
    if (!btn) {
      return;
    }
    if (enabled) {
      btn.classList.remove('disabled');
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    } else {
      btn.classList.add('disabled');
      btn.style.opacity = '0.3';
      btn.style.pointerEvents = 'none';
    }
  }

  function updateMenuAvailability() {
    const hasDatabase = state.hasDatabase;
    const hasSelectedPhotos = state.selectedPhotos.size > 0;
    const caps = getViewCapabilities();
    const getLinkEnabled =
      hasDatabase &&
      hasSelectedPhotos &&
      caps.shareLink &&
      !photoExportInProgress &&
      !publishInProgress;
    setShareMenuItemEnabled(
      document.getElementById('getShareLinkBtn'),
      getLinkEnabled,
    );

    const manageEnabled =
      caps.shareLink &&
      !photoExportInProgress &&
      !publishInProgress;
    setShareMenuItemEnabled(
      document.getElementById('manageShareLinksBtn'),
      manageEnabled,
    );
  }

  return {
    isPublishInProgress,
    isManageBusy,
    openFromSelection,
    openManageLinks,
    preloadManageOverlay,
    updateMenuAvailability,
  };
})();
