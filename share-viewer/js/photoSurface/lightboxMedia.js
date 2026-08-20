/**
 * Shared lightbox media loading — gray placeholder until fully ready, no partial decode.
 * Hosts supply URL/dimension adapters; rotation and error handling stay optional.
 */
const LightboxMedia = (() => {
  let resizeListenerBound = false;
  /** @type {{ isOpen: () => boolean, getPhoto: () => object|null, getContent: () => HTMLElement|null, getLoadOptions: () => object } | null} */
  let resizeUpgradeCtx = null;

  function normalizeRotationDegrees(degrees) {
    return ((degrees % 360) + 360) % 360;
  }

  function defaultDimensions(photo) {
    return {
      width: photo?.width || 0,
      height: photo?.height || 0,
    };
  }

  function calculateMediaDimensions(photo, rotationDegrees = 0, getDimensions = defaultDimensions) {
    const normalized = normalizeRotationDegrees(rotationDegrees);
    const isTransposed = normalized === 90 || normalized === 270;
    const base = getDimensions(photo) || {};
    const displayW = isTransposed ? base.height : base.width;
    const displayH = isTransposed ? base.width : base.height;

    if (!displayW || !displayH) {
      return {
        width: '100vw',
        height: '75vw',
        maxHeight: '100vh',
      };
    }

    const displayAR = displayW / displayH;
    const viewportAR = window.innerWidth / window.innerHeight;

    if (displayAR > viewportAR) {
      return {
        width: '100vw',
        height: `calc(100vw / ${displayAR})`,
      };
    }

    return {
      width: `calc(100vh * ${displayAR})`,
      height: '100vh',
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
      nativeVideoControls = false,
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
      nativeVideoControls,
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

    const revealImage = () => {
      if (placeholder.parentNode) {
        placeholder.parentNode.removeChild(placeholder);
      }

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
      if (!img.parentNode) {
        frame.appendChild(img);
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
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        maybeUpgradeViewport();
      }, 200);
    });
  }

  function wireResizeUpgrade(ctx) {
    resizeUpgradeCtx = ctx;
    bindResizeUpgradeListener();
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
      if (resolved.nativeVideoControls) {
        video.controls = true;
      }

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
  };
})();
