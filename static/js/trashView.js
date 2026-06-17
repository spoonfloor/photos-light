/**
 * Trash view — browse and act on user-deleted photos in .trash/user_deleted/.
 */
const TrashView = (() => {
  let wired = false;

  function isActive() {
    return Boolean(state.trashViewActive);
  }

  function getPhotosApiRoot() {
    return isActive() ? '/api/trash/photos' : '/api/photos';
  }

  function getYearsApiUrl() {
    return isActive() ? '/api/trash/years' : '/api/years';
  }

  function getNearestMonthApiUrl(targetMonth, sortOrder) {
    const root = isActive() ? '/api/trash' : '/api/photos';
    const params = new URLSearchParams({
      month: targetMonth,
      sort: sortOrder,
    });
    return `${root}/nearest_month?${params.toString()}`;
  }

  function getJumpApiUrl(targetMonth, limit, sortOrder) {
    const root = isActive() ? '/api/trash' : '/api/photos';
    const params = new URLSearchParams({
      month: targetMonth,
      limit: String(limit),
      sort: sortOrder,
    });
    return `${root}/jump?${params.toString()}`;
  }

  function getPhotoMediaRoot() {
    return isActive() ? '/api/trash/photo' : '/api/photo';
  }

  function getPhotoThumbnailUrl(photoId) {
    const version = state.lightboxMediaVersions[photoId];
    const root = getPhotoMediaRoot();
    return version
      ? `${root}/${photoId}/thumbnail?v=${version}`
      : `${root}/${photoId}/thumbnail`;
  }

  function getPhotoFileUrl(photoId) {
    const version = state.lightboxMediaVersions[photoId];
    const root = getPhotoMediaRoot();
    return version
      ? `${root}/${photoId}/file?v=${version}`
      : `${root}/${photoId}/file`;
  }

  function setChromeVisible(visible) {
    const bar = document.getElementById('trashChromeMount');
    if (bar) {
      bar.hidden = !visible;
    }
    document.body.classList.toggle('trash-view-active', visible);
  }

  function updateAppBarForMode() {
    const active = isActive();
    const addPhotoBtn = document.getElementById('addPhotoBtn');
    const editDateBtn = document.getElementById('editDateBtn');
    const restoreBtn = document.getElementById('restoreBtn');
    const deleteBtn = document.getElementById('deleteBtn');

    if (addPhotoBtn) {
      addPhotoBtn.hidden = active;
    }
    if (editDateBtn) {
      editDateBtn.hidden = active;
    }
    if (restoreBtn) {
      restoreBtn.hidden = !active;
    }
    if (deleteBtn) {
      deleteBtn.setAttribute(
        'title',
        active ? 'Delete permanently' : 'Delete selected',
      );
      deleteBtn.setAttribute(
        'aria-label',
        active ? 'Delete permanently' : 'Delete',
      );
    }

    updateTrashMenuItems();
    updateDeleteButtonVisibility();
    updateRestoreButtonVisibility();
  }

  function updateRestoreButtonVisibility() {
    const restoreBtn = document.getElementById('restoreBtn');
    if (!restoreBtn || !isActive()) {
      return;
    }
    if (state.selectedPhotos.size > 0) {
      restoreBtn.style.opacity = '1';
      restoreBtn.style.pointerEvents = 'auto';
    } else {
      restoreBtn.style.opacity = '0.3';
      restoreBtn.style.pointerEvents = 'none';
    }
  }

  function updateTrashMenuItems() {
    const trashBtn = document.getElementById('viewTrashBtn');
    const emptyTrashBtn = document.getElementById('emptyTrashBtn');
    const restoreAllBtn = document.getElementById('restoreAllTrashBtn');
    const trashDivider = document.getElementById('trashMenuDivider');
    const active = isActive();

    if (trashBtn) {
      trashBtn.hidden = active;
    }
    if (emptyTrashBtn) {
      emptyTrashBtn.hidden = !active;
    }
    if (restoreAllBtn) {
      restoreAllBtn.hidden = !active;
    }
    if (trashDivider) {
      trashDivider.hidden = !active;
    }
  }

  function updateLightboxForMode() {
    const active = isActive();
    const rotateBtn = document.getElementById('lightboxRotateBtn');
    const editDateBtn = document.getElementById('lightboxEditDateBtn');
    const starBtn = document.getElementById('lightboxStarBtn');
    const restoreBtn = document.getElementById('lightboxRestoreBtn');
    const deleteBtn = document.getElementById('lightboxDeleteBtn');

    if (rotateBtn) rotateBtn.hidden = active;
    if (editDateBtn) editDateBtn.hidden = active;
    if (starBtn) starBtn.hidden = active;
    if (restoreBtn) restoreBtn.hidden = !active;
    if (deleteBtn) {
      deleteBtn.setAttribute(
        'aria-label',
        active ? 'Delete permanently' : 'Delete',
      );
      deleteBtn.setAttribute(
        'title',
        active ? 'Delete permanently' : 'Delete',
      );
    }
  }

  async function reloadGridCatalog() {
    deselectAllPhotos();
    resetPhotoWindowState();
    if (typeof VirtualGrid !== 'undefined' && VirtualGrid.isActive()) {
      VirtualGrid.destroy();
    }
    await loadAndRenderPhotos();
  }

  function resetViewState() {
    if (!state.trashViewActive) {
      return;
    }
    state.trashViewActive = false;
    setChromeVisible(false);
    updateAppBarForMode();
    updateLightboxForMode();
  }

  async function enter() {
    if (isActive() || !state.hasDatabase) {
      return;
    }
    if (state.lightboxOpen) {
      await closeLightbox({ commitRotations: false });
    }
    state.trashViewActive = true;
    setChromeVisible(true);
    updateAppBarForMode();
    updateLightboxForMode();
    await reloadGridCatalog();
  }

  async function exit() {
    if (!isActive()) {
      return;
    }
    if (state.lightboxOpen) {
      await closeLightbox({ commitRotations: false });
    }
    state.trashViewActive = false;
    setChromeVisible(false);
    updateAppBarForMode();
    updateLightboxForMode();
    await reloadGridCatalog();
  }

  async function purgePhotos(photoIds) {
    if (!photoIds?.length || state.deleteInProgress) {
      return;
    }
    state.deleteInProgress = true;

    const fromLightbox =
      state.lightboxOpen &&
      photoIds.length === 1 &&
      state.photos[state.lightboxPhotoIndex]?.id === Number(photoIds[0]);

    let lightboxSuccessor = null;
    if (fromLightbox) {
      lightboxSuccessor = computeLightboxSuccessorBeforeRemove(photoIds[0]);
    }

    try {
      await enqueueLibraryMutation({
        applyOptimistic: () => {},
        revertOptimistic: () => {},
        execute: async () => {
          const response = await fetch('/api/trash/purge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photo_ids: photoIds }),
          });
          if (!response.ok) {
            return { ok: false, error: `Purge failed: ${response.status}` };
          }
          const result = await response.json();
          return { ok: true, ...result };
        },
        onSuccess: async (result) => {
          if (!fromLightbox) {
            state.selectedPhotos.clear();
            state.lastClickedIndex = null;
            updateDeleteButtonVisibility();
            updateRestoreButtonVisibility();
            if (state.lightboxOpen) {
              await closeLightbox({ commitRotations: false });
            }
          }

          const purgedCount = result.purged || 0;
          if (purgedCount > 0) {
            removePhotosFromState(photoIds);
            await syncGridAfterHistogramChange();
            if (fromLightbox) {
              await applyLightboxSuccessorAfterRemove(
                lightboxSuccessor,
                photoIds,
              );
            }
            showToast(
              `Permanently deleted ${purgedCount} photo${purgedCount > 1 ? 's' : ''}`,
              null,
            );
          } else {
            showToast('Nothing to delete', null);
          }
        },
        failureToast: 'Delete failed',
      });
    } catch (error) {
      console.error('❌ Purge trash error:', error);
    } finally {
      state.deleteInProgress = false;
    }
  }

  async function purgeAll() {
    const total = state.photoTotalCount || 0;
    if (!total) {
      showToast('Trash is already empty', null);
      return;
    }

    showDialogOld(
      'Empty Trash',
      `Permanently delete all ${total} photo${total > 1 ? 's' : ''} in trash? This cannot be undone.`,
      async () => {
        try {
          const response = await fetch('/api/trash/purge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all: true }),
          });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || 'Empty trash failed');
          }
          if (state.lightboxOpen) {
            await closeLightbox({ commitRotations: false });
          }
          deselectAllPhotos();
          await reloadGridCatalog();
          const count = result.purged || 0;
          showToast(
            `Permanently deleted ${count} photo${count > 1 ? 's' : ''}`,
            null,
          );
        } catch (error) {
          console.error('❌ Empty trash error:', error);
          showToast('Empty trash failed', null);
        }
      },
    );
  }

  async function restorePhotos(photoIds) {
    if (!photoIds?.length) {
      return;
    }

    const fromLightbox =
      state.lightboxOpen &&
      photoIds.length === 1 &&
      state.photos[state.lightboxPhotoIndex]?.id === Number(photoIds[0]);
    let lightboxSuccessor = null;
    if (fromLightbox) {
      lightboxSuccessor = computeLightboxSuccessorBeforeRemove(photoIds[0]);
    }

    try {
      await enqueueLibraryMutation({
        applyOptimistic: () => {},
        revertOptimistic: () => {},
        execute: async () => {
          const response = await fetch('/api/photos/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photo_ids: photoIds }),
          });
          if (!response.ok) {
            return { ok: false, error: `Restore failed: ${response.status}` };
          }
          const result = await response.json();
          return { ok: true, ...result };
        },
        onSuccess: async (result) => {
          if (!fromLightbox) {
            state.selectedPhotos.clear();
            state.lastClickedIndex = null;
            updateDeleteButtonVisibility();
            updateRestoreButtonVisibility();
            if (state.lightboxOpen) {
              await closeLightbox({ commitRotations: false });
            }
          }

          const restoredCount = result.restored || 0;
          if (restoredCount > 0) {
            removePhotosFromState(photoIds);
            await syncGridAfterHistogramChange();
            if (fromLightbox) {
              await applyLightboxSuccessorAfterRemove(
                lightboxSuccessor,
                photoIds,
              );
            }
            showToast(
              `Restored ${restoredCount} photo${restoredCount > 1 ? 's' : ''}`,
              null,
            );
          } else {
            showToast('Nothing to restore', null);
          }
        },
        failureToast: 'Restore failed',
      });
    } catch (error) {
      console.error('❌ Restore trash error:', error);
    }
  }

  async function restoreAll() {
    const total = state.photoTotalCount || 0;
    if (!total) {
      showToast('Trash is empty', null);
      return;
    }

    showDialogOld(
      'Restore All',
      `Restore all ${total} photo${total > 1 ? 's' : ''} to the library?`,
      async () => {
        try {
          const response = await fetch('/api/trash/restore-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || 'Restore all failed');
          }
          if (state.lightboxOpen) {
            await closeLightbox({ commitRotations: false });
          }
          deselectAllPhotos();
          await reloadGridCatalog();
          const count = result.restored || 0;
          showToast(
            `Restored ${count} photo${count > 1 ? 's' : ''}`,
            null,
          );
        } catch (error) {
          console.error('❌ Restore all error:', error);
          showToast('Restore all failed', null);
        }
      },
    );
  }

  function confirmPermanentDelete(photoIds, onConfirm) {
    const count = photoIds.length;
    showDialogOld(
      'Delete Permanently',
      `Permanently delete ${count} photo${count > 1 ? 's' : ''}? This cannot be undone.`,
      onConfirm,
    );
  }

  function wire() {
    if (wired) {
      return;
    }

    const backBtn = document.getElementById('trashBackBtn');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        void exit();
      });
    }

    const restoreBtn = document.getElementById('restoreBtn');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', () => {
        const count = state.selectedPhotos.size;
        if (count === 0) return;
        void restorePhotos(Array.from(state.selectedPhotos));
      });
    }

    const lightboxRestoreBtn = document.getElementById('lightboxRestoreBtn');
    if (lightboxRestoreBtn) {
      lightboxRestoreBtn.addEventListener('click', () => {
        const photoId = state.photos[state.lightboxPhotoIndex]?.id;
        if (!photoId) return;
        void restorePhotos([photoId]);
      });
    }

    wired = true;
  }

  function init() {
    wire();
    updateTrashMenuItems();
  }

  return {
    init,
    isActive,
    enter,
    exit,
    purgePhotos,
    purgeAll,
    restorePhotos,
    restoreAll,
    confirmPermanentDelete,
    getPhotosApiRoot,
    getYearsApiUrl,
    getNearestMonthApiUrl,
    getJumpApiUrl,
    getPhotoThumbnailUrl,
    getPhotoFileUrl,
    updateAppBarForMode,
    updateLightboxForMode,
    updateRestoreButtonVisibility,
    updateTrashMenuItems,
    resetViewState,
  };
})();
