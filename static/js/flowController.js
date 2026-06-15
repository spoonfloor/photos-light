/**
 * Unified flow controller — shared lifecycle for Add, Clean, and Convert.
 *
 * Public API (used by main.js flow adapters):
 * - init(deps) — inject hideFlowOverlay
 * - registerFlow(key, { overlayIds, adapter })
 * - syncOverlayPhase(flowKey, overlayPhase)
 * - cancelRecovery(flowKey, { reloadGrid?, skipConfirm?, resolveValue? })
 * - dismissOverlay(flowKey, { reloadGrid? })
 * - hideRegisteredOverlays(flowKey)
 * - getLifecyclePhase(flowKey) / getActiveFlowKey()
 */
const FlowController = (() => {
  /** @typedef {'idle' | 'preflight' | 'inflight' | 'complete'} LifecyclePhase */

  const LIFECYCLE_PHASES = Object.freeze([
    'idle',
    'preflight',
    'inflight',
    'complete',
  ]);

  /** @type {Record<string, LifecyclePhase>} */
  const DEFAULT_OVERLAY_PHASE_MAP = {
    scanning: 'preflight',
    preflight: 'preflight',
    interrupted: 'preflight',
    eta: 'preflight',
    'legacy-audit': 'preflight',
    confirm: 'preflight',
    warning: 'preflight',
    inflight: 'inflight',
    working: 'inflight',
    complete: 'complete',
    finished: 'complete',
  };

  /** @type {{ hideFlowOverlay?: (el: HTMLElement|null) => void } | null} */
  let deps = null;

  /** @type {Map<string, RegisteredFlow>} */
  const flows = new Map();

  /** @type {string | null} */
  let activeFlowKey = null;

  /**
   * @typedef {object} FlowAdapter
   * @property {() => boolean} [isPreflightPending]
   * @property {(shouldContinue: boolean) => void} [resolvePreflight]
   * @property {() => boolean} [isInflightActive]
   * @property {() => AbortController | null} [getAbortController]
   * @property {() => void} [abortInflight]
   * @property {() => number} [getImportedCount]
   * @property {() => void} [stopInflightUi]
   * @property {() => void} [resetInflightFeed]
   * @property {() => void} [finishSession]
   * @property {() => void} [resetSession]
   * @property {(options?: { reloadGrid?: boolean }) => Promise<void>} [hideOverlay]
   * @property {() => void} [scheduleGridRefresh]
   * @property {(importedCount: number) => void} [showCancelToast]
   * @property {() => Promise<boolean>} [confirmCancel]
   * @property {() => Promise<void>} [restoreShellAfterCancel]
   * @property {Record<string, LifecyclePhase>} [overlayPhaseMap]
   */

  /**
   * @typedef {object} RegisteredFlow
   * @property {string} key
   * @property {LifecyclePhase} lifecyclePhase
   * @property {string | null} overlayPhase
   * @property {string[]} overlayIds
   * @property {FlowAdapter} adapter
   */

  function init(injectedDeps = {}) {
    deps = injectedDeps;
  }

  /**
   * @param {string} key
   * @param {{ overlayIds?: string[], adapter?: FlowAdapter }} config
   */
  function registerFlow(key, { overlayIds = [], adapter = {} } = {}) {
    flows.set(key, {
      key,
      lifecyclePhase: 'idle',
      overlayPhase: null,
      overlayIds,
      adapter,
    });
  }

  function getFlow(key) {
    return flows.get(key) || null;
  }

  function mapOverlayPhase(flow, overlayPhase) {
    if (!overlayPhase) {
      return 'idle';
    }
    const map = flow.adapter.overlayPhaseMap || DEFAULT_OVERLAY_PHASE_MAP;
    return map[overlayPhase] || 'idle';
  }

  function setActiveFlow(key) {
    activeFlowKey = key || null;
  }

  function getActiveFlowKey() {
    return activeFlowKey;
  }

  /**
   * @param {string} flowKey
   * @returns {LifecyclePhase | null}
   */
  function getLifecyclePhase(flowKey) {
    return flows.get(flowKey)?.lifecyclePhase ?? null;
  }

  /**
   * Sync controller lifecycle from a flow-specific overlay phase label.
   * @param {string} flowKey
   * @param {string | null} overlayPhase
   */
  function syncOverlayPhase(flowKey, overlayPhase) {
    const flow = flows.get(flowKey);
    if (!flow) {
      return;
    }

    flow.overlayPhase = overlayPhase;
    flow.lifecyclePhase = mapOverlayPhase(flow, overlayPhase);

    if (flow.lifecyclePhase !== 'idle') {
      activeFlowKey = flowKey;
    } else if (activeFlowKey === flowKey) {
      activeFlowKey = null;
    }
  }

  function hideRegisteredOverlays(flowKey) {
    const flow = flows.get(flowKey);
    if (!flow || !deps?.hideFlowOverlay) {
      return;
    }
    for (const id of flow.overlayIds) {
      deps.hideFlowOverlay(document.getElementById(id));
    }
  }

  /**
   * Single cancel / go-back recovery entry for all flows.
   * @param {string} [flowKey]
   * @param {{ reloadGrid?: boolean, skipConfirm?: boolean, resolveValue?: * }} [options]
   */
  async function cancelRecovery(flowKey = activeFlowKey, options = {}) {
    if (!flowKey) {
      return;
    }

    const flow = flows.get(flowKey);
    if (!flow) {
      return;
    }

    const adapter = flow.adapter;
    const reloadGrid = options.reloadGrid;

    if (adapter.isPreflightPending?.()) {
      if (adapter.hideOverlay) {
        await adapter.hideOverlay({ reloadGrid: reloadGrid ?? false });
      } else {
        hideRegisteredOverlays(flowKey);
      }
      syncOverlayPhase(flowKey, null);
      await adapter.restoreShellAfterCancel?.();
      adapter.resolvePreflight?.(options.resolveValue ?? false);
      adapter.resetSession?.();
      return;
    }

    if (adapter.isInflightActive?.()) {
      if (!options.skipConfirm && adapter.confirmCancel) {
        const confirmed = await adapter.confirmCancel();
        if (!confirmed) {
          return;
        }
      }

      const importedCount = adapter.getImportedCount?.() ?? 0;
      adapter.abortInflight?.();
      adapter.stopInflightUi?.();
      adapter.finishSession?.();
      if (adapter.hideOverlay) {
        await adapter.hideOverlay({ reloadGrid: reloadGrid ?? true });
      } else {
        hideRegisteredOverlays(flowKey);
      }
      adapter.scheduleGridRefresh?.();
      adapter.showCancelToast?.(importedCount);
      syncOverlayPhase(flowKey, null);
      return;
    }

    if (adapter.hideOverlay) {
      await adapter.hideOverlay({ reloadGrid: reloadGrid ?? true });
    } else {
      hideRegisteredOverlays(flowKey);
    }
    syncOverlayPhase(flowKey, null);
    await adapter.restoreShellAfterCancel?.();
    adapter.resetSession?.();
  }

  /**
   * Close overlay without aborting an inflight run (e.g. Done on complete).
   * @param {string} flowKey
   * @param {{ reloadGrid?: boolean }} [options]
   */
  async function dismissOverlay(flowKey, options = {}) {
    const flow = flows.get(flowKey);
    if (!flow) {
      return;
    }

    const adapter = flow.adapter;
    if (adapter.hideOverlay) {
      await adapter.hideOverlay({ reloadGrid: options.reloadGrid ?? false });
    } else {
      hideRegisteredOverlays(flowKey);
    }
    adapter.finishSession?.();
    syncOverlayPhase(flowKey, null);
  }

  return Object.freeze({
    LIFECYCLE_PHASES,
    init,
    registerFlow,
    getFlow,
    getActiveFlowKey,
    setActiveFlow,
    getLifecyclePhase,
    syncOverlayPhase,
    cancelRecovery,
    dismissOverlay,
    hideRegisteredOverlays,
  });
})();
