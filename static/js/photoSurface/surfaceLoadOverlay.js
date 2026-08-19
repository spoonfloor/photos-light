/**
 * Shared bottom-left load overlay (library open, share resolve, etc.).
 */
const SurfaceLoadOverlay = (() => {
  function show({
    overlay = document.getElementById('shareLoadOverlay'),
    titleEl = document.getElementById('shareLoadTitle'),
    statusEl = document.getElementById('shareLoadStatusLabel'),
    title = 'Loading share',
    message = 'Loading your media.',
  } = {}) {
    if (!overlay) {
      return false;
    }
    if (titleEl) {
      titleEl.textContent = title;
    }
    if (statusEl) {
      statusEl.textContent = message;
    }
    overlay.style.display = 'flex';
    return true;
  }

  function hide({
    overlay = document.getElementById('shareLoadOverlay'),
  } = {}) {
    if (!overlay) {
      return;
    }
    overlay.style.display = 'none';
  }

  function flushDomPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  }

  return {
    show,
    hide,
    flushDomPaint,
  };
})();
