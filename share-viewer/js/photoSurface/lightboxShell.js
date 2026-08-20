/**
 * Shared lightbox chrome — keyboard, info panel, toolbar, nav chevrons.
 * Surfaces provide a thin adapter via wire(ctx).
 */
const LightboxShell = (() => {
  /** @type {object | null} */
  let ctx = null;
  let wired = false;
  let uiHideTimeout = null;
  let uiHovered = false;

  const els = {
    overlay: null,
    topBar: null,
    content: null,
    backBtn: null,
    prevBtn: null,
    nextBtn: null,
    infoBtn: null,
    infoPanel: null,
    infoCloseBtn: null,
    infoDate: null,
    infoFilename: null,
    rotateBtn: null,
    editDateBtn: null,
    starBtn: null,
    restoreBtn: null,
    downloadBtn: null,
    deleteBtn: null,
  };

  function cacheElements() {
    els.overlay = document.getElementById('lightboxOverlay');
    els.topBar = document.querySelector('.lightbox-top-bar');
    els.content = document.getElementById('lightboxContent');
    els.backBtn = document.getElementById('lightboxBackBtn');
    els.prevBtn = document.getElementById('lightboxPrevBtn');
    els.nextBtn = document.getElementById('lightboxNextBtn');
    els.infoBtn = document.getElementById('lightboxInfoBtn');
    els.infoPanel = document.getElementById('lightboxInfoPanel');
    els.infoCloseBtn = document.getElementById('infoCloseBtn');
    els.infoDate = document.getElementById('infoDate');
    els.infoFilename = document.getElementById('infoFilename');
    els.rotateBtn = document.getElementById('lightboxRotateBtn');
    els.editDateBtn = document.getElementById('lightboxEditDateBtn');
    els.starBtn = document.getElementById('lightboxStarBtn');
    els.restoreBtn = document.getElementById('lightboxRestoreBtn');
    els.downloadBtn = document.getElementById('lightboxDownloadBtn');
    els.deleteBtn = document.getElementById('lightboxDeleteBtn');
  }

  function isOpen() {
    return Boolean(ctx?.isOpen?.());
  }

  function shouldBlockKeyboard() {
    if (typeof ctx?.shouldBlockKeyboard === 'function') {
      return ctx.shouldBlockKeyboard();
    }
    return window.PickerUtils?.getTopmostVisibleOverlay?.() ?? null;
  }

  function showUI() {
    els.topBar?.classList.remove('hidden');
  }

  function hideUI() {
    els.topBar?.classList.add('hidden');
  }

  function clearUIHideTimeout() {
    if (uiHideTimeout !== null) {
      clearTimeout(uiHideTimeout);
      uiHideTimeout = null;
    }
  }

  function scheduleUIHide() {
    clearUIHideTimeout();
    uiHideTimeout = setTimeout(() => {
      if (isOpen() && !uiHovered) {
        hideUI();
      }
    }, 2000);
  }

  function hideInfoPanel() {
    if (els.infoPanel) {
      els.infoPanel.style.display = 'none';
    }
    els.overlay?.classList.remove('info-open');
    LightboxMedia.relayoutCurrent?.();
  }

  function toggleInfoPanel() {
    if (!els.infoPanel) {
      return;
    }
    const isVisible = els.infoPanel.style.display === 'block';
    if (isVisible) {
      hideInfoPanel();
    } else {
      els.infoPanel.style.display = 'block';
      els.overlay?.classList.add('info-open');
      LightboxMedia.relayoutCurrent?.();
    }
  }

  function applyInfoFields(info = {}) {
    if (els.infoDate) {
      els.infoDate.textContent = info.dateText ?? '-';
      els.infoDate.onclick = info.dateOnClick ?? null;
      els.infoDate.style.cursor = info.dateOnClick ? 'pointer' : 'default';
    }
    if (els.infoFilename) {
      els.infoFilename.textContent = info.filenameText ?? '-';
      els.infoFilename.onclick = info.filenameOnClick ?? null;
      els.infoFilename.style.cursor = info.filenameOnClick ? 'pointer' : 'default';
    }
  }

  function refreshInfo() {
    const photo = ctx?.getPhoto?.();
    if (!photo) {
      return;
    }
    applyInfoFields(ctx.formatInfo?.(photo) ?? {});
  }

  function applyCapabilities() {
    const caps = ViewCapabilities.get();

    if (els.rotateBtn) {
      els.rotateBtn.hidden = !caps.rotate;
    }
    if (els.editDateBtn) {
      els.editDateBtn.hidden = !caps.editDate;
    }
    if (els.starBtn) {
      els.starBtn.hidden = !caps.star;
    }
    if (els.downloadBtn) {
      els.downloadBtn.hidden = !caps.download;
    }
    if (els.restoreBtn) {
      els.restoreBtn.hidden = !caps.restore;
    }
    if (els.deleteBtn) {
      els.deleteBtn.hidden = !caps.deleteKind;
      if (caps.deleteLightboxLabel) {
        els.deleteBtn.setAttribute('aria-label', caps.deleteLightboxLabel);
        els.deleteBtn.setAttribute('title', caps.deleteLightboxLabel);
      }
    }
  }

  function setNavArrows(canPrev, canNext) {
    if (els.prevBtn) {
      els.prevBtn.classList.toggle('inactive', !canPrev);
    }
    if (els.nextBtn) {
      els.nextBtn.classList.toggle('inactive', !canNext);
    }
  }

  function syncUIHoverState() {
    if (!els.overlay || !isOpen()) {
      return;
    }
    uiHovered = els.overlay.matches(':hover');
    showUI();
    clearUIHideTimeout();
    if (!uiHovered) {
      scheduleUIHide();
    }
  }

  function show() {
    if (els.overlay) {
      els.overlay.style.display = 'flex';
    }
    document.body.style.overflow = 'hidden';
    syncUIHoverState();
  }

  function hide() {
    hideInfoPanel();
    if (els.overlay) {
      els.overlay.style.display = 'none';
    }
    document.body.style.overflow = '';
    clearUIHideTimeout();
    uiHovered = false;
  }

  function refreshChrome() {
    applyCapabilities();
    refreshInfo();
    ctx?.updateNavArrows?.();
    ctx?.updateStarButton?.();
    syncUIHoverState();
  }

  function onOverlayMouseEnter() {
    uiHovered = true;
    showUI();
    clearUIHideTimeout();
  }

  function onOverlayMouseLeave() {
    uiHovered = false;
    scheduleUIHide();
  }

  function handleKey(e, { includeEscape = true } = {}) {
    if (!isOpen()) {
      return false;
    }

    const blocked = shouldBlockKeyboard();

    if (e.key === 'Escape' && includeEscape) {
      if (typeof ctx?.onEscapeKey === 'function' && ctx.onEscapeKey(e)) {
        return true;
      }
      ctx?.close?.({ commitRotations: false });
      return true;
    }

    if (e.key === 'ArrowLeft' && !blocked) {
      ctx?.navigate?.(-1);
      return true;
    }
    if (e.key === 'ArrowRight' && !blocked) {
      ctx?.navigate?.(1);
      return true;
    }
    if (e.key === ' ' && !blocked) {
      const lightboxVideo = document.querySelector(
        '#lightboxContent .lightbox-video-stage video',
      );
      if (
        lightboxVideo &&
        typeof LightboxVideoControls !== 'undefined' &&
        document.activeElement?.tagName !== 'INPUT'
      ) {
        e.preventDefault();
        LightboxVideoControls.togglePlay();
        return true;
      }
    }
    if (
      e.key === 'r' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      ViewCapabilities.get().rotate
    ) {
      ctx?.onRotate?.();
      e.preventDefault();
      return true;
    }
    if (e.key === 'ArrowUp' && (e.metaKey || e.ctrlKey)) {
      ctx?.onBack?.();
      e.preventDefault();
      return true;
    }

    return false;
  }

  function onDocumentKeyDown(e) {
    handleKey(e);
  }

  function bindEvents() {
    els.backBtn?.addEventListener('click', () => ctx?.onBack?.());
    els.prevBtn?.addEventListener('click', () => ctx?.navigate?.(-1));
    els.nextBtn?.addEventListener('click', () => ctx?.navigate?.(1));

    els.infoBtn?.addEventListener('click', () => {
      refreshInfo();
      toggleInfoPanel();
    });

    els.infoCloseBtn?.addEventListener('click', hideInfoPanel);

    els.rotateBtn?.addEventListener('click', () => {
      if (ViewCapabilities.get().rotate) {
        ctx?.onRotate?.();
      }
    });
    els.starBtn?.addEventListener('click', () => {
      if (ViewCapabilities.get().star) {
        ctx?.onStar?.();
      }
    });
    els.editDateBtn?.addEventListener('click', () => {
      if (ViewCapabilities.get().editDate) {
        ctx?.onEditDate?.();
      }
    });
    els.deleteBtn?.addEventListener('click', () => ctx?.onDelete?.());
    els.downloadBtn?.addEventListener('click', () => {
      if (ViewCapabilities.get().download) {
        ctx?.onDownload?.();
      }
    });
    els.restoreBtn?.addEventListener('click', () => ctx?.onRestore?.());

    els.overlay?.addEventListener('mouseenter', onOverlayMouseEnter);
    els.overlay?.addEventListener('mouseleave', onOverlayMouseLeave);
  }

  function wire(adapter) {
    if (wired) {
      return;
    }
    ctx = adapter;
    wired = true;
    cacheElements();
    bindEvents();
    applyCapabilities();

    if (adapter.registerKeyboard !== false) {
      document.addEventListener('keydown', onDocumentKeyDown);
    }
  }

  return {
    wire,
    show,
    hide,
    hideInfoPanel,
    refreshChrome,
    refreshInfo,
    applyCapabilities,
    setNavArrows,
    showUI,
    hideUI,
    clearUIHideTimeout,
    scheduleUIHide,
    syncUIHoverState,
    handleKey,
  };
})();
