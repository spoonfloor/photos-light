/**
 * Shared lightbox chrome — keyboard, info panel, toolbar, nav chevrons.
 * Surfaces provide a thin adapter via wire(ctx).
 */
const LightboxShell = (() => {
  /** @type {object | null} */
  let ctx = null;
  let wired = false;

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
    // .lightbox-top-chrome wraps both the scrim and the icon row so
    // show/hide fades them together (see styles.css .lightbox-top-chrome).
    els.topBar = document.querySelector('.lightbox-top-chrome');
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

  function show() {
    if (els.overlay) {
      els.overlay.style.display = 'flex';
    }
    document.body.style.overflow = 'hidden';
    showUI();
    // Same overflow/squeeze engine as the grid app bar, scoped to
    // #lightboxMount — see appBarLayout.js.
    LightboxAppBarLayout.init();
  }

  function hide() {
    hideInfoPanel();
    if (els.overlay) {
      els.overlay.style.display = 'none';
    }
    document.body.style.overflow = '';
    touchActive = false;
    LightboxAppBarLayout.disconnect();
  }

  function refreshChrome() {
    applyCapabilities();
    refreshInfo();
    ctx?.updateNavArrows?.();
    ctx?.updateStarButton?.();
    showUI();
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

  // --- Gesture recognizer ---
  // Single recognizer shared by swipe left/right (Step 2, wired below),
  // swipe down to exit (Step 3, not yet wired), and tap-unclaimed-area to
  // toggle the app bar (Step 4, not yet wired) — see docs/lightbox-480-plan.md.
  // Hard cut only: we track start/end points on touchend, no live drag
  // tracking or filmstrip motion (locked decision, explicitly out of scope).
  const SWIPE_MIN_DISTANCE = 50; // px
  let touchActive = false;
  let touchStartX = 0;
  let touchStartY = 0;

  function isInteractiveTarget(target) {
    return Boolean(
      target?.closest?.(
        'button, a, input, textarea, select, [contenteditable], .lightbox-info-panel',
      ),
    );
  }

  function onOverlayTouchStart(e) {
    if (!isOpen() || e.touches.length !== 1 || isInteractiveTarget(e.target)) {
      touchActive = false;
      return;
    }
    touchActive = true;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }

  function onOverlayTouchEnd(e) {
    if (!touchActive) {
      return;
    }
    touchActive = false;
    const touch = e.changedTouches[0];
    if (!touch) {
      return;
    }
    const deltaX = touch.clientX - touchStartX;
    const deltaY = touch.clientY - touchStartY;

    if (Math.abs(deltaX) >= SWIPE_MIN_DISTANCE && Math.abs(deltaX) > Math.abs(deltaY)) {
      // Swipe left → next, swipe right → previous (same convention as the
      // chevrons: ctx.navigate(-1) is prev, ctx.navigate(1) is next).
      ctx?.navigate?.(deltaX < 0 ? 1 : -1);
      return;
    }
    // Vertical swipe-down (Step 3) and no-movement tap (Step 4) aren't
    // wired up yet — this recognizer only acts on the horizontal case today.
  }

  function onOverlayTouchCancel() {
    touchActive = false;
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

    els.overlay?.addEventListener('touchstart', onOverlayTouchStart, { passive: true });
    els.overlay?.addEventListener('touchend', onOverlayTouchEnd);
    els.overlay?.addEventListener('touchcancel', onOverlayTouchCancel);
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
    handleKey,
  };
})();
