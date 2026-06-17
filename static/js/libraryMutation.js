/**
 * Library write sync — intent-first settlement for row mutations.
 *
 * Star: per-photo intent slots + capped write drain.
 * Date / rotate: per-photo mutation slots + date SSE jobs.
 * Generic queue: delete, restore, and other batch flows (optimism at enqueue).
 */
const LibraryMutation = (() => {
  /** @type {Map<number, { confirmedRating: number|null, targetRating: number|null|undefined, inFlight: boolean, generation: number, inFlightGeneration: number|null }>} */
  const photoWriteSlots = new Map();
  /** @type {number[]} */
  const pendingPhotoIds = [];
  const queuedPhotoIds = new Set();

  /** @type {Map<number, object>} */
  const photoMutationSlots = new Map();
  /** @type {number[]} */
  const pendingMutationPhotoIds = [];
  const queuedMutationPhotoIds = new Set();
  /** @type {Set<number>} */
  const activeMutationWrites = new Set();

  /** @type {Array<object>} */
  const pendingDateJobs = [];
  /** @type {object|null} */
  let activeDateJob = null;

  /** @type {Map<number, { resolve: Function, reject: Function, waiters: Set<number> }>} */
  const photoMutationPromises = new Map();

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
  const MAX_CONCURRENT_MUTATION_WRITES = 4;

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

  function normalizeRotationDegrees(degrees) {
    const normalized = ((degrees % 360) + 360) % 360;
    return normalized;
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
    const favorited = isStarred(rating);
    hooks.patchPhotoRating?.(photoId, favorited ? 5 : null);
    hooks.applyStarUi?.(photoId, favorited);
    hooks.applyStarFilterRowChange?.(photoId);
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
        hooks.updateFilterChipUI?.();
        reapplyPendingStarUi();
      })();
    }, HISTOGRAM_SYNC_MS);
  }

  function countPendingWork() {
    return (
      genericQueue.length +
      (genericInFlight ? 1 : 0) +
      queuedPhotoIds.size +
      queuedMutationPhotoIds.size +
      activeMutationWrites.size +
      pendingDateJobs.length +
      (activeDateJob ? 1 : 0)
    );
  }

  function updatePendingCount() {
    const nextCount = countPendingWork();
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

  function enqueueMutationPhotoId(photoId) {
    if (!queuedMutationPhotoIds.has(photoId)) {
      queuedMutationPhotoIds.add(photoId);
      pendingMutationPhotoIds.push(photoId);
    }
    updatePendingCount();
    scheduleDrain();
  }

  function removeMutationPhotoFromQueue(photoId) {
    queuedMutationPhotoIds.delete(photoId);
    const index = pendingMutationPhotoIds.indexOf(photoId);
    if (index !== -1) {
      pendingMutationPhotoIds.splice(index, 1);
    }
    updatePendingCount();
  }

  function trackPhotoMutationPromise(photoId) {
    let entry = photoMutationPromises.get(photoId);
    if (!entry) {
      entry = {
        waiters: new Set(),
        resolve: null,
        reject: null,
        promise: null,
      };
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      photoMutationPromises.set(photoId, entry);
    }
    return entry.promise;
  }

  function settlePhotoMutationPromise(photoId, error = null) {
    const entry = photoMutationPromises.get(photoId);
    if (!entry) {
      return;
    }
    photoMutationPromises.delete(photoId);
    if (error) {
      entry.reject(error);
    } else {
      entry.resolve(true);
    }
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
    options.applyOptimistic?.();
    return new Promise((resolve, reject) => {
      genericQueue.push({ options, resolve, reject });
      updatePendingCount();
      scheduleDrain();
    });
  }

  function enqueueDateEditJob(options) {
    options.applyOptimistic?.();
    return new Promise((resolve, reject) => {
      pendingDateJobs.push({ ...options, resolve, reject });
      updatePendingCount();
      scheduleDrain();
    });
  }

  function getOrCreateRotateSlot(photoId) {
    const session = hooks.getRotationSession?.(photoId);
    if (!session) {
      return null;
    }

    let slot = photoMutationSlots.get(photoId);
    if (!slot || slot.kind !== 'rotate') {
      slot = {
        kind: 'rotate',
        confirmedRotation: session.persistedRotation,
        targetRotation: session.displayRotation,
        inFlight: false,
        generation: 0,
        inFlightGeneration: null,
      };
      photoMutationSlots.set(photoId, slot);
      return slot;
    }

    slot.targetRotation = session.displayRotation;
    return slot;
  }

  function rotationDelta(slot) {
    return normalizeRotationDegrees(slot.targetRotation - slot.confirmedRotation);
  }

  function enqueuePhotoRotate(photoId) {
    if (!photoId) {
      return Promise.resolve(true);
    }

    const session = hooks.getRotationSession?.(photoId);
    if (!session || hooks.getRotationStillNeeded?.(photoId) === 0) {
      return Promise.resolve(true);
    }

    const slot = getOrCreateRotateSlot(photoId);
    if (!slot) {
      return Promise.resolve(true);
    }

    slot.targetRotation = session.displayRotation;
    slot.generation += 1;
    enqueueMutationPhotoId(photoId);
    return trackPhotoMutationPromise(photoId);
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

  async function settlePhotoRotate(photoId) {
    const slot = photoMutationSlots.get(photoId);
    if (!slot || slot.kind !== 'rotate' || slot.inFlight) {
      return;
    }

    const session = hooks.getRotationSession?.(photoId);
    if (session) {
      slot.targetRotation = session.displayRotation;
    }

    const attemptDelta = rotationDelta(slot);
    if (attemptDelta === 0) {
      removeMutationPhotoFromQueue(photoId);
      photoMutationSlots.delete(photoId);
      settlePhotoMutationPromise(photoId);
      return;
    }

    slot.inFlight = true;
    slot.inFlightGeneration = slot.generation;
    updatePendingCount();

    const attemptGeneration = slot.inFlightGeneration;

    try {
      const response = await fetch(`/api/photo/${photoId}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          degrees_ccw: attemptDelta,
          commit_lossy: true,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !result.committed) {
        throw new Error(result.error || 'Failed to save rotation');
      }
      await handleRotateSuccess(photoId, slot, result, attemptGeneration, attemptDelta);
    } catch (error) {
      handleRotateFailure(photoId, slot, error, attemptGeneration);
    } finally {
      slot.inFlight = false;
      slot.inFlightGeneration = null;
      updatePendingCount();
    }
  }

  async function handleRotateSuccess(
    photoId,
    slot,
    result,
    attemptGeneration,
    attemptDelta,
  ) {
    const session = hooks.getRotationSession?.(photoId);

    if (result.duplicate_removed) {
      photoMutationSlots.delete(photoId);
      removeMutationPhotoFromQueue(photoId);
      settlePhotoMutationPromise(photoId);
      await hooks.onRotateDuplicateRemoved?.(photoId, result);
      return;
    }

    slot.confirmedRotation = normalizeRotationDegrees(
      slot.confirmedRotation + attemptDelta,
    );
    if (session) {
      session.persistedRotation = slot.confirmedRotation;
    }

    if (result.photo) {
      hooks.applyCommittedPhotoUpdate?.(result.photo, {
        deferThumbnailRefresh: Boolean(result.reconcile_pending),
      });
    }

    if (session) {
      slot.targetRotation = session.displayRotation;
    }

    const stillNeeded = rotationDelta(slot);
    const isSettled =
      slot.generation === attemptGeneration && stillNeeded === 0;

    if (!isSettled) {
      enqueueMutationPhotoId(photoId);
      return;
    }

    photoMutationSlots.delete(photoId);
    removeMutationPhotoFromQueue(photoId);
    if (session && hooks.getRotationStillNeeded?.(photoId) === 0) {
      hooks.cleanupRotationSession?.(photoId);
    }
    settlePhotoMutationPromise(photoId);
  }

  function handleRotateFailure(photoId, slot, error, attemptGeneration) {
    if (slot.generation !== attemptGeneration) {
      enqueueMutationPhotoId(photoId);
      return;
    }

    const session = hooks.getRotationSession?.(photoId);
    if (session) {
      session.displayRotation = slot.confirmedRotation;
      session.mode = null;
      hooks.applyLightboxPreviewRotation?.();
      hooks.cleanupRotationSession?.(photoId);
    }

    photoMutationSlots.delete(photoId);
    removeMutationPhotoFromQueue(photoId);
    settlePhotoMutationPromise(photoId, error);
    hooks.showToast?.(error.message || 'Failed to save rotation', null);
  }

  function runDateEditSse(job) {
    return new Promise((resolve, reject) => {
      const eventSource = new EventSource(job.sseUrl);
      const confirmedPhotos = new Map();

      const finish = (error, result) => {
        eventSource.close();
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };

      eventSource.addEventListener('progress', (event) => {
        try {
          const data = JSON.parse(event.data);
          job.onProgress?.(data);
          if (data.duplicate_removed && data.photo_id) {
            job.onDuplicateRemoved?.(data);
          } else if (data.photo_id && data.photo) {
            confirmedPhotos.set(Number(data.photo_id), data.photo);
          }
        } catch (parseError) {
          console.error('Date edit SSE progress parse error:', parseError);
        }
      });

      eventSource.addEventListener('complete', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.photo_id) {
            if (data.duplicate_removed) {
              job.onDuplicateRemoved?.({ photo_id: data.photo_id, ...data });
            } else if (data.photo) {
              confirmedPhotos.set(Number(data.photo_id), data.photo);
            }
          }
          finish(null, {
            data,
            confirmedPhotoIds: [...confirmedPhotos.keys()],
            confirmedPhotos,
          });
        } catch (parseError) {
          finish(parseError);
        }
      });

      eventSource.addEventListener('error', (event) => {
        let errorMsg = job.failureToast || 'Failed to update date';
        try {
          if (event.data) {
            const data = JSON.parse(event.data);
            errorMsg = data.error || errorMsg;
          }
        } catch {
          /* ignore parse errors */
        }
        finish(new Error(errorMsg));
      });
    });
  }

  async function settleDateJob(job) {
    activeDateJob = job;
    updatePendingCount();

    try {
      const result = await runDateEditSse(job);
      await job.onSuccess?.(result);
      job.resolve(result);
    } catch (error) {
      job.revertOptimistic?.();
      hooks.showToast?.(error.message || job.failureToast || 'Operation failed', null);
      job.onFailure?.(error);
      job.reject(error);
    } finally {
      activeDateJob = null;
      updatePendingCount();
      scheduleDrain();
    }
  }

  async function runGenericJob(job) {
    const { options } = job;
    try {
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
    startMutationSettlements();

    if (
      pendingPhotoIds.length === 0 &&
      activeStarWrites.size === 0 &&
      pendingMutationPhotoIds.length === 0 &&
      activeMutationWrites.size === 0 &&
      !activeDateJob &&
      pendingDateJobs.length > 0
    ) {
      void settleDateJob(pendingDateJobs.shift());
      updatePendingCount();
      return;
    }

    if (
      pendingPhotoIds.length === 0 &&
      activeStarWrites.size === 0 &&
      pendingMutationPhotoIds.length === 0 &&
      activeMutationWrites.size === 0 &&
      !activeDateJob &&
      pendingDateJobs.length === 0 &&
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

  function startMutationSettlements() {
    for (
      let index = 0;
      index < pendingMutationPhotoIds.length &&
      activeMutationWrites.size < MAX_CONCURRENT_MUTATION_WRITES;
      index += 1
    ) {
      const photoId = pendingMutationPhotoIds[index];
      const slot = photoMutationSlots.get(photoId);

      if (!slot) {
        removeMutationPhotoFromQueue(photoId);
        index -= 1;
        continue;
      }

      if (slot.inFlight) {
        continue;
      }

      if (slot.kind === 'rotate') {
        const session = hooks.getRotationSession?.(photoId);
        if (session) {
          slot.targetRotation = session.displayRotation;
        }
        if (rotationDelta(slot) === 0) {
          removeMutationPhotoFromQueue(photoId);
          photoMutationSlots.delete(photoId);
          settlePhotoMutationPromise(photoId);
          index -= 1;
          continue;
        }
        startRotateSettlement(photoId);
      }
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

  function startRotateSettlement(photoId) {
    activeMutationWrites.add(photoId);
    updatePendingCount();
    void settlePhotoRotate(photoId).finally(() => {
      activeMutationWrites.delete(photoId);
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
    enqueueDateEditJob,
    enqueuePhotoRotate,
    isLightboxStarFilled,
    getPendingCount: () => pendingCount,
  };
})();
