/**
 * Share-by-link flow — Get link modal + Supabase publish.
 */
const ShareFlow = (() => {
  let overlayLoaded = false;
  let publishInProgress = false;
  let session = null;

  function isPublishInProgress() {
    return publishInProgress;
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

  function setPreflightVisible(visible) {
    getOverlayEl('shareOverlayPreflight').hidden = !visible;
    getOverlayEl('shareOverlayPreflightActions').hidden = !visible;
  }

  function setCompleteVisible(visible) {
    getOverlayEl('shareOverlayComplete').hidden = !visible;
    getOverlayEl('shareOverlayCompleteActions').hidden = !visible;
  }

  function setProgressVisible(visible) {
    getOverlayEl('shareOverlayProgress').hidden = !visible;
  }

  function closeOverlay() {
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
    setPreflightVisible(true);
    setCompleteVisible(false);
    setProgressVisible(false);
  }

  function showCompleteState(result) {
    setPreflightVisible(false);
    setCompleteVisible(true);
    setProgressVisible(false);

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
    getOverlayEl('shareOverlayCompleteUrl').textContent = result.url || session?.url || '';
  }

  function showProgressState(completed, total) {
    setPreflightVisible(false);
    setCompleteVisible(false);
    setProgressVisible(true);
    const text = getOverlayEl('shareOverlayProgressText');
    if (text) {
      text.textContent = `Uploading ${completed} of ${total}…`;
    }
  }

  async function copyShareUrl(url) {
    const value = url || getOverlayEl('shareOverlayCompleteUrl')?.textContent || '';
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
          showProgressState(data.completed || 0, data.total || session?.photoIds?.length || 0);
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
        url: prepared.url,
        photoIds,
        suggestedTitle: prepared.suggested_title || 'Shared Photos',
        photoCount: prepared.photo_count || photoIds.length,
      };

      getOverlayEl('shareOverlayLead').textContent =
        `Share ${session.photoCount} selected photo${session.photoCount === 1 ? '' : 's'}?`;
      getOverlayEl('shareOverlayUrl').textContent = session.url;

      const titleToggle = getOverlayEl('shareOverlayTitleToggle');
      const titleInput = getOverlayEl('shareOverlayTitleInput');
      titleToggle.checked = false;
      titleInput.value = session.suggestedTitle;
      titleInput.placeholder = session.suggestedTitle;
      titleInput.disabled = true;

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

    const titleToggle = getOverlayEl('shareOverlayTitleToggle');
    const titleInput = getOverlayEl('shareOverlayTitleInput');
    const useTitle = Boolean(titleToggle?.checked);
    const title = (titleInput?.value || '').trim();

    showProgressState(0, session.photoCount);

    try {
      const streamResult = await publishShare({
        slug: session.slug,
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

    getOverlayEl('shareOverlayTitleToggle')?.addEventListener('change', (event) => {
      const input = getOverlayEl('shareOverlayTitleInput');
      if (!input) {
        return;
      }
      input.disabled = !event.target.checked;
      if (event.target.checked && !input.value.trim()) {
        input.value = session?.suggestedTitle || '';
      }
    });
  }

  function updateMenuAvailability() {
    const btn = document.getElementById('getShareLinkBtn');
    if (!btn) {
      return;
    }
    const hasDatabase = state.hasDatabase;
    const hasSelectedPhotos = state.selectedPhotos.size > 0;
    const caps = getViewCapabilities();
    const enabled =
      hasDatabase &&
      hasSelectedPhotos &&
      caps.download &&
      !photoExportInProgress &&
      !publishInProgress;
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

  return {
    isPublishInProgress,
    openFromSelection,
    updateMenuAvailability,
  };
})();
