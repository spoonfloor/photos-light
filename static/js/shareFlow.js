/**
 * Share-by-link flow — Get link modal + Supabase publish.
 */
const ShareFlow = (() => {
  const SHARE_CANCEL_CLEANUP_MAX_ATTEMPTS = 5;
  const SHARE_CANCEL_CLEANUP_BASE_DELAY_MS = 250;
  const SHARE_CHECKING_MIN_MS = 300;
  const SHARE_FAILURE_MESSAGE_GENERIC =
    'Something went wrong while sharing. Please try again.';
  const SHARE_FAILURE_MESSAGE_ORPHAN =
    "Sharing couldn't be completed. If the link appears in Manage links, delete it first, then try again.";

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
  /** @type {AbortController|null} */
  let publishAbortController = null;
  let publishUserCancelled = false;
  /** @type {Set<string>} */
  const pendingShareCancelCleanups = new Set();
  /** @type {object|null} */
  let pendingOversizeData = null;
  let prepareInProgress = false;

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
    setButtonVisible('shareOverlaySkipBtn', false);
    setButtonVisible('shareOverlayRetryBtn', false);
    setButtonVisible('shareOverlayDoneBtn', false);
    setShareButtonDisabled(false);
  }

  function showCheckingActions() {
    setActionsVisible(true);
    setButtonVisible('shareOverlayCancelBtn', true);
    setButtonVisible('shareOverlayShareBtn', true);
    setButtonVisible('shareOverlaySkipBtn', false);
    setButtonVisible('shareOverlayRetryBtn', false);
    setButtonVisible('shareOverlayDoneBtn', false);
    setShareButtonDisabled(true);
  }

  function showOversizePartialActions() {
    setActionsVisible(true);
    setButtonVisible('shareOverlayCancelBtn', true);
    setButtonVisible('shareOverlayShareBtn', false);
    setButtonVisible('shareOverlaySkipBtn', true);
    setButtonVisible('shareOverlayRetryBtn', false);
    setButtonVisible('shareOverlayDoneBtn', false);
    setShareButtonDisabled(false);
  }

  function showOversizeAllActions() {
    setActionsVisible(true);
    setButtonVisible('shareOverlayCancelBtn', true);
    setButtonVisible('shareOverlayShareBtn', false);
    setButtonVisible('shareOverlaySkipBtn', false);
    setButtonVisible('shareOverlayRetryBtn', false);
    setButtonVisible('shareOverlayDoneBtn', false);
    setShareButtonDisabled(false);
  }

  function showProgressActions() {
    setActionsVisible(true);
    setButtonVisible('shareOverlayCancelBtn', true);
    setButtonVisible('shareOverlayShareBtn', true);
    setButtonVisible('shareOverlaySkipBtn', false);
    setButtonVisible('shareOverlayRetryBtn', false);
    setButtonVisible('shareOverlayDoneBtn', false);
    setShareButtonDisabled(true);
  }

  function showCompleteActions() {
    setActionsVisible(true);
    setButtonVisible('shareOverlayCancelBtn', false);
    setButtonVisible('shareOverlayShareBtn', false);
    setButtonVisible('shareOverlaySkipBtn', false);
    setButtonVisible('shareOverlayRetryBtn', false);
    setButtonVisible('shareOverlayDoneBtn', true);
    setShareButtonDisabled(false);
  }

  function showFailedActions() {
    setActionsVisible(true);
    setButtonVisible('shareOverlayCancelBtn', true);
    setButtonVisible('shareOverlayShareBtn', false);
    setButtonVisible('shareOverlaySkipBtn', false);
    setButtonVisible('shareOverlayRetryBtn', true);
    setButtonVisible('shareOverlayDoneBtn', false);
    setShareButtonDisabled(false);
  }

  function setCheckingVisible(visible) {
    getOverlayEl('shareOverlayChecking').hidden = !visible;
  }

  function setPreflightVisible(visible) {
    getOverlayEl('shareOverlayPreflight').hidden = !visible;
  }

  function setOversizeVisible(visible) {
    getOverlayEl('shareOverlayOversize').hidden = !visible;
  }

  function setShareDetailsSectionVisible(visible) {
    const section = getOverlayEl('shareOverlayDetailsSection');
    if (section) {
      section.style.display = visible ? 'block' : 'none';
    }
  }

  function setCompleteVisible(visible) {
    getOverlayEl('shareOverlayComplete').hidden = !visible;
  }

  function setProgressVisible(visible) {
    getOverlayEl('shareOverlayProgress').hidden = !visible;
  }

  function setFailedVisible(visible) {
    getOverlayEl('shareOverlayFailed').hidden = !visible;
  }

  function setOverlayTitle(text) {
    const titleEl = getOverlayEl('shareOverlay')?.querySelector('.import-title');
    if (titleEl) {
      titleEl.textContent = text;
    }
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

  function isShareCompleteVisible() {
    const complete = getOverlayEl('shareOverlayComplete');
    return Boolean(complete && !complete.hidden);
  }

  function isShareAbortError(error) {
    return (
      publishUserCancelled ||
      error?.name === 'AbortError' ||
      error?.message?.includes('aborted')
    );
  }

  function shareCancelCleanupKey(credentials) {
    if (!credentials) {
      return '';
    }
    return (
      credentials.accessToken ||
      credentials.slug ||
      credentials.albumId ||
      ''
    );
  }

  function shareCancelCleanupFailureMessage() {
    return "Couldn't fully remove this share from the cloud. Open Manage links and delete it manually.";
  }

  function delayMs(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async function cancelSharePublish(credentials) {
    if (!credentials?.accessToken && !credentials?.slug && !credentials?.albumId) {
      return;
    }
    const { response, data } = await apiFetchJson('/api/share/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: credentials.accessToken || null,
        slug: credentials.slug || null,
        album_id: credentials.albumId || null,
      }),
    });
    if (!response.ok) {
      throw new Error(data.error || 'Could not cancel share');
    }
  }

  async function cancelSharePublishWithRetry(
    credentials,
    {
      maxAttempts = SHARE_CANCEL_CLEANUP_MAX_ATTEMPTS,
      logLabel = 'Share cancel cleanup',
    } = {},
  ) {
    const key = shareCancelCleanupKey(credentials);
    if (!key) {
      return;
    }
    if (pendingShareCancelCleanups.has(key)) {
      return;
    }

    pendingShareCancelCleanups.add(key);
    let lastError = null;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await cancelSharePublish(credentials);
          return;
        } catch (error) {
          lastError = error;
          console.error(
            `${logLabel} attempt ${attempt}/${maxAttempts} failed:`,
            error,
          );
          if (attempt < maxAttempts) {
            await delayMs(
              SHARE_CANCEL_CLEANUP_BASE_DELAY_MS * 2 ** (attempt - 1),
            );
          }
        }
      }
      console.error(`${logLabel} exhausted retries:`, lastError);
      showToast(shareCancelCleanupFailureMessage(), 'error');
    } finally {
      pendingShareCancelCleanups.delete(key);
    }
  }

  function captureSessionCredentials(activeSession = session) {
    if (!activeSession) {
      return null;
    }
    return {
      accessToken: activeSession.accessToken,
      slug: activeSession.slug,
      albumId: activeSession.albumId || null,
    };
  }

  function resetPublishState() {
    publishInProgress = false;
    publishAbortController = null;
    stopProgressEtaTicker();
    if (typeof updateUtilityMenuAvailability === 'function') {
      updateUtilityMenuAvailability();
    }
  }

  function beginInflightCancel() {
    if (!publishInProgress && !publishAbortController) {
      return null;
    }

    publishUserCancelled = true;
    const credentials = captureSessionCredentials();
    publishAbortController?.abort();
    resetPublishState();
    return credentials;
  }

  function runShareCancelCleanup(
    credentials,
    { logLabel = 'Share cancel cleanup' } = {},
  ) {
    if (!credentials) {
      return;
    }
    void cancelSharePublishWithRetry(credentials, { logLabel });
  }

  function dismissShareOverlay() {
    stopProgressEtaTicker();
    const overlay = getOverlayEl('shareOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
    session = null;
    pendingOversizeData = null;
    prepareInProgress = false;
    publishUserCancelled = false;
    resetShareDetailsPanel();
    if (typeof updateUtilityMenuAvailability === 'function') {
      updateUtilityMenuAvailability();
    }
  }

  function closeOverlay() {
    const wasInflight = publishInProgress || publishAbortController;
    const shareSucceeded = isShareCompleteVisible();
    const dismissCredentials = wasInflight
      ? beginInflightCancel()
      : shareSucceeded
        ? null
        : captureSessionCredentials();

    dismissShareOverlay();

    if (dismissCredentials) {
      runShareCancelCleanup(dismissCredentials, {
        logLabel: wasInflight ? 'Share cancel cleanup' : 'Share dismiss cleanup',
      });
    }
  }

  function hideAllBodySections() {
    setCheckingVisible(false);
    setPreflightVisible(false);
    setOversizeVisible(false);
    setShareDetailsSectionVisible(false);
    setCompleteVisible(false);
    setProgressVisible(false);
    setFailedVisible(false);
  }

  function showPreflightState() {
    stopProgressEtaTicker();
    setOverlayTitle('Share photos');
    hideAllBodySections();
    setPreflightVisible(true);
    showPreflightActions();
  }

  function showCheckingState() {
    stopProgressEtaTicker();
    setOverlayTitle('Share photos');
    hideAllBodySections();
    setCheckingVisible(true);
    showCheckingActions();
  }

  function resetShareDetailsPanel() {
    if (typeof resetFlowDetailsPanel === 'function') {
      resetFlowDetailsPanel('shareOversize');
    }
  }

  function populateShareOversizeDetails(oversizedPhotos = []) {
    const list = getOverlayEl('shareOverlayDetailsList');
    if (!list) {
      return;
    }
    list.innerHTML = '';
    for (const item of oversizedPhotos) {
      const row = document.createElement('div');
      row.className = 'import-detail-item';
      const name = item.filename || `Photo ${item.photo_id}`;
      const sizeMb = item.size_mb != null ? item.size_mb : '?';
      row.innerHTML = `
        <span class="material-symbols-outlined import-detail-icon error">warning</span>
        <div class="import-detail-text">
          <div>${name}</div>
          <div class="import-detail-message">${sizeMb} MB</div>
        </div>
      `;
      list.appendChild(row);
    }
  }

  function showOversizeState(data) {
    stopProgressEtaTicker();
    setOverlayTitle('Share photos');
    hideAllBodySections();
    setOversizeVisible(true);

    const maxMb = data.max_size_mb ?? '?';
    const count = data.oversized_count ?? data.oversized_photos?.length ?? 0;
    const lead = getOverlayEl('shareOverlayOversizeLead');
    if (lead) {
      if (data.oversized_all) {
        lead.textContent = `All selected photos are too large. Select photos smaller than ${maxMb} MB and try again.`;
      } else {
        lead.textContent = `${count} photo${count === 1 ? '' : 's'} are too large. Select photos smaller than ${maxMb} MB, or skip them to continue.`;
      }
    }

    resetShareDetailsPanel();
    populateShareOversizeDetails(data.oversized_photos || []);
    setShareDetailsSectionVisible((data.oversized_photos || []).length > 0);

    if (data.oversized_all) {
      showOversizeAllActions();
    } else {
      showOversizePartialActions();
    }
  }

  function applyPreparedSession(prepared, photoIds) {
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
  }

  function showCompleteState(result) {
    stopProgressEtaTicker();
    setOverlayTitle('Share photos');
    hideAllBodySections();
    setCompleteVisible(true);
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
    setOverlayTitle('Share photos');
    hideAllBodySections();
    setProgressVisible(true);
    showProgressActions();
    updateProgressDisplay(completed, total);
  }

  function showFailedState({ orphanHint = false, error = null } = {}) {
    stopProgressEtaTicker();
    setOverlayTitle('Sharing error');
    hideAllBodySections();
    setFailedVisible(true);
    showFailedActions();
    const messageEl = getOverlayEl('shareOverlayFailedMessage');
    if (messageEl) {
      messageEl.textContent =
        shareFailureUserMessage(error) ||
        (orphanHint ? SHARE_FAILURE_MESSAGE_ORPHAN : SHARE_FAILURE_MESSAGE_GENERIC);
    }
  }

  function formatSharePublishFailure(error, data = null) {
    const payload = data || {
      code: error?.code,
      photo_index: error?.photoIndex,
      photo_id: error?.photoId,
      step: error?.step,
      detail: error?.detail || error?.message,
    };
    const parts = [
      payload.code ? `code=${payload.code}` : null,
      payload.step ? `step=${payload.step}` : null,
      payload.photo_index != null ? `photo_index=${payload.photo_index}` : null,
      payload.photo_id != null ? `photo_id=${payload.photo_id}` : null,
      payload.detail ? `detail=${payload.detail}` : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : 'unknown';
  }

  function logSharePublishFailure(error, data = null) {
    console.error(`[share] publish failed: ${formatSharePublishFailure(error, data)}`);
  }

  function createSharePublishError(data) {
    const err = new Error(data.error || 'Share failed');
    err.code = data.code || 'share_unknown';
    err.photoIndex = data.photo_index ?? null;
    err.photoId = data.photo_id ?? null;
    err.step = data.step || null;
    err.detail = data.detail || data.error || null;
    err.shareFailureLogged = false;
    return err;
  }

  function throwSharePublishError(data) {
    const err = createSharePublishError(data);
    err.shareFailureLogged = true;
    logSharePublishFailure(err, data);
    return err;
  }

  function shareFailureUserMessage(error) {
    if (!error) {
      return null;
    }
    if (error.code === 'share_file_too_large') {
      return error.detail || error.message;
    }
    if (error.code === 'share_file_missing') {
      return error.detail || error.message;
    }
    return null;
  }

  async function fetchPublishOutcome(activeSession) {
    const params = new URLSearchParams();
    if (activeSession?.accessToken) {
      params.set('access_token', activeSession.accessToken);
    }
    if (activeSession?.slug) {
      params.set('slug', activeSession.slug);
    }
    if (activeSession?.albumId) {
      params.set('album_id', activeSession.albumId);
    }
    const { response, data } = await apiFetchJson(
      `/api/share/publish-outcome?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error(data.error || 'Could not verify share status');
    }
    return data;
  }

  function buildCompleteResultFromOutcome(
    outcome,
    activeSession,
    { useTitle, title },
  ) {
    return {
      url: outcome?.url || activeSession?.url,
      photo_count: outcome?.photo_count || activeSession?.photoCount,
      title: useTitle ? title : outcome?.title || null,
      album_id: outcome?.album_id || null,
    };
  }

  async function resolveVerifiedPublishResult(
    activeSession,
    streamResult,
    { useTitle, title },
  ) {
    if (streamResult) {
      return { kind: 'complete', result: streamResult };
    }

    let outcome = null;
    try {
      outcome = await fetchPublishOutcome(activeSession);
    } catch (error) {
      console.error('Share publish outcome check failed:', error);
      return { kind: 'failed', orphanHint: progressCompleted > 0 };
    }

    if (outcome?.status === 'complete') {
      if (activeSession && outcome.album_id) {
        activeSession.albumId = outcome.album_id;
      }
      return {
        kind: 'complete',
        result: buildCompleteResultFromOutcome(outcome, activeSession, {
          useTitle,
          title,
        }),
      };
    }

    return {
      kind: 'failed',
      orphanHint: outcome?.status === 'partial',
    };
  }

  async function resolvePublishFailure(activeSession, error) {
    const titleInput = getOverlayEl('shareOverlayTitleInput');
    const useTitle = isTitleFieldVisible();
    const typedTitle = (titleInput?.value || '').trim();
    const title = useTitle
      ? typedTitle || activeSession?.suggestedTitle || null
      : null;

    let orphanHint = progressCompleted > 0;
    try {
      const outcome = await fetchPublishOutcome(activeSession);
      if (outcome?.status === 'complete') {
        if (activeSession && outcome.album_id) {
          activeSession.albumId = outcome.album_id;
        }
        return {
          kind: 'complete',
          result: buildCompleteResultFromOutcome(outcome, activeSession, {
            useTitle,
            title,
          }),
        };
      }
      orphanHint = outcome?.status === 'partial';
    } catch (verifyError) {
      console.error('Share failure outcome check failed:', verifyError);
    }

    if (!error?.shareFailureLogged) {
      logSharePublishFailure(error);
    }
    return { kind: 'failed', orphanHint, error };
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
        `Delete ${label}? This will remove the share link and delete the shared media from the cloud. Your photo library won't be affected. This action cannot be undone.`,
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
    if (!getViewCapabilities().shareLink) {
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

  async function publishShare(payload, { signal } = {}) {
    const response = await fetch('/api/share/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw throwSharePublishError(data);
    }
    return consumeSseStream(response, {
      isAborted: () => Boolean(signal?.aborted) || publishUserCancelled,
      onMessage: async ({ event, dataText }) => {
        if (publishUserCancelled) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        const data = JSON.parse(dataText || '{}');
        if (event === 'progress') {
          showProgressState(
            data.completed || 0,
            data.total || session?.photoCount || 0,
          );
          return null;
        }
        if (event === 'heartbeat') {
          showProgressState(
            data.completed ?? progressCompleted,
            data.total || session?.photoCount || 0,
          );
          const text = getOverlayEl('shareOverlayProgressText');
          if (text && data.message) {
            text.textContent = data.message;
          }
          return null;
        }
        if (event === 'complete') {
          if (session) {
            session.albumId = data.album_id || null;
          }
          return { done: true, result: data };
        }
        if (event === 'error') {
          throw throwSharePublishError(data);
        }
        return null;
      },
    });
  }

  async function waitForMinCheckingDuration(checkingStartedAtMs) {
    const elapsed = Date.now() - checkingStartedAtMs;
    const remaining = SHARE_CHECKING_MIN_MS - elapsed;
    if (remaining > 0) {
      await delayMs(remaining);
    }
  }

  function applyShareableSessionFromPrepare(prepared) {
    const shareableIds = prepared?.shareable_photo_ids || [];
    if (
      !prepared ||
      prepared.oversized_all ||
      !prepared.access_token ||
      !shareableIds.length
    ) {
      session = null;
      return false;
    }
    applyPreparedSession(prepared, shareableIds);
    return true;
  }

  async function resolvePreparedOutcome(prepared, photoIds, checkingStartedAtMs) {
    await waitForMinCheckingDuration(checkingStartedAtMs);
    if (prepared.status === 'oversized') {
      pendingOversizeData = prepared;
      applyShareableSessionFromPrepare(prepared);
      showOversizeState(prepared);
      return null;
    }
    pendingOversizeData = null;
    applyPreparedSession(prepared, photoIds);
    return prepared;
  }

  async function runSharePrepare(photoIds) {
    return prepareShare(photoIds);
  }

  async function openFromSelection() {
    if (!getViewCapabilities().shareLink) {
      return;
    }
    const photoIds = Array.from(state.selectedPhotos);
    if (publishInProgress || prepareInProgress || photoIds.length === 0) {
      return;
    }

    prepareInProgress = true;
    if (typeof updateUtilityMenuAvailability === 'function') {
      updateUtilityMenuAvailability();
    }

    try {
      await ensureOverlayLoaded();
      getOverlayEl('shareOverlay').style.display = 'flex';
      showCheckingState();

      const checkingStartedAtMs = Date.now();
      const prepared = await runSharePrepare(photoIds);
      const ready = await resolvePreparedOutcome(
        prepared,
        photoIds,
        checkingStartedAtMs,
      );
      if (!ready) {
        return;
      }

      showPreflightState();
    } catch (error) {
      console.error('Share prepare failed:', error);
      dismissShareOverlay();
      showToast(error.message || 'Share failed', 'error');
    } finally {
      prepareInProgress = false;
      if (typeof updateUtilityMenuAvailability === 'function') {
        updateUtilityMenuAvailability();
      }
    }
  }

  async function handleShareSkipOversized() {
    if (prepareInProgress || publishInProgress) {
      return;
    }
    if (!applyShareableSessionFromPrepare(pendingOversizeData)) {
      showToast('Share failed', 'error');
      return;
    }

    pendingOversizeData = null;
    await handleShareConfirm();
  }

  async function handleShareConfirm() {
    if (!session || publishInProgress) {
      return;
    }
    publishInProgress = true;
    publishUserCancelled = false;
    publishAbortController = new AbortController();
    if (typeof updateUtilityMenuAvailability === 'function') {
      updateUtilityMenuAvailability();
    }

    const activeSession = session;
    const titleInput = getOverlayEl('shareOverlayTitleInput');
    const useTitle = isTitleFieldVisible();
    const typedTitle = (titleInput?.value || '').trim();
    const title = useTitle
      ? typedTitle || activeSession?.suggestedTitle || null
      : null;

    resetProgressTiming();
    showProgressState(0, activeSession.photoCount);
    startProgressEtaTicker(activeSession.photoCount);

    try {
      const streamResult = await publishShare(
        {
          slug: activeSession.slug,
          access_token: activeSession.accessToken,
          photo_ids: activeSession.photoIds,
          use_title: useTitle,
          title: useTitle ? title : null,
        },
        { signal: publishAbortController.signal },
      );
      if (publishUserCancelled) {
        return;
      }

      const resolved = await resolveVerifiedPublishResult(
        activeSession,
        streamResult,
        { useTitle, title },
      );
      if (resolved.kind === 'complete') {
        showCompleteState(
          resolved.result || {
            url: activeSession.url,
            photo_count: activeSession.photoCount,
            title: useTitle ? title : null,
          },
        );
        return;
      }
      showFailedState({ orphanHint: resolved.orphanHint, error: resolved.error });
    } catch (error) {
      if (isShareAbortError(error)) {
        return;
      }
      const resolved = await resolvePublishFailure(activeSession, error);
      if (resolved.kind === 'complete') {
        showCompleteState(resolved.result);
        return;
      }
      showFailedState({ orphanHint: resolved.orphanHint, error: resolved.error });
    } finally {
      publishAbortController = null;
      if (!publishUserCancelled) {
        publishInProgress = false;
        stopProgressEtaTicker();
        if (typeof updateUtilityMenuAvailability === 'function') {
          updateUtilityMenuAvailability();
        }
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
    getOverlayEl('shareOverlaySkipBtn')?.addEventListener('click', () => {
      void handleShareSkipOversized();
    });
    getOverlayEl('shareOverlayRetryBtn')?.addEventListener('click', () => {
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

    if (typeof wireFlowDetailsToggle === 'function') {
      wireFlowDetailsToggle('shareOversize');
    }
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
      !publishInProgress &&
      !prepareInProgress;
    setShareMenuItemEnabled(
      document.getElementById('getShareLinkBtn'),
      getLinkEnabled,
    );

    const manageEnabled = caps.shareLink && !photoExportInProgress;
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
