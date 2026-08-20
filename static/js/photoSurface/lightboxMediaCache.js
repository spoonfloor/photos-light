/**
 * Session LRU cache for lightbox display-tier images, keyed by photo + URL + viewport bucket.
 * Keeps decoded images alive off-DOM so revisit navigation skips the gray placeholder.
 */
const LightboxMediaCache = (() => {
  const MAX_ENTRIES = 30;
  const PREFETCH_RADIUS = 4;
  const BUCKET_SIZES = [1080, 1440, 2160, 3840];
  const BUCKET_SLACK = 1.25;

  /** @type {Map<string, { photoId: string, url: string, bucket: number, img: HTMLImageElement, lastUsed: number }>} */
  const cache = new Map();

  /** @type {Map<string, Promise<void>>} */
  const inFlight = new Map();

  function cacheKey(photoId, url, bucket) {
    return `${String(photoId)}:${bucket}:${url}`;
  }

  function viewportPixelMax() {
    const dpr = window.devicePixelRatio || 1;
    return Math.max(window.innerWidth, window.innerHeight) * dpr;
  }

  function getViewportBucket() {
    const target = viewportPixelMax() * BUCKET_SLACK;
    for (const bucket of BUCKET_SIZES) {
      if (bucket >= target) {
        return bucket;
      }
    }
    return BUCKET_SIZES[BUCKET_SIZES.length - 1];
  }

  function touch(key, entry) {
    entry.lastUsed = Date.now();
    cache.delete(key);
    cache.set(key, entry);
  }

  function evictIfNeeded() {
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function findEntry(photoId, url) {
    const id = String(photoId);
    const currentBucket = getViewportBucket();
    let best = null;

    for (const [key, entry] of cache) {
      if (entry.photoId !== id || entry.url !== url) {
        continue;
      }
      if (entry.bucket === currentBucket) {
        touch(key, entry);
        return { entry, needsUpgrade: false };
      }
      if (!best || entry.bucket > best.entry.bucket) {
        best = { key, entry };
      }
    }

    if (!best) {
      return null;
    }

    touch(best.key, best.entry);
    return {
      entry: best.entry,
      needsUpgrade: best.entry.bucket < currentBucket,
    };
  }

  function get(photoId, url) {
    if (photoId == null || !url) {
      return null;
    }
    const hit = findEntry(photoId, url);
    if (!hit?.entry?.img) {
      return null;
    }
    return {
      img: hit.entry.img,
      bucket: hit.entry.bucket,
      needsUpgrade: hit.needsUpgrade,
    };
  }

  function put(photoId, url, img) {
    if (photoId == null || !url || !img) {
      return;
    }
    const bucket = getViewportBucket();
    const key = cacheKey(photoId, url, bucket);
    cache.set(key, {
      photoId: String(photoId),
      url,
      bucket,
      img,
      lastUsed: Date.now(),
    });
    evictIfNeeded();
  }

  function detachForCache(img) {
    if (img?.parentNode) {
      img.parentNode.removeChild(img);
    }
    return img;
  }

  function stashVisibleMedia(content) {
    if (!content) {
      return;
    }
    const frame = content.querySelector('.lightbox-media-frame[data-photo-id]');
    const img = frame?.querySelector('img.lightbox-media-element');
    if (!frame || !img?.src) {
      return;
    }
    put(frame.dataset.photoId, img.src, detachForCache(img));
  }

  function prefetch(photoId, url) {
    if (photoId == null || !url) {
      return Promise.resolve();
    }
    if (get(photoId, url)) {
      return Promise.resolve();
    }

    const flightKey = `${String(photoId)}:${url}`;
    const existing = inFlight.get(flightKey);
    if (existing) {
      return existing;
    }

    const promise = new Promise((resolve) => {
      const img = new Image();
      const finish = () => {
        inFlight.delete(flightKey);
        resolve();
      };
      img.onload = () => {
        put(photoId, url, img);
        finish();
      };
      img.onerror = finish;
      img.src = url;
    });

    inFlight.set(flightKey, promise);
    return promise;
  }

  function prefetchAdjacent(photos, currentIndex, getUrl, radius = PREFETCH_RADIUS) {
    if (!Array.isArray(photos) || typeof getUrl !== 'function') {
      return;
    }
    for (let delta = -radius; delta <= radius; delta += 1) {
      if (delta === 0) {
        continue;
      }
      const index = currentIndex + delta;
      if (index < 0 || index >= photos.length) {
        continue;
      }
      const photo = photos[index];
      if (!photo) {
        continue;
      }
      const url = getUrl(photo);
      if (url) {
        void prefetch(photo.id, url);
      }
    }
  }

  function invalidatePhoto(photoId) {
    const id = String(photoId);
    for (const [key, entry] of cache) {
      if (entry.photoId === id) {
        cache.delete(key);
      }
    }
    for (const key of [...inFlight.keys()]) {
      if (key.startsWith(`${id}:`)) {
        inFlight.delete(key);
      }
    }
  }

  function clear() {
    cache.clear();
    inFlight.clear();
  }

  return {
    getViewportBucket,
    get,
    put,
    stashVisibleMedia,
    prefetch,
    prefetchAdjacent,
    invalidatePhoto,
    clear,
    detachForCache,
    PREFETCH_RADIUS,
  };
})();
