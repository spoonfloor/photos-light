/**
 * Viewport-first thumbnail queue + session warm cache for the timeline grid.
 * Strict viewport sync is lifecycle-driven (grid mount/hydrate/scroll sync), not timer-based.
 */
const ThumbnailQueue = (() => {
  const MAX_CACHE_ENTRIES = 3000;
  const MAX_CONCURRENT = 8;
  const BUFFER_PX = 500;
  const OBSERVER_MARGIN_PX = 500;

  /** @type {Map<string, { url: string, lastUsed: number }>} */
  const cache = new Map();

  /** @type {{ getUrl: (photoId: number) => string, getVersion?: (photoId: number) => number|undefined } | null} */
  let config = null;

  /** @type {Map<number, { img: HTMLImageElement, tier: number, distance: number }>} */
  const pending = new Map();

  /** @type {Map<number, { img: HTMLImageElement }>} photoId → active load target */
  const inFlight = new Map();

  /** @type {IntersectionObserver | null} */
  let observer = null;

  /** @type {WeakSet<HTMLImageElement>} */
  const observed = new WeakSet();

  let pumpScheduled = false;

  const DEBUG_EVENT_LIMIT = 80;
  const debug = {
    started: 0,
    completed: 0,
    errors: 0,
    warmHits: 0,
    observed: 0,
    releasedStale: 0,
    events: [],
  };

  function recordEvent(name, detail = {}) {
    debug.events.push({
      t: Date.now(),
      name,
      ...detail,
    });
    if (debug.events.length > DEBUG_EVENT_LIMIT) {
      debug.events.shift();
    }
  }

  function elementRect(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      return rect;
    }
    const card = el.closest('.photo-card');
    return card ? card.getBoundingClientRect() : rect;
  }

  /** @returns {{ tier: number, distance: number } | null} tier 0 = strict viewport */
  function classifyImg(img) {
    if (!img?.isConnected) {
      return null;
    }
    const rect = elementRect(img);
    if (rect.width === 0 && rect.height === 0) {
      return null;
    }

    const viewportBottom = window.innerHeight;
    const inStrict = rect.bottom > 0 && rect.top < viewportBottom;
    const inBuffer =
      rect.bottom > -BUFFER_PX && rect.top < viewportBottom + BUFFER_PX;

    if (!inBuffer) {
      return null;
    }

    const imgCenter = rect.top + rect.height / 2;
    const viewportCenter = viewportBottom / 2;
    return {
      tier: inStrict ? 0 : 1,
      distance: Math.abs(imgCenter - viewportCenter),
    };
  }

  function countViewportThumbs() {
    const container = document.getElementById('photoContainer');
    if (!container) {
      return {
        strictWithoutSrc: 0,
        strictWithSrc: 0,
        strictZeroLayout: 0,
        bufferWithoutSrc: 0,
        totalWithoutSrc: 0,
      };
    }

    let strictWithoutSrc = 0;
    let strictWithSrc = 0;
    let strictZeroLayout = 0;
    let bufferWithoutSrc = 0;
    let totalWithoutSrc = 0;

    container.querySelectorAll('.photo-thumb').forEach((img) => {
      const hasSrc = Boolean(img.getAttribute('src'));
      if (!hasSrc) {
        totalWithoutSrc += 1;
      }
      const ranked = classifyImg(img);
      if (!ranked) {
        if (!hasSrc) {
          const rect = elementRect(img);
          if (
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.width === 0 &&
            rect.height === 0
          ) {
            strictZeroLayout += 1;
          }
        }
        return;
      }
      if (ranked.tier === 0) {
        if (hasSrc) {
          strictWithSrc += 1;
        } else {
          strictWithoutSrc += 1;
        }
      } else if (!hasSrc) {
        bufferWithoutSrc += 1;
      }
    });

    return {
      strictWithoutSrc,
      strictWithSrc,
      strictZeroLayout,
      bufferWithoutSrc,
      totalWithoutSrc,
    };
  }

  function pendingBreakdown() {
    const tiers = { tier0: 0, tier1: 0 };
    for (const item of pending.values()) {
      if (item.tier === 0) {
        tiers.tier0 += 1;
      } else {
        tiers.tier1 += 1;
      }
    }
    return tiers;
  }

  function checkInvariants() {
    const viewport = countViewportThumbs();
    const violations = [];

    if (
      viewport.strictWithoutSrc > 0 &&
      pending.size === 0 &&
      inFlight.size === 0
    ) {
      violations.push({
        code: 'strict_visible_unqueued',
        message: 'Strict viewport has imgs without src but queue is idle',
        strictWithoutSrc: viewport.strictWithoutSrc,
      });
    }

    if (viewport.strictZeroLayout > 0) {
      violations.push({
        code: 'strict_zero_layout',
        message: 'Strict viewport imgs have zero layout (classify skipped)',
        count: viewport.strictZeroLayout,
      });
    }

    for (const [photoId, entry] of inFlight) {
      if (!entry.img.isConnected) {
        violations.push({
          code: 'inflight_disconnected',
          message: 'inFlight entry references disconnected img',
          photoId,
        });
      }
    }

    for (const [photoId, item] of pending) {
      if (!item.img.isConnected) {
        violations.push({
          code: 'pending_disconnected',
          message: 'pending entry references disconnected img',
          photoId,
        });
      }
    }

    return violations;
  }

  function getDebugSnapshot() {
    const viewport = countViewportThumbs();
    const violations = checkInvariants();
    return {
      pending: pending.size,
      inFlight: inFlight.size,
      inFlightIds: [...inFlight.keys()],
      pendingTiers: pendingBreakdown(),
      warmCacheSize: cache.size,
      maxConcurrent: MAX_CONCURRENT,
      viewport,
      stats: {
        started: debug.started,
        completed: debug.completed,
        errors: debug.errors,
        warmHits: debug.warmHits,
        observed: debug.observed,
        releasedStale: debug.releasedStale,
      },
      violations,
      lastEvents: debug.events.slice(-20),
      ok: violations.length === 0 && viewport.strictWithoutSrc === 0,
    };
  }

  function publishDebugState() {
    if (typeof window === 'undefined') {
      return getDebugSnapshot();
    }
    const snapshot = getDebugSnapshot();
    window.__thumbQueue = snapshot;
    return snapshot;
  }

  function cacheKey(photoId, version) {
    return version ? `${photoId}:${version}` : String(photoId);
  }

  function touchEntry(key, entry) {
    entry.lastUsed = Date.now();
    cache.delete(key);
    cache.set(key, entry);
  }

  function evictIfNeeded() {
    while (cache.size > MAX_CACHE_ENTRIES) {
      cache.delete(cache.keys().next().value);
    }
  }

  function markCardLoaded(img) {
    const photoCard = img.closest('.photo-card');
    if (!photoCard || photoCard.querySelector('.select-circle')) {
      return;
    }
    const circle = document.createElement('div');
    circle.className = 'select-circle';
    photoCard.insertBefore(circle, photoCard.firstChild);
    photoCard.classList.add('loaded');
  }

  function rememberUrl(photoId, url) {
    const version = config?.getVersion?.(photoId);
    const key = cacheKey(photoId, version);
    cache.set(key, { url, lastUsed: Date.now() });
    evictIfNeeded();
  }

  function getWarmUrl(photoId) {
    if (!config) {
      return null;
    }
    const version = config.getVersion?.(photoId);
    const key = cacheKey(photoId, version);
    const hit = cache.get(key);
    if (!hit?.url) {
      return null;
    }
    touchEntry(key, hit);
    return hit.url;
  }

  function releaseStaleEntries() {
    for (const [photoId, entry] of inFlight) {
      if (!entry.img.isConnected) {
        inFlight.delete(photoId);
        debug.releasedStale += 1;
        recordEvent('inflight_released', { photoId, reason: 'disconnected' });
      }
    }
    for (const [photoId, item] of pending) {
      if (!item.img.isConnected || item.img.getAttribute('src')) {
        pending.delete(photoId);
        debug.releasedStale += 1;
        recordEvent('pending_released', { photoId });
      }
    }
  }

  function applyWarmToImg(img) {
    const photoId = Number(img.dataset.photoId);
    if (!photoId || img.getAttribute('src')) {
      return true;
    }
    const url = getWarmUrl(photoId);
    if (!url) {
      return false;
    }
    pending.delete(photoId);
    const active = inFlight.get(photoId);
    if (active && active.img !== img && !active.img.isConnected) {
      inFlight.delete(photoId);
    }
    img.classList.add('loading');
    img.onload = () => {
      img.classList.remove('loading', 'error');
      markCardLoaded(img);
    };
    img.onerror = () => {
      img.classList.remove('loading');
      img.classList.add('error');
    };
    img.src = url;
    debug.warmHits += 1;
    recordEvent('warm_hit', { photoId });
    publishDebugState();
    return true;
  }

  function schedulePump() {
    if (pumpScheduled) {
      return;
    }
    pumpScheduled = true;
    window.requestAnimationFrame(() => {
      pumpScheduled = false;
      pump();
    });
  }

  function finishLoad(photoId, img, failed) {
    const active = inFlight.get(photoId);
    if (!active || active.img !== img) {
      recordEvent('load_stale_callback', { photoId, connected: img.isConnected });
      return;
    }
    inFlight.delete(photoId);
    if (failed) {
      debug.errors += 1;
      recordEvent('load_error', { photoId, connected: img.isConnected });
    } else {
      debug.completed += 1;
      recordEvent('load_done', { photoId, connected: img.isConnected });
    }
    if (img.isConnected) {
      img.classList.remove('loading');
      if (failed) {
        img.classList.add('error');
      } else {
        img.classList.remove('error');
        markCardLoaded(img);
      }
    }
    publishDebugState();
    schedulePump();
  }

  function startLoad(photoId, img) {
    if (!config || !img.isConnected || img.getAttribute('src')) {
      pending.delete(photoId);
      return;
    }
    if (applyWarmToImg(img)) {
      return;
    }

    const active = inFlight.get(photoId);
    if (active) {
      if (active.img === img) {
        return;
      }
      if (active.img.isConnected) {
        return;
      }
      inFlight.delete(photoId);
      recordEvent('inflight_replaced', { photoId });
    }

    pending.delete(photoId);
    inFlight.set(photoId, { img });
    debug.started += 1;
    recordEvent('load_start', { photoId });

    const url = config.getUrl(photoId);
    img.classList.add('loading');
    img.onload = () => {
      rememberUrl(photoId, url);
      finishLoad(photoId, img, false);
    };
    img.onerror = () => {
      finishLoad(photoId, img, true);
    };
    img.src = url;
    publishDebugState();
  }

  function pump() {
    releaseStaleEntries();

    if (!config) {
      recordEvent('pump_skip', { reason: 'no_config' });
      publishDebugState();
      return;
    }

    if (inFlight.size >= MAX_CONCURRENT) {
      recordEvent('pump_skip', {
        reason: 'at_capacity',
        inFlight: inFlight.size,
        pending: pending.size,
      });
      publishDebugState();
      return;
    }

    const candidates = [...pending.entries()].sort((a, b) => {
      const tierDiff = a[1].tier - b[1].tier;
      if (tierDiff !== 0) {
        return tierDiff;
      }
      return a[1].distance - b[1].distance;
    });

    let started = 0;
    for (const [photoId, item] of candidates) {
      if (inFlight.size >= MAX_CONCURRENT) {
        break;
      }
      startLoad(photoId, item.img);
      started += 1;
    }

    recordEvent('pump', { started, pending: pending.size, inFlight: inFlight.size });
    publishDebugState();

    if (pending.size > 0 && inFlight.size < MAX_CONCURRENT) {
      schedulePump();
    }
  }

  function enqueueImg(img, classification = null) {
    const photoId = Number(img?.dataset?.photoId);
    if (!photoId || !config || img.getAttribute('src')) {
      return;
    }
    if (applyWarmToImg(img)) {
      return;
    }

    const ranked = classification || classifyImg(img);
    if (!ranked) {
      observeForLater(img);
      return;
    }

    const existing = pending.get(photoId);
    if (
      !existing ||
      existing.img !== img ||
      ranked.tier < existing.tier ||
      (ranked.tier === existing.tier && ranked.distance < existing.distance)
    ) {
      pending.set(photoId, { img, tier: ranked.tier, distance: ranked.distance });
    }
    recordEvent('enqueue', { photoId, tier: ranked.tier, distance: ranked.distance });
    schedulePump();
    publishDebugState();
  }

  function ensureObserver() {
    if (observer) {
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }
          const img = entry.target;
          observer?.unobserve(img);
          enqueueImg(img);
        });
      },
      { rootMargin: `${OBSERVER_MARGIN_PX}px` },
    );
  }

  function observeForLater(img) {
    if (!img?.dataset?.photoId || img.getAttribute('src') || observed.has(img)) {
      return;
    }
    ensureObserver();
    observed.add(img);
    debug.observed += 1;
    recordEvent('enqueue_observe', { photoId: Number(img.dataset.photoId) });
    observer?.observe(img);
  }

  function registerThumbs(thumbs, { maxTier = 1 } = {}) {
    let enqueued = 0;
    let deferred = 0;
    for (const img of thumbs) {
      if (img.getAttribute('src')) {
        continue;
      }
      const ranked = classifyImg(img);
      if (!ranked || ranked.tier > maxTier) {
        observeForLater(img);
        deferred += 1;
        continue;
      }
      enqueueImg(img, ranked);
      enqueued += 1;
    }
    return { enqueued, deferred };
  }

  /** After grid DOM is in layout — enqueue strict + buffer for this grid. */
  function syncGrid(grid) {
    if (!grid || !config) {
      return null;
    }
    releaseStaleEntries();
    const month = grid.closest('[data-month]')?.dataset?.month || null;
    const thumbs = grid.querySelectorAll('.photo-thumb:not([src])');
    const result = registerThumbs(thumbs);
    recordEvent('sync_grid', { month, ...result, count: thumbs.length });
    publishDebugState();
    return result;
  }

  /** Sync all strict-viewport thumbs across mounted grids (scroll / handoff hook). */
  function syncStrictViewport() {
    if (!config) {
      return null;
    }
    releaseStaleEntries();
    const container = document.getElementById('photoContainer');
    if (!container) {
      return null;
    }
    const thumbs = container.querySelectorAll('.photo-thumb:not([src])');
    const result = registerThumbs(thumbs, { maxTier: 0 });
    recordEvent('sync_strict_viewport', { scanned: thumbs.length, ...result });
    publishDebugState();
    return result;
  }

  /** Layout-ready: wait for paint then sync grid + strict viewport. */
  function syncGridAfterLayout(grid) {
    if (!grid) {
      return;
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        syncGrid(grid);
        syncStrictViewport();
      });
    });
  }

  function configure(nextConfig) {
    config = nextConfig;
  }

  function scheduleScan(root = document) {
    if (!config) {
      return;
    }
    const grids = root.querySelectorAll?.('.photo-grid') || [];
    if (grids.length > 0) {
      grids.forEach((grid) => syncGridAfterLayout(grid));
      return;
    }
    syncStrictViewport();
  }

  function observeElements(elements) {
    if (!elements) {
      return;
    }
    for (const img of elements) {
      enqueueImg(img);
    }
  }

  function invalidate(photoId) {
    const prefix = `${photoId}:`;
    const exact = String(photoId);
    for (const key of [...cache.keys()]) {
      if (key === exact || key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
    pending.delete(photoId);
    inFlight.delete(photoId);
  }

  function clear() {
    cache.clear();
    pending.clear();
    inFlight.clear();
    observer?.disconnect();
    observer = null;
    debug.started = 0;
    debug.completed = 0;
    debug.errors = 0;
    debug.warmHits = 0;
    debug.observed = 0;
    debug.releasedStale = 0;
    debug.events = [];
    recordEvent('clear');
    publishDebugState();
  }

  function hasWarm(photoId) {
    return Boolean(getWarmUrl(photoId));
  }

  function refreshImg(img) {
    const photoId = Number(img.dataset.photoId);
    if (!photoId) {
      return;
    }
    invalidate(photoId);
    img.removeAttribute('src');
    img.classList.remove('loading', 'error');
    enqueueImg(img);
  }

  return {
    configure,
    syncGrid,
    syncStrictViewport,
    syncGridAfterLayout,
    prioritizeGrid: syncGrid,
    prioritizeStrictViewport: syncStrictViewport,
    scheduleScan,
    observeElements,
    applyToElements: observeElements,
    invalidate,
    refreshImg,
    clear,
    hasWarm,
    getDebugSnapshot,
    publishDebugState,
  };
})();
