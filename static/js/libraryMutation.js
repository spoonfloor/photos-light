/**
 * Library write sync — intent-first settlement for row mutations.
 *
 * v1: star toggle via per-photo intent slots + capped write drain.
 * Future: date/bulk plug into enqueueGenericJob or extend slots.
 */
const LibraryMutation = (() => {
  /** @type {Map<number, { confirmedRating: number|null, targetRating: number|null|undefined, inFlight: boolean, generation: number, inFlightGeneration: number|null }>} */
  const photoWriteSlots = new Map();
  /** @type {number[]} */
  const pendingPhotoIds = [];
  const queuedPhotoIds = new Set();
  /** @type {Array<{ options: object, resolve: Function, reject: Function }>} */
  const genericQueue = [];
  /** @type {Set<number>} */
  const activeStarWrites = new Set();

  let drainScheduled = false;
  let genericInFlight = false;
  let pendingCount = 0;
  let histogramSyncTimer = null;
  let hooks = {};

  const HISTOGRAM_SYNC_MS = 300;
  const MAX_CONCURRENT_STAR_WRITES = 4;

  function init(nextHooks) {
    hooks = nextHooks || {};
  }

  function normalizeRating(rating) {
    return rating === 5 ? 5 : null;
  }

  function ratingToApiValue(rating) {
    return rating === 5 ? 5 : 0;
  }

  function isStarred(rating) {
    return normalizeRating(rating) === 5;
  }

  function effectiveTarget(slot) {
    return slot.targetRating !== undefined
      ? slot.targetRating
      : slot.confirmedRating;
  }

  function ratingsMatch(a, b) {
    return normalizeRating(a) === normalizeRating(b);
  }

  function confirmedRatingForPhoto(photoId) {
    const slot = photoWriteSlots.get(photoId);
    if (slot) {
      return slot.confirmedRating;
    }
    const photo = hooks.getPhoto?.(photoId);
    return normalizeRating(photo?.rating);
  }

  function getOrCreateSlot(photoId) {
    let slot = photoWriteSlots.get(photoId);
    if (slot) {
      return slot;
    }
    slot = {
      confirmedRating: confirmedRatingForPhoto(photoId),
      targetRating: undefined,
      inFlight: false,
      generation: 0,
      inFlightGeneration: null,
    };
    photoWriteSlots.set(photoId, slot);
    return slot;
  }

  function applyStarUi(photoId, rating) {
    hooks.applyStarUi?.(photoId, isStarred(rating));
    hooks.patchPhotoRating?.(photoId, rating === 5 ? 5 : null);
  }

  function hasPendingStarIntent() {
    for (const slot of photoWriteSlots.values()) {
      if (
        slot.inFlight ||
        (slot.targetRating !== undefined &&
          !ratingsMatch(slot.targetRating, slot.confirmedRating))
      ) {
        return true;
      }
    }
    return false;
  }

  function reapplyPendingStarUi() {
    for (const [photoId, slot] of photoWriteSlots.entries()) {
      if (
        slot.inFlight ||
        (slot.targetRating !== undefined &&
          !ratingsMatch(slot.targetRating, slot.confirmedRating))
      ) {
        applyStarUi(photoId, effectiveTarget(slot));
      }
    }
  }

  function scheduleHistogramSync() {
    if (histogramSyncTimer) {
      clearTimeout(histogramSyncTimer);
    }
    histogramSyncTimer = setTimeout(() => {
      histogramSyncTimer = null;
      if (hasPendingStarIntent()) {
        scheduleHistogramSync();
        return;
      }
      void (async () => {
        if (hooks.hasStarredPhotoFilter?.()) {
          hooks.applyPhotoFilters?.();
        } else {
          hooks.updateFilterChipUI?.();
        }
        reapplyPendingStarUi();
      })();
    }, HISTOGRAM_SYNC_MS);
  }

  function updatePendingCount() {
    const nextCount =
      genericQueue.length + queuedPhotoIds.size + (genericInFlight ? 1 : 0);
    if (nextCount === pendingCount) {
      return;
    }
    pendingCount = nextCount;
    hooks.onPendingCountChange?.(pendingCount);
  }

  function enqueuePhotoId(photoId) {
    if (!queuedPhotoIds.has(photoId)) {
      queuedPhotoIds.add(photoId);
      pendingPhotoIds.push(photoId);
    }
    updatePendingCount();
    scheduleDrain();
  }

  function removePhotoFromQueue(photoId) {
    queuedPhotoIds.delete(photoId);
    const index = pendingPhotoIds.indexOf(photoId);
    if (index !== -1) {
      pendingPhotoIds.splice(index, 1);
    }
    updatePendingCount();
  }

  function togglePhotoStar(photoId) {
    if (!photoId) {
      return;
    }
    const slot = getOrCreateSlot(photoId);
    const current = effectiveTarget(slot);
    slot.targetRating = isStarred(current) ? null : 5;
    slot.generation += 1;
    applyStarUi(photoId, slot.targetRating);
    enqueuePhotoId(photoId);
  }

  function isLightboxStarFilled(photoId) {
    const slot = photoWriteSlots.get(photoId);
    if (slot) {
      return isStarred(effectiveTarget(slot));
    }
    return isStarred(confirmedRatingForPhoto(photoId));
  }

  function enqueueGenericJob(options) {
    return new Promise((resolve, reject) => {
      genericQueue.push({ options, resolve, reject });
      updatePendingCount();
      scheduleDrain();
    });
  }

  async function settlePhotoStar(photoId) {
    const slot = photoWriteSlots.get(photoId);
    if (!slot || slot.inFlight) {
      return;
    }

    const attemptTarget = effectiveTarget(slot);
    if (ratingsMatch(slot.confirmedRating, attemptTarget)) {
      slot.targetRating = undefined;
      removePhotoFromQueue(photoId);
      return;
    }

    slot.inFlight = true;
    slot.inFlightGeneration = slot.generation;
    updatePendingCount();

    const attemptGeneration = slot.inFlightGeneration;

    try {
      const response = await fetch(`/api/photo/${photoId}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: ratingToApiValue(attemptTarget) }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result.error || `Failed to update star: ${response.status}`,
        );
      }
      await handleStarSuccess(photoId, slot, result, attemptGeneration);
    } catch (error) {
      handleStarFailure(photoId, slot, error, attemptGeneration);
    } finally {
      slot.inFlight = false;
      slot.inFlightGeneration = null;
      updatePendingCount();
    }
  }

  async function handleStarSuccess(photoId, slot, result, attemptGeneration) {
    if (result.duplicate_removed) {
      slot.confirmedRating = null;
      slot.targetRating = undefined;
      removePhotoFromQueue(photoId);
      await hooks.onStarDuplicateRemoved?.(photoId, result);
      scheduleHistogramSync();
      return;
    }

    slot.confirmedRating = normalizeRating(result.rating);

    if (result.photo) {
      hooks.applyCommittedPhotoUpdate?.(result.photo, {
        skipMediaRefresh: true,
      });
    }

    const stillWanted = effectiveTarget(slot);
    const isSettled =
      slot.generation === attemptGeneration &&
      ratingsMatch(slot.confirmedRating, stillWanted);

    applyStarUi(photoId, stillWanted);

    if (!isSettled) {
      enqueuePhotoId(photoId);
      return;
    }

    slot.targetRating = undefined;
    removePhotoFromQueue(photoId);
    scheduleHistogramSync();
  }

  function handleStarFailure(photoId, slot, error, attemptGeneration) {
    if (slot.generation !== attemptGeneration) {
      enqueuePhotoId(photoId);
      return;
    }

    slot.targetRating = undefined;
    applyStarUi(photoId, slot.confirmedRating);
    removePhotoFromQueue(photoId);
    hooks.showToast?.(error.message || 'Failed to update star', null);
  }

  async function runGenericJob(job) {
    const { options } = job;
    try {
      options.applyOptimistic?.();
      const result = await options.execute();
      if (!result.ok) {
        throw new Error(result.error || 'Mutation failed');
      }
      if (options.onSuccess) {
        await options.onSuccess(result);
      }
      job.resolve(result);
    } catch (error) {
      options.revertOptimistic?.();
      hooks.showToast?.(
        options.failureToast || error.message || 'Operation failed',
        null,
      );
      if (options.onFailure) {
        options.onFailure(error);
      }
      job.reject(error);
    }
  }

  function scheduleDrain() {
    if (drainScheduled) {
      return;
    }
    drainScheduled = true;
    Promise.resolve().then(() => {
      drainScheduled = false;
      pumpDrain();
    });
  }

  function pumpDrain() {
    startStarSettlements();

    if (
      pendingPhotoIds.length === 0 &&
      activeStarWrites.size === 0 &&
      genericQueue.length > 0 &&
      !genericInFlight
    ) {
      startGenericSettlement(genericQueue.shift());
    }
  }

  function startStarSettlements() {
    for (
      let index = 0;
      index < pendingPhotoIds.length &&
      activeStarWrites.size < MAX_CONCURRENT_STAR_WRITES;
      index += 1
    ) {
      const photoId = pendingPhotoIds[index];
      const slot = photoWriteSlots.get(photoId);

      if (!slot) {
        removePhotoFromQueue(photoId);
        index -= 1;
        continue;
      }

      if (slot.inFlight) {
        continue;
      }

      const target = effectiveTarget(slot);
      if (ratingsMatch(slot.confirmedRating, target)) {
        slot.targetRating = undefined;
        removePhotoFromQueue(photoId);
        index -= 1;
        continue;
      }

      startStarSettlement(photoId);
    }
  }

  function startStarSettlement(photoId) {
    activeStarWrites.add(photoId);
    updatePendingCount();
    void settlePhotoStar(photoId).finally(() => {
      activeStarWrites.delete(photoId);
      const slot = photoWriteSlots.get(photoId);
      if (
        slot &&
        !slot.inFlight &&
        ratingsMatch(slot.confirmedRating, effectiveTarget(slot))
      ) {
        slot.targetRating = undefined;
        removePhotoFromQueue(photoId);
      }
      updatePendingCount();
      scheduleDrain();
    });
  }

  function startGenericSettlement(job) {
    if (!job) {
      return;
    }
    genericInFlight = true;
    updatePendingCount();
    void runGenericJob(job).finally(() => {
      genericInFlight = false;
      updatePendingCount();
      scheduleDrain();
    });
  }

  return {
    init,
    togglePhotoStar,
    enqueueGenericJob,
    isLightboxStarFilled,
    getPendingCount: () => pendingCount,
  };
})();
