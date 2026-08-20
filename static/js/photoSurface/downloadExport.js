/**
 * Shared download export — zip threshold, prep modal, and JSZip assembly.
 * Used by the desktop app and share viewer (static/ is source of truth).
 */
const DownloadExport = (() => {
  const ZIP_THRESHOLD = 2;
  const OVERLAY_ID = 'downloadPrepOverlay';
  const FRAGMENT_PATH = 'fragments/downloadPrepOverlay.html';

  /** @type {AbortController|null} */
  let activeAbort = null;
  let overlayWired = false;

  function zipThreshold(override) {
    const value = override ?? ZIP_THRESHOLD;
    return Number.isFinite(value) && value > 0 ? value : ZIP_THRESHOLD;
  }

  function shouldZip(count, override) {
    return count >= zipThreshold(override);
  }

  function isVideoPhoto(photo) {
    if (photo.file_type === 'video') {
      return true;
    }
    const name = photo.original_filename || photo.path || photo.filename || '';
    return /\.(mov|mp4|m4v|avi|mpg|mpeg|mkv|webm)$/i.test(name);
  }

  function countMediaTypes(items, isVideo = isVideoPhoto) {
    let photos = 0;
    let videos = 0;
    for (const item of items) {
      if (isVideo(item)) {
        videos += 1;
      } else {
        photos += 1;
      }
    }
    return { photos, videos };
  }

  function formatZipStatus(photoCount, videoCount) {
    const photoWord = photoCount === 1 ? 'photo' : 'photos';
    const videoWord = videoCount === 1 ? 'video' : 'videos';
    if (photoCount > 0 && videoCount > 0) {
      return `Zipping ${photoCount} ${photoWord} and ${videoCount} ${videoWord}…`;
    }
    if (videoCount > 0) {
      return `Zipping ${videoCount} ${videoWord}…`;
    }
    return `Zipping ${photoCount} ${photoWord}…`;
  }

  function statusHtml(message) {
    return `${message}<span class="import-spinner" aria-hidden="true"></span>`;
  }

  function getOverlay() {
    return document.getElementById(OVERLAY_ID);
  }

  function versionedFragmentUrl(path) {
    if (typeof versionedStaticUrl === 'function') {
      return versionedStaticUrl(path);
    }
    return path;
  }

  async function ensureOverlay() {
    const existing = getOverlay();
    if (existing) {
      wireOverlay(existing);
      return existing;
    }

    try {
      const response = await fetch(versionedFragmentUrl(FRAGMENT_PATH));
      if (!response.ok) {
        throw new Error(`Failed to load download prep overlay (${response.status})`);
      }
      document.body.insertAdjacentHTML('beforeend', await response.text());
    } catch (error) {
      console.error('Download prep overlay load failed:', error);
      return null;
    }

    const overlay = getOverlay();
    if (overlay) {
      wireOverlay(overlay);
    }
    return overlay;
  }

  function wireOverlay(overlay) {
    if (overlayWired) {
      return;
    }
    overlayWired = true;

    const closeBtn = document.getElementById('downloadPrepCloseBtn');
    const cancelBtn = document.getElementById('downloadPrepCancelBtn');

    closeBtn?.addEventListener('click', () => {
      hidePrepModal();
    });

    cancelBtn?.addEventListener('click', () => {
      activeAbort?.abort();
      hidePrepModal();
    });
  }

  function showPrepModal(photoCount, videoCount) {
    const overlay = getOverlay();
    if (!overlay) {
      return;
    }
    const statusEl = document.getElementById('downloadPrepStatusText');
    if (statusEl) {
      statusEl.innerHTML = statusHtml(formatZipStatus(photoCount, videoCount));
    }
    overlay.style.display = 'flex';
  }

  function hidePrepModal() {
    const overlay = getOverlay();
    if (overlay) {
      overlay.style.display = 'none';
    }
  }

  function triggerBrowserDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function filenameFromContentDisposition(header) {
    if (!header) {
      return null;
    }
    const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (utf8Match) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch {
        return utf8Match[1];
      }
    }
    const plainMatch = /filename="?([^";]+)"?/i.exec(header);
    return plainMatch ? plainMatch[1] : null;
  }

  async function buildZipArchive({ items, fetchBlob, getEntryName, signal }) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip is not loaded');
    }

    const zip = new JSZip();
    for (const item of items) {
      if (signal?.aborted) {
        throw new DOMException('Download cancelled', 'AbortError');
      }
      const fetched = await fetchBlob(item, signal);
      const blob = fetched instanceof Blob ? fetched : fetched.blob;
      const entryName =
        (fetched instanceof Blob ? null : fetched.filename) || getEntryName(item);
      zip.file(entryName, blob);
    }

    if (signal?.aborted) {
      throw new DOMException('Download cancelled', 'AbortError');
    }

    return zip.generateAsync({ type: 'blob' });
  }

  /**
   * Zip download with prep modal. Individual delivery for sub-threshold is caller-owned.
   */
  async function downloadAsZip({
    items,
    archiveName,
    fetchBlob,
    getEntryName,
    isVideo = isVideoPhoto,
    deliverArchive,
    signal: externalSignal,
  }) {
    if (!items.length) {
      return;
    }

    await ensureOverlay();

    const { photos, videos } = countMediaTypes(items, isVideo);
    const controller = new AbortController();
    activeAbort = controller;

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    showPrepModal(photos, videos);

    try {
      const archive = await buildZipArchive({
        items,
        fetchBlob: (item) => fetchBlob(item, controller.signal),
        getEntryName,
        signal: controller.signal,
      });

      if (controller.signal.aborted) {
        return;
      }

      await deliverArchive(archive, archiveName, controller.signal);
    } finally {
      if (activeAbort === controller) {
        activeAbort = null;
      }
    }
  }

  return {
    ZIP_THRESHOLD,
    zipThreshold,
    shouldZip,
    isVideoPhoto,
    countMediaTypes,
    formatZipStatus,
    filenameFromContentDisposition,
    ensureOverlay,
    showPrepModal,
    hidePrepModal,
    triggerBrowserDownload,
    buildZipArchive,
    downloadAsZip,
  };
})();
