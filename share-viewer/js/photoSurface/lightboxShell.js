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
    moreBtn: null,
    utilitiesMenu: null,
    rotateMenuBtn: null,
    editDateMenuBtn: null,
    downloadMenuBtn: null,
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
    els.moreBtn = document.getElementById('lightboxMoreBtn');
    els.utilitiesMenu = document.getElementById('lightboxUtilitiesMenu');
    els.rotateMenuBtn = document.getElementById('lightboxRotateMenuBtn');
    els.editDateMenuBtn = document.getElementById('lightboxEditDateMenuBtn');
    els.downloadMenuBtn = document.getElementById('lightboxDownloadMenuBtn');
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

  // --- Chevron auto-hide (docs/lightbox-480-plan.md) ---
  // Narrow (≤480px, touch) only. Wide widths never run this timer — the
  // chevrons there are hidden by default and revealed purely by CSS
  // :hover on the chevron's own hit halo (see .lightbox-nav-btn in
  // styles.css), with no JS-side state at all. The width check happens at
  // arm-time (scheduleChevronHide), not continuously, so this doesn't
  // chase a live resize across the breakpoint mid-session — matching how
  // every other breakpoint delta in this codebase is plain CSS with no JS
  // awareness.
  const CHEVRON_AUTO_HIDE_DELAY = 1500; // ms, from image load
  const NARROW_QUERY = '(max-width: 480px)';
  let chevronHideTimeout = null;
  // Which side was last used to navigate — null on initial open (show both),
  // -1/1 after a prev/next interaction (show only that side's chevron).
  // Set by navigate() below, the single place every nav trigger (chevron
  // click, swipe, arrow key) funnels through.
  let lastNavDelta = null;
  // True when the last navigate() came from a touch swipe. A swipe must do
  // nothing to chevron visibility — not reveal, not re-arm the timer — so
  // showChevrons() bails when this is set. Reset on a genuine open and by
  // any non-swipe nav (the default arg).
  let lastNavWasSwipe = false;
  // Tracks whether the overlay is currently open, so show() can tell a true
  // open-from-closed apart from a nav-triggered reshow (see show()).
  let isShowing = false;

  function clearChevronHideTimeout() {
    if (chevronHideTimeout !== null) {
      clearTimeout(chevronHideTimeout);
      chevronHideTimeout = null;
    }
  }

  function scheduleChevronHide() {
    clearChevronHideTimeout();
    if (!window.matchMedia(NARROW_QUERY).matches) {
      return;
    }
    chevronHideTimeout = setTimeout(() => {
      chevronHideTimeout = null;
      els.prevBtn?.classList.add('hidden');
      els.nextBtn?.classList.add('hidden');
    }, CHEVRON_AUTO_HIDE_DELAY);
  }

  // Called on image load and re-armed on every nav interaction, since a
  // nav interaction always results in a new image load (an inactive
  // chevron is unclickable, so there's no "reset without a new photo"
  // case to handle separately) — this single call covers both of the
  // narrow triggers ("1500ms from image load" and "any nav interaction
  // resets the timer") at once. Which side(s) get revealed depends on
  // lastNavDelta: initial open shows both, a nav interaction shows only
  // the side just used (left after back, right after forward).
  // A swipe is the exception: it leaves chevron visibility and the timer
  // completely untouched (see lastNavWasSwipe).
  function showChevrons() {
    if (lastNavWasSwipe) {
      return;
    }
    if (lastNavDelta === -1) {
      els.prevBtn?.classList.remove('hidden');
      els.nextBtn?.classList.add('hidden');
    } else if (lastNavDelta === 1) {
      els.nextBtn?.classList.remove('hidden');
      els.prevBtn?.classList.add('hidden');
    } else {
      els.prevBtn?.classList.remove('hidden');
      els.nextBtn?.classList.remove('hidden');
    }
    scheduleChevronHide();
  }

  // Single funnel for every navigate trigger (chevron click, swipe, arrow
  // key) so lastNavDelta can't drift out of sync with what actually
  // navigated. fromSwipe is set only by the swipe branch of
  // classifyGesture — every other caller navigates "normally" and gets
  // the usual chevron reveal.
  function navigate(delta, { fromSwipe = false } = {}) {
    lastNavDelta = delta;
    lastNavWasSwipe = fromSwipe;
    ctx?.navigate?.(delta);
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
    // Info panel: share shows the Date row only, app shows Date + Filename
    // (docs/share-ui-deltas.md). One shared panel in lightbox.html, gated
    // here — not a forked panel. .info-row sets `display: flex`, which beats
    // the UA [hidden] rule, so styles.css needs an explicit
    // `.info-row[hidden] { display: none }` for this to take effect.
    if (els.infoFilename) {
      const filenameRow = els.infoFilename.closest('.info-row');
      if (filenameRow) {
        filenameRow.hidden = !caps.infoFilename;
      }
    }
    if (els.starBtn) {
      els.starBtn.hidden = !caps.star;
    }
    if (els.downloadBtn) {
      els.downloadBtn.hidden = !caps.download;
    }
    // More-menu counterparts (narrow width — see docs/lightbox-480-plan.md)
    // mirror the same capability gates as their inline siblings above.
    if (els.rotateMenuBtn) {
      els.rotateMenuBtn.hidden = !caps.rotate;
    }
    if (els.editDateMenuBtn) {
      els.editDateMenuBtn.hidden = !caps.editDate;
    }
    if (els.downloadMenuBtn) {
      els.downloadMenuBtn.hidden = !caps.download;
    }
    // The narrow-width more menu only earns its place when it would hold at
    // least two of rotate/change-date/download. With one (share: Download
    // only) or zero (trash view) it is pure overhead — a tap to open a
    // single-item popover — so collapse it and let the lone action, if any,
    // stay inline at ≤480px. Consistent with the grid's own "download in the
    // app bar, not the utilities menu" share delta (docs/share-ui-deltas.md).
    // This only gates whether the menu is used; the inline/menu swap itself
    // stays CSS-media-driven (styles.css ≤480 block).
    const moreMenuItemCount =
      (caps.rotate ? 1 : 0) + (caps.editDate ? 1 : 0) + (caps.download ? 1 : 0);
    els.overlay?.classList.toggle(
      'lightbox-more-menu-active',
      moreMenuItemCount >= 2,
    );
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

  // --- Fade-up-from-black on open (docs/lightbox-480-plan.md) ---
  // A one-shot opaque black scrim (.lightbox-open-scrim in styles.css, timing
  // in --lightbox-anim-scrim-*) over the whole overlay, faded out and removed.
  // Photo + chrome are already in the DOM underneath when show() runs (both
  // hosts load media before calling show()). Only on a genuine open-from-
  // closed — nav reloads have their own fake-swipe. Honors prefers-reduced-
  // motion. Shared via show(), so share inherits it.
  function playOpenScrim() {
    if (!els.overlay) {
      return;
    }
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    const scrim = document.createElement('div');
    scrim.className = 'lightbox-open-scrim';
    els.overlay.appendChild(scrim);
    // Prime the opaque state before arming the fade, else the two writes coalesce.
    void scrim.offsetWidth;
    scrim.classList.add('is-fading');
    let done = false;
    const remove = (e) => {
      if (done || (e && e.propertyName !== 'opacity')) {
        return;
      }
      done = true;
      scrim.removeEventListener('transitionend', remove);
      scrim.remove();
    };
    scrim.addEventListener('transitionend', remove);
    setTimeout(remove, LightboxMedia.transitionTimeoutMs(scrim));
  }

  function show() {
    // openLightbox() (main.js/shareBoot.js) calls LightboxShell.show() on
    // EVERY photo load, not just the true initial open — a nav interaction
    // reloads the lightbox with a new photo the same way opening it does.
    // lastNavDelta must only reset on a genuine open-from-closed, or every
    // nav wipes the direction it just set right before showChevrons() reads
    // it, showing both chevrons instead of just the used side (bug: both
    // chevrons reappear after navigating once they'd auto-hidden). Tracked
    // internally rather than via ctx.isOpen(), since state.lightboxOpen is
    // already flipped true by the caller before this runs either way.
    const isInitialOpen = !isShowing;
    isShowing = true;
    if (els.overlay) {
      els.overlay.style.display = 'flex';
    }
    document.body.style.overflow = 'hidden';
    if (isInitialOpen) {
      lastNavDelta = null;
      lastNavWasSwipe = false;
      playOpenScrim();
    }
    showUI();
    // Same overflow/squeeze engine as the grid app bar, scoped to
    // #lightboxMount — see appBarLayout.js.
    LightboxAppBarLayout.init();
  }

  function hide() {
    isShowing = false;
    hideInfoPanel();
    PhotoChrome.hideUtilitiesMenu(els.utilitiesMenu);
    if (els.overlay) {
      els.overlay.style.display = 'none';
    }
    document.body.style.overflow = '';
    touchActive = false;
    mouseActive = false;
    clearChevronHideTimeout();
    LightboxAppBarLayout.disconnect();
  }

  function refreshChrome() {
    applyCapabilities();
    refreshInfo();
    ctx?.updateNavArrows?.();
    ctx?.updateStarButton?.();
    showUI();
    // Every call site calls this right after loading a (possibly new)
    // photo into the lightbox — the correct single hook for "1500ms from
    // image load" regardless of whether this is the initial open or a
    // nav-triggered reset (see showChevrons comment above).
    showChevrons();
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
      navigate(-1);
      return true;
    }
    if (e.key === 'ArrowRight' && !blocked) {
      navigate(1);
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
  // Single recognizer shared by swipe left/right (Step 2), swipe down to
  // exit (Step 3), and tap-unclaimed-area to toggle the app bar (Step 4)
  // — see docs/lightbox-480-plan.md. Touch and mouse feed the same
  // classifier (classifyGesture) so the shared tap/toggle behavior can't
  // drift between them, but drag-based nav/close is touch-only (revised
  // 2026-08-25): click-drag isn't a discoverable desktop convention the way
  // touch swipe is, and a mouse drag doesn't carry the same intentionality
  // as a touch swipe at the same distance threshold — chevrons and
  // keyboard already cover desktop nav. Plain click-to-toggle (no drag) is
  // still shared, since a click is a normal desktop interaction.
  // Hard cut only: we track start/end points on release, no live drag
  // tracking or filmstrip motion (locked decision, explicitly out of scope).
  const SWIPE_MIN_DISTANCE = 50; // px
  // A genuine tap/click, not an aborted/sub-threshold swipe attempt —
  // distinct from SWIPE_MIN_DISTANCE on purpose. A drag that moves 11-49px
  // in any direction is ambiguous and stays a no-op rather than toggling
  // the bar.
  const TAP_MAX_MOVEMENT = 10; // px
  let touchActive = false;
  let touchStartX = 0;
  let touchStartY = 0;
  let mouseActive = false;
  let mouseStartX = 0;
  let mouseStartY = 0;

  function isInteractiveTarget(target) {
    return Boolean(
      target?.closest?.(
        'button, a, input, textarea, select, [contenteditable], .lightbox-info-panel, .utilities-menu',
      ),
    );
  }

  // Shared by both input sources — see classification comments below.
  // `allowDrag` gates the swipe-left/right/down branches: true for touch,
  // false for mouse (2026-08-25 revision — see gesture-recognizer comment
  // above). A mouse drag past the tap threshold is simply a no-op, at any
  // distance, in any direction.
  function classifyGesture(deltaX, deltaY, { allowDrag }) {
    if (allowDrag) {
      if (Math.abs(deltaX) >= SWIPE_MIN_DISTANCE && Math.abs(deltaX) > Math.abs(deltaY)) {
        // Swipe left → next, right → previous (same convention as the
        // chevrons: navigate(-1) is prev, navigate(1) is next). fromSwipe
        // so the resulting reload leaves the chevrons untouched.
        navigate(deltaX < 0 ? 1 : -1, { fromSwipe: true });
        return;
      }
      if (deltaY >= SWIPE_MIN_DISTANCE && deltaY > Math.abs(deltaX)) {
        // Swipe down → exit to grid. Plays a short scale + slide-down exit on
        // the current frame (LightboxMedia.animateFrameExit — shared, so share
        // inherits it), then runs the same close as tapping the back/close
        // button (commits pending rotations), not the Escape shortcut (which
        // discards them) — a deliberate exit gesture, not a discard-and-bail
        // escape hatch.
        LightboxMedia.animateFrameExit(els.content, () => ctx?.onBack?.());
        return;
      }
    }
    if (Math.abs(deltaX) <= TAP_MAX_MOVEMENT && Math.abs(deltaY) <= TAP_MAX_MOVEMENT) {
      // Tap/click on an unclaimed area → toggle the app bar. Touches/clicks
      // that started on a registered interactive element never reach here
      // (touchActive/mouseActive is already false — see the isInteractiveTarget
      // check in each start handler), so this only fires for genuinely
      // unclaimed surface. App bar only: no timer, no effect on chevron
      // visibility (that's the independent auto-hide timer).
      toggleAppBar();
      return;
    }
    // Swipe-up, ambiguous sub-swipe-threshold moves, and (for mouse) any
    // drag past the tap threshold are intentional no-ops today.
  }

  function toggleAppBar() {
    if (els.topBar?.classList.contains('hidden')) {
      showUI();
    } else {
      hideUI();
    }
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
    // Suppress the browser's post-touch compatibility mouse events
    // (mousedown/mouseup/click), which would otherwise replay this same
    // gesture through the mouse path a moment later — e.g. double-firing
    // toggleAppBar() and cancelling out the tap the user just made.
    // Guard on cancelable: a touchend that coincides with an in-progress
    // scroll is non-cancelable, and calling preventDefault() on it only
    // logs an [Intervention] warning. Kept as a guard even though #3's
    // `touch-action: none` on the ≤480 overlay (styles.css) now stops the
    // overlay from initiating a scroll in the first place.
    if (e.cancelable) {
      e.preventDefault();
    }
    const touch = e.changedTouches[0];
    if (!touch) {
      return;
    }
    classifyGesture(touch.clientX - touchStartX, touch.clientY - touchStartY, { allowDrag: true });
  }

  function onOverlayTouchCancel() {
    touchActive = false;
  }

  // Mouse arms/resolves the same way touch does: mousedown on the overlay
  // arms the gesture (subject to the same isInteractiveTarget exclusion),
  // release classifies it — but classifyGesture is called with
  // allowDrag: false, so only the plain-click tap case can fire; a mouse
  // drag never navigates or closes (see gesture-recognizer comment above).
  // mouseup is bound on `document`, not the overlay — unlike touch, mouse
  // events don't auto-capture to their start element, so a drag that ends
  // over the info panel or outside the viewport must still resolve (to a
  // no-op, now, but still needs to clear `mouseActive`).
  function onOverlayMouseDown(e) {
    if (!isOpen() || e.button !== 0 || isInteractiveTarget(e.target)) {
      mouseActive = false;
      return;
    }
    mouseActive = true;
    mouseStartX = e.clientX;
    mouseStartY = e.clientY;
    // Suppress native image drag/text-selection so it can't steal the
    // gesture or leave a stray drag-ghost mid-swipe.
    e.preventDefault();
  }

  function onDocumentMouseUp(e) {
    if (!mouseActive) {
      return;
    }
    mouseActive = false;
    classifyGesture(e.clientX - mouseStartX, e.clientY - mouseStartY, { allowDrag: false });
  }

  function bindEvents() {
    els.backBtn?.addEventListener('click', () => ctx?.onBack?.());
    els.prevBtn?.addEventListener('click', () => navigate(-1));
    els.nextBtn?.addEventListener('click', () => navigate(1));

    els.infoBtn?.addEventListener('click', () => {
      refreshInfo();
      toggleInfoPanel();
    });

    els.infoCloseBtn?.addEventListener('click', hideInfoPanel);

    // Named so both the inline icon and its more-menu counterpart (narrow,
    // app-only — see docs/lightbox-480-plan.md) call the same handler
    // instead of duplicating the capability-gated call.
    function handleRotate() {
      if (ViewCapabilities.get().rotate) {
        ctx?.onRotate?.();
      }
    }
    function handleEditDate() {
      if (ViewCapabilities.get().editDate) {
        ctx?.onEditDate?.();
      }
    }
    function handleDownload() {
      if (ViewCapabilities.get().download) {
        ctx?.onDownload?.();
      }
    }

    els.rotateBtn?.addEventListener('click', handleRotate);
    els.starBtn?.addEventListener('click', () => {
      if (ViewCapabilities.get().star) {
        ctx?.onStar?.();
      }
    });
    els.editDateBtn?.addEventListener('click', handleEditDate);
    els.deleteBtn?.addEventListener('click', () => ctx?.onDelete?.());
    els.downloadBtn?.addEventListener('click', handleDownload);
    els.restoreBtn?.addEventListener('click', () => ctx?.onRestore?.());

    els.moreBtn?.addEventListener('click', () => {
      PhotoChrome.toggleUtilitiesMenu(els.moreBtn, els.utilitiesMenu);
    });
    PhotoChrome.wireUtilitiesDismiss(els.utilitiesMenu, els.moreBtn);
    els.rotateMenuBtn?.addEventListener('click', () => {
      PhotoChrome.hideUtilitiesMenu(els.utilitiesMenu);
      handleRotate();
    });
    els.editDateMenuBtn?.addEventListener('click', () => {
      PhotoChrome.hideUtilitiesMenu(els.utilitiesMenu);
      handleEditDate();
    });
    els.downloadMenuBtn?.addEventListener('click', () => {
      PhotoChrome.hideUtilitiesMenu(els.utilitiesMenu);
      handleDownload();
    });

    els.overlay?.addEventListener('touchstart', onOverlayTouchStart, { passive: true });
    els.overlay?.addEventListener('touchend', onOverlayTouchEnd);
    els.overlay?.addEventListener('touchcancel', onOverlayTouchCancel);

    els.overlay?.addEventListener('mousedown', onOverlayMouseDown);
    document.addEventListener('mouseup', onDocumentMouseUp);
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
