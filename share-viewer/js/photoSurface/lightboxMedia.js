/**
 * Shared lightbox media loading — gray placeholder until fully ready, no partial decode.
 * Hosts supply URL/dimension adapters; rotation and error handling stay optional.
 */
const LightboxMedia = (() => {
  let resizeListenerBound = false;
  /** @type {{ isOpen: () => boolean, getPhoto: () => object|null, getContent: () => HTMLElement|null, getLoadOptions: () => object } | null} */
  let resizeUpgradeCtx = null;
  /** @type {ResizeObserver | null} */
  let contentResizeObserver = null;
  /** @type {HTMLElement | null} */
  let observedContent = null;

  // --- Lightbox photo-surface animations (docs/lightbox-480-plan.md) ---
  // All timings/distances live in CSS (--lightbox-anim-* + the
  // .is-animating-entry / .is-exiting / .lightbox-open-scrim classes in
  // styles.css). JS here only toggles classes, forces the priming reflow,
  // and derives its cleanup backstop from the element's resolved
  // transition-duration — so there is no timing constant to keep in sync.

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  // Longest (duration + delay) of the element's current CSS transition, in ms,
  // plus a fixed slack for the transitionend event itself to land. Used only
  // as the backstop for cleanup when transitionend never fires (tab
  // backgrounded mid-animation, interrupted, zero-delta) — the transition
  // itself is entirely CSS-driven.
  const TRANSITION_END_SLACK_MS = 100;
  function transitionTimeoutMs(el) {
    const cs = getComputedStyle(el);
    const parseSecs = (prop) =>
      cs.getPropertyValue(prop).split(',').map((v) => parseFloat(v) || 0);
    const durations = parseSecs('transition-duration');
    const delays = parseSecs('transition-delay');
    const longest = Math.max(
      0,
      ...durations.map((d, i) => d + (delays[i] || 0)),
    );
    return longest * 1000 + TRANSITION_END_SLACK_MS;
  }

  // Swipe-nav entry ("fake swipe"): the outgoing frame is a hard cut (already
  // gone — the caller cleared #lightboxContent before loadIntoContent). The
  // incoming frame mounts offset toward the side it came from and slides to
  // its natural position. `enterFrom` is the signed nav delta (+1 = next,
  // from the right; -1 = prev, from the left); 0/undefined (initial open,
  // rotation reload, resize relayout) → no animation.
  function animateFrameEntry(content, enterFrom) {
    const delta = Math.sign(enterFrom || 0);
    if (!delta || prefersReducedMotion()) {
      return;
    }
    const frame = content.querySelector('.lightbox-media-frame');
    if (!frame) {
      return;
    }
    const fromClass = delta > 0 ? 'entering-from-right' : 'entering-from-left';
    frame.classList.add('is-animating-entry', fromClass);
    // Force the offset start position to paint before dropping it, else the
    // browser coalesces both writes and nothing animates.
    void frame.offsetWidth;
    frame.classList.remove(fromClass);
    // Drop the transition class once settled so a later frame.style.transform
    // (there is none today) can't be silently animated. transitionend is the
    // normal path; the timeout is the backstop.
    let done = false;
    let fallback = null;
    const cleanup = (e) => {
      if (done || (e && e.propertyName !== 'transform')) {
        return;
      }
      done = true;
      if (fallback !== null) {
        clearTimeout(fallback);
      }
      frame.removeEventListener('transitionend', cleanup);
      frame.classList.remove('is-animating-entry');
    };
    frame.addEventListener('transitionend', cleanup);
    fallback = setTimeout(cleanup, transitionTimeoutMs(frame));
  }

  // Swipe-down exit (docs "Interim"): release-triggered, no drag tracking.
  // The frame drops + shrinks + fades, then `onDone` runs the host's real
  // close (ctx.onBack). A normal close removes the frame wholesale (caller's
  // innerHTML clear), so nothing here needs resetting; the only stuck state
  // is a close that bails (rotation-commit failure) — rare, self-heals on the
  // next nav/reopen, and the user already has a failure toast.
  function animateFrameExit(content, onDone) {
    const finish = typeof onDone === 'function' ? onDone : () => {};
    const frame = content && content.querySelector('.lightbox-media-frame');
    if (!frame || frame.dataset.exiting === '1' || prefersReducedMotion()) {
      finish();
      return;
    }
    frame.dataset.exiting = '1';
    let called = false;
    const run = () => {
      if (called) {
        return;
      }
      called = true;
      frame.removeEventListener('transitionend', onEnd);
      finish();
    };
    // transitionend fires per-property (transform + opacity) — act on
    // 'transform' only; `called` guards the double anyway.
    const onEnd = (e) => {
      if (e.propertyName === 'transform') {
        run();
      }
    };
    frame.classList.add('is-exiting');
    frame.addEventListener('transitionend', onEnd);
    setTimeout(run, transitionTimeoutMs(frame));
  }

  function normalizeRotationDegrees(degrees) {
    return ((degrees % 360) + 360) % 360;
  }

  function defaultDimensions(photo) {
    return {
      width: photo?.width || 0,
      height: photo?.height || 0,
    };
  }

  function availableViewport() {
    const content =
      (typeof resizeUpgradeCtx?.getContent === 'function'
        ? resizeUpgradeCtx.getContent()
        : null) || document.getElementById('lightboxContent');
    const width = content?.clientWidth || 0;
    const height = content?.clientHeight || 0;
    return {
      width: Math.max(1, Math.floor(width > 0 ? width : window.innerWidth)),
      height: Math.max(1, Math.floor(height > 0 ? height : window.innerHeight)),
    };
  }

  function calculateMediaDimensions(photo, rotationDegrees = 0, getDimensions = defaultDimensions) {
    const normalized = normalizeRotationDegrees(rotationDegrees);
    const isTransposed = normalized === 90 || normalized === 270;
    const base = getDimensions(photo) || {};
    const displayW = isTransposed ? base.height : base.width;
    const displayH = isTransposed ? base.width : base.height;
    const viewport = availableViewport();

    if (!displayW || !displayH) {
      return {
        width: `${viewport.width}px`,
        height: `${Math.round(viewport.width * 0.75)}px`,
        maxHeight: `${viewport.height}px`,
      };
    }

    const displayAR = displayW / displayH;
    const viewportAR = viewport.width / viewport.height;

    if (displayAR > viewportAR) {
      return {
        width: `${viewport.width}px`,
        height: `${viewport.width / displayAR}px`,
      };
    }

    return {
      width: `${viewport.height * displayAR}px`,
      height: `${viewport.height}px`,
    };
  }

  function createPlaceholder(isDebug = false) {
    const placeholder = document.createElement('div');
    placeholder.className = 'lightbox-media-placeholder';

    if (isDebug) {
      placeholder.style.backgroundColor = 'rgba(255, 192, 203, 0.3)';
      placeholder.style.zIndex = '10';
      placeholder.style.pointerEvents = 'none';
    } else {
      placeholder.style.backgroundColor = '#2a2a2a';
    }

    placeholder.style.width = '100%';
    placeholder.style.height = '100%';
    return placeholder;
  }

  function createFrame(photoId = null) {
    const frame = document.createElement('div');
    frame.className = 'lightbox-media-frame';
    if (photoId != null) {
      frame.dataset.photoId = String(photoId);
    }
    return frame;
  }

  function applyMediaStyles(
    frameEl,
    mediaEl,
    photo,
    rotationDegrees,
    getDimensions = defaultDimensions,
  ) {
    if (!frameEl) {
      return;
    }

    const normalized = normalizeRotationDegrees(rotationDegrees);
    const isTransposed = normalized === 90 || normalized === 270;
    const frameDims = calculateMediaDimensions(photo, normalized, getDimensions);

    frameEl.style.position = 'relative';
    frameEl.style.flexShrink = '0';
    frameEl.style.width = frameDims.width || '';
    frameEl.style.height = frameDims.height || '';
    frameEl.style.maxHeight = frameDims.maxHeight || '';
    frameEl.style.overflow = 'hidden';

    if (!mediaEl) {
      return;
    }

    mediaEl.style.position = 'absolute';
    mediaEl.style.top = '50%';
    mediaEl.style.left = '50%';
    mediaEl.style.objectFit = 'contain';
    mediaEl.style.maxWidth = 'none';
    mediaEl.style.maxHeight = 'none';

    if (isTransposed) {
      mediaEl.style.width = frameDims.height || '';
      mediaEl.style.height = frameDims.width || '';
    } else {
      mediaEl.style.width = '100%';
      mediaEl.style.height = '100%';
    }

    if (normalized) {
      mediaEl.style.transform = `translate(-50%, -50%) rotate(${-normalized}deg)`;
    } else {
      mediaEl.style.transform = 'translate(-50%, -50%)';
    }
    mediaEl.style.transformOrigin = 'center center';
  }

  function isVideoPhoto(photo) {
    return (
      photo?.file_type === 'video' ||
      Boolean(photo?.path?.match(/\.(mov|mp4|m4v|avi|mpg|mpeg)$/i))
    );
  }

  function resolveLoadOptions(photo, options = {}) {
    const {
      isVideo = isVideoPhoto(photo),
      rotationDegrees = 0,
      getMediaUrl,
      getDimensions = defaultDimensions,
      getAltText = (p) => p.original_filename || p.filename || 'Photo',
      onVisualState = null,
      getPreviewRotation = null,
      onImageError = null,
      onVideoError = null,
      mountVideoControls = null,
    } = options;

    const previewRotation = () =>
      typeof getPreviewRotation === 'function'
        ? getPreviewRotation(photo)
        : rotationDegrees;

    return {
      isVideo,
      rotationDegrees,
      getMediaUrl,
      getDimensions,
      getAltText,
      onVisualState,
      previewRotation,
      onImageError,
      onVideoError,
      mountVideoControls,
    };
  }

  function mountCachedImage(content, photo, frame, img, resolved) {
    img.className = 'lightbox-media-element';
    applyMediaStyles(
      frame,
      img,
      photo,
      resolved.previewRotation(),
      resolved.getDimensions,
    );
    img.alt = resolved.getAltText(photo);
    if (!img.parentNode) {
      frame.appendChild(img);
    }
    if (typeof resolved.onVisualState === 'function') {
      resolved.onVisualState(photo, img);
    }
    if (!content.contains(frame)) {
      content.appendChild(frame);
    }
  }

  function upgradeImageInPlace(content, photo, frame, currentImg, resolved) {
    if (typeof resolved.getMediaUrl !== 'function') {
      return;
    }

    const mediaUrl = resolved.getMediaUrl(photo);
    const cachedAtCurrentBucket = LightboxMediaCache.get(photo.id, mediaUrl);
    if (cachedAtCurrentBucket && !cachedAtCurrentBucket.needsUpgrade) {
      if (cachedAtCurrentBucket.img !== currentImg) {
        const upgradedImg = cachedAtCurrentBucket.img;
        upgradedImg.className = 'lightbox-media-element';
        applyMediaStyles(
          frame,
          upgradedImg,
          photo,
          resolved.previewRotation(),
          resolved.getDimensions,
        );
        upgradedImg.alt = resolved.getAltText(photo);
        frame.replaceChild(upgradedImg, currentImg);
        if (typeof resolved.onVisualState === 'function') {
          resolved.onVisualState(photo, upgradedImg);
        }
      }
      return;
    }

    const nextImg = new Image();
    nextImg.onload = () => {
      if (frame.dataset.photoId !== String(photo.id)) {
        return;
      }
      const liveFrame = content.querySelector(
        `.lightbox-media-frame[data-photo-id="${String(photo.id)}"]`,
      );
      const liveImg = liveFrame?.querySelector('img.lightbox-media-element');
      if (!liveFrame || !liveImg) {
        return;
      }

      LightboxMediaCache.put(photo.id, mediaUrl, nextImg);
      nextImg.className = 'lightbox-media-element';
      applyMediaStyles(
        liveFrame,
        nextImg,
        photo,
        resolved.previewRotation(),
        resolved.getDimensions,
      );
      nextImg.alt = resolved.getAltText(photo);
      liveFrame.replaceChild(nextImg, liveImg);
      if (typeof resolved.onVisualState === 'function') {
        resolved.onVisualState(photo, nextImg);
      }
    };
    nextImg.onerror = () => {
      if (typeof resolved.onImageError === 'function') {
        void resolved.onImageError(photo);
      }
    };
    nextImg.src = mediaUrl;
  }

  function loadCachedStill(content, photo, mediaUrl, resolved) {
    const cached = LightboxMediaCache.get(photo.id, mediaUrl);
    if (!cached?.img) {
      return false;
    }

    const frame = createFrame(photo.id);
    content.appendChild(frame);
    mountCachedImage(content, photo, frame, cached.img, resolved);

    if (cached.needsUpgrade) {
      upgradeImageInPlace(content, photo, frame, cached.img, resolved);
    }
    return true;
  }

  function loadStillImage(content, photo, mediaUrl, resolved) {
    if (loadCachedStill(content, photo, mediaUrl, resolved)) {
      return;
    }

    const frame = createFrame(photo.id);
    const placeholder = createPlaceholder();
    applyMediaStyles(
      frame,
      placeholder,
      photo,
      resolved.rotationDegrees,
      resolved.getDimensions,
    );
    frame.appendChild(placeholder);
    content.appendChild(frame);

    const img = new Image();
    let revealed = false;

    const dropPlaceholder = () => {
      if (placeholder.parentNode) {
        placeholder.parentNode.removeChild(placeholder);
      }
    };

    const revealImage = () => {
      if (revealed) {
        return;
      }
      revealed = true;

      LightboxMediaCache.put(photo.id, mediaUrl, img);
      img.className = 'lightbox-media-element';
      applyMediaStyles(
        frame,
        img,
        photo,
        resolved.previewRotation(),
        resolved.getDimensions,
      );
      img.alt = resolved.getAltText(photo);
      // Mount the image *over* the still-present placeholder, not in its
      // place. On a swipe to an un-prefetched photo the frame is already
      // sliding in (animateFrameEntry); if the decode spills past this
      // append, the frame keeps showing the gray box rather than the black
      // overlay behind it. The placeholder only comes out once the image
      // actually has pixels to paint — decode() resolving guarantees the
      // next frame is real (rAF is the fallback for no-decode() browsers
      // and the rare decode() rejection on interrupted nav).
      if (!img.parentNode) {
        frame.appendChild(img);
      }
      if (typeof img.decode === 'function') {
        img.decode().then(dropPlaceholder, dropPlaceholder);
      } else {
        requestAnimationFrame(dropPlaceholder);
      }
      if (typeof resolved.onVisualState === 'function') {
        resolved.onVisualState(photo, img);
      }
    };

    img.onload = revealImage;
    img.onerror = () => {
      if (typeof resolved.onImageError === 'function') {
        void resolved.onImageError(photo);
      }
    };

    img.src = mediaUrl;

    if (img.complete && img.naturalWidth > 0) {
      revealImage();
    }
  }

  function restyleMountedFrame(content, photo, options) {
    const frame = content.querySelector('.lightbox-media-frame');
    if (!frame) {
      return;
    }
    const resolved = resolveLoadOptions(photo, options);
    const rotation = resolved.previewRotation();
    const mediaEl = frame.querySelector('.lightbox-media-element');
    const placeholder = frame.querySelector('.lightbox-media-placeholder');
    applyMediaStyles(
      frame,
      mediaEl || placeholder,
      photo,
      rotation,
      resolved.getDimensions,
    );
    if (mediaEl && placeholder) {
      applyMediaStyles(frame, placeholder, photo, rotation, resolved.getDimensions);
    }
  }

  function relayoutCurrent() {
    if (!resizeUpgradeCtx?.isOpen?.()) {
      return;
    }
    const photo = resizeUpgradeCtx.getPhoto?.();
    const content = resizeUpgradeCtx.getContent?.();
    const options = resizeUpgradeCtx.getLoadOptions?.();
    if (!photo || !content || !options) {
      return;
    }
    restyleMountedFrame(content, photo, options);
  }

  let relayoutRaf = null;
  function scheduleRelayout() {
    if (relayoutRaf != null) {
      return;
    }
    relayoutRaf = requestAnimationFrame(() => {
      relayoutRaf = null;
      relayoutCurrent();
    });
  }

  function observeContentBox() {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    if (!contentResizeObserver) {
      contentResizeObserver = new ResizeObserver(() => {
        scheduleRelayout();
      });
    }
    const content = resizeUpgradeCtx?.getContent?.();
    if (!content || observedContent === content) {
      return;
    }
    if (observedContent) {
      contentResizeObserver.unobserve(observedContent);
    }
    observedContent = content;
    contentResizeObserver.observe(content);
  }

  function bindResizeUpgradeListener() {
    if (resizeListenerBound) {
      return;
    }
    resizeListenerBound = true;
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (!resizeUpgradeCtx?.isOpen?.()) {
        return;
      }
      scheduleRelayout();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        maybeUpgradeViewport();
      }, 200);
    });
  }

  function wireResizeUpgrade(ctx) {
    resizeUpgradeCtx = ctx;
    bindResizeUpgradeListener();
    observeContentBox();
  }

  function maybeUpgradeViewport() {
    if (!resizeUpgradeCtx?.isOpen?.()) {
      return;
    }
    const photo = resizeUpgradeCtx.getPhoto?.();
    const content = resizeUpgradeCtx.getContent?.();
    const options = resizeUpgradeCtx.getLoadOptions?.();
    if (!photo || !content || !options) {
      return;
    }
    if (typeof options.getMediaUrl !== 'function') {
      return;
    }
    const mediaUrl = options.getMediaUrl(photo);
    const cached = LightboxMediaCache.get(photo.id, mediaUrl);
    if (!cached?.needsUpgrade) {
      return;
    }
    const frame = content.querySelector(
      `.lightbox-media-frame[data-photo-id="${String(photo.id)}"]`,
    );
    const img = frame?.querySelector('img.lightbox-media-element');
    if (!frame || !img) {
      return;
    }
    const resolved = resolveLoadOptions(photo, options);
    upgradeImageInPlace(content, photo, frame, img, resolved);
  }

  function prepareContentSwap(content) {
    LightboxMediaCache.stashVisibleMedia(content);
  }

  function loadIntoContent(content, photo, options = {}) {
    if (!content || !photo) {
      return;
    }

    const resolved = resolveLoadOptions(photo, options);
    if (typeof resolved.getMediaUrl !== 'function') {
      return;
    }

    const mediaUrl = resolved.getMediaUrl(photo);

    if (resolved.isVideo) {
      const frame = createFrame(photo.id);
      const placeholder = createPlaceholder();
      const stage = document.createElement('div');
      stage.className = 'lightbox-video-stage';

      content.appendChild(frame);

      const video = document.createElement('video');
      video.className = 'lightbox-media-element';
      video.src = mediaUrl;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'auto';

      applyMediaStyles(
        frame,
        placeholder,
        photo,
        resolved.rotationDegrees,
        resolved.getDimensions,
      );
      applyMediaStyles(
        frame,
        video,
        photo,
        resolved.rotationDegrees,
        resolved.getDimensions,
      );
      video.style.backgroundColor = '#2a2a2a';

      stage.appendChild(placeholder);
      stage.appendChild(video);
      frame.appendChild(stage);

      if (typeof resolved.mountVideoControls === 'function') {
        resolved.mountVideoControls(stage, video);
      }

      animateFrameEntry(content, options.enterFrom);

      video.addEventListener('loadedmetadata', () => {
        if (typeof resolved.onVisualState === 'function') {
          resolved.onVisualState(photo, video, 0);
        }
        applyMediaStyles(
          frame,
          video,
          photo,
          resolved.previewRotation(),
          resolved.getDimensions,
        );
        if (typeof LightboxVideoControls !== 'undefined') {
          LightboxVideoControls.resetTransport?.();
        }
      });

      video.addEventListener('loadeddata', () => {
        if (placeholder.parentNode) {
          placeholder.parentNode.removeChild(placeholder);
        }
        if (typeof resolved.onVisualState === 'function') {
          resolved.onVisualState(photo, video, 0);
        }
        applyMediaStyles(
          frame,
          video,
          photo,
          resolved.previewRotation(),
          resolved.getDimensions,
        );
        video.style.backgroundColor = 'transparent';
      });

      video.addEventListener('error', () => {
        if (typeof resolved.onVideoError === 'function') {
          void resolved.onVideoError(photo);
        }
      });

      return;
    }

    loadStillImage(content, photo, mediaUrl, resolved);
    animateFrameEntry(content, options.enterFrom);
  }

  return {
    normalizeRotationDegrees,
    calculateMediaDimensions,
    createPlaceholder,
    createFrame,
    applyMediaStyles,
    isVideoPhoto,
    loadIntoContent,
    prepareContentSwap,
    wireResizeUpgrade,
    maybeUpgradeViewport,
    relayoutCurrent,
    animateFrameExit,
    transitionTimeoutMs,
  };
})();
