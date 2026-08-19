/**
 * Shared lightbox media loading — gray placeholder until fully ready, no partial decode.
 * Hosts supply URL/dimension adapters; rotation and error handling stay optional.
 */
const LightboxMedia = (() => {
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

  function createFrame() {
    const frame = document.createElement('div');
    frame.className = 'lightbox-media-frame';
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

  function loadIntoContent(content, photo, options = {}) {
    if (!content || !photo) {
      return;
    }

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

    if (typeof getMediaUrl !== 'function') {
      return;
    }

    const mediaUrl = getMediaUrl(photo);
    const previewRotation = () =>
      typeof getPreviewRotation === 'function'
        ? getPreviewRotation(photo)
        : rotationDegrees;

    if (isVideo) {
      const frame = createFrame();
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
      if (nativeVideoControls) {
        video.controls = true;
      }

      applyMediaStyles(frame, placeholder, photo, rotationDegrees, getDimensions);
      applyMediaStyles(frame, video, photo, rotationDegrees, getDimensions);
      video.style.backgroundColor = '#2a2a2a';

      stage.appendChild(placeholder);
      stage.appendChild(video);
      frame.appendChild(stage);

      if (typeof mountVideoControls === 'function') {
        mountVideoControls(stage, video);
      }

      video.addEventListener('loadedmetadata', () => {
        if (typeof onVisualState === 'function') {
          onVisualState(photo, video, 0);
        }
        applyMediaStyles(frame, video, photo, previewRotation(), getDimensions);
        if (typeof LightboxVideoControls !== 'undefined') {
          LightboxVideoControls.resetTransport?.();
        }
      });

      video.addEventListener('loadeddata', () => {
        if (placeholder.parentNode) {
          placeholder.parentNode.removeChild(placeholder);
        }
        if (typeof onVisualState === 'function') {
          onVisualState(photo, video, 0);
        }
        applyMediaStyles(frame, video, photo, previewRotation(), getDimensions);
        video.style.backgroundColor = 'transparent';
      });

      video.addEventListener('error', () => {
        if (typeof onVideoError === 'function') {
          void onVideoError(photo);
        }
      });

      return;
    }

    const img = new Image();
    img.src = mediaUrl;

    if (img.complete && img.naturalWidth > 0) {
      const frame = createFrame();
      if (typeof onVisualState === 'function') {
        onVisualState(photo, img);
      }
      img.className = 'lightbox-media-element';
      applyMediaStyles(frame, img, photo, previewRotation(), getDimensions);
      img.alt = getAltText(photo);
      frame.appendChild(img);
      content.appendChild(frame);
      return;
    }

    const frame = createFrame();
    const placeholder = createPlaceholder();
    applyMediaStyles(frame, placeholder, photo, rotationDegrees, getDimensions);
    frame.appendChild(placeholder);
    content.appendChild(frame);

    img.onload = () => {
      if (placeholder.parentNode) {
        placeholder.parentNode.removeChild(placeholder);
      }

      if (typeof onVisualState === 'function') {
        onVisualState(photo, img);
      }
      img.className = 'lightbox-media-element';
      applyMediaStyles(frame, img, photo, previewRotation(), getDimensions);
      img.alt = getAltText(photo);
      frame.appendChild(img);
    };

    img.onerror = () => {
      if (typeof onImageError === 'function') {
        void onImageError(photo);
      }
    };
  }

  return {
    normalizeRotationDegrees,
    calculateMediaDimensions,
    createPlaceholder,
    createFrame,
    applyMediaStyles,
    isVideoPhoto,
    loadIntoContent,
  };
})();
