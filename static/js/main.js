// Photo Viewer - Main Entry Point
const MAIN_JS_VERSION = 'v338';
console.log(`🚀 main.js loaded: ${MAIN_JS_VERSION}`);

// =====================
// STATE MANAGEMENT
// =====================

const state = {
  currentSortOrder: 'newest', // 'newest' or 'oldest'
  selectedPhotos: new Set(),
  photos: [],
  loading: false,
  libraryGeneration: 0,
  libraryTransitionActive: false,
  lastClickedIndex: null, // For shift-select
  lightboxOpen: false,
  lightboxPhotoIndex: null, // Index of currently viewed photo in lightbox
  lightboxUITimeout: null, // Timeout for hiding UI
  deleteInProgress: false,
  hasMore: true, // For infinite scroll
  currentOffset: 0, // Current pagination offset
  navigateToMonth: null, // Month to navigate to after closing lightbox (e.g., '2025-12')
  hasDatabase: false, // Track whether database exists and is healthy
  lightboxRotationSessions: {}, // photoId -> optimistic rotation session state
  lightboxMediaVersions: {}, // photoId -> cache-buster for rewritten media
  lightboxVisualState: null, // currently mounted lightbox bitmap state
  lightboxReloadToken: 0,
  lightboxClosing: false,
};

const libraryRecoveryState = {
  shellHidden: false,
  hasSwitchedLibrary: false,
  rebuildTotal: 0,
  rebuildAdded: 0,
};

let currentPhotoLoad = null;
let currentPhotoLoadAbortController = null;
let photoLoadRequestId = 0;

const ROTATABLE_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.tif',
  '.tiff',
]);

// ============================================================================
// DEBUG FLAG - Click-to-load lightbox (set to true for testing gray placeholder)
// ============================================================================
const DEBUG_CLICK_TO_LOAD = false; // Set to false for production

// ============================================================================
// DATABASE CORRUPTION DETECTION
// ============================================================================

/**
 * Check if API response indicates database corruption
 * Show rebuild dialog if detected
 */
function checkForDatabaseCorruption(responseData) {
  if (responseData && responseData.error) {
    const errorMsg = responseData.error.toLowerCase();
    // Check for corruption keywords in error message
    if (
      errorMsg.includes('database_corrupted') ||
      errorMsg.includes('not a database') ||
      errorMsg.includes('malformed') ||
      errorMsg.includes('corrupt')
    ) {
      console.error('🚨 Database corruption detected:', responseData.error);
      // Show rebuild dialog using existing critical error modal
      showCriticalErrorModal(
        'db_corrupted',
        responseData.message || 'Database appears corrupted',
      );
      return true;
    }
  }
  return false;
}

function logOpenLibraryAccessPoint(source) {
  console.log(`[open-library disabled] ${source}`);
}

function isCalendarMonthKey(monthKey) {
  return typeof monthKey === 'string' && /^\d{4}-\d{2}$/.test(monthKey);
}

function parsePhotoDate(photo) {
  if (!photo || !photo.date) {
    return null;
  }

  const dateStr = photo.date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  const date = new Date(dateStr);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ============================================================================
// TOAST DURATION - Default duration for toast messages in milliseconds
// ============================================================================
const TOAST_DURATION = 3000; // 3s for info/error toasts
const TOAST_DURATION_WITH_UNDO = 7000; // 7s for toasts with undo action

// =====================
// APP BAR
// =====================

// Load app bar fragment
function loadAppBar() {
  const mount = document.getElementById('appBarMount');

  // Check session cache first (with version check)
  const APP_BAR_VERSION = '49'; // Increment this when appBar changes
  try {
    const cachedVersion = sessionStorage.getItem('photoViewer_appBarVersion');
    const cached = sessionStorage.getItem('photoViewer_appBarShell');
    if (cached && cachedVersion === APP_BAR_VERSION) {
      mount.innerHTML = cached;
      wireAppBar();
      return Promise.resolve();
    }
  } catch (e) {
    // Ignore cache errors
  }

  // Fetch fragment (query must stay in sync with APP_BAR_VERSION for HTTP caches)
  return fetch(`fragments/appBar.html?v=${APP_BAR_VERSION}`)
    .then((r) => {
      if (!r.ok) throw new Error(`Failed to load app bar (${r.status})`);
      return r.text();
    })
    .then((html) => {
      mount.innerHTML = html;

      // Cache it with version
      try {
        sessionStorage.setItem('photoViewer_appBarShell', html);
        sessionStorage.setItem('photoViewer_appBarVersion', APP_BAR_VERSION);
      } catch (e) {
        // Ignore cache errors
      }

      wireAppBar();
    })
    .catch((err) => {
      console.error('❌ App bar load failed:', err);
    });
}

// Wire up app bar button handlers
function wireAppBar() {
  const menuBtn = document.getElementById('appBarMenuBtn');
  const deleteBtn = document.getElementById('deleteBtn');
  const deselectAllBtn = document.getElementById('deselectAllBtn');
  const sortToggleBtn = document.getElementById('sortToggleBtn');
  const sortIcon = document.getElementById('sortIcon');
  const addPhotoBtn = document.getElementById('addPhotoBtn');
  const utilitiesBtn = document.getElementById('utilitiesBtn');

  if (menuBtn) {
    menuBtn.addEventListener('click', () => {});
  }

  if (utilitiesBtn) {
    utilitiesBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleUtilitiesMenu();
    });
  } else {
    console.warn('⚠️ Utilities button not found in app bar');
  }

  if (addPhotoBtn) {
    addPhotoBtn.addEventListener('click', () => {
      triggerImport();
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      const count = state.selectedPhotos.size;

      if (count === 0) return;

      showDialogOld(
        'Delete Photos',
        `Are you sure you want to delete ${count} photo${
          count > 1 ? 's' : ''
        }?`,
        () => deletePhotos(Array.from(state.selectedPhotos)),
      );
    });
  }

  const editDateBtn = document.getElementById('editDateBtn');
  if (editDateBtn) {
    editDateBtn.addEventListener('click', () => {
      const count = state.selectedPhotos.size;

      if (count === 0) return;

      const selectedIds = Array.from(state.selectedPhotos);

      // Special case: if only 1 photo selected, open in single mode
      if (count === 1) {
        openDateEditor(selectedIds[0]);
      } else {
        // 2+ photos: open in bulk mode
        openDateEditor(selectedIds);
      }
    });
  }

  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', () => {
      deselectAllPhotos();
    });
  }

  if (sortToggleBtn && sortIcon) {
    sortToggleBtn.addEventListener('click', async () => {
      // Toggle sort order
      state.currentSortOrder =
        state.currentSortOrder === 'newest' ? 'oldest' : 'newest';

      // Update icon
      if (state.currentSortOrder === 'newest') {
        sortIcon.textContent = 'hourglass_arrow_down';
        sortToggleBtn.title = 'Newest first';
      } else {
        sortIcon.textContent = 'hourglass_arrow_up';
        sortToggleBtn.title = 'Oldest first';
      }

      // Reload photos with new sort
      await loadAndRenderPhotos();
    });
  }

  // Wire up date picker change handlers (but don't populate yet - that happens after health check)
  wireDatePicker();
}

/**
 * Populate year picker with years from DB
 */
async function populateDatePicker() {
  try {
    const response = await fetch('/api/years');

    // If the database is missing or API fails, bail gracefully
    if (!response.ok) {
      console.warn('⚠️  Date picker disabled (database not available)');
      return;
    }

    const data = await response.json();

    // Check for database corruption
    if (checkForDatabaseCorruption(data)) {
      return;
    }

    // Validate response data
    if (!data || !Array.isArray(data.years)) {
      console.warn('⚠️  Date picker disabled (invalid data)');
      return;
    }

    const yearPicker = document.getElementById('yearPicker');
    if (!yearPicker) return;

    // Clear existing options before populating (prevents duplicates)
    yearPicker.innerHTML = '';

    // Populate years
    data.years.forEach((year) => {
      const option = document.createElement('option');
      option.value = year;
      option.textContent = year;
      yearPicker.appendChild(option);
    });

    // Set to most recent year by default
    if (data.years.length > 0) {
      yearPicker.value = data.years[0];

      // Show the date picker now that we have dates
      const datePickerContainer = document.querySelector('.date-picker');
      if (datePickerContainer) {
        datePickerContainer.style.visibility = 'visible';
      }

      // Enable photo-related actions
      enablePhotoRelatedActions();
    } else {
      // Hide the date picker when there are no photos
      const datePickerContainer = document.querySelector('.date-picker');
      if (datePickerContainer) {
        datePickerContainer.style.visibility = 'hidden';
      }
    }
  } catch (error) {
    console.warn('⚠️  Date picker disabled:', error.message);
  }
}

/**
 * Enable actions that require photos to be present
 */
function enablePhotoRelatedActions() {
  // Enable sort button
  const sortBtn = document.getElementById('sortToggleBtn');
  if (sortBtn) {
    sortBtn.style.opacity = '1';
    sortBtn.style.pointerEvents = 'auto';
  }

  // Enable utility menu items (except Switch library which is always enabled)
  const utilityItems = ['cleanOrganizeBtn', 'rebuildDatabaseBtn'];

  utilityItems.forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      btn.classList.remove('disabled');
    }
  });
}

/**
 * Wire up date picker change handlers
 */
function wireDatePicker() {
  const monthPicker = document.getElementById('monthPicker');
  const yearPicker = document.getElementById('yearPicker');

  if (!monthPicker || !yearPicker) return;

  // Flag to prevent feedback loop when updating picker from scroll
  let updatingFromScroll = false;

  const handleDateChange = async () => {
    // Don't jump if we're updating from scroll
    if (updatingFromScroll) return;

    const month = monthPicker.value.padStart(2, '0');
    const year = yearPicker.value;
    const targetMonth = `${year}-${month}`;

    // Check if month section already exists in DOM
    const monthSection = document.getElementById(`month-${targetMonth}`);

    if (monthSection) {
      // Already rendered, just scroll to it
      // Position month label near top with small offset for app bar
      const appBarHeight = 60;
      const targetY = monthSection.offsetTop - appBarHeight - 20; // 20px padding
      window.scrollTo({ top: targetY, behavior: 'smooth' });
    } else {
      // Not rendered - need to find nearest valid month

      try {
        const nearestResponse = await fetch(
          `/api/photos/nearest_month?month=${targetMonth}&sort=${state.currentSortOrder}`,
        );
        const nearestData = await nearestResponse.json();

        if (!nearestData.nearest_month) {
          return;
        }

        const actualMonth = nearestData.nearest_month;

        // Check if that section exists
        const actualSection = document.getElementById(`month-${actualMonth}`);
        if (actualSection) {
          // Position month label near top with small offset for app bar
          const appBarHeight = 60;
          const targetY = actualSection.offsetTop - appBarHeight - 20; // 20px padding
          window.scrollTo({ top: targetY, behavior: 'smooth' });
        } else {
        }
      } catch (error) {
        console.error('❌ Error finding nearest month:', error);
      }
    }
  };

  monthPicker.addEventListener('change', handleDateChange);
  yearPicker.addEventListener('change', handleDateChange);

  // Track visibility of all sections
  const sectionVisibility = new Map();

  // Setup IntersectionObserver to update picker based on scroll position
  const observer = new IntersectionObserver(
    (entries) => {
      // Update visibility state for sections that changed
      entries.forEach((entry) => {
        const monthId = entry.target.dataset.month;
        if (monthId) {
          if (entry.intersectionRatio > 0) {
            // Section is visible - store it
            sectionVisibility.set(monthId, entry.target);
          } else {
            // Section is not visible - remove it
            sectionVisibility.delete(monthId);
          }
        }
      });

      // Get all month sections in DOM order, find first visible one
      const allSections = document.querySelectorAll('.month-section');
      const topmostVisibleSection = Array.from(allSections).find((section) => {
        const monthKey = section.dataset.month;
        return isCalendarMonthKey(monthKey) && sectionVisibility.has(monthKey);
      });

      if (!topmostVisibleSection) return;

      const monthId = topmostVisibleSection.dataset.month;

      if (isCalendarMonthKey(monthId)) {
        const [year, month] = monthId.split('-');

        // Set flag to prevent triggering jump
        updatingFromScroll = true;

        // Update pickers
        yearPicker.value = year;
        monthPicker.value = parseInt(month, 10).toString(); // Remove leading zero

        // Reset flag after a brief delay
        setTimeout(() => {
          updatingFromScroll = false;
        }, 100);
      }
    },
    {
      threshold: [0], // Just detect ANY visibility (entering or leaving viewport)
      rootMargin: '-60px 0px 0px 0px', // Offset for app bar height
    },
  );

  // Observe all month sections
  const observeMonthSections = () => {
    const monthSections = document.querySelectorAll('.month-section');
    monthSections.forEach((section) => observer.observe(section));
  };

  // Initial observation
  observeMonthSections();

  // Re-observe when new sections are added
  state.onMonthsRendered = observeMonthSections;
}

/**
 * Deselect all photos
 */
function deselectAllPhotos() {
  state.selectedPhotos.clear();
  state.lastClickedIndex = null; // Reset shift-select anchor
  const selectedCards = document.querySelectorAll('.photo-card.selected');
  selectedCards.forEach((card) => {
    card.classList.remove('selected');
  });
  updateDeleteButtonVisibility();
  updateMonthCircleStates(); // Update month circles
}

/**
 * Show/hide delete button based on selection
 */
function updateDeleteButtonVisibility() {
  const deleteBtn = document.getElementById('deleteBtn');
  const editDateBtn = document.getElementById('editDateBtn');
  const deselectBtn = document.getElementById('deselectAllBtn');

  if (deleteBtn) {
    if (state.selectedPhotos.size > 0) {
      deleteBtn.style.opacity = '1';
      deleteBtn.style.pointerEvents = 'auto';
    } else {
      deleteBtn.style.opacity = '0.3';
      deleteBtn.style.pointerEvents = 'none';
    }
  }

  if (editDateBtn) {
    if (state.selectedPhotos.size > 0) {
      editDateBtn.style.opacity = '1';
      editDateBtn.style.pointerEvents = 'auto';
    } else {
      editDateBtn.style.opacity = '0.3';
      editDateBtn.style.pointerEvents = 'none';
    }
  }

  if (deselectBtn) {
    if (state.selectedPhotos.size > 0) {
      deselectBtn.classList.remove('inactive');
    } else {
      deselectBtn.classList.add('inactive');
    }
  }
}

// =====================
// DIALOG
// =====================

// Store current dialog callback to avoid listener accumulation
let currentDialogCallback = null;
let originalDialogButtonsHTML = null;

/**
 * Handle dialog confirm click (single persistent listener)
 */
function handleDialogConfirm() {
  hideDialog();
  if (currentDialogCallback) {
    currentDialogCallback();
    currentDialogCallback = null;
  } else {
    console.warn('⚠️  No callback stored');
  }
}

/**
 * Load dialog fragment
 */
function loadDialog() {
  const mount = document.getElementById('dialogMount');

  return fetch('fragments/dialog.html')
    .then((r) => {
      if (!r.ok) throw new Error(`Failed to load dialog (${r.status})`);
      return r.text();
    })
    .then((html) => {
      mount.innerHTML = html;

      // Save original button HTML for restoration
      const actionsEl = document.querySelector('.dialog-actions');
      if (actionsEl) {
        originalDialogButtonsHTML = actionsEl.innerHTML;
      }

      // Wire up persistent event listeners once
      const confirmBtn = document.getElementById('dialogConfirmBtn');
      const cancelBtn = document.getElementById('dialogCancelBtn');
      const closeBtn = document.getElementById('dialogCloseBtn');

      if (confirmBtn) confirmBtn.addEventListener('click', handleDialogConfirm);
      if (cancelBtn) cancelBtn.addEventListener('click', hideDialog);
      if (closeBtn) closeBtn.addEventListener('click', hideDialog);
    })
    .catch((err) => {
      console.error('❌ Dialog load failed:', err);
    });
}

/**
 * Load critical error modal fragment
 */
function loadCriticalErrorModal() {
  const mount = document.createElement('div');
  mount.id = 'criticalErrorModalMount';
  document.body.appendChild(mount);

  return fetch('fragments/criticalErrorModal.html')
    .then((r) => {
      if (!r.ok)
        throw new Error(`Failed to load critical error modal (${r.status})`);
      return r.text();
    })
    .then((html) => {
      mount.innerHTML = html;
    })
    .catch((err) => {
      console.error('❌ Critical error modal load failed:', err);
    });
}

/**
 * Load rebuild database overlay fragment
 */
function loadRebuildDatabaseOverlay() {
  const mount = document.createElement('div');
  mount.id = 'rebuildDatabaseOverlayMount';
  document.body.appendChild(mount);

  return fetch('fragments/rebuildDatabaseOverlay.html')
    .then((r) => {
      if (!r.ok)
        throw new Error(
          `Failed to load rebuild database overlay (${r.status})`,
        );
      return r.text();
    })
    .then((html) => {
      mount.innerHTML = html;

      // Wire up event listeners
      const closeBtn = document.getElementById('rebuildDatabaseCloseBtn');
      const cancelBtn = document.getElementById('rebuildDatabaseCancelBtn');
      const proceedBtn = document.getElementById('rebuildDatabaseProceedBtn');
      const doneBtn = document.getElementById('rebuildDatabaseDoneBtn');

      if (closeBtn)
        closeBtn.addEventListener('click', hideRebuildDatabaseOverlay);
      if (cancelBtn)
        cancelBtn.addEventListener('click', hideRebuildDatabaseOverlay);
      if (proceedBtn)
        proceedBtn.addEventListener('click', executeRebuildDatabase);
      if (doneBtn)
        doneBtn.addEventListener('click', () => {
          hideRebuildDatabaseOverlay();
          loadAndRenderPhotos(); // Reload photos after rebuild
        });
    })
    .catch((err) => {
      console.error('❌ Rebuild database overlay load failed:', err);
    });
}

function hideRebuildDatabaseOverlay() {
  const overlay = document.getElementById('rebuildDatabaseOverlay');
  if (overlay) {
    overlay.remove(); // Destroy overlay, will be recreated fresh on next open
  }
}

// =====================
// CRITICAL ERROR MODAL
// =====================

/**
 * Show critical error modal (blocking)
 * @param {string} title - Error title
 * @param {string} message - Error message
 * @param {Array} buttons - Array of {text, action, primary} button configs
 */
function showCriticalError(title, message, buttons) {
  const overlay = document.getElementById('criticalErrorOverlay');
  const titleEl = document.getElementById('criticalErrorTitle');
  const messageEl = document.getElementById('criticalErrorMessage');
  const actionsEl = document.getElementById('criticalErrorActions');

  if (!overlay) {
    console.error('❌ Critical error overlay not found');
    return;
  }

  titleEl.textContent = title;
  messageEl.textContent = message;

  // Build button HTML
  actionsEl.innerHTML = buttons
    .map(
      (btn) => `
    <button class="btn ${btn.primary ? 'btn-primary' : 'btn-secondary'}" 
            data-action="${btn.action}">
      ${btn.text}
    </button>
  `,
    )
    .join('');

  // Wire up button actions
  actionsEl.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;

      if (action === 'rebuild_database') {
        hideCriticalError();
        await startRebuildDatabase();
      } else if (action === 'switch_library') {
        hideCriticalError();
        await loadSwitchLibraryOverlay();
        logOpenLibraryAccessPoint('critical-error-legacy');
      } else if (action === 'retry') {
        // Check if library is accessible now
        try {
          const response = await fetch('/api/library/status');
          const status = await response.json();
          if (status.status === 'healthy') {
            hideCriticalError();
            loadAndRenderPhotos();
          } else {
            showToast(
              `Library still not accessible: ${status.message}`,
              'error',
              5000,
            );
          }
        } catch (error) {
          showToast('Connection failed', 'error');
        }
      } else if (action === 'close') {
        window.close();
      }
    });
  });

  overlay.style.display = 'flex';
}

function hideCriticalError() {
  const overlay = document.getElementById('criticalErrorOverlay');
  if (overlay) overlay.style.display = 'none';
}

// =====================
// MAKE LIBRARY PERFECT
// =====================

/**
 * Run the authoritative clean-library engine and refresh the UI.
 */
async function requestMakeLibraryPerfect(options = {}) {
  const { signal } = options;
  const response = await fetch('/api/library/make-perfect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    signal,
  });

  const contentType = response.headers.get('content-type') || '';
  let data;

  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    const responseText = await response.text();
    const isHtmlError = contentType.includes('text/html');
    data = {
      error:
        (isHtmlError ? '' : responseText.replace(/\s+/g, ' ').trim()) ||
        `Server returned ${response.status} ${response.statusText}`,
    };
  }

  if (!response.ok) {
    throw new Error(data.error || `Operation failed: ${response.statusText}`);
  }

  return data;
}

const LIBRARY_RECOVERY_MAKE_PERFECT_PHASE_LABEL = {
  setup: 'Preparing library',
  scan: 'Adding media',
  dedupe: 'Adding media',
  canonicalize: 'Adding media',
  folders: 'Adding media',
  rebuild_db: 'Adding media',
  audit: 'Verifying library',
};

function updateLibraryRecoveryMakePerfectProgress(ev) {
  const statusEl = document.getElementById('libraryRecoveryStatus');
  const total = Math.max(Number(libraryRecoveryState.rebuildTotal || 0), 1);
  if (ev.type === 'phase' && statusEl && ev.status === 'starting') {
    const label =
      LIBRARY_RECOVERY_MAKE_PERFECT_PHASE_LABEL[ev.phase] || ev.phase;
    statusEl.style.display = 'flex';
    if (ev.phase === 'audit') {
      setLibraryRecoveryStats([]);
      statusEl.innerHTML = `${label}…<span class="import-spinner"></span>`;
    } else {
      statusEl.textContent = `${label}…`;
      setLibraryRecoveryStats([
        { label: 'Added', value: libraryRecoveryState.rebuildAdded || 0 },
        { label: 'Total', value: total },
      ]);
    }
    return;
  }
  if (
    ev.type === 'phase' &&
    statusEl &&
    ev.status === 'complete' &&
    ev.phase === 'audit'
  ) {
    statusEl.style.display = 'flex';
    statusEl.textContent = 'Library verified';
    return;
  }
  if (ev.type === 'progress') {
    const phaseLabel =
      LIBRARY_RECOVERY_MAKE_PERFECT_PHASE_LABEL[ev.phase] ||
      ev.phase ||
      'Working';
    if (statusEl) {
      statusEl.style.display = 'flex';
      if (ev.phase === 'audit') {
        setLibraryRecoveryStats([]);
        statusEl.innerHTML = `${phaseLabel}…<span class="import-spinner"></span>`;
        return;
      }
      statusEl.textContent = `${phaseLabel}…`;
    }
    if (ev.phase === 'canonicalize' || ev.phase === 'rebuild_db') {
      libraryRecoveryState.rebuildAdded = Math.max(
        Number(libraryRecoveryState.rebuildAdded || 0),
        Math.min(Number(ev.processed ?? 0), total),
      );
    }
    setLibraryRecoveryStats([
      { label: 'Added', value: libraryRecoveryState.rebuildAdded || 0 },
      { label: 'Total', value: total },
    ]);
  }
}

/**
 * Same engine as POST /api/library/make-perfect, with SSE progress events.
 */
async function streamMakeLibraryPerfect(options = {}) {
  const { signal, onProgress } = options;
  const response = await fetch('/api/library/make-perfect/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    signal,
  });

  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    let data;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const responseText = await response.text();
      const isHtmlError = contentType.includes('text/html');
      data = {
        error:
          (isHtmlError ? '' : responseText.replace(/\s+/g, ' ').trim()) ||
          `Server returned ${response.status} ${response.statusText}`,
      };
    }
    throw new Error(data.error || `Operation failed: ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let onAbort;
  if (signal) {
    onAbort = () => {
      reader.cancel().catch(() => {});
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  function consumeDataLine(line) {
    if (!line.startsWith('data: ')) return null;
    let payload;
    try {
      payload = JSON.parse(line.slice(6));
    } catch {
      return null;
    }
    if (payload.type === 'complete') {
      return { done: true, result: payload.result };
    }
    if (payload.type === 'error') {
      throw new Error(payload.error || 'Unknown error');
    }
    if (typeof onProgress === 'function') {
      onProgress(payload);
    }
    return null;
  }

  try {
    while (true) {
      let done;
      let value;
      try {
        ({ done, value } = await reader.read());
      } catch (readErr) {
        if (
          signal &&
          (signal.aborted ||
            readErr.name === 'AbortError' ||
            readErr?.name === 'AbortError')
        ) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        throw readErr;
      }
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
      }

      let sep;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split('\n')) {
          const fin = consumeDataLine(line);
          if (fin) {
            return fin.result;
          }
        }
      }

      if (done) {
        for (const line of buffer.split('\n')) {
          const fin = consumeDataLine(line);
          if (fin) {
            return fin.result;
          }
        }
        break;
      }
    }
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  throw new Error('Stream ended without complete event');
}

async function runMakeLibraryPerfectOperation(options = {}) {
  const {
    startMessage = 'Starting library cleanup...',
    reloadingMessage = 'Library cleanup complete! Reloading photos...',
    successMessage = '✅ Library is now perfectly organized',
    failurePrefix = 'Operation failed',
  } = options;

  try {
    showToast(startMessage, null);
    await requestMakeLibraryPerfect();

    showToast(reloadingMessage, null);
    await loadAndRenderPhotos(false, { throwOnError: true });
    showToast(successMessage, null);
    return true;
  } catch (error) {
    console.error('❌ Make Library Perfect failed:', error);
    showToast(`${failurePrefix}: ${error.message}`, null);
    return false;
  }
}

/**
 * Start "Make Library Perfect" operation (unified Clean + Rebuild)
 * Entry point from utilities menu "Clean library" option
 */
async function startMakeLibraryPerfect() {
  try {
    // Show confirmation dialog
    const confirmed = await showDialog(
      'Clean library',
      'This will:\n\n• Fix misnamed and misfiled media\n• Move duplicates, corrupted files, and non-library files to .trash\n• Add missing media to the database and remove ghost DB entries\n• Bake still-image rotation when it is lossless\n• Strip EXIF rating flags when rating = 0\n• Remove empty and non-canonical folders outside infrastructure\n\nItems already inside .trash are allowed and do not count against cleanliness.\n\nThis operation may take several hours for large libraries. The app must remain open until complete.\n\nContinue?',
      [
        { text: 'Cancel', value: false, primary: false },
        { text: 'Start cleaning', value: true, primary: true },
      ],
    );

    if (!confirmed) {
      return;
    }

    await runMakeLibraryPerfectOperation();
  } catch (error) {
    console.error('❌ Make Library Perfect failed:', error);
    showToast(`Operation failed: ${error.message}`, 'error');
  }
}

// =====================
// REBUILD DATABASE
// =====================

/**
 * Start rebuild database flow (entry point from utilities menu)
 */
async function startRebuildDatabase() {
  try {
    // Load the overlay if not already loaded
    if (!document.getElementById('rebuildDatabaseOverlay')) {
      await loadRebuildDatabaseOverlay();
    }

    // Pre-scan: count files and get estimate

    const overlay = document.getElementById('rebuildDatabaseOverlay');
    const statusText = document.getElementById('rebuildDatabaseStatusText');
    const cancelBtn = document.getElementById('rebuildDatabaseCancelBtn');
    const proceedBtn = document.getElementById('rebuildDatabaseProceedBtn');

    overlay.style.display = 'flex';
    statusText.innerHTML =
      'Scanning library<span class="import-spinner"></span>';
    cancelBtn.style.display = 'block';
    proceedBtn.style.display = 'none';

    const response = await fetch('/api/recovery/rebuild-database/scan', {
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`Scan failed: ${response.statusText}`);
    }

    const data = await response.json();

    // Show warning if large library
    if (data.requires_warning) {
      const confirmed = await showDialog(
        'Large library',
        `Your library contains ${data.file_count.toLocaleString()} photos.\n\nRebuilding will take an estimated ${
          data.estimated_display
        }. Keep the app open until rebuilding is complete.`,
        [
          { text: 'Cancel', value: false, primary: false },
          { text: 'Continue', value: true, primary: true },
        ],
      );

      if (!confirmed) {
        hideRebuildDatabaseOverlay();
        return;
      }
    }

    // Update UI to show ready state
    const estimateText = data.estimated_display
      ? `<p>Estimated time: ${data.estimated_display}</p>`
      : '';
    statusText.innerHTML = `<p>Ready to rebuild database.</p><p>Found ${data.file_count.toLocaleString()} files.</p>${estimateText}`;
    proceedBtn.style.display = 'block';
  } catch (error) {
    console.error('❌ Rebuild database scan failed:', error);
    showToast(`Scan failed: ${error.message}`, 'error');
    hideRebuildDatabaseOverlay();
  }
}

/**
 * Execute rebuild database (after user confirms)
 */
async function executeRebuildDatabase() {
  // Close lightbox if open (user should see grid during rebuild)
  const lightbox = document.getElementById('lightboxOverlay');
  if (lightbox && lightbox.style.display !== 'none') {
    closeLightbox();
  }

  const overlay = document.getElementById('rebuildDatabaseOverlay');
  const title = overlay.querySelector('.import-title');
  const statusText = document.getElementById('rebuildDatabaseStatusText');
  const stats = document.getElementById('rebuildDatabaseStats');
  const indexedCount = document.getElementById('rebuildIndexedCount');
  const cancelBtn = document.getElementById('rebuildDatabaseCancelBtn');
  const proceedBtn = document.getElementById('rebuildDatabaseProceedBtn');
  const doneBtn = document.getElementById('rebuildDatabaseDoneBtn');

  // Update title and show stats (State 3)
  title.textContent = 'Rebuilding database';
  proceedBtn.style.display = 'none';
  cancelBtn.style.display = 'none';
  stats.style.display = 'flex';
  statusText.textContent = 'Rebuilding database';

  try {
    const eventSource = new EventSource(
      '/api/recovery/rebuild-database/execute',
    );

    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);

      if (data.phase === 'adding_untracked') {
        indexedCount.textContent = data.current.toLocaleString();
        // Update status text with total (static)
        statusText.textContent = `Indexing ${data.total.toLocaleString()} files...`;
      } else if (data.phase === 'removing_empty') {
        statusText.textContent = 'Cleaning up';
      }
    });

    eventSource.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);

      // Update title and status (State 4)
      title.textContent = 'Database rebuilt';
      const totalIndexed = data.stats.untracked_files.toLocaleString();
      statusText.innerHTML = `<p>Database rebuilt successfully.</p><p>Indexed ${totalIndexed} files.</p>`;
      doneBtn.style.display = 'block';

      eventSource.close();

      // Check library health and reload photos

      checkLibraryHealthAndInit().catch((err) => {
        console.error('❌ Failed to reload after rebuild:', err);
      });
    });

    eventSource.addEventListener('error', (e) => {
      console.error('❌ Rebuild failed:', e);

      let errorMsg = 'Rebuild failed';
      try {
        const data = JSON.parse(e.data);
        errorMsg = data.error || errorMsg;
      } catch (err) {
        // Ignore parse errors
      }

      statusText.innerHTML = `<p>❌ ${errorMsg}</p>`;
      cancelBtn.textContent = 'Close';
      cancelBtn.style.display = 'block';

      eventSource.close();
    });
  } catch (error) {
    console.error('❌ Rebuild execution error:', error);
    statusText.innerHTML = `<p>❌ Rebuild failed: ${error.message}</p>`;
    cancelBtn.textContent = 'Close';
    cancelBtn.style.display = 'block';
  }
}

/**
 * Show confirmation dialog (old callback-based version)
 */
function showDialogOld(title, message, onConfirm, confirmLabel = 'Delete') {
  const overlay = document.getElementById('dialogOverlay');
  const titleEl = document.getElementById('dialogTitle');
  const messageEl = document.getElementById('dialogMessage');
  const actionsEl = document.querySelector('.dialog-actions');

  if (!overlay) {
    console.error('❌ Dialog overlay not found');
    return;
  }

  // Restore original button HTML (in case showDialog modified it)
  if (actionsEl && originalDialogButtonsHTML) {
    actionsEl.innerHTML = originalDialogButtonsHTML;

    // Re-attach listeners to restored buttons
    const confirmBtn = document.getElementById('dialogConfirmBtn');
    const cancelBtn = document.getElementById('dialogCancelBtn');
    if (confirmBtn) confirmBtn.addEventListener('click', handleDialogConfirm);
    if (cancelBtn) cancelBtn.addEventListener('click', hideDialog);
  }

  const confirmBtn = document.getElementById('dialogConfirmBtn');
  if (confirmBtn) {
    confirmBtn.textContent = confirmLabel;
  }

  titleEl.textContent = title;
  messageEl.textContent = message;

  // Store the callback for the handler to use
  currentDialogCallback = onConfirm;

  overlay.style.display = 'flex';
}

/**
 * Show confirmation dialog (new promise-based version with custom buttons)
 */
function showDialog(title, message, buttons) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('dialogOverlay');
    const titleEl = document.getElementById('dialogTitle');
    const messageEl = document.getElementById('dialogMessage');
    const actionsEl = overlay.querySelector('.dialog-actions');
    const closeBtn = document.getElementById('dialogCloseBtn');

    if (!overlay) {
      resolve(false);
      return;
    }

    titleEl.textContent = title;
    messageEl.textContent = message;

    // Clear and rebuild buttons
    actionsEl.innerHTML = '';

    buttons.forEach((btn) => {
      const buttonEl = document.createElement('button');
      buttonEl.className = `btn ${
        btn.primary ? 'btn-primary' : 'btn-secondary'
      }`;
      buttonEl.textContent = btn.text;
      buttonEl.addEventListener('click', () => {
        cleanup();
        resolve(btn.value);
      });
      actionsEl.appendChild(buttonEl);
    });

    // ESC key handler
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(false);
      }
    };

    // Click outside handler
    const handleClickOutside = (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(false);
      }
    };

    // Cleanup function
    const cleanup = () => {
      hideDialog();
      document.removeEventListener('keydown', handleEscape);
      overlay.removeEventListener('click', handleClickOutside);
    };

    // Wire up X button
    if (closeBtn) {
      const newCloseBtn = closeBtn.cloneNode(true);
      closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
      newCloseBtn.addEventListener('click', () => {
        cleanup();
        resolve(false);
      });
    }

    // Add listeners
    document.addEventListener('keydown', handleEscape);
    overlay.addEventListener('click', handleClickOutside);

    overlay.style.display = 'flex';
  });
}

/**
 * Hide dialog
 */
function hideDialog() {
  const overlay = document.getElementById('dialogOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

async function loadLibraryRecoveryDock() {
  if (document.getElementById('libraryRecoveryDock')) {
    return;
  }

  const mount = document.getElementById('dialogMount');
  if (!mount) {
    console.error('❌ Library recovery dock mount not found');
    return;
  }

  try {
    const response = await fetch('fragments/libraryRecoveryDock.html?v=3');
    if (!response.ok) {
      throw new Error(
        `Failed to load library recovery dock (${response.status})`,
      );
    }

    mount.insertAdjacentHTML('beforeend', await response.text());
  } catch (error) {
    console.error('❌ Library recovery dock load failed:', error);
  }
}

async function ensureLibraryRecoveryDock() {
  if (!document.getElementById('libraryRecoveryDock')) {
    await loadLibraryRecoveryDock();
  }
  return document.getElementById('libraryRecoveryDock');
}

function setLibraryRecoveryShellHidden(hidden) {
  libraryRecoveryState.shellHidden = hidden;
  document.body.classList.toggle('library-recovery-active', hidden);
}

/**
 * Hide app bar + photo grid between folder picker close and the next modal
 * (covers async /api/library/check). Cleared on healthy switch, cancel, or recovery end.
 */
function setOpenLibraryModalHandoffShellHidden(hidden) {
  document.body.classList.toggle('open-library-modal-handoff', hidden);
}

function hideLibraryRecoveryDock() {
  const dock = document.getElementById('libraryRecoveryDock');
  if (dock) {
    dock.style.display = 'none';
  }
}

function finishLibraryRecoveryJourney() {
  hideLibraryRecoveryDock();
  setLibraryRecoveryShellHidden(false);
  setOpenLibraryModalHandoffShellHidden(false);
  libraryRecoveryState.hasSwitchedLibrary = false;
  libraryRecoveryState.rebuildTotal = 0;
  libraryRecoveryState.rebuildAdded = 0;
}

function setLibraryRecoveryStats(stats = []) {
  const statsEl = document.getElementById('libraryRecoveryStats');
  if (!statsEl) return;

  if (!stats.length) {
    statsEl.style.display = 'none';
    statsEl.innerHTML = '';
    return;
  }

  statsEl.innerHTML = stats
    .map((stat) => {
      const rawValue = stat.value ?? 0;
      const formattedValue =
        typeof rawValue === 'number'
          ? rawValue.toLocaleString()
          : `${rawValue}`;
      return `
        <span class="import-stat">
          <span class="import-stat-label">${stat.label}</span>
          <span class="import-stat-value">${formattedValue}</span>
        </span>
      `;
    })
    .join('');
  statsEl.style.display = 'flex';
}

function setLibraryRecoveryActions(actions = [], resolveAction = null) {
  const actionsEl = document.getElementById('libraryRecoveryActions');
  if (!actionsEl) return;

  actionsEl.innerHTML = '';
  if (!actions.length) {
    actionsEl.style.display = 'none';
    return;
  }

  actions.forEach((action) => {
    const button = document.createElement('button');
    button.className = `btn ${action.primary ? 'btn-primary' : 'btn-secondary'}`;
    button.textContent = action.text;
    button.disabled = !!action.disabled;
    button.addEventListener('click', async () => {
      if (typeof action.onClick === 'function') {
        await action.onClick();
      }
      if (resolveAction) {
        resolveAction(action.value);
      }
    });
    actionsEl.appendChild(button);
  });

  actionsEl.style.display = 'flex';
}

async function showLibraryRecoveryDockCard(options = {}) {
  const dock = await ensureLibraryRecoveryDock();
  if (!dock) {
    return false;
  }

  const titleEl = document.getElementById('libraryRecoveryTitle');
  const bodyEl = document.getElementById('libraryRecoveryBody');
  const statusEl = document.getElementById('libraryRecoveryStatus');
  const errorEl = document.getElementById('libraryRecoveryError');

  if (titleEl) {
    titleEl.textContent = options.title || '';
  }
  if (bodyEl) {
    bodyEl.textContent = options.body || '';
  }

  if (statusEl) {
    if (options.statusText) {
      statusEl.innerHTML = `${options.statusText}${
        options.statusSpinner ? '<span class="import-spinner"></span>' : ''
      }`;
      statusEl.style.display = 'flex';
    } else {
      statusEl.style.display = 'none';
      statusEl.textContent = '';
    }
  }

  if (errorEl) {
    if (options.errorText) {
      errorEl.textContent = options.errorText;
      errorEl.style.display = 'block';
    } else {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
    }
  }

  setLibraryRecoveryStats(options.stats || []);
  setLibraryRecoveryActions(options.actions || []);

  const actionsEl = document.getElementById('libraryRecoveryActions');
  if (actionsEl) {
    if (options.actionsJustify) {
      actionsEl.style.justifyContent = options.actionsJustify;
    } else {
      actionsEl.style.removeProperty('justify-content');
    }
  }

  const closeBtn = document.getElementById('libraryRecoveryCloseBtn');
  if (closeBtn) {
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
    if (options.showCloseButton && typeof options.onClose === 'function') {
      newCloseBtn.style.display = 'flex';
      newCloseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        options.onClose();
      });
    } else {
      newCloseBtn.style.display = 'none';
    }
  }

  dock.style.display = 'block';
  return true;
}

async function promptLibraryRecoveryDock(options = {}) {
  return new Promise(async (resolve) => {
    const userOnClose = options.onClose;
    const closeValue = options.closeActionValue ?? 'cancel';
    const shown = await showLibraryRecoveryDockCard({
      ...options,
      showCloseButton: options.showCloseButton !== false,
      onClose: () => {
        if (typeof userOnClose === 'function') {
          userOnClose();
        }
        resolve(closeValue);
      },
    });
    if (!shown) {
      resolve(false);
      return;
    }
    setLibraryRecoveryActions(options.actions || [], resolve);
  });
}

function getRecoveryFailureCopy(stage, hasSwitchedLibrary) {
  if (stage === 'recover_database') {
    return {
      title: "Couldn't recover library",
      body: "We couldn't add a new database for this folder.",
      errorText:
        'Nothing was changed. Please try again or pick a different folder.',
    };
  }

  if (stage === 'add_media') {
    return {
      title: "Couldn't finish rebuilding library",
      body: "Your library is open, but we couldn't finish adding media.",
      errorText: 'You can keep using your library and try again later.',
    };
  }

  if (hasSwitchedLibrary) {
    return {
      title: "Couldn't finish opening library",
      body: "Your library is open, but we couldn't finish checking it for media to add.",
      errorText: 'You can keep using your library and try again later.',
    };
  }

  return {
    title: "Couldn't open library",
    body: "We couldn't finish opening this folder as a library.",
    errorText: 'Please try again or pick a different folder.',
  };
}

// =====================
// TOAST
// =====================

/**
 * Load date editor fragment
 */
function loadDateEditor() {
  const mount = document.getElementById('dateEditorMount');

  return fetch('fragments/dateEditor.html?v=4') // Version 4: Sequence with interval
    .then((r) => {
      if (!r.ok) throw new Error(`Failed to load date editor (${r.status})`);
      return r.text();
    })
    .then((html) => {
      mount.innerHTML = html;
      wireDateEditor();
    })
    .catch((err) => {
      console.error('❌ Date editor load failed:', err);
    });
}

/**
 * Wire up date editor controls
 */
function wireDateEditor() {
  const overlay = document.getElementById('dateEditorOverlay');
  const dateEditor = document.querySelector('.date-editor');
  const cancelBtn = document.getElementById('dateEditorCancelBtn');
  const saveBtn = document.getElementById('dateEditorSaveBtn');

  // Populate year options (1900-2100)
  const yearSelect = document.getElementById('dateEditorYear');
  for (let year = 2100; year >= 1900; year--) {
    const option = document.createElement('option');
    option.value = year;
    option.textContent = year;
    yearSelect.appendChild(option);
  }

  // Populate month options
  const monthSelect = document.getElementById('dateEditorMonth');
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  monthNames.forEach((name, index) => {
    const option = document.createElement('option');
    option.value = index + 1;
    option.textContent = name;
    monthSelect.appendChild(option);
  });

  // Populate day options (1-31)
  const daySelect = document.getElementById('dateEditorDay');
  for (let day = 1; day <= 31; day++) {
    const option = document.createElement('option');
    option.value = day;
    option.textContent = day;
    daySelect.appendChild(option);
  }

  // Function to update day options based on selected month/year
  window.updateDateEditorDayOptions = () => {
    const yearSelect = document.getElementById('dateEditorYear');
    const monthSelect = document.getElementById('dateEditorMonth');
    const daySelect = document.getElementById('dateEditorDay');

    if (!yearSelect || !monthSelect || !daySelect) return;

    const year = parseInt(yearSelect.value);
    const month = parseInt(monthSelect.value);
    const currentDay = parseInt(daySelect.value);

    // Get days in month
    const daysInMonth = new Date(year, month, 0).getDate();

    // Clear and repopulate day options
    daySelect.innerHTML = '';
    for (let day = 1; day <= daysInMonth; day++) {
      const option = document.createElement('option');
      option.value = day;
      option.textContent = day;
      daySelect.appendChild(option);
    }

    // Restore selected day if still valid, otherwise set to last day of month
    if (currentDay <= daysInMonth) {
      daySelect.value = currentDay;
    } else {
      daySelect.value = daysInMonth;
    }
  };

  // Add listeners to month/year to update valid days
  document
    .getElementById('dateEditorYear')
    .addEventListener('change', window.updateDateEditorDayOptions);
  document
    .getElementById('dateEditorMonth')
    .addEventListener('change', window.updateDateEditorDayOptions);

  // Populate hour options (1-12)
  const hourSelect = document.getElementById('dateEditorHour');
  for (let hour = 1; hour <= 12; hour++) {
    const option = document.createElement('option');
    option.value = hour;
    option.textContent = hour;
    hourSelect.appendChild(option);
  }

  // Populate minute options (00-59)
  const minuteSelect = document.getElementById('dateEditorMinute');
  for (let minute = 0; minute < 60; minute++) {
    const option = document.createElement('option');
    option.value = minute;
    option.textContent = String(minute).padStart(2, '0');
    minuteSelect.appendChild(option);
  }

  // Populate interval amount options (1-60)
  const intervalAmountSelect = document.getElementById(
    'dateEditorIntervalAmount',
  );
  if (intervalAmountSelect) {
    for (let amount = 1; amount <= 60; amount++) {
      const option = document.createElement('option');
      option.value = amount;
      option.textContent = amount;
      if (amount === 5) option.selected = true; // Default to 5
      intervalAmountSelect.appendChild(option);
    }
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', closeDateEditor);
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', saveDateEdit);
  }

  // ESC to close (handled by global keyboard handler, not here)
  // Click outside (on overlay, not on editor card) to close
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      // Only close if clicking directly on overlay (not on the editor card)
      if (e.target === overlay) {
        closeDateEditor();
      }
    });
  }
}

/**
 * Open date editor for a photo or multiple photos
 * @param {number|number[]} photoIdOrIds - Single photo ID or array of IDs for bulk edit
 */
function openDateEditor(photoIdOrIds) {
  const overlay = document.getElementById('dateEditorOverlay');
  if (!overlay) return;

  // Determine if bulk mode
  const isBulk = Array.isArray(photoIdOrIds);
  const photoIds = isBulk ? photoIdOrIds : [photoIdOrIds];
  const firstPhotoId = photoIds[0];

  // Find first photo to populate fields
  const photo = state.photos.find((p) => p.id === firstPhotoId);
  if (!photo) {
    console.error('Photo not found:', firstPhotoId);
    return;
  }

  const date = parsePhotoDate(photo);
  if (!date) {
    showToast('This photo is missing a usable library date', null);
    return;
  }

  // Populate fields
  document.getElementById('dateEditorYear').value = date.getFullYear();
  document.getElementById('dateEditorMonth').value = date.getMonth() + 1;

  // Update day options based on selected month/year before setting day
  if (window.updateDateEditorDayOptions) {
    window.updateDateEditorDayOptions();
  }

  document.getElementById('dateEditorDay').value = date.getDate();

  let hours = date.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;

  document.getElementById('dateEditorHour').value = hours;
  document.getElementById('dateEditorMinute').value = date.getMinutes(); // Set as number, not padded string
  document.getElementById('dateEditorAmPm').value = ampm;

  // Update current date display
  const currentDisplay = document.getElementById('dateEditorCurrent');
  if (currentDisplay) {
    if (isBulk) {
      currentDisplay.textContent = `${photoIds.length} photos selected`;
    } else {
      currentDisplay.textContent = date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    }
  }

  // Show/hide bulk mode selector
  const bulkModeSection = document.getElementById('dateEditorBulkMode');
  if (bulkModeSection) {
    bulkModeSection.style.display = isBulk ? 'block' : 'none';
  }

  // Store photo IDs for saving
  overlay.dataset.photoIds = JSON.stringify(photoIds);
  overlay.dataset.isBulk = isBulk;

  // Update state
  state.dateEditorOpen = true;

  // Show overlay
  overlay.style.display = 'flex';
}

/**
 * Close date editor
 */
function closeDateEditor() {
  const overlay = document.getElementById('dateEditorOverlay');
  if (!overlay) return;

  // Update state
  state.dateEditorOpen = false;

  overlay.style.display = 'none';
}

/**
 * Load date change progress overlay
 */
function loadDateChangeProgressOverlay() {
  const mount = document.createElement('div');
  mount.id = 'dateChangeProgressOverlayMount';
  document.body.appendChild(mount);

  return fetch('fragments/dateChangeProgressOverlay.html')
    .then((r) => {
      if (!r.ok)
        throw new Error(
          `Failed to load date change progress overlay (${r.status})`,
        );
      return r.text();
    })
    .then((html) => {
      mount.innerHTML = html;

      // Wire up event listeners
      const closeBtn = document.getElementById('dateChangeProgressCloseBtn');
      const doneBtn = document.getElementById('dateChangeProgressDoneBtn');

      if (closeBtn)
        closeBtn.addEventListener('click', hideDateChangeProgressOverlay);
      if (doneBtn)
        doneBtn.addEventListener('click', hideDateChangeProgressOverlay);
    })
    .catch((err) => {
      console.error('❌ Date change progress overlay load failed:', err);
    });
}

/**
 * Show date change progress overlay
 */
function showDateChangeProgressOverlay(photoCount) {
  const overlay = document.getElementById('dateChangeProgressOverlay');
  if (!overlay) return;

  const title = document.getElementById('dateChangeProgressTitle');
  const statusText = document.getElementById('dateChangeProgressStatusText');
  const stats = document.getElementById('dateChangeProgressStats');
  const currentEl = document.getElementById('dateChangeProgressCurrent');
  const closeBtn = document.getElementById('dateChangeProgressCloseBtn');

  // Set title based on count
  if (title) {
    title.textContent = photoCount === 1 ? 'Updating date' : 'Updating dates';
  }

  // Set static status text with total
  if (statusText) {
    if (photoCount === 1) {
      statusText.innerHTML =
        'Updating 1 photo<span class="import-spinner"></span>';
    } else {
      statusText.textContent = `Updating ${photoCount} photos...`;
    }
  }

  // Show stats for multiple photos
  if (stats && photoCount > 1) {
    stats.style.display = 'flex';
    if (currentEl) currentEl.textContent = '0';
  } else if (stats) {
    stats.style.display = 'none';
  }

  // Hide done button initially
  const doneBtn = document.getElementById('dateChangeProgressDoneBtn');
  if (doneBtn) doneBtn.style.display = 'none';
  if (closeBtn) closeBtn.style.display = 'none';

  overlay.style.display = 'flex';
}

/**
 * Hide date change progress overlay
 */
function hideDateChangeProgressOverlay() {
  const overlay = document.getElementById('dateChangeProgressOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

/**
 * Update date change progress
 */
function updateDateChangeProgress(current, total) {
  const currentEl = document.getElementById('dateChangeProgressCurrent');

  if (currentEl) {
    currentEl.textContent = current.toString();
  }

  // Status text stays static (no updates during progress)
}

function finalizeDateChangeSuccess({ message, originalDates, clearSelection }) {
  hideDateChangeProgressOverlay();

  if (clearSelection) {
    deselectAllPhotos();
  }

  loadAndRenderPhotos(false);
  showToast(message, () => undoDateEdit(originalDates));
}

/**
 * Show date change error
 */
function showDateChangeError(errorMsg) {
  const statusText = document.getElementById('dateChangeProgressStatusText');
  const closeBtn = document.getElementById('dateChangeProgressCloseBtn');
  const title = document.getElementById('dateChangeProgressTitle');

  if (title) {
    title.textContent = 'Update failed';
  }

  if (statusText) {
    statusText.innerHTML = `<p>❌ ${errorMsg}</p>`;
  }

  if (closeBtn) {
    closeBtn.style.display = 'block';
  }

  console.error(`❌ Date change error: ${errorMsg}`);
}

/**
 * Save date edit (SSE version with progress dialog)
 */
async function saveDateEdit() {
  const overlay = document.getElementById('dateEditorOverlay');
  if (!overlay) return;

  const photoIds = JSON.parse(overlay.dataset.photoIds || '[]');
  const isBulk = overlay.dataset.isBulk === 'true';

  // Get values
  const year = document.getElementById('dateEditorYear').value;
  const month = String(
    document.getElementById('dateEditorMonth').value,
  ).padStart(2, '0');
  const day = String(document.getElementById('dateEditorDay').value).padStart(
    2,
    '0',
  );
  let hour = parseInt(document.getElementById('dateEditorHour').value);
  const minute = String(
    document.getElementById('dateEditorMinute').value,
  ).padStart(2, '0');
  const ampm = document.getElementById('dateEditorAmPm').value;

  // Convert to 24-hour format
  if (ampm === 'PM' && hour !== 12) {
    hour += 12;
  } else if (ampm === 'AM' && hour === 12) {
    hour = 0;
  }
  const hour24 = String(hour).padStart(2, '0');

  // Format as EXIF format (YYYY:MM:DD HH:MM:SS)
  const newDate = `${year}:${month}:${day} ${hour24}:${minute}:00`;

  // Capture original dates BEFORE edit for undo
  const originalDates = photoIds.map((id) => {
    const photo = state.photos.find((p) => p.id === id);
    return {
      id: id,
      originalDate: photo ? photo.date : null,
    };
  });

  // Close date editor immediately
  closeDateEditor();
  if (state.lightboxOpen) closeLightbox();

  // Show progress dialog immediately (instant feedback!)
  if (!document.getElementById('dateChangeProgressOverlay')) {
    await loadDateChangeProgressOverlay();
  }
  showDateChangeProgressOverlay(photoIds.length);

  try {
    // Build query parameters for SSE (EventSource only supports GET)
    const params = new URLSearchParams();

    if (isBulk) {
      // Bulk edit mode
      const mode = document.querySelector(
        'input[name="dateEditorMode"]:checked',
      ).value;

      params.append('photo_ids', JSON.stringify(photoIds));
      params.append('new_date', newDate);
      params.append('mode', mode);

      // Add interval data if sequence mode
      if (mode === 'sequence') {
        params.append(
          'interval_amount',
          document.getElementById('dateEditorIntervalAmount').value,
        );
        params.append(
          'interval_unit',
          document.getElementById('dateEditorIntervalUnit').value,
        );
      }

      // Use SSE for bulk updates
      const eventSource = new EventSource(
        '/api/photos/bulk_update_date/execute?' + params.toString(),
      );

      eventSource.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);

        updateDateChangeProgress(data.current, data.total);
      });

      eventSource.addEventListener('complete', (e) => {
        const data = JSON.parse(e.data);

        eventSource.close();

        let message = `Updated ${data.updated_count} photo${data.updated_count !== 1 ? 's' : ''}`;
        if (data.duplicate_count > 0) {
          message += `, ${data.duplicate_count} duplicate${data.duplicate_count !== 1 ? 's' : ''} moved to trash`;
        }

        finalizeDateChangeSuccess({
          message,
          originalDates,
          clearSelection: true,
        });
      });

      eventSource.addEventListener('error', (e) => {
        console.error('❌ Bulk date update failed:', e);

        let errorMsg = 'Failed to update dates';
        try {
          const data = JSON.parse(e.data);
          errorMsg = data.error || errorMsg;
        } catch (err) {
          // Ignore parse errors
        }

        showDateChangeError(errorMsg);
        eventSource.close();
      });
    } else {
      // Single photo edit
      params.append('photo_id', photoIds[0]);
      params.append('new_date', newDate);

      // Use SSE for single photo update
      const eventSource = new EventSource(
        '/api/photo/update_date/execute?' + params.toString(),
      );

      eventSource.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);

        updateDateChangeProgress(data.current || 0, data.total || 1);
      });

      eventSource.addEventListener('complete', (e) => {
        JSON.parse(e.data);

        eventSource.close();

        finalizeDateChangeSuccess({
          message: 'Date updated',
          originalDates,
          clearSelection: false,
        });
      });

      eventSource.addEventListener('error', (e) => {
        console.error('❌ Date update failed:', e);

        let errorMsg = 'Failed to update date';
        try {
          const data = JSON.parse(e.data);
          errorMsg = data.error || errorMsg;
        } catch (err) {
          // Ignore parse errors
        }

        showDateChangeError(errorMsg);
        eventSource.close();
      });
    }
  } catch (error) {
    console.error('❌ Error updating date:', error);
    showDateChangeError(error.message || 'Unknown error');
  }
}

/**
 * Load toast fragment
 */
function loadToast() {
  const mount = document.getElementById('toastMount');

  return fetch('fragments/toast.html')
    .then((r) => {
      if (!r.ok) throw new Error(`Failed to load toast (${r.status})`);
      return r.text();
    })
    .then((html) => {
      mount.innerHTML = html;
    })
    .catch((err) => {
      console.error('❌ Toast load failed:', err);
    });
}

/**
 * Show toast with undo option
 */
function showToast(message, onUndo, duration) {
  const toast = document.getElementById('toast');
  const messageEl = document.getElementById('toastMessage');
  const undoBtn = document.getElementById('toastUndoBtn');
  const closeBtn = document.getElementById('toastCloseBtn');
  const undoCallback = typeof onUndo === 'function' ? onUndo : null;

  if (!toast) return;

  messageEl.textContent = message;

  // Auto-select duration based on whether undo is provided
  if (duration === undefined) {
    duration = undoCallback ? TOAST_DURATION_WITH_UNDO : TOAST_DURATION;
  }

  // Log actual duration being used

  // Show/hide undo button based on whether undo callback exists
  const newUndoBtn = undoBtn.cloneNode(true);
  undoBtn.parentNode.replaceChild(newUndoBtn, undoBtn);

  if (undoCallback) {
    // Show undo button and add listener
    newUndoBtn.style.display = 'block';
    newUndoBtn.addEventListener('click', () => {
      hideToast();
      undoCallback();
    });
  } else {
    // Hide undo button
    newUndoBtn.style.display = 'none';
  }

  // Wire up close button
  const newCloseBtn = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
  newCloseBtn.addEventListener('click', () => {
    hideToast();
  });

  toast.style.display = 'flex';

  // Auto-hide after duration
  setTimeout(() => {
    hideToast();
  }, duration);
}

/**
 * Hide toast
 */
function hideToast() {
  const toast = document.getElementById('toast');
  if (toast) {
    toast.style.display = 'none';
  }
}

// =====================
// CRITICAL ERROR MODAL
// =====================

/**
 * Load critical error modal fragment
 */
async function loadCriticalErrorModal() {
  const mount = document.getElementById('dialogMount');
  try {
    const response = await fetch('fragments/criticalErrorModal.html');
    if (!response.ok)
      throw new Error(
        `Failed to load critical error modal (${response.status})`,
      );
    mount.insertAdjacentHTML('beforeend', await response.text());
  } catch (error) {
    console.error('❌ Critical Error Modal load failed:', error);
  }
}

/**
 * Show critical error modal with specific error type
 */
function showCriticalErrorModal(type, path = '') {
  const overlay = document.getElementById('criticalErrorOverlay');
  const title = document.getElementById('criticalErrorTitle');
  const message = document.getElementById('criticalErrorMessage');
  const actions = document.getElementById('criticalErrorActions');

  if (!overlay) {
    console.error('❌ Critical error modal not loaded');
    return;
  }

  // Clear previous buttons
  actions.innerHTML = '';

  if (type === 'db_missing' || type === 'db_corrupted') {
    title.textContent = 'Database missing';

    message.innerHTML = `<p style="margin: 0;">The file your library needs to display and keep track of your photos is missing or corrupted. To continue, you can rebuild the database or open a different library.</p>`;

    // Add buttons
    const switchBtn = document.createElement('button');
    switchBtn.className = 'btn btn-secondary';
    switchBtn.textContent = 'Open library';
    switchBtn.onclick = async () => {
      hideCriticalErrorModal();
      logOpenLibraryAccessPoint('critical-error-db-missing');
    };

    const rebuildBtn = document.createElement('button');
    rebuildBtn.className = 'btn btn-primary';
    rebuildBtn.textContent = 'Rebuild database';
    rebuildBtn.onclick = async () => {
      hideCriticalErrorModal();
      await startRebuildDatabase();
    };

    actions.appendChild(switchBtn);
    actions.appendChild(rebuildBtn);
  } else if (type === 'db_needs_migration') {
    title.textContent = 'Database needs migration';

    message.innerHTML = `<p style="margin: 0 0 12px 0;">Your library database needs an update before it can be opened safely.</p><p style="margin: 0;">${path}</p>`;

    const switchBtn = document.createElement('button');
    switchBtn.className = 'btn btn-secondary';
    switchBtn.textContent = 'Open library';
    switchBtn.onclick = async () => {
      hideCriticalErrorModal();
      logOpenLibraryAccessPoint('critical-error-db-needs-migration');
    };

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn btn-primary';
    reloadBtn.textContent = 'Reload';
    reloadBtn.onclick = () => {
      hideCriticalErrorModal();
      window.location.reload();
    };

    actions.appendChild(switchBtn);
    actions.appendChild(reloadBtn);
  } else if (type === 'library_not_found') {
    title.textContent = 'Library folder not found';

    message.innerHTML = `
      <p style="margin: 0 0 12px 0;">Can't access your library:</p>
      <p style="font-family: monospace; font-size: 12px; color: var(--text-secondary); margin: 0 0 12px 0;">${path}</p>
      <p style="margin: 0;">Your library folder is no longer accessible. To continue, you can retry the connection or open a different library.</p>
    `;

    const switchBtn = document.createElement('button');
    switchBtn.className = 'btn btn-secondary';
    switchBtn.textContent = 'Open library';
    switchBtn.onclick = async () => {
      hideCriticalErrorModal();
      logOpenLibraryAccessPoint('critical-error-library-not-found');
    };

    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn btn-primary';
    retryBtn.textContent = 'Retry';
    retryBtn.onclick = () => {
      hideCriticalErrorModal();
      window.location.reload();
    };

    actions.appendChild(switchBtn);
    actions.appendChild(retryBtn);
  } else {
    title.textContent = 'Error';
    message.innerHTML = `<p style="margin: 0;">An unexpected error occurred: ${path}</p>`;

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn btn-primary';
    reloadBtn.textContent = 'Reload';
    reloadBtn.onclick = () => window.location.reload();

    actions.appendChild(reloadBtn);
  }

  overlay.style.display = 'flex';
}

function hideCriticalErrorModal() {
  const overlay = document.getElementById('criticalErrorOverlay');
  if (overlay) overlay.style.display = 'none';
}

// =====================
// LIGHTBOX
// =====================

/**
 * Load lightbox fragment
 */
function loadLightbox() {
  const mount = document.getElementById('lightboxMount');

  return fetch('fragments/lightbox.html?v=6')
    .then((r) => {
      if (!r.ok) throw new Error(`Failed to load lightbox (${r.status})`);
      return r.text();
    })
    .then((html) => {
      mount.innerHTML = html;
      wireLightbox();
    })
    .catch((err) => {
      console.error('❌ Lightbox load failed:', err);
    });
}

function normalizeRotationDegrees(degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  return normalized;
}

function getPhotoExtension(photo) {
  const path = photo?.path || '';
  const match = path.match(/(\.[^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function getLightboxRotationSession(photoId, create = false) {
  let session = state.lightboxRotationSessions[photoId];
  if (!session && create) {
    session = {
      displayRotation: 0,
      persistedRotation: 0,
      mode: null, // null | 'staged'
      requestInFlight: false,
    };
    state.lightboxRotationSessions[photoId] = session;
  }
  return session;
}

function cleanupLightboxRotationSession(photoId) {
  const session = getLightboxRotationSession(photoId);
  if (!session) return;
  if (
    session.displayRotation === 0 &&
    session.persistedRotation === 0 &&
    session.mode !== 'staged' &&
    !session.requestInFlight
  ) {
    delete state.lightboxRotationSessions[photoId];
  }
}

function getLightboxVisualState(photoId) {
  const visualState = state.lightboxVisualState;
  if (!visualState || visualState.photoId !== photoId) {
    return null;
  }
  return visualState;
}

function clearLightboxVisualState() {
  state.lightboxVisualState = null;
}

function setLightboxVisualState(photoId, mediaEl, persistedRotation = null) {
  const width = mediaEl?.naturalWidth || mediaEl?.videoWidth || 0;
  const height = mediaEl?.naturalHeight || mediaEl?.videoHeight || 0;
  const session = getLightboxRotationSession(photoId);

  state.lightboxVisualState = {
    photoId,
    width,
    height,
    persistedRotation: normalizeRotationDegrees(
      persistedRotation ?? session?.persistedRotation ?? 0,
    ),
  };
}

function getLightboxVisualDimensions(photo) {
  const visualState = getLightboxVisualState(photo.id);
  if (visualState?.width && visualState?.height) {
    return {
      width: visualState.width,
      height: visualState.height,
    };
  }

  return {
    width: photo.width,
    height: photo.height,
  };
}

function getLightboxPreviewRotation(photoId) {
  const session = getLightboxRotationSession(photoId);
  if (!session) return 0;

  const visualState = getLightboxVisualState(photoId);
  if (!visualState) {
    return getRotationStillNeeded(photoId);
  }

  // Preview rotation must be relative to the bitmap currently mounted in the
  // lightbox, not whichever intermediate file state has already committed.
  return normalizeRotationDegrees(
    session.displayRotation - visualState.persistedRotation,
  );
}

function rebaseLightboxRotationSessionForReload(photoId) {
  const session = getLightboxRotationSession(photoId);
  if (!session || session.persistedRotation === 0) return;

  session.displayRotation = normalizeRotationDegrees(
    session.displayRotation - session.persistedRotation,
  );
  session.persistedRotation = 0;
  cleanupLightboxRotationSession(photoId);
}

function getRotationStillNeeded(photoId) {
  const session = getLightboxRotationSession(photoId);
  if (!session) return 0;
  return normalizeRotationDegrees(
    session.displayRotation - session.persistedRotation,
  );
}

function createLightboxMediaFrame() {
  const frame = document.createElement('div');
  frame.className = 'lightbox-media-frame';
  return frame;
}

function applyLightboxMediaStyles(frameEl, mediaEl, photo, rotationDegrees) {
  if (!frameEl) return;
  const normalized = normalizeRotationDegrees(rotationDegrees);
  const isTransposed = normalized === 90 || normalized === 270;
  const session = getLightboxRotationSession(photo.id);
  const persistedRotation = session
    ? normalizeRotationDegrees(session.persistedRotation)
    : 0;
  const displayRotation = session
    ? normalizeRotationDegrees(session.displayRotation)
    : 0;
  const stillNeeded = session ? getRotationStillNeeded(photo.id) : normalized;

  // frameDims are already sized for the displayed (post-rotation) orientation
  const frameDims = calculateMediaDimensions(photo, normalized);

  frameEl.style.position = 'relative';
  frameEl.style.flexShrink = '0';
  frameEl.style.width = frameDims.width || '';
  frameEl.style.height = frameDims.height || '';
  frameEl.style.maxHeight = frameDims.maxHeight || '';
  frameEl.style.overflow = 'hidden';

  if (!mediaEl) return;

  mediaEl.style.position = 'absolute';
  mediaEl.style.top = '50%';
  mediaEl.style.left = '50%';
  mediaEl.style.objectFit = 'contain';
  mediaEl.style.maxWidth = 'none';
  mediaEl.style.maxHeight = 'none';

  if (isTransposed) {
    // The CSS transform rotates the image 90/270°, swapping its visual width and height.
    // To fill the frame after rotation: pre-rotation width = frame height, height = frame width.
    mediaEl.style.width = frameDims.height || '';
    mediaEl.style.height = frameDims.width || '';
  } else {
    mediaEl.style.width = '100%';
    mediaEl.style.height = '100%';
  }

  if (normalized) {
    // Rotation state is tracked as counterclockwise degrees, but CSS positive
    // angles render clockwise on screen. Negate here so optimistic preview
    // matches the committed file rotation.
    mediaEl.style.transform = `translate(-50%, -50%) rotate(${-normalized}deg)`;
  } else {
    mediaEl.style.transform = 'translate(-50%, -50%)';
  }
  mediaEl.style.transformOrigin = 'center center';

  // Diagnostic: report what the browser actually rendered after layout
  requestAnimationFrame(() => {
    const fw = frameEl.offsetWidth,
      fh = frameEl.offsetHeight;
    const mw = mediaEl.offsetWidth,
      mh = mediaEl.offsetHeight;
    const pos = frameEl.style.position;
    const parentClass = frameEl.parentElement?.className || '(no parent)';
    const mediaClass = mediaEl.className || mediaEl.tagName;
  });
}

function applyCurrentLightboxPreviewRotation() {
  if (!state.lightboxOpen || state.lightboxPhotoIndex === null) return;

  const photo = state.photos[state.lightboxPhotoIndex];
  const rotationDegrees = getLightboxPreviewRotation(photo.id);
  const content = document.getElementById('lightboxContent');
  if (!content) return;

  const frameEls = content.querySelectorAll('.lightbox-media-frame');
  frameEls.forEach((frameEl) => {
    const mediaEl = frameEl.querySelector(
      '.lightbox-media-element, .lightbox-media-placeholder',
    );
    applyLightboxMediaStyles(frameEl, mediaEl, photo, rotationDegrees);
  });
}

function getPhotoFileUrl(photoId) {
  const version = state.lightboxMediaVersions[photoId];
  return version
    ? `/api/photo/${photoId}/file?v=${version}`
    : `/api/photo/${photoId}/file`;
}

function getPhotoThumbnailUrl(photoId) {
  const version = state.lightboxMediaVersions[photoId];
  return version
    ? `/api/photo/${photoId}/thumbnail?v=${version}`
    : `/api/photo/${photoId}/thumbnail`;
}

function invalidatePendingLightboxReloads() {
  state.lightboxReloadToken += 1;
}

function reloadOpenLightboxMedia(photoId) {
  if (!state.lightboxOpen || state.lightboxPhotoIndex === null) return;

  const photo = state.photos[state.lightboxPhotoIndex];
  if (!photo || photo.id !== photoId) return;

  const content = document.getElementById('lightboxContent');
  if (!content) return;

  const isVideo =
    photo.file_type === 'video' ||
    (photo.path && photo.path.match(/\.(mov|mp4|m4v|avi|mpg|mpeg)$/i));
  const reloadToken = ++state.lightboxReloadToken;

  if (!isVideo) {
    const existingFrame = content.querySelector('.lightbox-media-frame');
    const existingImg = content.querySelector('img.lightbox-media-element');

    if (existingFrame && existingImg) {
      const nextImg = new Image();
      nextImg.src = getPhotoFileUrl(photoId);
      nextImg.onload = () => {
        if (
          reloadToken !== state.lightboxReloadToken ||
          !state.lightboxOpen ||
          state.lightboxPhotoIndex === null
        ) {
          return;
        }

        const currentPhoto = state.photos[state.lightboxPhotoIndex];
        if (!currentPhoto || currentPhoto.id !== photoId) {
          return;
        }

        const currentFrame = content.querySelector('.lightbox-media-frame');
        const currentImg = currentFrame?.querySelector(
          'img.lightbox-media-element',
        );
        if (!currentFrame || !currentImg) {
          return;
        }

        setLightboxVisualState(
          photoId,
          nextImg,
          getLightboxRotationSession(photoId)?.persistedRotation ?? 0,
        );
        nextImg.className = 'lightbox-media-element';
        nextImg.alt =
          currentPhoto.path?.split('/').pop() ||
          currentPhoto.filename ||
          `Photo ${currentPhoto.id}`;
        applyLightboxMediaStyles(
          currentFrame,
          nextImg,
          currentPhoto,
          getLightboxPreviewRotation(photoId),
        );
        currentFrame.replaceChild(nextImg, currentImg);
      };
      nextImg.onerror = () => {
        console.error(`❌ Reloaded image ${photoId} failed to load`);
      };
      return;
    }
  }

  if (reloadToken !== state.lightboxReloadToken) {
    return;
  }

  content.innerHTML = '';
  content.style.backgroundColor = 'transparent';
  loadMediaIntoContent(content, photo, isVideo, {
    rotationDegrees: getLightboxPreviewRotation(photoId),
  });
}

function getRotateDisabledReason(photo) {
  if (!photo) return 'Rotation is not available';
  if (photo.file_type === 'video') return "Rotation isn't available for videos";

  const ext = getPhotoExtension(photo);
  if (!ROTATABLE_IMAGE_EXTENSIONS.has(ext)) {
    return "Rotation isn't available for this file type";
  }

  return null;
}

function updateLightboxRotateButtonState(
  photo = state.photos[state.lightboxPhotoIndex],
) {
  const rotateBtn = document.getElementById('lightboxRotateBtn');
  if (!rotateBtn) return;

  const reason = getRotateDisabledReason(photo);
  const isUnavailable = Boolean(reason);

  rotateBtn.setAttribute('aria-disabled', isUnavailable ? 'true' : 'false');
  rotateBtn.disabled = state.lightboxClosing;
  rotateBtn.title = reason || 'Rotate left';
}

function refreshGridPhotoThumbnail(photoId) {
  const thumb = document.querySelector(
    `.photo-thumb[data-photo-id="${photoId}"]`,
  );
  if (!thumb) return;

  if (thumb.getAttribute('src')) {
    thumb.src = getPhotoThumbnailUrl(photoId);
  }
}

function scheduleGridPhotoThumbnailRefresh(photoId, delayMs = 1200) {
  window.setTimeout(() => {
    refreshGridPhotoThumbnail(photoId);
  }, delayMs);
}

function applyCommittedPhotoUpdate(updatedPhoto, options = {}) {
  const photoIndex = state.photos.findIndex(
    (photo) => photo.id === updatedPhoto.id,
  );
  if (photoIndex === -1) return;

  state.photos[photoIndex] = {
    ...state.photos[photoIndex],
    path: updatedPhoto.path,
    width: updatedPhoto.width,
    height: updatedPhoto.height,
  };

  state.lightboxMediaVersions[updatedPhoto.id] = Date.now();

  if (options.deferThumbnailRefresh) {
    scheduleGridPhotoThumbnailRefresh(updatedPhoto.id);
  } else {
    refreshGridPhotoThumbnail(updatedPhoto.id);
  }
}

async function handleDuplicateRemovedRotation(photoId, message) {
  delete state.lightboxRotationSessions[photoId];
  if (
    state.lightboxOpen &&
    state.photos[state.lightboxPhotoIndex]?.id === photoId
  ) {
    await closeLightbox();
  }
  await loadAndRenderPhotos();
  showToast(message || 'Photo became a duplicate and was moved to trash');
}

async function processImmediateRotationSession(photoId) {
  const session = getLightboxRotationSession(photoId);
  if (!session || session.mode === 'staged' || session.requestInFlight) return;

  const rotationStillNeeded = getRotationStillNeeded(photoId);
  if (rotationStillNeeded === 0) {
    cleanupLightboxRotationSession(photoId);
    return;
  }

  session.requestInFlight = true;
  const requestDegrees = rotationStillNeeded;
  const rotateStartedAt = performance.now();

  try {
    const response = await fetch(`/api/photo/${photoId}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        degrees_ccw: requestDegrees,
        commit_lossy: false,
      }),
    });

    const result = await response.json();
    const rotateElapsedMs = performance.now() - rotateStartedAt;

    if (!response.ok) {
      throw new Error(result.error || 'Failed to rotate photo');
    }

    if (result.duplicate_removed) {
      session.requestInFlight = false;
      await handleDuplicateRemovedRotation(photoId, result.message);
      return;
    }

    if (result.staged) {
      session.mode = 'staged';
      session.requestInFlight = false;
      return;
    }

    if (!result.committed || !result.photo) {
      throw new Error('Unexpected rotate response');
    }

    applyCommittedPhotoUpdate(result.photo, {
      deferThumbnailRefresh: Boolean(result.reconcile_pending),
    });
    session.persistedRotation = normalizeRotationDegrees(
      session.persistedRotation + requestDegrees,
    );
    session.requestInFlight = false;
    const stillNeededAfterCommit = getRotationStillNeeded(photoId);
    if (stillNeededAfterCommit === 0) {
      reloadOpenLightboxMedia(photoId);
    }

    if (stillNeededAfterCommit !== 0) {
      processImmediateRotationSession(photoId);
    } else {
      cleanupLightboxRotationSession(photoId);
    }
  } catch (error) {
    session.requestInFlight = false;
    session.displayRotation = session.persistedRotation;
    session.mode = null;
    applyCurrentLightboxPreviewRotation();
    cleanupLightboxRotationSession(photoId);
    console.error('❌ Error rotating photo:', error);
    showToast('Failed to rotate photo', null);
  }
}

async function commitPendingLightboxRotations() {
  const pendingEntries = Object.entries(state.lightboxRotationSessions).filter(
    ([photoId, session]) =>
      session.mode === 'staged' &&
      getRotationStillNeeded(Number(photoId)) !== 0,
  );

  if (pendingEntries.length === 0) {
    return true;
  }

  for (const [photoIdString, session] of pendingEntries) {
    const photoId = Number(photoIdString);
    const degrees = getRotationStillNeeded(photoId);
    try {
      const saveStartedAt = performance.now();
      const response = await fetch(`/api/photo/${photoId}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          degrees_ccw: degrees,
          commit_lossy: true,
        }),
      });

      const result = await response.json();
      if (!response.ok || !result.ok || !result.committed) {
        throw new Error(result.error || 'Failed to save rotation');
      }

      if (result.duplicate_removed) {
        await handleDuplicateRemovedRotation(photoId, result.message);
        continue;
      }

      applyCommittedPhotoUpdate(result.photo, {
        deferThumbnailRefresh: Boolean(result.reconcile_pending),
      });
      delete state.lightboxRotationSessions[photoId];
      const saveElapsedMs = performance.now() - saveStartedAt;
    } catch (error) {
      session.displayRotation = session.persistedRotation;
      session.mode = null;
      applyCurrentLightboxPreviewRotation();
      cleanupLightboxRotationSession(photoId);
      console.error('❌ Error saving staged rotation:', error);
      showToast('Failed to save rotation', null);
      return false;
    }
  }

  return true;
}

async function handleLightboxRotate() {
  const photo = state.photos[state.lightboxPhotoIndex];
  const rotateBtn = document.getElementById('lightboxRotateBtn');
  if (!photo || !rotateBtn) return;
  if (rotateBtn.getAttribute('aria-disabled') === 'true') return;
  if (state.lightboxClosing) return;

  const session = getLightboxRotationSession(photo.id, true);
  session.displayRotation = normalizeRotationDegrees(
    session.displayRotation + 90,
  );
  invalidatePendingLightboxReloads();
  applyCurrentLightboxPreviewRotation();

  if (session.mode === 'staged') {
    return;
  }

  processImmediateRotationSession(photo.id);
}

/**
 * Wire up lightbox controls
 */
function wireLightbox() {
  const overlay = document.getElementById('lightboxOverlay');
  const topBar = document.querySelector('.lightbox-top-bar');
  const backBtn = document.getElementById('lightboxBackBtn');
  const infoBtn = document.getElementById('lightboxInfoBtn');
  const deleteBtn = document.getElementById('lightboxDeleteBtn');
  const infoPanel = document.getElementById('lightboxInfoPanel');
  const prevBtn = document.getElementById('lightboxPrevBtn');
  const nextBtn = document.getElementById('lightboxNextBtn');

  if (backBtn) {
    backBtn.addEventListener('click', closeLightbox);
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', () => navigateLightbox(-1));
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => navigateLightbox(1));
  }

  if (infoBtn && infoPanel) {
    infoBtn.addEventListener('click', () => {
      const isVisible = infoPanel.style.display === 'block';
      const overlay = document.getElementById('lightboxOverlay');

      if (isVisible) {
        infoPanel.style.display = 'none';
        if (overlay) overlay.classList.remove('info-open');
      } else {
        infoPanel.style.display = 'block';
        if (overlay) overlay.classList.add('info-open');
      }
    });
  }

  // Wire up close button in info panel
  const infoCloseBtn = document.getElementById('infoCloseBtn');
  if (infoCloseBtn && infoPanel) {
    infoCloseBtn.addEventListener('click', () => {
      const overlay = document.getElementById('lightboxOverlay');
      infoPanel.style.display = 'none';
      if (overlay) overlay.classList.remove('info-open');
    });
  }

  const rotateBtn = document.getElementById('lightboxRotateBtn');
  if (rotateBtn) {
    rotateBtn.addEventListener('click', handleLightboxRotate);
  }

  const starBtn = document.getElementById('lightboxStarBtn');
  if (starBtn) {
    starBtn.addEventListener('click', async () => {
      const photoId = state.photos[state.lightboxPhotoIndex]?.id;
      if (!photoId) return;

      const starIcon = starBtn.querySelector('.material-symbols-outlined');
      const isFilled = starIcon.classList.contains('filled');

      try {
        // Optimistically toggle UI
        starIcon.classList.toggle('filled');

        // Call API to toggle favorite
        const response = await fetch(`/api/photo/${photoId}/favorite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
          throw new Error(`Failed to toggle favorite: ${response.status}`);
        }

        const result = await response.json();

        if (result.duplicate_removed) {
          if (
            state.lightboxOpen &&
            state.photos[state.lightboxPhotoIndex]?.id === photoId
          ) {
            await closeLightbox();
          }
          await loadAndRenderPhotos();
          showToast(
            result.message || 'Photo became a duplicate and was moved to trash',
            null,
          );
          return;
        }

        // Update local state to match backend
        if (state.photos[state.lightboxPhotoIndex]) {
          state.photos[state.lightboxPhotoIndex].rating = result.rating;
        }
        if (result.photo) {
          applyCommittedPhotoUpdate(result.photo);
        }

        // Update grid star badge
        const gridCard = document.querySelector(
          `.photo-card[data-id="${photoId}"]`,
        );
        if (gridCard) {
          // Remove existing star badge if present
          const existingBadge = gridCard.querySelector('.star-badge');
          if (existingBadge) {
            existingBadge.remove();
          }

          // Add star badge if favorited
          if (result.favorited) {
            const starBadge = document.createElement('div');
            starBadge.className = 'star-badge';
            starBadge.innerHTML =
              '<span class="material-symbols-outlined">star</span>';
            gridCard.appendChild(starBadge);
          }
        }

        // Ensure UI matches result
        if (result.favorited) {
          starIcon.classList.add('filled');
        } else {
          starIcon.classList.remove('filled');
        }
      } catch (error) {
        console.error('❌ Error toggling star:', error);
        // Revert optimistic UI change on error
        starIcon.classList.toggle('filled');
        showToast('Failed to update star', null);
      }
    });
  }

  const editDateBtn = document.getElementById('lightboxEditDateBtn');
  if (editDateBtn) {
    editDateBtn.addEventListener('click', () => {
      const photoId = state.photos[state.lightboxPhotoIndex]?.id;

      openDateEditor(photoId);
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      const photoId = state.photos[state.lightboxPhotoIndex]?.id;

      if (!photoId) return;

      showDialogOld(
        'Delete Photo',
        'Are you sure you want to delete this photo?',
        () => {
          deletePhotos([photoId]);
          // Close lightbox after delete
          closeLightbox();
        },
      );
    });
  }

  // Auto-hide UI after 2 seconds of no mouse movement
  if (overlay) {
    overlay.addEventListener('mousemove', () => {
      showLightboxUI();
      resetLightboxUITimeout();
    });
  }

  // Keyboard navigation
  document.addEventListener('keydown', handleLightboxKeyboard);
}

/**
 * Show lightbox UI
 */
function showLightboxUI() {
  const topBar = document.querySelector('.lightbox-top-bar');
  if (topBar) {
    topBar.classList.remove('hidden');
  }
}

/**
 * Hide lightbox UI
 */
function hideLightboxUI() {
  const topBar = document.querySelector('.lightbox-top-bar');
  if (topBar) {
    topBar.classList.add('hidden');
  }
}

/**
 * Reset the auto-hide timeout
 */
function resetLightboxUITimeout() {
  // Clear existing timeout
  if (state.lightboxUITimeout) {
    clearTimeout(state.lightboxUITimeout);
  }

  // Set new timeout to hide UI after 2 seconds
  state.lightboxUITimeout = setTimeout(() => {
    if (state.lightboxOpen) {
      hideLightboxUI();
    }
  }, 2000);
}

/**
 * Handle keyboard events for lightbox
 */
function handleLightboxKeyboard(e) {
  if (e.key === 'Escape') {
    // Priority 1: Close date editor if open (stay in lightbox)
    if (state.dateEditorOpen) {
      closeDateEditor();
      e.stopPropagation(); // Prevent further ESC handling
      return;
    }

    // Priority 2: Close lightbox if open
    if (state.lightboxOpen) {
      closeLightbox();
      return;
    }

    // Priority 3: Deselect all if on grid
    deselectAllPhotos();
  } else if (e.key === 'Enter') {
    // Don't trigger if photo picker is open (it has its own Enter handler)
    const photoPickerOverlay = document.getElementById('photoPickerOverlay');
    if (photoPickerOverlay && photoPickerOverlay.style.display !== 'none') {
      return;
    }

    // Don't trigger if user is typing in an input field
    const activeElement = document.activeElement;
    if (
      activeElement &&
      (activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.tagName === 'SELECT')
    ) {
      return; // Let the input handle Enter naturally
    }

    // Find visible primary button (not hidden, not disabled)
    // Use offsetParent check - returns null if element or any ancestor has display:none
    const allPrimaryBtns = document.querySelectorAll(
      '.btn-primary:not(:disabled)',
    );
    let primaryBtn = null;
    for (const btn of allPrimaryBtns) {
      if (btn.offsetParent !== null) {
        primaryBtn = btn;
        break;
      }
    }

    if (primaryBtn) {
      primaryBtn.click();
      e.preventDefault(); // Prevent any default Enter behavior
    } else {
    }
  } else if (e.key === 'ArrowLeft' && state.lightboxOpen) {
    navigateLightbox(-1);
  } else if (e.key === 'ArrowRight' && state.lightboxOpen) {
    navigateLightbox(1);
  } else if (
    e.key === 'r' &&
    state.lightboxOpen &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey
  ) {
    const photo = state.photos[state.lightboxPhotoIndex];
    if (!getRotateDisabledReason(photo)) {
      handleLightboxRotate();
      e.preventDefault();
    }
  } else if (
    state.lightboxOpen &&
    e.key === 'ArrowUp' &&
    (e.metaKey || e.ctrlKey)
  ) {
    closeLightbox();
    e.preventDefault();
  }
}

/**
 * Calculate frame dimensions for the displayed (post-rotation) orientation.
 * For 90/270° rotations the photo's pixel width and height are transposed
 * before the viewport-fill comparison, so the frame is always sized to match
 * what the viewer actually sees.
 *
 * Both `width` and `height` are always returned as CSS strings so callers can
 * safely swap them to derive inner-media dimensions.
 */
function calculateMediaDimensions(photo, rotationDegrees = 0) {
  const normalized = normalizeRotationDegrees(rotationDegrees);
  const isTransposed = normalized === 90 || normalized === 270;
  const baseDimensions = getLightboxVisualDimensions(photo);

  // Displayed dimensions after rotation
  const displayW = isTransposed ? baseDimensions.height : baseDimensions.width;
  const displayH = isTransposed ? baseDimensions.width : baseDimensions.height;

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
  } else {
    return {
      width: `calc(100vh * ${displayAR})`,
      height: '100vh',
    };
  }
}

/**
 * Create placeholder element
 */
function createPlaceholder(photo, dims, isDebug = false) {
  const placeholder = document.createElement('div');
  placeholder.className = 'lightbox-media-placeholder';

  if (isDebug) {
    placeholder.style.backgroundColor = 'rgba(255, 192, 203, 0.3)'; // Pink overlay for debug
    placeholder.style.zIndex = '10';
    placeholder.style.pointerEvents = 'none';
  } else {
    placeholder.style.backgroundColor = '#2a2a2a'; // Same as grid
  }

  placeholder.style.width = '100%';
  placeholder.style.height = '100%';

  return placeholder;
}

/**
 * Helper function to load media into lightbox content
 */
function loadMediaIntoContent(content, photo, isVideo, options = {}) {
  const rotationDegrees = normalizeRotationDegrees(
    options.rotationDegrees || 0,
  );
  const dims = calculateMediaDimensions(photo, rotationDegrees);

  if (isVideo) {
    // For video, show placeholder and load
    const frame = createLightboxMediaFrame();
    const placeholder = createPlaceholder(photo, dims);
    frame.appendChild(placeholder);
    content.appendChild(frame);

    const video = document.createElement('video');
    video.className = 'lightbox-media-element';
    video.src = `/api/photo/${photo.id}/file`;
    video.controls = true;
    video.autoplay = true;
    applyLightboxMediaStyles(frame, video, photo, rotationDegrees);
    video.style.backgroundColor = '#2a2a2a';

    video.addEventListener('loadeddata', () => {
      if (placeholder.parentNode) {
        placeholder.parentNode.removeChild(placeholder);
      }
      setLightboxVisualState(photo.id, video, 0);
      video.style.backgroundColor = 'transparent';
    });

    frame.appendChild(video);
  } else {
    // For images, preload in memory first
    const img = new Image();
    img.src = getPhotoFileUrl(photo.id);

    // Check if already cached
    if (img.complete && img.naturalWidth > 0) {
      const frame = createLightboxMediaFrame();
      setLightboxVisualState(photo.id, img);
      img.className = 'lightbox-media-element';
      applyLightboxMediaStyles(
        frame,
        img,
        photo,
        getLightboxPreviewRotation(photo.id),
      );
      const filename =
        photo.path?.split('/').pop() || photo.filename || `Photo ${photo.id}`;
      img.alt = filename;

      frame.appendChild(img);
      content.appendChild(frame);
    } else {
      // Not cached - show placeholder while loading
      const frame = createLightboxMediaFrame();
      const placeholder = createPlaceholder(photo, dims);
      applyLightboxMediaStyles(frame, placeholder, photo, rotationDegrees);
      frame.appendChild(placeholder);
      content.appendChild(frame);

      img.onload = () => {
        // Remove placeholder
        if (placeholder.parentNode) {
          placeholder.parentNode.removeChild(placeholder);
        }

        // Add loaded image
        setLightboxVisualState(photo.id, img);
        img.className = 'lightbox-media-element';
        applyLightboxMediaStyles(
          frame,
          img,
          photo,
          getLightboxPreviewRotation(photo.id),
        );
        const filename =
          photo.path?.split('/').pop() || photo.filename || `Photo ${photo.id}`;
        img.alt = filename;

        frame.appendChild(img);
      };

      img.onerror = async () => {
        console.error(`❌ Image ${photo.id} failed to load`);

        // Check if failure was due to database corruption
        try {
          const response = await fetch(`/api/photo/${photo.id}/file`);

          if (!response.ok) {
            const contentType = response.headers.get('content-type');

            if (contentType && contentType.includes('application/json')) {
              const data = await response.json();

              if (checkForDatabaseCorruption(data)) {
                return; // Corruption dialog shown, stop here
              }
            }
          }
        } catch (e) {
          console.error('🔍 Error checking for corruption:', e);
          // Ignore fetch errors, keep placeholder
        }

        // Keep placeholder, show error state
      };
    }
  }
}

/**
 * Open lightbox with photo at index
 */
async function openLightbox(photoIndex) {
  const overlay = document.getElementById('lightboxOverlay');
  const content = document.getElementById('lightboxContent');

  if (!overlay || !content) return;

  invalidatePendingLightboxReloads();
  clearLightboxVisualState();
  state.lightboxOpen = true;
  state.lightboxPhotoIndex = photoIndex;

  const photo = state.photos[photoIndex];
  rebaseLightboxRotationSessionForReload(photo.id);

  // Clear previous content
  content.innerHTML = '';
  content.style.backgroundColor = 'transparent';

  // Determine if photo or video - check both file_type field and path extension
  const isVideo =
    photo.file_type === 'video' ||
    (photo.path && photo.path.match(/\.(mov|mp4|m4v|avi|mpg|mpeg)$/i));
  const previewRotation = getLightboxPreviewRotation(photo.id);

  // DEBUG MODE: Show pink overlay to verify sizing
  if (DEBUG_CLICK_TO_LOAD) {
    // Load media normally (with preload logic)
    loadMediaIntoContent(content, photo, isVideo, {
      rotationDegrees: previewRotation,
    });

    // Add pink debug overlay on top
    const dims = calculateMediaDimensions(photo, previewRotation);
    const debugOverlay = createPlaceholder(photo, dims, true);
    content.appendChild(debugOverlay);
  } else {
    // PRODUCTION MODE: Auto-load media immediately
    loadMediaIntoContent(content, photo, isVideo, {
      rotationDegrees: previewRotation,
    });
  }

  overlay.style.display = 'flex';

  // Prevent body scroll while lightbox is open
  document.body.style.overflow = 'hidden';

  // Update star button state based on photo rating
  const starBtn = document.getElementById('lightboxStarBtn');
  if (starBtn) {
    const starIcon = starBtn.querySelector('.material-symbols-outlined');
    if (starIcon) {
      // Photo is starred if rating === 5
      if (photo.rating === 5) {
        starIcon.classList.add('filled');
      } else {
        starIcon.classList.remove('filled');
      }
    }
  }

  // Update info panel with photo details
  updateLightboxRotateButtonState(photo);

  const infoDate = document.getElementById('infoDate');
  const infoFilename = document.getElementById('infoFilename');

  if (infoDate) {
    const date = parsePhotoDate(photo);
    const month = photo.month;
    const canJumpToMonth = isCalendarMonthKey(month);

    if (date) {
      const dateString = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const timeString = date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      infoDate.textContent = `${dateString} at ${timeString}`;
    } else {
      infoDate.textContent = 'No date in library';
    }

    if (date && canJumpToMonth) {
      infoDate.onclick = (e) => {
        e.preventDefault();
        state.navigateToMonth = month;
        closeLightbox();
      };
      infoDate.style.cursor = 'pointer';
    } else {
      infoDate.onclick = null;
      infoDate.style.cursor = 'default';
    }
  }

  if (infoFilename) {
    // Extract actual filename from current path
    const currentFilename = photo.path
      ? photo.path.split('/').pop()
      : photo.filename || 'Unknown';
    infoFilename.textContent = currentFilename;

    // Wire up click to reveal in Finder
    infoFilename.onclick = async (e) => {
      e.preventDefault();
      const filename = photo.path
        ? photo.path.split('/').pop()
        : photo.filename || photo.id;

      try {
        const response = await fetch(`/api/photo/${photo.id}/reveal`, {
          method: 'POST',
        });

        if (!response.ok) {
          const error = await response.json();
          console.error('❌ Failed to reveal in Finder:', error);
        } else {
        }
      } catch (error) {
        console.error('❌ Error revealing in Finder:', error);
      }
    };
  }

  // Scroll grid to current photo position (instant, behind the lightbox)
  const card = document.querySelector(`[data-index="${photoIndex}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'instant', block: 'center' });
  }

  // Preload adjacent images for smooth navigation
  preloadAdjacentImages(photoIndex);

  // Show UI initially, then start auto-hide timer
  showLightboxUI();
  resetLightboxUITimeout();

  // Update arrow states based on position
  updateLightboxArrowStates();
}

/**
 * Preload adjacent images for smooth navigation
 */
function preloadAdjacentImages(currentIndex) {
  const prevIndex = currentIndex - 1;
  const nextIndex = currentIndex + 1;

  // Preload previous image
  if (prevIndex >= 0 && prevIndex < state.photos.length) {
    const prevPhoto = state.photos[prevIndex];
    const prevImg = new Image();
    prevImg.src = getPhotoFileUrl(prevPhoto.id);
  }

  // Preload next image
  if (nextIndex >= 0 && nextIndex < state.photos.length) {
    const nextPhoto = state.photos[nextIndex];
    const nextImg = new Image();
    nextImg.src = getPhotoFileUrl(nextPhoto.id);
  }
}

/**
 * Update lightbox placeholder dimensions based on aspect ratio
 * (No longer needed with real images, keeping for compatibility)
 */
function updateLightboxDimensions(placeholder, aspectRatio) {
  // Deprecated - real images handle their own aspect ratio
}

/**
 * Close lightbox
 */
async function closeLightbox() {
  const overlay = document.getElementById('lightboxOverlay');
  if (!overlay) return;
  if (state.lightboxClosing) return;

  state.lightboxClosing = true;
  updateLightboxRotateButtonState();

  const saved = await commitPendingLightboxRotations();
  if (!saved) {
    state.lightboxClosing = false;
    updateLightboxRotateButtonState();

    return;
  }

  // Stop any playing videos
  const video = overlay.querySelector('video');
  if (video) {
    video.pause();
    video.currentTime = 0;
  }

  // Hide info panel
  const infoPanel = document.getElementById('lightboxInfoPanel');
  if (infoPanel) {
    infoPanel.style.display = 'none';
  }
  if (overlay) {
    overlay.classList.remove('info-open');
  }

  // Grid is already positioned (from openLightbox), just close
  invalidatePendingLightboxReloads();
  clearLightboxVisualState();
  state.lightboxOpen = false;
  state.lightboxPhotoIndex = null;
  overlay.style.display = 'none';

  // Restore body scroll
  document.body.style.overflow = '';

  // Clear UI timeout
  if (state.lightboxUITimeout) {
    clearTimeout(state.lightboxUITimeout);
    state.lightboxUITimeout = null;
  }

  // Check if we need to navigate to a specific month
  if (state.navigateToMonth) {
    const month = state.navigateToMonth;
    state.navigateToMonth = null; // Clear flag

    // Scroll to month header after lightbox closes
    setTimeout(() => {
      const monthSection = document.getElementById(`month-${month}`);

      if (monthSection) {
        const monthHeader = monthSection.querySelector('.month-header');
        const target = monthHeader || monthSection;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        console.warn('⚠️ Month section not found:', month);
      }
    }, 100);
  }

  state.lightboxClosing = false;
}

/**
 * Update lightbox navigation arrow states based on current position
 */
function updateLightboxArrowStates() {
  const prevBtn = document.getElementById('lightboxPrevBtn');
  const nextBtn = document.getElementById('lightboxNextBtn');

  if (!prevBtn || !nextBtn) return;

  const currentIndex = state.lightboxPhotoIndex;
  const totalPhotos = state.photos.length;

  // Dim left arrow if at first photo
  if (currentIndex <= 0) {
    prevBtn.classList.add('inactive');
  } else {
    prevBtn.classList.remove('inactive');
  }

  // Dim right arrow if at last photo
  if (currentIndex >= totalPhotos - 1) {
    nextBtn.classList.add('inactive');
  } else {
    nextBtn.classList.remove('inactive');
  }
}

/**
 * Navigate to next/prev photo in lightbox
 */
function navigateLightbox(direction) {
  if (state.lightboxPhotoIndex === null) return;

  const newIndex = state.lightboxPhotoIndex + direction;

  // Bounds check
  if (newIndex < 0 || newIndex >= state.photos.length) {
    return;
  }

  openLightbox(newIndex);
}

// =====================
// DATA LOADING
// =====================

/**
 * Fetch photos from the API
 */
async function fetchPhotos(offset = 0, limit = 100) {
  const sort = state.currentSortOrder;
  const url = `/api/photos?offset=${offset}&limit=${limit}&sort=${sort}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.photos || [];
  } catch (error) {
    console.error('Error fetching photos:', error);
    return [];
  }
}

/**
 * Load ALL photos metadata at once (lightweight)
 */
async function loadAndRenderPhotos(append = false, options = {}) {
  const {
    throwOnError = false,
    generation = state.libraryGeneration,
    sortOrder = state.currentSortOrder,
  } = options;

  if (currentPhotoLoadAbortController) {
    currentPhotoLoadAbortController.abort();
  }

  const loadId = ++photoLoadRequestId;
  const abortController = new AbortController();
  currentPhotoLoadAbortController = abortController;
  state.loading = true;

  const loadPromise = (async () => {
    try {
      // Fetch ALL photos (no limit) - just id, date, month, file_type
      const response = await fetch(`/api/photos?sort=${sortOrder}`, {
        signal: abortController.signal,
      });
      const data = await response.json();

      const isStaleLoad =
        abortController.signal.aborted ||
        loadId !== photoLoadRequestId ||
        !isCurrentLibraryGeneration(generation) ||
        sortOrder !== state.currentSortOrder;

      if (isStaleLoad) {
        return false;
      }

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load photos');
      }

      // Check for database corruption
      if (checkForDatabaseCorruption(data)) {
        throw new Error(
          data.error || data.message || 'Database appears corrupted',
        );
      }

      state.photos = data.photos;
      state.hasDatabase = true; // Database exists if we successfully loaded photos

      // Reset shift-select anchor when reloading (indices may have changed)
      if (!append) {
        state.lastClickedIndex = null;
      }

      // Render entire grid structure immediately (placeholders)
      renderPhotoGrid(state.photos, false);

      // Setup lazy loading for thumbnails
      setupThumbnailLazyLoading();

      // Update utility menu availability after loading photos
      updateUtilityMenuAvailability();

      // Update date picker to reflect current photo years (show/hide as needed)
      await populateDatePicker();

      const isStaleAfterPicker =
        abortController.signal.aborted ||
        loadId !== photoLoadRequestId ||
        !isCurrentLibraryGeneration(generation) ||
        sortOrder !== state.currentSortOrder;

      if (isStaleAfterPicker) {
        return false;
      }

      // Re-enable app bar buttons after transition
      enableAppBarButtons();
      return true;
    } catch (error) {
      const isExpectedAbort =
        error.name === 'AbortError' || abortController.signal.aborted;
      const isStaleError =
        loadId !== photoLoadRequestId || !isCurrentLibraryGeneration(generation);

      if (isExpectedAbort || isStaleError) {
        return false;
      }
      console.error('❌ Error loading photos:', error);
      state.hasDatabase = false; // Mark database as unavailable on error
      throw error;
    } finally {
      if (currentPhotoLoad?.id === loadId) {
        currentPhotoLoad = null;
      }
      if (currentPhotoLoadAbortController === abortController) {
        currentPhotoLoadAbortController = null;
      }
      state.loading = currentPhotoLoad !== null;
    }
  })();

  currentPhotoLoad = {
    id: loadId,
    append,
    generation,
    sortOrder,
    promise: loadPromise,
  };

  if (throwOnError) {
    return await loadPromise;
  }

  try {
    return await loadPromise;
  } catch {
    return false;
  }
}

/**
 * Hydrate the grid for a library generation after switch (e.g. deferPhotoReload).
 * Retries once if the first load was superseded (stale), which avoids an empty grid.
 *
 * If the inner load returns false but still applied data (e.g. stale check after
 * populateDatePicker) or a second load aborted the first, we accept the result when
 * generation matches and the session has a usable DB snapshot.
 */
async function loadAndRenderPhotosCommitted(generation) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ok = await loadAndRenderPhotos(false, {
      throwOnError: true,
      generation,
    });
    if (ok === true) {
      return true;
    }
    if (!isCurrentLibraryGeneration(generation)) {
      throw new Error('Library changed while loading photos.');
    }
  }
  if (isCurrentLibraryGeneration(generation) && state.hasDatabase) {
    enableAppBarButtons();
    return true;
  }
  throw new Error('Photos failed to load. Try refreshing the page.');
}

/**
 * Setup lazy loading for thumbnails (only load when visible)
 */
let thumbnailObserver = null;

function setupThumbnailLazyLoading() {
  // Disconnect existing observer to clear stale references
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
  }

  // Create fresh observer
  thumbnailObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const img = entry.target;
          const photoId = img.dataset.photoId;

          if (photoId && !img.src) {
            // Load thumbnail
            img.src = getPhotoThumbnailUrl(photoId);
            img.classList.add('loading');

            img.onload = () => {
              img.classList.remove('loading');
              // Inject select circle now that image is loaded
              const photoCard = img.closest('.photo-card');
              if (photoCard && !photoCard.querySelector('.select-circle')) {
                const circle = document.createElement('div');
                circle.className = 'select-circle';
                photoCard.insertBefore(circle, photoCard.firstChild);
                photoCard.classList.add('loaded');
              }
            };

            img.onerror = () => {
              img.classList.remove('loading');
              img.classList.add('error');
            };

            // Stop observing once loaded
            thumbnailObserver.unobserve(img);
          }
        }
      });
    },
    {
      rootMargin: '1000px', // Load 1000px before entering viewport for smoother experience
    },
  );

  // Observe all thumbnail images that don't have src yet
  const thumbnails = document.querySelectorAll('.photo-thumb:not([src])');
  thumbnails.forEach((thumb) => thumbnailObserver.observe(thumb));
}

// =====================
// RENDERING
// =====================

/**
 * First run or no library configured — open library + add photos
 */
function renderFirstRunEmptyState() {
  const container = document.getElementById('photoContainer');
  if (!container) return;

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: calc(100vh - 64px); margin-top: -48px; color: var(--text-color); gap: 24px;">
      <div style="text-align: center;">
        <div style="font-size: 18px; margin-bottom: 8px;">Create a library</div>
        <div style="font-size: 14px; color: var(--text-secondary);">Add photos or open an existing library to get started.</div>
      </div>
      <div style="display: flex; gap: 12px;">
        <button class="btn" onclick="logOpenLibraryAccessPoint('first-run-empty-state')" style="display: flex; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.1); color: var(--text-primary); white-space: nowrap;">
          <span class="material-symbols-outlined" style="font-size: 18px; width: 18px; height: 18px; display: inline-block; overflow: hidden;">folder_open</span>
          <span>Open library</span>
        </button>
        <button class="btn btn-primary" onclick="triggerImportWithLibraryCheck()" style="display: flex; align-items: center; gap: 8px; white-space: nowrap;">
          <span class="material-symbols-outlined" style="font-size: 18px; width: 18px; height: 18px; display: inline-block; overflow: hidden;">add_a_photo</span>
          <span>Add photos</span>
        </button>
      </div>
    </div>
  `;
}

/**
 * Library is open but contains no photos — add photos only
 */
function renderEmptyLibraryState() {
  const container = document.getElementById('photoContainer');
  if (!container) return;

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: calc(100vh - 64px); margin-top: -48px; color: var(--text-color); gap: 24px;">
      <div style="text-align: center;">
        <div style="font-size: 18px; margin-bottom: 8px;">This library is empty</div>
        <div style="font-size: 14px; color: var(--text-secondary);">Add some photos to get started.</div>
      </div>
      <div style="display: flex; gap: 12px;">
        <button class="btn btn-primary" onclick="triggerImport()" style="display: flex; align-items: center; gap: 8px; white-space: nowrap;">
          <span class="material-symbols-outlined" style="font-size: 18px; width: 18px; height: 18px; display: inline-block; overflow: hidden;">add_a_photo</span>
          <span>Add photos</span>
        </button>
      </div>
    </div>
  `;
}

/**
 * Render photo grid with real data
 */
function renderPhotoGrid(photos, append = false) {
  const container = document.getElementById('photoContainer');

  // Clear container if not appending
  if (!append) {
    container.innerHTML = '';
  }

  if (!photos || photos.length === 0) {
    if (!append) {
      if (state.hasDatabase) {
        renderEmptyLibraryState();
      } else {
        renderFirstRunEmptyState();
      }
    }
    return;
  }

  // Group photos by month
  const photosByMonth = {};
  photos.forEach((photo, idx) => {
    const monthKey = photo.month || 'undated';
    if (!photosByMonth[monthKey]) {
      photosByMonth[monthKey] = [];
    }
    // Use globalIndex if provided, otherwise use idx
    const globalIndex =
      photo.globalIndex !== undefined ? photo.globalIndex : idx;
    photosByMonth[monthKey].push({ ...photo, globalIndex });
  });

  // Render each month section
  let html = '';

  Object.keys(photosByMonth).forEach((month) => {
    let monthLabel;
    if (month === 'undated') {
      monthLabel = 'Undated';
    } else {
      const [year, monthNum] = month.split('-');
      const monthName = new Date(
        parseInt(year, 10),
        parseInt(monthNum, 10) - 1,
      ).toLocaleString('default', { month: 'long' });
      monthLabel = `${monthName} ${year}`;
    }

    // Check if this month section already exists (for append mode)
    const existingSection = append
      ? container.querySelector(`[data-month="${month}"]`)
      : null;

    if (existingSection) {
      // Append to existing month grid
      const grid = existingSection.querySelector('.photo-grid');
      photosByMonth[month].forEach((photo) => {
        const card = document.createElement('div');
        card.className = 'photo-card';
        card.dataset.id = photo.id;
        card.dataset.index = photo.globalIndex;

        // Build star badge HTML if photo is starred
        const starBadgeHTML =
          photo.rating === 5
            ? '<div class="star-badge"><span class="material-symbols-outlined">star</span></div>'
            : '';

        // Build video badge HTML if photo is a video
        const videoBadgeHTML =
          photo.file_type === 'video'
            ? '<div class="video-badge"><span class="material-symbols-outlined">play_circle</span></div>'
            : '';

        card.innerHTML = `
          <img src="${getPhotoThumbnailUrl(photo.id)}" alt="" loading="lazy" class="photo-thumb" data-photo-id="${photo.id}">
          ${starBadgeHTML}
          ${videoBadgeHTML}
        `;
        grid.appendChild(card);
      });
    } else {
      // Create new month section (with select circle in header)
      html += `
        <div class="month-section" id="month-${month}" data-month="${month}">
          <div class="month-header">
            <span class="month-label">${monthLabel}</span>
            <div class="month-select-circle"></div>
          </div>
          <div class="photo-grid">
      `;

      photosByMonth[month].forEach((photo) => {
        const globalIndex =
          photo.globalIndex !== undefined
            ? photo.globalIndex
            : photosByMonth[month].indexOf(photo);

        // Build star badge HTML if photo is starred
        const starBadgeHTML =
          photo.rating === 5
            ? '<div class="star-badge"><span class="material-symbols-outlined">star</span></div>'
            : '';

        // Build video badge HTML if photo is a video
        const videoBadgeHTML =
          photo.file_type === 'video'
            ? '<div class="video-badge"><span class="material-symbols-outlined">play_circle</span></div>'
            : '';

        html += `
          <div class="photo-card" data-id="${photo.id}" data-index="${globalIndex}">
            <img data-photo-id="${photo.id}" alt="" class="photo-thumb">
            ${starBadgeHTML}
            ${videoBadgeHTML}
          </div>
        `;
      });

      html += `
          </div>
        </div>
      `;
    }
  });

  if (append) {
    // Find sentinel and insert before it
    const sentinel = document.getElementById('scroll-sentinel');
    if (sentinel && html) {
      sentinel.insertAdjacentHTML('beforebegin', html);
    }
  } else {
    container.innerHTML = html;
  }

  // Wire up photo card clicks
  wirePhotoCards();

  // Wire up month selection circles
  wireMonthSelectors();

  // Notify date picker to observe new month sections
  if (state.onMonthsRendered) {
    state.onMonthsRendered();
  }
}

/**
 * Wire up photo card interactions
 */
function wirePhotoCards() {
  const cards = document.querySelectorAll('.photo-card');

  cards.forEach((card) => {
    const selectCircle = card.querySelector('.select-circle');
    const photoArea = card.querySelector('.placeholder');

    // Click on card: handle selection or open lightbox
    card.addEventListener('click', (e) => {
      const index = parseInt(card.dataset.index);

      // If there's an active selection, ALL clicks toggle selection
      if (state.selectedPhotos.size > 0) {
        togglePhotoSelection(card, e);
        return;
      }

      // If shift is held, always select (for shift-select range)
      if (e.shiftKey) {
        e.stopPropagation();
        togglePhotoSelection(card, e);
        return;
      }

      // If clicking the select circle, toggle selection
      // Query for it at click time since it's dynamically created
      const selectCircle = card.querySelector('.select-circle');
      if (
        selectCircle &&
        (e.target === selectCircle || selectCircle.contains(e.target))
      ) {
        e.stopPropagation();
        togglePhotoSelection(card, e);
        return;
      }

      // Otherwise, open lightbox
      openLightbox(index);
    });
  });
}

/**
 * Toggle photo selection (for multi-select)
 */
function togglePhotoSelection(card, e) {
  const id = parseInt(card.dataset.id);
  const index = parseInt(card.dataset.index);

  // SHIFT-SELECT: Select range
  if (e.shiftKey && state.lastClickedIndex !== null) {
    const start = Math.min(state.lastClickedIndex, index);
    const end = Math.max(state.lastClickedIndex, index);

    // Get all photo cards in the DOM
    const allCards = Array.from(document.querySelectorAll('.photo-card'));

    // Debug: show sample of indices
    const sampleIndices = allCards
      .slice(0, 10)
      .map((c) => parseInt(c.dataset.index));

    // Filter to cards within the range
    const cardsInRange = allCards.filter((c) => {
      const cardIndex = parseInt(c.dataset.index);
      return cardIndex >= start && cardIndex <= end;
    });

    // Debug: if we found fewer than expected, show what's missing
    if (cardsInRange.length < end - start + 1) {
      const foundIndices = new Set(
        cardsInRange.map((c) => parseInt(c.dataset.index)),
      );
      const missing = [];
      for (let i = start; i <= end && missing.length < 10; i++) {
        if (!foundIndices.has(i)) missing.push(i);
      }
      console.warn(
        `⚠️ Missing ${end - start + 1 - cardsInRange.length} cards. First missing indices: ${missing.join(', ')}`,
      );
    }

    // Select all cards in range
    cardsInRange.forEach((rangeCard) => {
      const rangeId = parseInt(rangeCard.dataset.id);
      rangeCard.classList.add('selected');
      state.selectedPhotos.add(rangeId);
    });

    updateDeleteButtonVisibility();
  }
  // NORMAL CLICK: Toggle single
  else {
    if (card.classList.contains('selected')) {
      card.classList.remove('selected');
      state.selectedPhotos.delete(id);
    } else {
      card.classList.add('selected');
      state.selectedPhotos.add(id);
    }

    // Update last clicked index for next shift-select
    state.lastClickedIndex = index;
    updateDeleteButtonVisibility();
    updateMonthCircleStates(); // Update month circles
  }
}

/**
 * Wire up month selection circles
 */
function wireMonthSelectors() {
  const monthCircles = document.querySelectorAll('.month-select-circle');

  monthCircles.forEach((circle) => {
    const monthSection = circle.closest('.month-section');
    const month = monthSection.dataset.month;

    circle.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault(); // Prevent text selection on shift-click

      // Get all photos in this month
      const monthPhotoCards = monthSection.querySelectorAll('.photo-card');
      if (monthPhotoCards.length === 0) return;

      // Use first photo as anchor for normal clicks, last photo for shift-clicks
      const firstPhotoIndex = parseInt(monthPhotoCards[0].dataset.index);
      const lastPhotoIndex = parseInt(
        monthPhotoCards[monthPhotoCards.length - 1].dataset.index,
      );

      if (e.shiftKey && state.lastClickedIndex !== null) {
        // SHIFT-SELECT: Select range from last clicked to this month's LAST photo
        const start = Math.min(state.lastClickedIndex, lastPhotoIndex);
        const end = Math.max(state.lastClickedIndex, lastPhotoIndex);

        // Get all photo cards and select those in range
        const allCards = Array.from(document.querySelectorAll('.photo-card'));
        const cardsInRange = allCards.filter((c) => {
          const cardIndex = parseInt(c.dataset.index);
          return cardIndex >= start && cardIndex <= end;
        });

        cardsInRange.forEach((card) => {
          const cardId = parseInt(card.dataset.id);
          card.classList.add('selected');
          state.selectedPhotos.add(cardId);
        });

        // Update anchor to this month's last photo
        state.lastClickedIndex = lastPhotoIndex;
        updateDeleteButtonVisibility();
        updateMonthCircleStates();
      } else {
        // NORMAL CLICK: Toggle entire month
        toggleMonthSelection(month);

        // Update anchor to this month's last photo for next shift-select
        state.lastClickedIndex = lastPhotoIndex;
      }
    });
  });
}

/**
 * Toggle selection for all photos in a month
 */
function toggleMonthSelection(month) {
  const monthSection = document.querySelector(`[data-month="${month}"]`);
  if (!monthSection) return;

  const photoCards = monthSection.querySelectorAll('.photo-card');
  const photoIds = Array.from(photoCards).map((card) =>
    parseInt(card.dataset.id),
  );

  // Check if all photos in this month are already selected
  const allSelected = photoIds.every((id) => state.selectedPhotos.has(id));

  if (allSelected) {
    // Deselect all photos in this month
    photoCards.forEach((card) => {
      card.classList.remove('selected');
      const id = parseInt(card.dataset.id);
      state.selectedPhotos.delete(id);
    });
  } else {
    // Select all photos in this month
    photoCards.forEach((card) => {
      card.classList.add('selected');
      const id = parseInt(card.dataset.id);
      state.selectedPhotos.add(id);
    });
  }

  updateDeleteButtonVisibility();
  updateMonthCircleStates();
}

/**
 * Update visual state of month selection circles
 */
function updateMonthCircleStates() {
  const monthSections = document.querySelectorAll('.month-section');

  monthSections.forEach((section) => {
    const photoCards = section.querySelectorAll('.photo-card');
    const photoIds = Array.from(photoCards).map((card) =>
      parseInt(card.dataset.id),
    );
    const allSelected =
      photoIds.length > 0 &&
      photoIds.every((id) => state.selectedPhotos.has(id));

    const circle = section.querySelector('.month-select-circle');
    if (circle) {
      if (allSelected) {
        circle.classList.add('selected');
      } else {
        circle.classList.remove('selected');
      }
    }
  });
}

// =====================
// DELETE FUNCTIONALITY
// =====================

/**
 * Delete photos - with undo support via trash tracking
 */
async function deletePhotos(photoIds) {
  if (state.deleteInProgress) return;
  state.deleteInProgress = true;

  try {
    // Delete immediately from backend (moves to trash + deleted_photos table)
    const response = await fetch('/api/photos/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: photoIds }),
    });

    if (!response.ok) {
      throw new Error(`Delete failed: ${response.status}`);
    }

    const result = await response.json();

    // Clear selection and shift-select anchor
    state.selectedPhotos.clear();
    state.lastClickedIndex = null;
    updateDeleteButtonVisibility();

    // Close lightbox if open
    if (state.lightboxOpen) {
      closeLightbox();
    }

    // Reload grid to sync with DB
    await loadAndRenderPhotos(false);

    // Show success toast with undo
    const count = result.deleted;
    showToast(`Deleted ${count} photo${count > 1 ? 's' : ''}`, () =>
      undoDelete(photoIds),
    );
  } catch (error) {
    console.error('❌ Delete error:', error);
    showToast('Delete failed', null);
  } finally {
    state.deleteInProgress = false;
  }
}

/**
 * Undo date edit by restoring original dates
 */
async function undoDateEdit(originalDates) {
  try {
    // Restore each photo to its original date
    const promises = originalDates.map(({ id, originalDate }) =>
      fetch('/api/photo/update_date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_id: id, new_date: originalDate }),
      }),
    );

    const responses = await Promise.all(promises);

    // Check if all succeeded
    const allSucceeded = responses.every((r) => r.ok);

    if (allSucceeded) {
      // Reload grid to reflect restored dates
      await loadAndRenderPhotos(false);

      showToast('Date change undone', null);
    } else {
      throw new Error('Some updates failed');
    }
  } catch (error) {
    console.error('❌ Undo date edit error:', error);
    showToast('Undo failed', null);
  }
}

/**
 * Undo delete by restoring from trash
 */
async function undoDelete(photoIds) {
  try {
    const response = await fetch('/api/photos/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: photoIds }),
    });

    if (!response.ok) {
      throw new Error(`Restore failed: ${response.status}`);
    }

    const result = await response.json();

    // Reload grid to show restored photos
    await loadAndRenderPhotos(false);

    const count = result.restored;
    showToast(`Restored ${count} photo${count > 1 ? 's' : ''}`, null);
  } catch (error) {
    console.error('❌ Restore error:', error);
    showToast('Restore failed', null);
  }
}

// =====================
// IMPORT FUNCTIONALITY
// =====================

let importState = {
  isImporting: false,
  totalFiles: 0,
  importedCount: 0,
  duplicateCount: 0,
  errorCount: 0,
  backupPath: null,
  importedPhotoIds: [],
  results: [],
  abortController: null,
  cancelRequested: false,
};

// Toggle this on if cancelling an import should require confirmation.
const IMPORT_CANCEL_CONFIRMATION_ENABLED = false;

function setImportActionButtons({
  showCancel = false,
  showDone = false,
  showUndo = false,
} = {}) {
  const cancelBtn = document.getElementById('importCancelBtn');
  const doneBtn = document.getElementById('importDoneBtn');
  const undoBtn = document.getElementById('importUndoBtn');

  if (cancelBtn) cancelBtn.style.display = showCancel ? 'block' : 'none';
  if (doneBtn) doneBtn.style.display = showDone ? 'block' : 'none';
  if (undoBtn) undoBtn.style.display = showUndo ? 'block' : 'none';
}

function resetImportSession(totalFiles) {
  importState.isImporting = true;
  importState.totalFiles = totalFiles;
  importState.importedCount = 0;
  importState.duplicateCount = 0;
  importState.errorCount = 0;
  importState.importedPhotoIds = [];
  importState.results = [];
  importState.cancelRequested = false;

  window.importErrors = [];
  window.importRejections = [];
  window.importedPhotoIds = [];

  const statusText = document.getElementById('importStatusText');
  const stats = document.getElementById('importStats');
  const detailsSection = document.getElementById('importDetailsSection');
  const detailsList = document.getElementById('importDetailsList');
  const toggleBtn = document.getElementById('importDetailsToggle');
  const importedCount = document.getElementById('importedCount');
  const duplicateCount = document.getElementById('duplicateCount');
  const errorCount = document.getElementById('errorCount');

  if (statusText) {
    statusText.textContent = `Preparing import of ${totalFiles} file${
      totalFiles === 1 ? '' : 's'
    }...`;
  }
  if (stats) stats.style.display = 'none';
  if (detailsSection) detailsSection.style.display = 'none';
  if (detailsList) {
    detailsList.innerHTML = '';
    detailsList.style.display = 'none';
  }
  if (toggleBtn) {
    toggleBtn.classList.remove('expanded');
    toggleBtn.innerHTML = `
      <span class="material-symbols-outlined">expand_more</span>
      <span>Show details</span>
    `;
  }
  if (importedCount) importedCount.textContent = '0';
  if (duplicateCount) duplicateCount.textContent = '0';
  if (errorCount) errorCount.textContent = '0';

  setImportActionButtons({ showCancel: true });
}

function finishImportSession() {
  importState.isImporting = false;
  importState.abortController = null;
  importState.cancelRequested = false;
}

function scheduleImportRefresh(delayMs = 1500) {
  window.setTimeout(() => {
    loadAndRenderPhotos(false).catch((error) => {
      console.error('❌ Follow-up import refresh failed:', error);
    });
  }, delayMs);
}

/**
 * Load import overlay fragment
 */
async function loadImportOverlay() {
  if (document.getElementById('importOverlay')) {
    return;
  }

  const mount = document.getElementById('importOverlayMount');
  if (!mount) {
    console.error('❌ Import overlay mount not found');
    return;
  }

  try {
    const response = await fetch('fragments/importOverlay.html?v=2');
    if (!response.ok)
      throw new Error(`Failed to load import overlay (${response.status})`);

    const html = await response.text();
    mount.insertAdjacentHTML('beforeend', html);
    wireImportOverlay();
  } catch (error) {
    console.error('❌ Import overlay load failed:', error);
  }
}

/**
 * Wire up import overlay event handlers
 */
function wireImportOverlay() {
  const closeBtn = document.getElementById('importCloseBtn');
  const cancelBtn = document.getElementById('importCancelBtn');
  const doneBtn = document.getElementById('importDoneBtn');
  const undoBtn = document.getElementById('importUndoBtn');
  const detailsToggle = document.getElementById('importDetailsToggle');

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      closeImportOverlay();
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      cancelImport();
    });
  }

  if (doneBtn) {
    doneBtn.addEventListener('click', async () => {
      // Scroll to first imported photo if we have any
      if (window.importedPhotoIds && window.importedPhotoIds.length > 0) {
        scrollToImportedPhoto(window.importedPhotoIds);
      }
      await closeImportOverlay();
    });
  }

  if (undoBtn) {
    undoBtn.addEventListener('click', undoImport);
  }

  if (detailsToggle) {
    detailsToggle.addEventListener('click', () => {
      const detailsList = document.getElementById('importDetailsList');
      const isExpanded = detailsToggle.classList.toggle('expanded');

      if (detailsList) {
        detailsList.style.display = isExpanded ? 'block' : 'none';
      }
    });
  }
}

/**
 * Start import process with SSE
 */
/**
 * Update import UI with progress
 */
function updateImportUI(statusText, showSpinner = false) {
  const statusTextEl = document.getElementById('importStatusText');
  const importStatsEl = document.getElementById('importStats');
  const importedCountEl = document.getElementById('importedCount');
  const duplicateCountEl = document.getElementById('duplicateCount');
  const errorCountEl = document.getElementById('errorCount');

  if (statusTextEl) {
    if (showSpinner) {
      statusTextEl.innerHTML = `${statusText}<span class="import-spinner"></span>`;
    } else {
      statusTextEl.textContent = statusText;
    }
  }

  // Show stats immediately when status changes to "Processing"
  if (statusText.startsWith('Processing') && importStatsEl) {
    importStatsEl.style.display = 'flex';
  }

  // Hide actions section during "Preparing" and "Processing" states
  const actionsSection = document.querySelector('.import-actions');
  if (actionsSection) {
    if (
      statusText.startsWith('Preparing') ||
      statusText.startsWith('Processing')
    ) {
      actionsSection.style.display = 'none';
    }
  }

  // Instant updates - no animation
  if (importedCountEl) {
    importedCountEl.textContent = importState.importedCount;
  }
  if (duplicateCountEl) {
    duplicateCountEl.textContent = importState.duplicateCount;
  }
  if (errorCountEl) {
    errorCountEl.textContent = importState.errorCount;
  }
}

/**
 * Show import overlay
 */
function showImportOverlay() {
  const overlay = document.getElementById('importOverlay');
  if (overlay) {
    overlay.style.display = 'flex';
  }
}

async function hideImportOverlay(reloadPhotos = true) {
  const overlay = document.getElementById('importOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }

  if (reloadPhotos) {
    await loadAndRenderPhotos(false);
  }
}

/**
 * Close import overlay
 */
async function closeImportOverlay() {
  if (importState.isImporting) {
    await cancelImport();
    return;
  }

  await hideImportOverlay();
}

/**
 * Scroll to first imported photo based on current sort order
 */
function scrollToImportedPhoto(photoIds) {
  if (!photoIds || photoIds.length === 0) return;

  // Find the first imported photo ID that exists in current view
  // (respects current sort order - newest/oldest)
  const firstVisibleId = photoIds.find((id) => {
    const element = document.querySelector(`[data-photo-id="${id}"]`);
    return element !== null;
  });

  if (firstVisibleId) {
    const element = document.querySelector(
      `[data-photo-id="${firstVisibleId}"]`,
    );
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Optional: briefly highlight the photo
      element.style.outline = '3px solid #6366f1';
      setTimeout(() => {
        element.style.outline = '';
      }, 2000);
    }
  }
}

/**
 * Show import complete UI (show details, done, undo buttons)
 */
async function showImportComplete() {
  const cancelBtn = document.getElementById('importCancelBtn');
  const doneBtn = document.getElementById('importDoneBtn');
  const undoBtn = document.getElementById('importUndoBtn');
  const detailsSection = document.getElementById('importDetailsSection');
  const actionsSection = document.querySelector('.import-actions');

  if (cancelBtn) cancelBtn.style.display = 'none';
  if (doneBtn) doneBtn.style.display = 'block';
  if (undoBtn && importState.importedCount > 0) undoBtn.style.display = 'block';
  if (detailsSection) detailsSection.style.display = 'block';

  // Show actions section in results state
  if (actionsSection) actionsSection.style.display = 'flex';

  // Populate details list
  populateImportDetails();

  // Reload grid immediately to show new photos
  await loadAndRenderPhotos(false);

  // Scroll to first imported photo based on sort order
  if (
    importState.importedPhotoIds.length > 0 &&
    importState.results.length > 0
  ) {
    // Get the date of the first successfully imported photo
    const firstImported = importState.results.find(
      (r) => r.status === 'success' && r.photo_id,
    );

    if (firstImported && firstImported.date) {
      // Extract month from date (YYYY:MM:DD HH:MM:SS -> YYYY-MM)
      const dateStr = firstImported.date.replace(/:/g, '-');
      const monthStr = dateStr.substring(0, 7); // YYYY-MM

      // Wait for grid to render, then scroll to the month section
      setTimeout(() => {
        const monthSection = document.getElementById(`month-${monthStr}`);
        if (monthSection) {
          const appBarHeight = 60;
          const targetY = monthSection.offsetTop - appBarHeight - 20;
          window.scrollTo({ top: targetY, behavior: 'smooth' });
        }
      }, 500);
    }
  }
}

/**
 * Populate import details list
 */
function populateImportDetails() {
  const detailsList = document.getElementById('importDetailsList');
  if (!detailsList) return;

  detailsList.innerHTML = '';

  importState.results.forEach((result) => {
    const item = document.createElement('div');
    item.className = 'import-detail-item';

    let icon = '';
    let iconClass = '';

    if (result.status === 'success') {
      icon = 'check_circle';
      iconClass = 'success';
    } else if (result.status === 'duplicate') {
      icon = 'content_copy';
      iconClass = 'duplicate';
    } else {
      icon = 'error';
      iconClass = 'error';
    }

    item.innerHTML = `
      <span class="material-symbols-outlined import-detail-icon ${iconClass}">${icon}</span>
      <div class="import-detail-text">
        <div>${result.filename}</div>
        ${
          result.message
            ? `<div class="import-detail-message">${result.message}</div>`
            : ''
        }
      </div>
    `;

    detailsList.appendChild(item);
  });
}

/**
 * Cancel import in progress
 */
async function cancelImport() {
  if (!importState.isImporting || !importState.abortController) {
    await hideImportOverlay();
    return;
  }

  let confirmed = true;
  if (IMPORT_CANCEL_CONFIRMATION_ENABLED) {
    confirmed = await showDialog(
      'Stop import',
      'Stop importing now? Photos already imported will stay in the library.',
      [
        { text: 'Keep importing', value: false, secondary: true },
        { text: 'Stop import', value: true, primary: true },
      ],
    );
  }

  if (!confirmed) {
    return;
  }

  const importedCount = importState.importedCount;
  const controller = importState.abortController;

  importState.cancelRequested = true;
  importState.isImporting = false;
  importState.abortController = null;

  controller.abort();
  await hideImportOverlay();
  scheduleImportRefresh();

  showToast(
    `Import stopped after ${importedCount} image${
      importedCount === 1 ? '' : 's'
    }`,
    null,
  );
}

/**
 * Undo import - delete all imported photos
 */
async function undoImport() {
  if (importState.importedPhotoIds.length === 0) {
    showToast('Nothing to undo', null);
    return;
  }

  try {
    // Delete all imported photos
    const response = await fetch('/api/photos/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: importState.importedPhotoIds }),
    });

    if (!response.ok) {
      throw new Error(`Undo failed: ${response.status}`);
    }

    const result = await response.json();

    showToast(`Undid import of ${result.deleted} photos`, null);
    closeImportOverlay();

    // Reload grid
    await loadAndRenderPhotos(false);
  } catch (error) {
    console.error('❌ Undo error:', error);
    showToast('Undo failed', null);
  }
}

// =====================
// UTILITIES MENU
// =====================

let utilitiesMenuLoaded = false;

/**
 * Load utilities menu fragment
 */
async function loadUtilitiesMenu() {
  if (utilitiesMenuLoaded) return;

  try {
    const response = await fetch('fragments/utilitiesMenu.html?v=4');
    if (!response.ok) throw new Error('Failed to load utilities menu');

    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);

    // Wire up menu items
    const switchLibraryBtn = document.getElementById('switchLibraryBtn');
    const cleanOrganizeBtn = document.getElementById('cleanOrganizeBtn');
    const closeLibraryBtn = document.getElementById('closeLibraryBtn');

    if (switchLibraryBtn) {
      switchLibraryBtn.addEventListener('click', () => {
        hideUtilitiesMenu();
        logOpenLibraryAccessPoint('utilities-menu-open-library');
      });
    }

    if (cleanOrganizeBtn) {
      cleanOrganizeBtn.addEventListener('click', () => {
        hideUtilitiesMenu();
        openUpdateIndexOverlay();
      });
    }

    if (closeLibraryBtn) {
      closeLibraryBtn.addEventListener('click', () => {
        hideUtilitiesMenu();
        void resetLibraryConfig();
      });
    }

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('utilitiesMenu');
      const utilitiesBtn = document.getElementById('utilitiesBtn');
      if (menu && !menu.contains(e.target) && e.target !== utilitiesBtn) {
        hideUtilitiesMenu();
      }
    });

    utilitiesMenuLoaded = true;

    // Update menu item availability
    updateUtilityMenuAvailability();
  } catch (error) {
    console.error('❌ Failed to load utilities menu:', error);
  }
}

/**
 * Toggle utilities menu
 */
async function toggleUtilitiesMenu() {
  await loadUtilitiesMenu();

  const menu = document.getElementById('utilitiesMenu');
  const utilitiesBtn = document.getElementById('utilitiesBtn');

  if (!menu || !utilitiesBtn) {
    console.warn('⚠️ Menu or button not found');
    return;
  }

  const isVisible = menu.style.display === 'block';

  if (isVisible) {
    hideUtilitiesMenu();
  } else {
    // Update menu availability before showing
    updateUtilityMenuAvailability();

    // Position menu below the button
    const btnRect = utilitiesBtn.getBoundingClientRect();
    const insetEnd = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--utilities-menu-viewport-inset-end',
      ),
    );
    const insetExtra = Number.isFinite(insetEnd) ? insetEnd : 0;

    menu.style.top = `${btnRect.bottom + 8}px`;
    menu.style.right = `${window.innerWidth - btnRect.right + insetExtra}px`;
    menu.style.display = 'block';
  }
}

/**
 * Hide utilities menu
 */
function hideUtilitiesMenu() {
  const menu = document.getElementById('utilitiesMenu');
  if (menu) {
    menu.style.display = 'none';
  }
}

/**
 * Update utility menu item availability based on current state
 *
 * Requirements:
 * - Switch library: ALWAYS available
 * - Update database: requires database (doesn't need photos)
 * - Rebuild database: requires database
 * - Remove duplicates: requires database AND 1+ photos
 * - Close library: requires database
 */
function updateUtilityMenuAvailability() {
  const hasDatabase = state.hasDatabase;
  const hasPhotos = state.photos && state.photos.length > 0;

  // Switch library - ALWAYS available (never disabled)
  enableMenuItem('switchLibraryBtn', true);

  enableMenuItem('closeLibraryBtn', hasDatabase);

  // Update database - requires database (doesn't need photos)
  enableMenuItem('cleanOrganizeBtn', hasDatabase);

  // Rebuild database - requires database
  enableMenuItem('rebuildDatabaseBtn', hasDatabase);
}

/**
 * Enable or disable a menu item
 */
function enableMenuItem(buttonId, enabled) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;

  if (enabled) {
    btn.classList.remove('disabled');
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
  } else {
    btn.classList.add('disabled');
    btn.style.opacity = '0.3';
    btn.style.pointerEvents = 'none';
  }
}

// =====================
// DUPLICATES OVERLAY
// =====================

// ==========================
// UPDATE DATABASE OVERLAY
// ==========================

let updateIndexState = {
  misfiledMedia: 0,
  duplicates: 0,
  unsupportedFiles: 0,
  metadataCleanup: 0,
  databaseRepairs: 0,
  details: null,
  resultStats: null,
};

/**
 * Load Update Database overlay fragment
 */
async function loadUpdateIndexOverlay() {
  // Check if already loaded
  if (document.getElementById('updateIndexOverlay')) {
    return;
  }

  try {
    const response = await fetch('fragments/updateIndexOverlay.html');
    if (!response.ok) throw new Error('Failed to load Update Database overlay');

    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);

    // Wire up buttons
    const closeBtn = document.getElementById('updateIndexCloseBtn');
    const cancelBtn = document.getElementById('updateIndexCancelBtn');
    const proceedBtn = document.getElementById('updateIndexProceedBtn');
    const doneBtn = document.getElementById('updateIndexDoneBtn');
    const detailsToggle = document.getElementById('updateIndexDetailsToggle');

    if (closeBtn) closeBtn.addEventListener('click', closeUpdateIndexOverlay);
    if (cancelBtn) cancelBtn.addEventListener('click', closeUpdateIndexOverlay);
    if (proceedBtn) proceedBtn.addEventListener('click', executeUpdateIndex);
    if (doneBtn) doneBtn.addEventListener('click', closeUpdateIndexOverlay);

    if (detailsToggle) {
      detailsToggle.addEventListener('click', () => {
        const detailsList = document.getElementById('updateIndexDetailsList');
        const icon = detailsToggle.querySelector('.material-symbols-outlined');

        if (detailsList.style.display === 'none') {
          detailsList.style.display = 'block';
          icon.textContent = 'expand_less';
          detailsToggle.querySelector('span:last-child').textContent =
            'Hide details';
        } else {
          detailsList.style.display = 'none';
          icon.textContent = 'expand_more';
          detailsToggle.querySelector('span:last-child').textContent =
            'Show details';
        }
      });
    }
  } catch (error) {
    console.error('❌ Failed to load Update Database overlay:', error);
  }
}

/**
 * Phase 1: Open overlay and scan
 */
async function openUpdateIndexOverlay() {
  // Check if already open
  const existingOverlay = document.getElementById('updateIndexOverlay');
  if (existingOverlay && existingOverlay.style.display === 'flex') {
    return;
  }

  await loadUpdateIndexOverlay();

  const overlay = document.getElementById('updateIndexOverlay');
  if (!overlay) return;

  // Reset state
  updateIndexState = {
    misfiledMedia: 0,
    duplicates: 0,
    unsupportedFiles: 0,
    metadataCleanup: 0,
    databaseRepairs: 0,
    details: null,
    resultStats: null,
  };

  // Reset UI to initial state
  const statsEl = document.getElementById('updateIndexStats');
  const detailsSection = document.getElementById('updateIndexDetailsSection');
  if (statsEl) statsEl.style.display = 'none';
  if (detailsSection) detailsSection.style.display = 'none';

  // Show overlay
  overlay.style.display = 'flex';

  // Phase 1: Scanning
  updateUpdateIndexUI('Scanning library', true);
  showUpdateIndexButtons('cancel');

  try {
    const response = await fetch('/api/library/make-perfect/scan');
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to scan clean library');
    }

    updateIndexState.misfiledMedia = data.summary?.misfiled_media || 0;
    updateIndexState.duplicates = data.summary?.duplicates || 0;
    updateIndexState.unsupportedFiles = data.summary?.unsupported_files || 0;
    updateIndexState.metadataCleanup = data.summary?.metadata_cleanup || 0;
    updateIndexState.databaseRepairs = data.summary?.database_repairs || 0;
    updateIndexState.details = data.details || null;

    const hasChanges = (data.summary?.issue_count || 0) > 0;
    showUpdateIndexStats();
    renderUpdateIndexDetails();

    if (hasChanges) {
      updateUpdateIndexUI('Scan complete. Ready to continue?', false);
      showUpdateIndexButtons('cancel', 'proceed');
    } else {
      updateUpdateIndexUI(
        'Library is already clean. No changes required.',
        false,
      );
      showUpdateIndexButtons('done');
    }
  } catch (error) {
    console.error('❌ Failed to scan clean library:', error);
    updateUpdateIndexUI('Failed to scan', false);
    showToast('Failed to scan clean library', null);
  }
}

/**
 * Phase 3: Execute update (after user clicks Continue)
 */
async function executeUpdateIndex() {
  updateUpdateIndexUI('Cleaning library...', true);
  showUpdateIndexButtons('cancel-disabled');

  try {
    const response = await fetch('/api/library/make-perfect', {
      method: 'POST',
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Clean library failed: ${response.status}`);
    }

    updateIndexState.resultStats = data.stats || null;
    updateUpdateIndexUI('Library cleaned', false);
    showUpdateIndexStats();
    renderUpdateIndexDetails();
    showUpdateIndexButtons('done');

    // Reload grid
    await loadAndRenderPhotos(false);
  } catch (error) {
    console.error('❌ Failed to clean library:', error);
    updateUpdateIndexUI('Failed to clean library', false);
    showToast('Failed to clean library', null);
    showUpdateIndexButtons('cancel');
  }
}

/**
 * Update UI status text
 */
function updateUpdateIndexUI(statusText, showSpinner = false) {
  const statusTextEl = document.getElementById('updateIndexStatusText');

  if (statusTextEl) {
    if (showSpinner) {
      statusTextEl.innerHTML = `${statusText}<span class="import-spinner"></span>`;
    } else {
      statusTextEl.textContent = statusText;
    }
  }
}

/**
 * Show statistics
 */
function showUpdateIndexStats() {
  const statsEl = document.getElementById('updateIndexStats');
  const misfiledEl = document.getElementById('misfiledMediaCount');
  const duplicatesEl = document.getElementById('duplicatesCount');
  const unsupportedEl = document.getElementById('unsupportedFilesCount');
  const metadataEl = document.getElementById('metadataCleanupCount');
  const dbRepairsEl = document.getElementById('databaseRepairsCount');

  if (statsEl) statsEl.style.display = 'flex';
  if (misfiledEl) misfiledEl.textContent = updateIndexState.misfiledMedia;
  if (duplicatesEl) duplicatesEl.textContent = updateIndexState.duplicates;
  if (unsupportedEl)
    unsupportedEl.textContent = updateIndexState.unsupportedFiles;
  if (metadataEl) metadataEl.textContent = updateIndexState.metadataCleanup;
  if (dbRepairsEl) dbRepairsEl.textContent = updateIndexState.databaseRepairs;
}

/**
 * Hide statistics (Phase 4)
 */
function hideUpdateIndexStats() {
  const statsEl = document.getElementById('updateIndexStats');
  if (statsEl) statsEl.style.display = 'none';
}

/**
 * Show appropriate buttons for each phase
 */
function showUpdateIndexButtons(...buttons) {
  const cancelBtn = document.getElementById('updateIndexCancelBtn');
  const proceedBtn = document.getElementById('updateIndexProceedBtn');
  const doneBtn = document.getElementById('updateIndexDoneBtn');

  // Hide all first
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (proceedBtn) proceedBtn.style.display = 'none';
  if (doneBtn) doneBtn.style.display = 'none';

  // Show requested buttons
  buttons.forEach((btn) => {
    if (btn === 'cancel' && cancelBtn) {
      cancelBtn.style.display = 'inline-block';
      cancelBtn.disabled = false;
    } else if (btn === 'cancel-disabled' && cancelBtn) {
      cancelBtn.style.display = 'inline-block';
      cancelBtn.disabled = true;
    } else if (btn === 'proceed' && proceedBtn) {
      proceedBtn.style.display = 'inline-block';
    } else if (btn === 'done' && doneBtn) {
      doneBtn.style.display = 'inline-block';
    }
  });
}

/**
 * Render details (Phase 4 only)
 */
function renderUpdateIndexDetails() {
  const detailsSection = document.getElementById('updateIndexDetailsSection');
  const detailsList = document.getElementById('updateIndexDetailsList');

  if (!detailsSection || !detailsList) {
    console.warn('⚠️ Details elements not found in DOM!');
    return;
  }

  const details = updateIndexState.details;
  const resultStats = updateIndexState.resultStats;
  let html = '';

  if (resultStats) {
    const duplicateCopiesRemoved = resultStats.duplicates_trashed || 0;
    const otherTrashMoves = Math.max(
      0,
      (resultStats.moved_to_trash || 0) - duplicateCopiesRemoved,
    );
    const changesApplied = [];

    if (duplicateCopiesRemoved > 0) {
      changesApplied.push(
        `Duplicate copies removed: ${duplicateCopiesRemoved}`,
      );
    }
    if (otherTrashMoves > 0) {
      changesApplied.push(
        `Unsupported files moved to trash: ${otherTrashMoves}`,
      );
    }
    if ((resultStats.metadata_fixed || 0) > 0) {
      changesApplied.push(
        `Metadata cleanup applied: ${resultStats.metadata_fixed}`,
      );
    }
    if ((resultStats.media_moved || 0) > 0) {
      changesApplied.push(
        `Media moved into canonical folders: ${resultStats.media_moved}`,
      );
    }
    if ((resultStats.folders_removed || 0) > 0) {
      changesApplied.push(
        `Empty folders removed: ${resultStats.folders_removed}`,
      );
    }
    if ((resultStats.db_rows_rebuilt || 0) > 0) {
      changesApplied.push('Database updated to match library');
    }

    html +=
      '<div class="update-detail-section"><strong>Changes Applied:</strong><ul>';
    if (changesApplied.length === 0) {
      html += '<li>No visible library changes were required.</li>';
    } else {
      changesApplied.forEach((message) => {
        html += `<li>${escapeHtml(message)}</li>`;
      });
    }
    html += '</ul></div>';
  }

  if (details?.misfiled_media?.length > 0) {
    html +=
      '<div class="update-detail-section"><strong>Misfiled Media:</strong><ul>';
    details.misfiled_media.slice(0, 20).forEach((item) => {
      html += `<li>${escapeHtml(renderUpdateIndexDetailMessage(item))}</li>`;
    });
    if (details.misfiled_media.length > 20) {
      html += `<li><em>... and ${
        details.misfiled_media.length - 20
      } more</em></li>`;
    }
    html += '</ul></div>';
  }

  if (details?.duplicates?.length > 0) {
    html +=
      '<div class="update-detail-section"><strong>Duplicates:</strong><ul>';
    details.duplicates.slice(0, 20).forEach((item) => {
      html += `<li>${escapeHtml(renderUpdateIndexDetailMessage(item))}</li>`;
    });
    if (details.duplicates.length > 20) {
      html += `<li><em>... and ${
        details.duplicates.length - 20
      } more</em></li>`;
    }
    html += '</ul></div>';
  }

  if (details?.unsupported_files?.length > 0) {
    html +=
      '<div class="update-detail-section"><strong>Unsupported Files:</strong><ul>';
    details.unsupported_files.slice(0, 20).forEach((item) => {
      html += `<li>${escapeHtml(renderUpdateIndexDetailMessage(item))}</li>`;
    });
    if (details.unsupported_files.length > 20) {
      html += `<li><em>... and ${
        details.unsupported_files.length - 20
      } more</em></li>`;
    }
    html += '</ul></div>';
  }

  if (details?.metadata_cleanup?.length > 0) {
    html +=
      '<div class="update-detail-section"><strong>Metadata Cleanup:</strong><ul>';
    details.metadata_cleanup.slice(0, 20).forEach((item) => {
      html += `<li>${escapeHtml(renderUpdateIndexDetailMessage(item))}</li>`;
    });
    if (details.metadata_cleanup.length > 20) {
      html += `<li><em>... and ${
        details.metadata_cleanup.length - 20
      } more</em></li>`;
    }
    html += '</ul></div>';
  }

  if (details?.database_repairs?.length > 0) {
    html +=
      '<div class="update-detail-section"><strong>Database Repairs:</strong><ul>';
    details.database_repairs.slice(0, 20).forEach((item) => {
      html += `<li>${escapeHtml(renderUpdateIndexDetailMessage(item))}</li>`;
    });
    if (details.database_repairs.length > 20) {
      html += `<li><em>... and ${
        details.database_repairs.length - 20
      } more</em></li>`;
    }
    html += '</ul></div>';
  }

  if (html) {
    detailsList.innerHTML = html;
  } else {
    detailsList.innerHTML =
      '<div class="update-detail-section"><em>No issues found.</em></div>';
  }
  detailsSection.style.display = 'block';
}

function renderUpdateIndexDetailMessage(item) {
  if (item && typeof item === 'object') {
    return item.message || item.path || '';
  }
  return String(item || '');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Close Update Database overlay
 */
function closeUpdateIndexOverlay() {
  const overlay = document.getElementById('updateIndexOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

// =====================
// INITIALIZATION
// =====================

/**
 * Rebuild thumbnails — 3-phase overlay pattern.
 *
 * UI entry (More menu) removed Apr 2026: thumbnail cache issues are rare; deleting
 * the library `.thumbnails` folder manually is equivalent. Kept so POST
 * `/api/utilities/rebuild-thumbnails` and this flow remain available if we
 * re-expose or call from devtools / a future setting.
 */
async function rebuildThumbnails() {
  // Load overlay if not already loaded
  const overlay = document.getElementById('rebuildThumbnailsOverlay');
  if (!overlay) {
    await loadRebuildThumbnailsOverlay();
  }

  openRebuildThumbnailsOverlay();
}

/**
 * Load rebuild thumbnails overlay fragment
 */
async function loadRebuildThumbnailsOverlay() {
  try {
    const response = await fetch('/fragments/rebuildThumbnailsOverlay.html');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);

    // Wire up event listeners
    document
      .getElementById('rebuildThumbnailsCloseBtn')
      ?.addEventListener('click', closeRebuildThumbnailsOverlay);
    document
      .getElementById('rebuildThumbnailsCancelBtn')
      ?.addEventListener('click', closeRebuildThumbnailsOverlay);
    document
      .getElementById('rebuildThumbnailsProceedBtn')
      ?.addEventListener('click', executeRebuildThumbnails);
    document
      .getElementById('rebuildThumbnailsDoneBtn')
      ?.addEventListener('click', async () => {
        closeRebuildThumbnailsOverlay();
        // Force thumbnail reload by adding cache-buster (only to loaded images)
        const thumbnails = document.querySelectorAll('.photo-thumb');
        const cacheBuster = Date.now();
        thumbnails.forEach((img) => {
          // Only add cachebuster to images that have valid thumbnail URLs
          if (img.src && img.src.includes('/api/photo/')) {
            const src = img.src.split('?')[0];
            img.src = `${src}?t=${cacheBuster}`;
          }
        });
      });
  } catch (error) {
    console.error('❌ Failed to load rebuild thumbnails overlay:', error);
  }
}

/**
 * Open rebuild thumbnails overlay (Phase 1: Confirmation)
 */
async function openRebuildThumbnailsOverlay() {
  const overlay = document.getElementById('rebuildThumbnailsOverlay');
  if (!overlay) return;

  // Get UI elements
  const statusText = document.getElementById('rebuildThumbnailsStatusText');
  const cancelBtn = document.getElementById('rebuildThumbnailsCancelBtn');
  const proceedBtn = document.getElementById('rebuildThumbnailsProceedBtn');
  const doneBtn = document.getElementById('rebuildThumbnailsDoneBtn');

  // Show loading state while checking
  statusText.innerHTML =
    '<p>Checking thumbnails<span class="import-spinner"></span></p>';
  cancelBtn.style.display = 'none';
  proceedBtn.style.display = 'none';
  doneBtn.style.display = 'none';
  overlay.style.display = 'block';

  try {
    // First, check if there are any thumbnails without deleting
    const response = await fetch('/api/utilities/check-thumbnails');
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to check thumbnails');
    }

    // If no thumbnails exist, show info message with Done button only
    if (result.thumbnail_count === 0) {
      statusText.innerHTML =
        '<p>No thumbnails found. Thumbnails will be generated automatically as you scroll.</p>';
      cancelBtn.style.display = 'none';
      proceedBtn.style.display = 'none';
      doneBtn.style.display = 'block';
    } else {
      // Thumbnails exist, show confirmation dialog
      statusText.innerHTML =
        '<p>This will clear all cached thumbnails. They will regenerate automatically as you scroll.</p><p>Ready to delete existing thumbnails?</p>';
      cancelBtn.style.display = 'block';
      proceedBtn.style.display = 'block';
      doneBtn.style.display = 'none';
    }
  } catch (error) {
    console.error('❌ Failed to check thumbnails:', error);
    statusText.innerHTML = `<p>Error: ${error.message}</p>`;
    cancelBtn.style.display = 'none';
    proceedBtn.style.display = 'none';
    doneBtn.style.display = 'block';
  }
}

/**
 * Close rebuild thumbnails overlay
 */
function closeRebuildThumbnailsOverlay() {
  const overlay = document.getElementById('rebuildThumbnailsOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

/**
 * Execute thumbnail rebuild (Phase 2 -> 3)
 */
async function executeRebuildThumbnails() {
  const statusText = document.getElementById('rebuildThumbnailsStatusText');
  const cancelBtn = document.getElementById('rebuildThumbnailsCancelBtn');
  const proceedBtn = document.getElementById('rebuildThumbnailsProceedBtn');
  const doneBtn = document.getElementById('rebuildThumbnailsDoneBtn');

  try {
    // Immediately show Phase 2 (spinner)
    statusText.innerHTML =
      '<p>Clearing thumbnails<span class="import-spinner"></span></p>';
    cancelBtn.disabled = true;
    cancelBtn.style.opacity = '0.5';
    proceedBtn.style.display = 'none';

    // Execute rebuild
    const response = await fetch('/api/utilities/rebuild-thumbnails', {
      method: 'POST',
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to rebuild thumbnails');
    }

    // Visual confirmation: Clear all thumbnail images
    if (result.cleared_count > 0) {
      // Clear the grid to show user that purge happened
      const container = document.getElementById('photoContainer');
      if (container) {
        container.innerHTML = '';
      }

      // Show blank grid for 300ms before reloading
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Reload grid with fresh thumbnails

      await loadAndRenderPhotos(false);
    }

    // Show Phase 3 (confirmation)
    if (result.cleared_count === 0) {
      // No thumbnails to rebuild
      statusText.innerHTML =
        '<p>No thumbnails found. Thumbnails are generated automatically as you scroll.</p>';
    } else {
      // Thumbnails were cleared
      statusText.innerHTML =
        '<p>Old thumbnails have been removed. New ones are created automatically as you scroll.</p>';
    }
    cancelBtn.style.display = 'none';
    doneBtn.style.display = 'block';
  } catch (error) {
    console.error('❌ Failed to rebuild thumbnails:', error);
    showToast(`Error: ${error.message}`, 'error');
    closeRebuildThumbnailsOverlay();
  }
}

// =============================
// REBUILD DATABASE OVERLAY
// =============================

/**
 * Load rebuild database overlay fragment
 */
async function loadRebuildDatabaseOverlay() {
  if (document.getElementById('rebuildDatabaseOverlay')) {
    return;
  }

  const mount = document.getElementById('importOverlayMount');
  try {
    const response = await fetch('fragments/rebuildDatabaseOverlay.html');
    if (!response.ok)
      throw new Error(
        `Failed to load rebuild database overlay (${response.status})`,
      );
    mount.insertAdjacentHTML('beforeend', await response.text());

    // Wire up event listeners
    document
      .getElementById('rebuildDatabaseCloseBtn')
      .addEventListener('click', hideRebuildDatabaseOverlay);
    document
      .getElementById('rebuildDatabaseCancelBtn')
      .addEventListener('click', hideRebuildDatabaseOverlay);
    document
      .getElementById('rebuildDatabaseProceedBtn')
      .addEventListener('click', executeRebuildDatabase);
    document
      .getElementById('rebuildDatabaseDoneBtn')
      .addEventListener('click', hideRebuildDatabaseOverlay);
  } catch (error) {
    console.error('❌ Rebuild Database Overlay load failed:', error);
  }
}

// =====================
// SWITCH LIBRARY
// =====================

/**
 * Load switch library overlay fragment
 */
async function loadSwitchLibraryOverlay() {
  try {
    const response = await fetch('/fragments/switchLibraryOverlay.html');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);

    // Wire up event listeners
    document
      .getElementById('switchLibraryCloseBtn')
      ?.addEventListener('click', closeSwitchLibraryOverlay);
    document
      .getElementById('switchLibraryCancelBtn')
      ?.addEventListener('click', closeSwitchLibraryOverlay);
    document
      .getElementById('switchLibraryBrowseBtn')
      ?.addEventListener('click', browseSwitchLibrary);
    document
      .getElementById('switchLibraryResetBtn')
      ?.addEventListener('click', resetLibraryConfig);
  } catch (error) {
    console.error('❌ Failed to load switch library overlay:', error);
  }
}

/**
 * Load create library overlay fragment
 */
async function loadCreateLibraryOverlay() {
  try {
    const response = await fetch('/fragments/createLibraryOverlay.html');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);

    // Event listeners wired up when showing overlay
  } catch (error) {
    console.error('❌ Failed to load create library overlay:', error);
  }
}

/**
 * Load name library overlay fragment
 */
async function loadNameLibraryOverlay() {
  try {
    const response = await fetch('/fragments/nameLibraryOverlay.html');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    console.error('❌ Failed to load name library overlay:', error);
  }
}

/**
 * Show name library dialog and return user's chosen name
 * @returns {Promise<string|null|{ action: 'cancel'|'back' }>} Name, null if cancelled (non-wizard), or wizard actions
 */
async function showNameLibraryDialog(options = {}) {
  return new Promise(async (resolve) => {
    // Load overlay if not already loaded
    let overlay = document.getElementById('nameLibraryOverlay');
    if (!overlay) {
      await loadNameLibraryOverlay();
      overlay = document.getElementById('nameLibraryOverlay');
    }

    const input = document.getElementById('libraryNameInput');
    const errorDiv = document.getElementById('libraryNameError');
    const cancelBtn = document.getElementById('nameLibraryCancelBtn');
    const confirmBtn = document.getElementById('nameLibraryConfirmBtn');
    const closeBtn = document.getElementById('nameLibraryCloseBtn');
    const goBackBtn = document.getElementById('nameLibraryGoBackBtn');

    const wizardActions = !!options.wizardActions;
    const showGoBack = wizardActions && !!options.showGoBack;
    let listenersDetached = false;
    let isSubmitting = false;
    let latestValidationTicket = 0;

    function setActionButtonsDisabled(disabled) {
      cancelBtn.disabled = disabled;
      confirmBtn.disabled = disabled;
      closeBtn.disabled = disabled;
      if (goBackBtn) {
        goBackBtn.disabled = disabled;
      }
    }

    if (goBackBtn) {
      goBackBtn.style.display = showGoBack ? '' : 'none';
    }

    // Update dialog title and subtitle if provided
    const titleEl = overlay.querySelector('.import-title');
    const subtitleEl = overlay.querySelector('.import-status-text p');

    if (titleEl && options.title) {
      titleEl.textContent = options.title;
    } else if (titleEl) {
      titleEl.textContent = 'Create new library';
    }

    if (subtitleEl && options.subtitle) {
      subtitleEl.textContent = options.subtitle;
    } else if (subtitleEl) {
      subtitleEl.textContent =
        'Your new library needs its own folder. Please give it a name.';
    }

    // Reset state
    const defaultName =
      options.initialLibraryName != null && options.initialLibraryName !== ''
        ? options.initialLibraryName
        : 'Photo Library';
    isSubmitting = false;
    setActionButtonsDisabled(false);
    confirmBtn.disabled = !!options.parentPath;
    input.value = defaultName;
    errorDiv.style.visibility = 'hidden';
    errorDiv.textContent = '';

    // Focus input and select text
    setTimeout(() => {
      input.focus();
      input.select();
      if (options.parentPath) {
        validateName(input.value);
      }
    }, 100);

    // Sanitize folder name
    function sanitizeFolderName(name) {
      // Remove invalid characters: / \ : * ? " < > | and leading dots
      return name
        .replace(/[\/\\:*?"<>|]/g, '')
        .replace(/^\.+/, '')
        .trim();
    }

    // Validate name
    async function computeNameValidation(name) {
      const sanitized = sanitizeFolderName(name);

      if (!sanitized) {
        return {
          sanitized: null,
          errorMessage: 'Please enter a valid name',
        };
      }

      if (sanitized.length > 255) {
        return {
          sanitized: null,
          errorMessage: 'Name is too long (max 255 characters)',
        };
      }

      // Check if folder exists at parent location (if parentPath provided)
      if (options.parentPath) {
        try {
          const response = await fetch('/api/filesystem/list-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: options.parentPath }),
          });

          if (response.ok) {
            const data = await response.json();
            const existingFolders = data.folders.map((f) =>
              typeof f === 'string' ? f : f.name,
            );

            if (existingFolders.includes(sanitized)) {
              return {
                sanitized: null,
                errorMessage: `A folder named "${sanitized}" already exists here`,
              };
            }
          }
        } catch (error) {
          // If validation fails, allow it (don't block user)
          console.warn('Failed to validate folder name:', error);
        }
      }

      return {
        sanitized,
        errorMessage: null,
      };
    }

    async function validateName(name) {
      const ticket = ++latestValidationTicket;
      const result = await computeNameValidation(name);

      // Ignore stale async responses while user keeps typing.
      if (ticket !== latestValidationTicket) {
        return result.sanitized;
      }

      if (result.errorMessage) {
        errorDiv.textContent = result.errorMessage;
        errorDiv.style.visibility = 'visible';
      } else {
        errorDiv.style.visibility = 'hidden';
        errorDiv.textContent = '';
      }

      if (!isSubmitting) {
        confirmBtn.disabled = !result.sanitized;
      }

      return result.sanitized;
    }

    // Remove listeners (clone nodes). Optionally hide — wizard handoff keeps overlay
    // visible until the next step paints so the empty state never flashes through.
    function detachListeners() {
      if (listenersDetached) {
        return;
      }
      if (
        !cancelBtn?.parentNode ||
        !confirmBtn?.parentNode ||
        !closeBtn?.parentNode ||
        !input?.parentNode
      ) {
        listenersDetached = true;
        return;
      }

      const newCancelBtn = cancelBtn.cloneNode(true);
      const newConfirmBtn = confirmBtn.cloneNode(true);
      const newCloseBtn = closeBtn.cloneNode(true);
      const newInput = input.cloneNode(true);
      const newGoBackBtn = goBackBtn ? goBackBtn.cloneNode(true) : null;

      cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
      confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
      closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
      input.parentNode.replaceChild(newInput, input);
      if (goBackBtn && newGoBackBtn && goBackBtn.parentNode) {
        goBackBtn.parentNode.replaceChild(newGoBackBtn, goBackBtn);
      }
      listenersDetached = true;
    }

    function cleanup() {
      overlay.style.display = 'none';
      detachListeners();
    }

    // Handle cancel
    const handleCancel = () => {
      cleanup();
      if (wizardActions) {
        resolve({ action: 'cancel' });
      } else {
        resolve(null);
      }
    };

    const handleGoBack = () => {
      cleanup();
      resolve({ action: 'back' });
    };

    // Handle confirm
    const handleConfirm = async () => {
      if (isSubmitting) {
        return;
      }

      isSubmitting = true;
      setActionButtonsDisabled(true);
      try {
        const validated = await validateName(input.value);
        if (!validated) {
          isSubmitting = false;
          setActionButtonsDisabled(false);
          confirmBtn.disabled = true;
          return;
        }

        isSubmitting = false;
        setActionButtonsDisabled(false);

        if (wizardActions) {
          detachListeners();
        } else {
          cleanup();
        }

        resolve(validated);
      } catch (error) {
        console.error('❌ Failed to confirm library name:', error);
        isSubmitting = false;
        setActionButtonsDisabled(false);
        errorDiv.textContent = 'Something went wrong. Please try again.';
        errorDiv.style.visibility = 'visible';
      }
    };

    // Handle Enter key
    const handleKeyPress = (e) => {
      if (e.key === 'Enter') {
        handleConfirm();
      } else if (e.key === 'Escape') {
        handleCancel();
      }
    };

    // Debounced validation on input
    let debounceTimeout = null;
    const handleInput = () => {
      // Clear any pending validation
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }

      // Hide error immediately while typing
      errorDiv.style.visibility = 'hidden';
      errorDiv.textContent = '';
      if (!isSubmitting) {
        confirmBtn.disabled = true;
      }

      // Schedule validation after 150ms of no typing
      debounceTimeout = setTimeout(async () => {
        await validateName(input.value);
      }, 150);
    };

    // Wire up listeners
    cancelBtn.addEventListener('click', handleCancel);
    closeBtn.addEventListener('click', handleCancel);
    confirmBtn.addEventListener('click', handleConfirm);
    if (goBackBtn && showGoBack) {
      goBackBtn.addEventListener('click', handleGoBack);
    }
    input.addEventListener('keydown', handleKeyPress);
    input.addEventListener('input', handleInput);

    // Show overlay
    overlay.style.display = 'flex';
  });
}

/**
 * Open switch library overlay
 */
async function openSwitchLibraryOverlay() {
  // Load overlay if not already loaded
  const overlay = document.getElementById('switchLibraryOverlay');
  if (!overlay) {
    await loadSwitchLibraryOverlay();
  }

  // Get current library path
  const currentLibrary = await fetchCurrentLibraryInfo();
  const pathElement = document.getElementById('currentLibraryPath');
  if (pathElement) {
    pathElement.textContent =
      currentLibrary?.library_path || '(unable to load)';
  }

  document.getElementById('switchLibraryOverlay').style.display = 'block';
}

/**
 * Close switch library overlay
 */
function closeSwitchLibraryOverlay() {
  const overlay = document.getElementById('switchLibraryOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

async function fetchCurrentLibraryInfo() {
  try {
    const response = await fetch('/api/library/current');
    if (!response.ok) {
      throw new Error(`Failed to load current library (${response.status})`);
    }
    return await response.json();
  } catch (error) {
    console.warn('⚠️ Failed to get current library:', error);
    return null;
  }
}

// =====================
// TERRAFORM DIALOGS
// =====================

/**
 * Load terraform choice overlay
 */
async function loadTerraformChoiceOverlay() {
  try {
    const response = await fetch('/fragments/terraformChoiceOverlay.html');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    console.error('❌ Failed to load terraform choice overlay:', error);
  }
}

/**
 * Show terraform choice dialog
 * @param {Object} options - { path: string, media_count: number }
 * @returns {Promise<string|null>} 'blank' | 'terraform' | null if cancelled
 */
async function showTerraformChoiceDialog(options = {}) {
  return new Promise(async (resolve) => {
    // Load overlay if needed
    let overlay = document.getElementById('terraformChoiceOverlay');
    if (!overlay) {
      await loadTerraformChoiceOverlay();
      overlay = document.getElementById('terraformChoiceOverlay');
    }

    // Set values
    document.getElementById('terraformChoiceCount').textContent =
      options.media_count.toLocaleString();
    document.getElementById('terraformChoicePath').textContent = options.path;

    // Reset radio selection to "blank" by default
    const blankRadio = document.querySelector(
      'input[name="terraformChoice"][value="blank"]',
    );
    if (blankRadio) blankRadio.checked = true;

    const closeBtn = document.getElementById('terraformChoiceCloseBtn');
    const cancelBtn = document.getElementById('terraformChoiceCancelBtn');
    const continueBtn = document.getElementById('terraformChoiceContinueBtn');

    const handleCancel = () => {
      overlay.style.display = 'none';
      resolve(null);
    };

    const handleContinue = () => {
      const selected = document.querySelector(
        'input[name="terraformChoice"]:checked',
      );
      overlay.style.display = 'none';
      resolve(selected ? selected.value : null);
    };

    closeBtn.onclick = handleCancel;
    cancelBtn.onclick = handleCancel;
    continueBtn.onclick = handleContinue;

    overlay.style.display = 'flex';
  });
}

/**
 * Load terraform preview overlay
 */
async function loadTerraformPreviewOverlay() {
  try {
    const response = await fetch('/fragments/terraformPreviewOverlay.html');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    console.error('❌ Failed to load terraform preview overlay:', error);
  }
}

/**
 * Show terraform preview dialog
 * @param {Object} options - { path: string, photo_count: number, video_count: number }
 * @returns {Promise<boolean>} true to continue, false to go back
 */
async function showTerraformPreviewDialog(options = {}) {
  return new Promise(async (resolve) => {
    // Load overlay if needed
    let overlay = document.getElementById('terraformPreviewOverlay');
    if (!overlay) {
      await loadTerraformPreviewOverlay();
      overlay = document.getElementById('terraformPreviewOverlay');
    }

    // Set values
    document.getElementById('terraformPreviewPath').textContent = options.path;
    document.getElementById('terraformPreviewPhotos').textContent =
      options.photo_count.toLocaleString();
    document.getElementById('terraformPreviewVideos').textContent =
      options.video_count.toLocaleString();

    const closeBtn = document.getElementById('terraformPreviewCloseBtn');
    const continueBtn = document.getElementById('terraformPreviewContinueBtn');
    const backBtn = document.getElementById('terraformPreviewBackBtn');

    const handleClose = () => {
      overlay.style.display = 'none';
      resolve(false);
    };

    const handleContinue = () => {
      overlay.style.display = 'none';
      resolve(true);
    };

    const handleBack = () => {
      overlay.style.display = 'none';
      resolve(false);
    };

    closeBtn.onclick = handleClose;
    continueBtn.onclick = handleContinue;
    backBtn.onclick = handleBack;

    overlay.style.display = 'flex';
  });
}

/**
 * Load terraform warning overlay
 */
async function loadTerraformWarningOverlay() {
  try {
    const response = await fetch('/fragments/terraformWarningOverlay.html');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    console.error('❌ Failed to load terraform warning overlay:', error);
  }
}

/**
 * Show terraform warning dialog
 * @param {Object} options - { total_files: number, estimated_time: string }
 * @returns {Promise<boolean>} true to continue, false to go back
 */
async function showTerraformWarningDialog(options = {}) {
  return new Promise(async (resolve) => {
    // Load overlay if needed
    let overlay = document.getElementById('terraformWarningOverlay');
    if (!overlay) {
      await loadTerraformWarningOverlay();
      overlay = document.getElementById('terraformWarningOverlay');
    }

    // Set values
    document.getElementById('terraformWarningCount').textContent =
      options.total_files.toLocaleString();
    document.getElementById('terraformWarningEta').textContent =
      options.estimated_time || 'calculating...';

    const closeBtn = document.getElementById('terraformWarningCloseBtn');
    const continueBtn = document.getElementById('terraformWarningContinueBtn');
    const backBtn = document.getElementById('terraformWarningBackBtn');

    const handleClose = () => {
      overlay.style.display = 'none';
      resolve(false);
    };

    const handleContinue = () => {
      overlay.style.display = 'none';
      resolve(true);
    };

    const handleBack = () => {
      overlay.style.display = 'none';
      resolve(false);
    };

    closeBtn.onclick = handleClose;
    continueBtn.onclick = handleContinue;
    backBtn.onclick = handleBack;

    overlay.style.display = 'flex';
  });
}

/**
 * Load terraform progress overlay
 */
async function loadTerraformProgressOverlay() {
  try {
    const response = await fetch('/fragments/terraformProgressOverlay.html');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    console.error('❌ Failed to load terraform progress overlay:', error);
  }
}

/**
 * Load terraform complete overlay
 */
async function loadTerraformCompleteOverlay() {
  try {
    const response = await fetch('/fragments/terraformCompleteOverlay.html');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    console.error('❌ Failed to load terraform complete overlay:', error);
  }
}

/**
 * Show terraform complete dialog
 * @param {Object} results - { processed: number, duplicates: number, errors: number, log_path: string }
 */
async function showTerraformCompleteDialog(results = {}) {
  return new Promise(async (resolve) => {
    // Load overlay if needed
    let overlay = document.getElementById('terraformCompleteOverlay');
    if (!overlay) {
      await loadTerraformCompleteOverlay();
      overlay = document.getElementById('terraformCompleteOverlay');
    }

    // Set values
    document.getElementById('terraformCompleteProcessed').textContent =
      results.processed.toLocaleString();
    document.getElementById('terraformCompleteDuplicates').textContent =
      results.duplicates.toLocaleString();
    document.getElementById('terraformCompleteErrors').textContent =
      results.errors.toLocaleString();
    document.getElementById('terraformCompleteLogPath').textContent =
      `A detailed log has been saved to ${results.log_path}`;

    const closeBtn = document.getElementById('terraformCompleteCloseBtn');
    const doneBtn = document.getElementById('terraformCompleteDoneBtn');

    const handleDone = () => {
      overlay.style.display = 'none';
      resolve();
    };

    closeBtn.onclick = handleDone;
    doneBtn.onclick = handleDone;

    overlay.style.display = 'flex';
  });
}

/**
 * Execute terraform conversion (preview → warning → convert → complete)
 * @param {Object} options - { path: string, media_count: number }
 */
async function executeTerraformFlow(options = {}) {
  try {
    const { path, media_count, photo_count = 0, video_count = 0 } = options;

    // Use counts from checkResult if provided, otherwise query database
    let finalPhotoCount = photo_count;
    let finalVideoCount = video_count;

    // If counts weren't provided (shouldn't happen), try database
    if (photo_count === 0 && video_count === 0 && media_count > 0) {
      try {
        const response = await fetch('/api/file-counts');
        if (response.ok) {
          const data = await response.json();
          finalPhotoCount = data.photo_count;
          finalVideoCount = data.video_count;
        } else {
          // Fallback to estimate if API fails
          console.warn('Failed to get file counts, using estimate');
          finalPhotoCount = Math.floor(media_count * 0.9);
          finalVideoCount = media_count - finalPhotoCount;
        }
      } catch (error) {
        console.error('Error fetching file counts:', error);
        // Fallback to estimate
        finalPhotoCount = Math.floor(media_count * 0.9);
        finalVideoCount = media_count - finalPhotoCount;
      }
    }

    // Step 1: Preview

    const continuePreview = await showTerraformPreviewDialog({
      path,
      photo_count: finalPhotoCount,
      video_count: finalVideoCount,
    });

    if (!continuePreview) {
      return false;
    }

    // Step 2: Warning

    // Estimate time: ~2 seconds per file
    const estimated_seconds = Math.ceil(media_count * 2);
    const estimated_minutes = Math.ceil(estimated_seconds / 60);
    const estimated_time =
      estimated_minutes < 60
        ? `${estimated_minutes}-${estimated_minutes + 2} minutes`
        : `${Math.floor(estimated_minutes / 60)}-${Math.ceil(estimated_minutes / 60)} hours`;

    const continueWarning = await showTerraformWarningDialog({
      total_files: media_count,
      estimated_time,
    });

    if (!continueWarning) {
      return false;
    }

    // Step 3: Execute terraform

    // Load progress overlay
    let progressOverlay = document.getElementById('terraformProgressOverlay');
    if (!progressOverlay) {
      await loadTerraformProgressOverlay();
      progressOverlay = document.getElementById('terraformProgressOverlay');
    }

    progressOverlay.style.display = 'flex';

    // Start SSE
    const response = await fetch('/api/library/terraform', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: path }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let processed = 0;
    let duplicates = 0;
    let errors = 0;
    let log_path = '';
    let dbPath = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        if (line.startsWith('event: ')) {
          const event = line.substring(7);
          continue;
        }

        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.substring(6));

          // Update progress UI
          if (data.processed !== undefined) {
            processed = data.processed;
            document.getElementById('terraformProgressProcessed').textContent =
              processed.toLocaleString();
          }
          if (data.duplicates !== undefined) {
            duplicates = data.duplicates;
            document.getElementById('terraformProgressDuplicates').textContent =
              duplicates.toLocaleString();
          }
          if (data.errors !== undefined) {
            errors = data.errors;
            document.getElementById('terraformProgressErrors').textContent =
              errors.toLocaleString();
          }
          if (data.log_path) {
            log_path = data.log_path;
          }
          if (data.db_path) {
            dbPath = data.db_path;
          }

          // Update status (static - shows total)
          if (data.total) {
            const statusEl = document.getElementById('terraformProgressStatus');
            statusEl.textContent = `Processing ${data.total} files...`;
          }
        }
      }
    }

    // Hide progress overlay
    progressOverlay.style.display = 'none';

    // Step 4: Show completion

    await showTerraformCompleteDialog({
      processed,
      duplicates,
      errors,
      log_path,
    });

    // Step 5: Switch to this library
    return await switchToLibrary(path, dbPath);
  } catch (error) {
    console.error('❌ Terraform failed:', error);
    showToast(`Terraform failed: ${error.message}`);

    // Hide progress overlay if showing
    const progressOverlay = document.getElementById('terraformProgressOverlay');
    if (progressOverlay) {
      progressOverlay.style.display = 'none';
    }

    return false;
  }
}

async function loadLibraryTransitionOverlay() {
  if (document.getElementById('libraryTransitionOverlay')) {
    return;
  }

  try {
    const response = await fetch('/fragments/libraryTransitionOverlay.html');
    if (!response.ok) {
      throw new Error(
        `Failed to load library transition overlay (${response.status})`,
      );
    }
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    console.error('❌ Failed to load library transition overlay:', error);
  }
}

async function showLibraryTransitionOverlay(options = {}) {
  let overlay = document.getElementById('libraryTransitionOverlay');
  if (!overlay) {
    await loadLibraryTransitionOverlay();
    overlay = document.getElementById('libraryTransitionOverlay');
  }

  if (!overlay) {
    return;
  }

  const titleEl = document.getElementById('libraryTransitionTitle');
  const statusEl = document.getElementById('libraryTransitionStatusLabel');

  if (titleEl) {
    titleEl.textContent = options.title || 'Opening library';
  }
  if (statusEl) {
    statusEl.textContent =
      options.message || 'Loading photos and preparing your library.';
  }

  overlay.style.display = 'flex';
  state.libraryTransitionActive = true;
}

function hideLibraryTransitionOverlay() {
  const overlay = document.getElementById('libraryTransitionOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
  state.libraryTransitionActive = false;
}

async function restorePreviousLibraryAfterFailedSwitch(previousLibrary) {
  if (!previousLibrary?.library_path) {
    return false;
  }

  try {
    const response = await fetch('/api/library/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        library_path: previousLibrary.library_path,
        db_path: previousLibrary.db_path,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to restore previous library');
    }

    const restoredGeneration = advanceLibraryGeneration();
    await loadAndRenderPhotos(false, {
      throwOnError: true,
      generation: restoredGeneration,
    });
    return true;
  } catch (error) {
    console.error('❌ Failed to restore previous library:', error);
    return false;
  }
}

function advanceLibraryGeneration() {
  state.libraryGeneration += 1;
  return state.libraryGeneration;
}

function isCurrentLibraryGeneration(generation) {
  return generation === state.libraryGeneration;
}

function renderSafeLibraryFallback() {
  advanceLibraryGeneration();
  state.photos = [];
  state.hasDatabase = false;
  state.selectedPhotos.clear();
  state.lastClickedIndex = null;
  const datePickerContainer = document.querySelector('.date-picker');
  if (datePickerContainer) {
    datePickerContainer.style.visibility = 'hidden';
  }
  renderFirstRunEmptyState();
  enableAppBarButtons();
}

/**
 * Sync app bar interactivity after library load state changes
 */
function enableAppBarButtons() {
  const hasPhotos = state.photos && state.photos.length > 0;
  const canUseDatePicker = state.hasDatabase && hasPhotos;

  // Re-enable add photo button (always available)
  const addPhotoBtn = document.getElementById('addPhotoBtn');
  if (addPhotoBtn) {
    addPhotoBtn.style.opacity = '1';
    addPhotoBtn.style.pointerEvents = 'auto';
  }

  // Sort button follows whether the current library has photos.
  const sortToggleBtn = document.getElementById('sortToggleBtn');
  if (sortToggleBtn) {
    sortToggleBtn.style.opacity = hasPhotos ? '1' : '0.3';
    sortToggleBtn.style.pointerEvents = hasPhotos ? 'auto' : 'none';
  }

  updateDeleteButtonVisibility();

  const monthPicker = document.getElementById('monthPicker');
  const yearPicker = document.getElementById('yearPicker');
  if (monthPicker) {
    monthPicker.disabled = !canUseDatePicker;
    monthPicker.style.opacity = canUseDatePicker ? '1' : '0.3';
  }
  if (yearPicker) {
    yearPicker.disabled = !canUseDatePicker;
    yearPicker.style.opacity = canUseDatePicker ? '1' : '0.3';
  }

  updateUtilityMenuAvailability();
}

async function createAndSwitchLibraryInSubfolder(parentPath) {
  const libraryName = await showNameLibraryDialog({
    title: 'Name your library',
    parentPath,
  });

  if (!libraryName) {
    return false;
  }

  const libraryPath = `${parentPath}/${libraryName}`;
  const createResponse = await fetch('/api/library/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library_path: libraryPath }),
  });

  const createResult = await createResponse.json();
  if (!createResponse.ok) {
    throw new Error(createResult.error || 'Failed to create library');
  }

  return await switchToLibrary(libraryPath, createResult.db_path);
}

/**
 * Phrase after "It should take " — avoids "about less than a minute".
 * Matches backend `estimate_duration` strings (e.g. "2-3 minutes", "1 hour" ranges).
 */
function formatDurationEstimateForItShouldTake(estimatedTime) {
  const fallback = 'less than a minute';
  const raw = (estimatedTime || fallback).trim();
  if (!raw) {
    return fallback;
  }
  if (raw.toLowerCase() === 'less than a minute') {
    return fallback;
  }
  return `about ${raw}`;
}

async function showRecoverDatabaseDialog() {
  return await showDialog(
    'Add new database',
    "The selected folder doesn't have a usable library database. Add a new database to continue.",
    [
      { text: 'Cancel', value: 'cancel', primary: false },
      { text: 'Add database', value: 'continue', primary: true },
    ],
  );
}

async function showGeneralPurposeFolderWarningDialog() {
  return await showDialog(
    'Use this folder for your library?',
    'This folder has many non-media files. You can continue, or create a subfolder instead.',
    [
      { text: 'Cancel', value: 'cancel', primary: false },
      {
        text: 'Create subfolder',
        value: 'create_subfolder',
        primary: true,
      },
      { text: 'Continue', value: 'continue', primary: false },
    ],
  );
}

async function showRecoverMediaDialog(options = {}) {
  const count = Number(options.media_count || 0).toLocaleString();
  const eta = options.estimated_time || 'less than a minute';
  return await showDialog(
    'Recover media',
    `This folder has ${count} untracked media files. It should take ${formatDurationEstimateForItShouldTake(eta)} to process them. Add them to your library?`,
    [
      { text: 'Cancel', value: 'cancel', primary: false },
      { text: 'See my library', value: 'see_library', primary: false },
      { text: 'Add media', value: 'add_media', primary: true },
    ],
  );
}

async function scanRecoverMediaAfterOpen(fallback = {}, streamOptions = {}) {
  const { signal } = streamOptions;
  try {
    const response = await fetch('/api/library/make-perfect/scan', { signal });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to scan recovered library');
    }

    const summary = data.summary || {};
    const scannedAddableCount = Number(summary.database_repairs);
    return {
      // `database_repairs` is the number of files the recovery flow can add.
      // `fallback.media_count` is only the raw folder count used when scan fails.
      media_count: Number.isFinite(scannedAddableCount)
        ? Math.max(scannedAddableCount, 0)
        : Number(fallback.media_count) || 0,
      duplicate_count: summary.duplicates ?? 0,
      incompatible_count: summary.unsupported_files ?? 0,
      estimated_time: fallback.media_eta || 'less than a minute',
    };
  } catch (error) {
    console.warn('⚠️ Failed to scan recovered media:', error);
    return {
      media_count: fallback.media_count || 0,
      duplicate_count: 0,
      incompatible_count: 0,
      estimated_time: fallback.media_eta || 'less than a minute',
    };
  }
}

async function runLibraryRecoveryJourney(selectedPath, checkResult) {
  libraryRecoveryState.hasSwitchedLibrary = false;
  setLibraryRecoveryShellHidden(true);
  let failureStage = 'recover_database';
  /** Set after a successful switch; used for all post-switch hydrations. */
  let hydrationGeneration = null;
  const recoveryJourneyAbort = new AbortController();

  await showLibraryRecoveryDockCard({
    title: 'Scanning library',
    body: 'Reviewing the database and searching for available media.',
    statusText: 'Preparing your library',
    statusSpinner: true,
    showCloseButton: true,
    onClose: () => recoveryJourneyAbort.abort(),
  });

  try {
    const recoverResponse = await fetch('/api/library/recover-database', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: selectedPath }),
      signal: recoveryJourneyAbort.signal,
    });
    const recoverResult = await recoverResponse.json();

    if (!recoverResponse.ok) {
      throw new Error(recoverResult.error || 'Failed to recover database');
    }

    if (recoveryJourneyAbort.signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    failureStage = 'switch';
    await switchToLibrary(selectedPath, recoverResult.db_path, {
      deferPhotoReload: true,
      skipTransitionOverlay: true,
      suppressSuccessToast: true,
      suppressFailureToast: true,
      throwOnError: true,
      signal: recoveryJourneyAbort.signal,
    });
    hydrationGeneration = state.libraryGeneration;
    libraryRecoveryState.hasSwitchedLibrary = true;
    failureStage = 'scan';

    const recoverMediaInfo = await scanRecoverMediaAfterOpen(
      {
        media_count: checkResult.media_count || 0,
        media_eta: checkResult.media_eta || 'less than a minute',
      },
      { signal: recoveryJourneyAbort.signal },
    );

    if (!recoverMediaInfo.media_count) {
      await loadAndRenderPhotosCommitted(hydrationGeneration);
      finishLibraryRecoveryJourney();
      return true;
    }

    const mediaCount = Number(recoverMediaInfo.media_count || 0);
    const mediaCountLabel = mediaCount.toLocaleString();
    const mediaFileLabel = mediaCount === 1 ? 'media file' : 'media files';
    const addClosingPhrase =
      mediaCount === 1 ? 'Add the file' : 'Add the files';
    const duplicateCount = Number(recoverMediaInfo.duplicate_count ?? 0);
    const incompatibleCount = Number(recoverMediaInfo.incompatible_count ?? 0);
    const recoverMediaChoice = await promptLibraryRecoveryDock({
      title: 'Scan complete',
      body: `This folder has ${mediaCountLabel} ${mediaFileLabel} that could be added to your library. It should take ${formatDurationEstimateForItShouldTake(recoverMediaInfo.estimated_time)}. ${addClosingPhrase} or go directly to your library.`,
      stats: [
        { label: 'Media files', value: mediaCount },
        { label: 'Duplicates', value: duplicateCount },
        { label: 'Incompatible', value: incompatibleCount },
      ],
      actions: [
        { text: 'Cancel', value: 'cancel', primary: false },
        { text: 'See my library', value: 'see_library', primary: false },
        { text: 'Add media', value: 'add_media', primary: true },
      ],
    });

    if (recoverMediaChoice !== 'add_media') {
      await loadAndRenderPhotosCommitted(hydrationGeneration);
      finishLibraryRecoveryJourney();
      return true;
    }

    const rebuildAbort = new AbortController();
    libraryRecoveryState.rebuildTotal = mediaCount;
    libraryRecoveryState.rebuildAdded = 0;
    let rebuildDismissed = false;
    const dismissRebuild = async () => {
      if (rebuildDismissed) {
        return;
      }
      rebuildDismissed = true;
      rebuildAbort.abort();
      try {
        await loadAndRenderPhotosCommitted(hydrationGeneration);
      } catch (error) {
        console.warn('Hydrate after rebuild cancel:', error);
      }
      finishLibraryRecoveryJourney();
    };

    await showLibraryRecoveryDockCard({
      title: 'Rebuilding library',
      body: `Repairing your library and adding ${mediaCountLabel} ${mediaFileLabel} to your database. Stay on this screen until it finishes.`,
      stats: [
        { label: 'Added', value: 0 },
        { label: 'Total', value: mediaCount },
      ],
      showCloseButton: true,
      onClose: dismissRebuild,
      actionsJustify: 'flex-end',
      actions: [
        {
          text: 'Cancel',
          primary: false,
          onClick: dismissRebuild,
        },
      ],
    });

    try {
      await streamMakeLibraryPerfect({
        signal: rebuildAbort.signal,
        onProgress: updateLibraryRecoveryMakePerfectProgress,
      });
      // Replace rebuild UI (with Cancel) so users cannot race hydrate by clicking Cancel.
      await showLibraryRecoveryDockCard({
        title: 'Opening library',
        body: 'Loading your photos into the app.',
        statusText: 'Almost done',
        statusSpinner: true,
        showCloseButton: false,
        actions: [],
      });
      await loadAndRenderPhotosCommitted(hydrationGeneration);
      finishLibraryRecoveryJourney();
      showToast('Library ready');
      return true;
    } catch (error) {
      if (error.name === 'AbortError') {
        if (!rebuildDismissed) {
          try {
            await loadAndRenderPhotosCommitted(hydrationGeneration);
          } catch (hydrateErr) {
            console.warn('Hydrate after rebuild abort:', hydrateErr);
          }
          finishLibraryRecoveryJourney();
        }
        return true;
      }
      console.error('❌ Recover media failed:', error);
      const failureCopy = getRecoveryFailureCopy('add_media', true);
      const postFailureChoice = await promptLibraryRecoveryDock({
        ...failureCopy,
        actions: [
          { text: 'Close', value: 'close', primary: false },
          { text: 'See my library', value: 'see_library', primary: true },
        ],
      });
      if (postFailureChoice === 'see_library') {
        try {
          await loadAndRenderPhotosCommitted(hydrationGeneration);
        } catch (hydrateErr) {
          console.error('❌ Failed to show library after recovery error:', hydrateErr);
          showToast(`Error: ${hydrateErr.message}`);
        }
      }
      finishLibraryRecoveryJourney();
      return true;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      finishLibraryRecoveryJourney();
      return false;
    }
    console.error('❌ Library recovery journey failed:', error);
    const hasSwitchedLibrary = libraryRecoveryState.hasSwitchedLibrary;
    const failureCopy = getRecoveryFailureCopy(
      failureStage,
      hasSwitchedLibrary,
    );
    const actions = hasSwitchedLibrary
      ? [
          { text: 'Close', value: 'close', primary: false },
          { text: 'See my library', value: 'see_library', primary: true },
        ]
      : [{ text: 'Close', value: 'close', primary: true }];
    const recoveryFailureChoice = await promptLibraryRecoveryDock({
      ...failureCopy,
      actions,
    });
    if (recoveryFailureChoice === 'see_library' && hydrationGeneration !== null) {
      try {
        await loadAndRenderPhotosCommitted(hydrationGeneration);
      } catch (hydrateErr) {
        console.error('❌ Failed to show library after recovery error:', hydrateErr);
        showToast(`Error: ${hydrateErr.message}`);
      }
    }
    finishLibraryRecoveryJourney();
    return hasSwitchedLibrary;
  }
}

/**
 * Browse for library (uses custom folder picker)
 * Healthy libraries open immediately. Missing/corrupt DBs recover in place and
 * optionally hand off into the same full cleanup engine as Clean library.
 */
async function browseSwitchLibrary() {
  try {
    closeSwitchLibraryOverlay();

    const selectedPath = await FolderPicker.show({
      intent: FolderPicker.INTENT.OPEN_EXISTING_LIBRARY,
      title: 'Open library',
      subtitle:
        'Select an existing library folder (or choose where to create one).',
    });

    if (!selectedPath) {
      return false;
    }

    setOpenLibraryModalHandoffShellHidden(true);

    const checkResponse = await fetch('/api/library/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: selectedPath }),
    });
    const checkResult = await checkResponse.json();

    if (!checkResponse.ok) {
      throw new Error(checkResult.error || 'Failed to inspect selected folder');
    }

    if (checkResult.has_openable_db) {
      setOpenLibraryModalHandoffShellHidden(false);
      return await switchToLibrary(selectedPath, checkResult.db_path);
    }

    const recoverChoice = await showRecoverDatabaseDialog();
    if (recoverChoice !== 'continue') {
      setOpenLibraryModalHandoffShellHidden(false);
      return false;
    }

    if (checkResult.folder_warning?.show) {
      const warningChoice = await showGeneralPurposeFolderWarningDialog();
      if (warningChoice === 'create_subfolder') {
        setOpenLibraryModalHandoffShellHidden(false);
        return await createAndSwitchLibraryInSubfolder(selectedPath);
      }
      if (warningChoice !== 'continue') {
        setOpenLibraryModalHandoffShellHidden(false);
        return false;
      }
    }

    return await runLibraryRecoveryJourney(selectedPath, checkResult);
  } catch (error) {
    console.error('❌ Failed to browse library:', error);
    setOpenLibraryModalHandoffShellHidden(false);
    showToast(`Error: ${error.message}`);
    return false;
  }
}

/**
 * True if a folder with the same sanitized name already exists under parentPath.
 */
async function libraryFolderNameExistsAtParent(parentPath, rawName) {
  const sanitizeFolderName = (name) =>
    name
      .replace(/[\/\\:*?"<>|]/g, '')
      .replace(/^\.+/, '')
      .trim();
  const sanitized = sanitizeFolderName(rawName);
  if (!sanitized) return false;
  try {
    const response = await fetch('/api/filesystem/list-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: parentPath }),
    });
    if (!response.ok) return false;
    const data = await response.json();
    const existingFolders = data.folders.map((f) =>
      typeof f === 'string' ? f : f.name,
    );
    return existingFolders.includes(sanitized);
  } catch (_) {
    return false;
  }
}

/**
 * Create new library with name prompt (first-run flow): naming → location → create → import
 */
async function createNewLibraryWithName(dialogOptions = {}) {
  try {
    let phase = 'name';
    let libraryName = null;
    let selectedParentPath = null;
    let showDuplicateCopy = false;

    while (true) {
      if (phase === 'name') {
        const nameResult = await showNameLibraryDialog({
          ...dialogOptions,
          ...(showDuplicateCopy
            ? {
                title: 'Folder already exists',
                subtitle:
                  'Give your library a unique name to continue adding photos.',
              }
            : {}),
          wizardActions: true,
          showGoBack: selectedParentPath !== null,
          parentPath: selectedParentPath,
          initialLibraryName: libraryName,
        });

        if (
          nameResult &&
          typeof nameResult === 'object' &&
          nameResult.action === 'cancel'
        ) {
          return false;
        }
        if (
          nameResult &&
          typeof nameResult === 'object' &&
          nameResult.action === 'back'
        ) {
          selectedParentPath = null;
          showDuplicateCopy = false;
          phase = 'folder';
          continue;
        }

        libraryName = nameResult;
        showDuplicateCopy = false;
        phase = selectedParentPath ? 'create' : 'folder';
        continue;
      }

      if (phase === 'folder') {
        const folderResult = await FolderPicker.show({
          intent: FolderPicker.INTENT.CHOOSE_LIBRARY_LOCATION,
          title: 'Library location',
          subtitle: "Choose where you'd like to create your new library",
          wizardActions: true,
          showGoBack: true,
          keepVisibleOnChoose: true,
        });

        if (
          folderResult &&
          typeof folderResult === 'object' &&
          folderResult.action === 'cancel'
        ) {
          return false;
        }
        if (
          folderResult &&
          typeof folderResult === 'object' &&
          folderResult.action === 'back'
        ) {
          selectedParentPath = null;
          showDuplicateCopy = false;
          phase = 'name';
          continue;
        }

        selectedParentPath = folderResult;
        phase = 'create';
        continue;
      }

      if (phase === 'create') {
        if (!selectedParentPath) {
          phase = 'folder';
          continue;
        }

        const taken = await libraryFolderNameExistsAtParent(
          selectedParentPath,
          libraryName,
        );
        if (taken) {
          FolderPicker.hide();
          showDuplicateCopy = true;
          phase = 'name';
          continue;
        }

        const cleanParentPath = selectedParentPath.replace(/\/+$/, '');
        const fullLibraryPath = `${cleanParentPath}/${libraryName}`;

        const createResponse = await fetch('/api/library/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            library_path: fullLibraryPath,
          }),
        });

        const createResult = await createResponse.json();

        if (!createResponse.ok) {
          const errorMessage = createResult.error || 'Failed to create library';
          if (
            createResponse.status === 400 &&
            /already exists/i.test(errorMessage)
          ) {
            FolderPicker.hide();
            showDuplicateCopy = true;
            phase = 'name';
            continue;
          }

          throw new Error(createResult.error || 'Failed to create library');
        }

        const switched = await switchToLibrary(
          fullLibraryPath,
          createResult.db_path,
          { skipTransitionOverlay: true },
        );
        if (!switched) {
          FolderPicker.hide();
          return false;
        }

        await triggerImport({
          onPickerVisible: () => FolderPicker.hide(),
        });

        return true;
      }
    }
  } catch (error) {
    FolderPicker.hide();
    console.error('❌ Failed to create library:', error);
    showToast(`Error: ${error.message}`);
    return false;
  }
}

/**
 * Reset library configuration to first-run state (debug)
 */
async function resetLibraryConfig() {
  try {
    const response = await fetch('/api/library/reset', {
      method: 'DELETE',
    });

    const data = await response.json();

    if (data.status === 'success') {
      window.location.reload();
    } else {
      throw new Error(data.error || 'Reset failed');
    }
  } catch (error) {
    console.error('❌ Failed to reset configuration:', error);
    showToast(`Reset failed: ${error.message}`, 'error');
  }
}

/**
 * Show create library confirmation overlay
 */
async function showCreateLibraryConfirmation(libraryPath, dbPath) {
  // Load overlay if not already loaded
  let overlay = document.getElementById('createLibraryOverlay');
  if (!overlay) {
    await loadCreateLibraryOverlay();
    overlay = document.getElementById('createLibraryOverlay');
  }

  // Set path
  document.getElementById('newLibraryPath').textContent = libraryPath;

  // Wire up buttons for this specific confirmation
  const cancelBtn = document.getElementById('createLibraryCancelBtn');
  const confirmBtn = document.getElementById('createLibraryConfirmBtn');

  // Remove old listeners by cloning
  const newCancelBtn = cancelBtn.cloneNode(true);
  const newConfirmBtn = confirmBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
  confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

  // Add new listeners
  newCancelBtn.addEventListener('click', () => {
    overlay.style.display = 'none';
  });

  newConfirmBtn.addEventListener('click', async () => {
    await createAndSwitchLibrary(libraryPath, dbPath);
  });

  overlay.style.display = 'block';
}

/**
 * Create new library and switch to it
 */
async function createAndSwitchLibrary(libraryPath, dbPath) {
  try {
    // Show loading
    const confirmBtn = document.getElementById('createLibraryConfirmBtn');
    confirmBtn.textContent = 'Creating...';
    confirmBtn.disabled = true;

    // Create library
    const createResponse = await fetch('/api/library/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: libraryPath, db_path: dbPath }),
    });

    const createResult = await createResponse.json();

    if (!createResponse.ok) {
      throw new Error(createResult.error || 'Failed to create library');
    }

    // Close create overlay
    document.getElementById('createLibraryOverlay').style.display = 'none';

    // Switch to new library
    const switched = await switchToLibrary(libraryPath, createResult.db_path);
    if (!switched) {
      confirmBtn.textContent = 'Create & Switch';
      confirmBtn.disabled = false;
    }
  } catch (error) {
    console.error('❌ Failed to create library:', error);
    showToast(`Error: ${error.message}`);

    // Reset button
    const confirmBtn = document.getElementById('createLibraryConfirmBtn');
    confirmBtn.textContent = 'Create & Switch';
    confirmBtn.disabled = false;
  }
}

/**
 * Switch to a different library
 */
async function switchToLibrary(libraryPath, dbPath, switchOptions = {}) {
  const deferPhotoReload = !!switchOptions.deferPhotoReload;
  const deferTransitionHide = !!switchOptions.deferTransitionHide;
  const skipTransitionOverlay = !!switchOptions.skipTransitionOverlay;
  const suppressSuccessToast = !!switchOptions.suppressSuccessToast;
  const suppressFailureToast = !!switchOptions.suppressFailureToast;
  const throwOnError = !!switchOptions.throwOnError;
  const { signal } = switchOptions;
  const previousLibrary = await fetchCurrentLibraryInfo();
  const folderName = libraryPath.split('/').filter(Boolean).pop() || 'library';
  let switchedLibrary = false;
  let success = false;

  try {
    if (!skipTransitionOverlay && !state.libraryTransitionActive) {
      await showLibraryTransitionOverlay({
        title: 'Opening library',
        message: 'Loading photos and preparing your library.',
      });
    }

    const response = await fetch('/api/library/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: libraryPath, db_path: dbPath }),
      signal,
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to switch library');
    }
    switchedLibrary = true;
    const switchedGeneration = advanceLibraryGeneration();

    // Close overlays
    closeSwitchLibraryOverlay();
    const createOverlay = document.getElementById('createLibraryOverlay');
    if (createOverlay) createOverlay.style.display = 'none';

    // Reload photos from new library
    if (!deferPhotoReload) {
      await loadAndRenderPhotos(false, {
        throwOnError: true,
        generation: switchedGeneration,
      });
    }
    if (
      !deferTransitionHide &&
      !skipTransitionOverlay &&
      !suppressSuccessToast
    ) {
      showToast(`Opened ${folderName}`);
    }
    success = true;
    return true;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw error;
    }
    console.error('❌ Failed to switch library:', error);
    let restoredPreviousLibrary = false;
    const shouldAttemptRestore =
      switchedLibrary && previousLibrary?.library_path !== libraryPath;

    if (shouldAttemptRestore) {
      if (!skipTransitionOverlay) {
        await showLibraryTransitionOverlay({
          title: 'Restoring previous library',
          message:
            'Returning to your previous library after the switch failed.',
        });
      }
      restoredPreviousLibrary =
        await restorePreviousLibraryAfterFailedSwitch(previousLibrary);
    }

    if (switchedLibrary && !restoredPreviousLibrary && shouldAttemptRestore) {
      renderSafeLibraryFallback();
    }

    const errorMessage = restoredPreviousLibrary
      ? `Couldn't open ${folderName}. Restored your previous library.`
      : `Error: ${error.message}`;
    if (!suppressFailureToast) {
      showToast(errorMessage);
    }
    if (throwOnError) {
      throw new Error(errorMessage);
    }
    return false;
  } finally {
    if (!skipTransitionOverlay && (!deferTransitionHide || !success)) {
      hideLibraryTransitionOverlay();
    }
  }
}

// =====================
// IMPORT MEDIA
// =====================

/**
 * Trigger import with library check (creates library if needed)
 */
async function triggerImportWithLibraryCheck() {
  try {
    // Check if library is configured
    const response = await fetch('/api/library/status');
    const status = await response.json();

    if (status.status === 'not_configured') {
      // No library - prompt to create one first

      // Create new library with naming (custom copy for Add photos flow)
      const created = await createNewLibraryWithName({
        title: 'Add to new library',
        subtitle:
          'To add photos, first create a new library. Give your library a name to continue.',
      });

      // If user cancelled at any point, show empty state
      if (!created) {
        renderFirstRunEmptyState();
        return;
      }

      // After library is created, the page will reload automatically
      // (handled by createAndSwitchLibrary -> switchToLibrary -> reload)
      return;
    }

    // Library exists - proceed with normal import
    await triggerImport();
  } catch (error) {
    console.error('❌ Failed to check library status:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Trigger import via disambiguation dialog
 * @param {object} [options]
 * @param {boolean} [options.deferTransitionHandoff] If true, keep the library transition
 *   overlay up until the photo picker is fully painted and ready to take over.
 * @param {Function} [options.onPickerVisible] Optional callback fired exactly once
 *   when the photo picker is ready to take over, or immediately if setup fails first.
 */
async function triggerImport(options = {}) {
  const deferHandoff = !!options.deferTransitionHandoff;
  let didRunPickerVisibleCallback = false;

  function runPickerVisibleCallback() {
    if (didRunPickerVisibleCallback) {
      return;
    }
    didRunPickerVisibleCallback = true;
    if (typeof options.onPickerVisible === 'function') {
      options.onPickerVisible();
    }
  }

  try {
    if (deferHandoff && state.libraryTransitionActive) {
      await showLibraryTransitionOverlay({
        title: 'Select photos',
        message: 'Choose photos and folders to import.',
      });
    }

    const selectedPaths = await PhotoPicker.show({
      title: 'Select photos',
      subtitle: 'Choose photos and folders to import',
      onOverlayReady: () => {
        if (deferHandoff) {
          hideLibraryTransitionOverlay();
        }
        runPickerVisibleCallback();
      },
    });

    if (!selectedPaths || selectedPaths.length === 0) {
      return;
    }

    // Scan paths to expand folders into file list (without confirmation dialog)
    await scanAndImport(selectedPaths);
  } catch (error) {
    if (deferHandoff) {
      hideLibraryTransitionOverlay();
    }
    runPickerVisibleCallback();
    console.error('❌ Failed to trigger import:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Import individual files
 */
async function importFiles() {
  try {
    // Blur browser window to ensure focus shifts to native file picker
    window.blur();

    const script =
      'POSIX path of (choose file of type {"public.image", "public.movie"} with prompt "Select photos to import" with multiple selections allowed)';

    const response = await fetch('/api/import/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script }),
    });

    if (!response.ok) {
      const error = await response.json();
      if (error.status === 'cancelled') {
        return;
      }
      throw new Error(error.error || 'Failed to select files');
    }

    const result = await response.json();
    const paths = result.paths || [];

    if (paths.length === 0) {
      return;
    }

    await scanAndConfirmImport(paths);
  } catch (error) {
    console.error('❌ Failed to import files:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Import folders recursively
 */
async function importFolders() {
  try {
    // Blur browser window to ensure focus shifts to native folder picker
    window.blur();

    const script =
      'POSIX path of (choose folder with prompt "Select folder to import" with multiple selections allowed)';

    const response = await fetch('/api/import/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script }),
    });

    if (!response.ok) {
      const error = await response.json();
      if (error.status === 'cancelled') {
        return;
      }
      throw new Error(error.error || 'Failed to select folder');
    }

    const result = await response.json();
    const paths = result.paths || [];

    if (paths.length === 0) {
      return;
    }

    await scanAndConfirmImport(paths);
  } catch (error) {
    console.error('❌ Failed to import folders:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Scan paths and import directly (no confirmation dialog)
 */
async function scanAndImport(paths) {
  try {
    showToast('Scanning...', null, 0);

    const response = await fetch('/api/import/scan-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to scan paths');
    }

    const { files, total_count } = result;

    if (total_count === 0) {
      showToast('No media files found', null);
      return;
    }

    // Start import directly (no confirmation dialog)
    await startImportFromPaths(files);
  } catch (error) {
    console.error('❌ Failed to scan paths:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Scan selected paths and show confirmation
 */
async function scanAndConfirmImport(paths) {
  try {
    showToast('Scanning...', null, 0);

    const response = await fetch('/api/import/scan-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to scan paths');
    }

    const { files, total_count, files_selected, folders_scanned } = result;

    if (total_count === 0) {
      showToast('No media files found', null);
      return;
    }

    // Show confirmation
    const message = `Found ${total_count} total file${total_count > 1 ? 's' : ''}. Start import?`;

    const confirmed = await showDialog('Import media', message, [
      { text: 'Cancel', value: false, secondary: true },
      { text: 'Import', value: true, primary: true },
    ]);

    if (!confirmed) {
      return;
    }

    // Start import with file list
    await startImportFromPaths(files);
  } catch (error) {
    console.error('❌ Failed to scan paths:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Start import process from file paths (SSE streaming version)
 */
async function startImportFromPaths(filePaths) {
  try {
    if (importState.isImporting) {
      console.warn('⚠️ Import already in progress');
      return;
    }

    // Load import overlay if not already loaded
    const overlay = document.getElementById('importOverlay');
    if (!overlay) {
      await loadImportOverlay();
    }

    const controller = new AbortController();
    resetImportSession(filePaths.length);
    importState.abortController = controller;

    // Show overlay
    showImportOverlay();

    // Start SSE stream
    const response = await fetch('/api/photos/import-from-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: filePaths }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error('Import request failed');
    }

    if (!response.body) {
      throw new Error('Import stream unavailable');
    }

    // Handle SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        const eventMatch = line.match(/^event: (.+)$/m);
        const dataMatch = line.match(/^data: (.+)$/m);

        if (eventMatch && dataMatch) {
          const event = eventMatch[1];
          const data = JSON.parse(dataMatch[1]);

          handleImportEvent(event, data);
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }

    console.error('❌ Import failed:', error);
    showToast(`Import failed: ${error.message}`, null);
    await hideImportOverlay(false);
  } finally {
    finishImportSession();
  }
}

/**
 * Handle import SSE events
 */
function handleImportEvent(event, data) {
  const statusText = document.getElementById('importStatusText');
  const stats = document.getElementById('importStats');
  const importedCount = document.getElementById('importedCount');
  const duplicateCount = document.getElementById('duplicateCount');
  const errorCount = document.getElementById('errorCount');

  if (event === 'start') {
    importState.totalFiles = data.total || importState.totalFiles;
    importState.importedCount = 0;
    importState.duplicateCount = 0;
    importState.errorCount = 0;
    importState.importedPhotoIds = [];

    if (statusText) {
      statusText.textContent = `Importing ${data.total} files...`;
    }
    if (stats) {
      stats.style.display = 'flex';
    }

    const detailsSection = document.getElementById('importDetailsSection');
    if (detailsSection) {
      detailsSection.style.display = 'none';
    }

    setImportActionButtons({ showCancel: true });
  }

  if (event === 'progress') {
    importState.importedCount = data.imported || 0;
    importState.duplicateCount = data.duplicates || 0;
    importState.errorCount = data.errors || 0;

    if (importedCount) {
      importedCount.textContent = importState.importedCount;
    }
    if (duplicateCount) {
      duplicateCount.textContent = importState.duplicateCount;
    }
    if (errorCount) {
      errorCount.textContent = importState.errorCount;
    }

    // Track imported photo ID if provided
    if (data.photo_id) {
      importState.importedPhotoIds.push(data.photo_id);
      window.importedPhotoIds = [...importState.importedPhotoIds];
    }

    // Track error details if present
    if (data.error && data.error_file) {
      if (!window.importErrors) {
        window.importErrors = [];
      }
      window.importErrors.push({
        file: data.error_file,
        message: data.error,
      });
    }
  }

  // Handle rejection events
  if (event === 'rejected') {
    if (!window.importRejections) {
      window.importRejections = [];
    }
    window.importRejections.push({
      file: data.file,
      source_path: data.source_path,
      reason: data.reason,
      category: data.category,
      technical_error: data.technical_error,
    });
  }

  if (event === 'complete') {
    importState.importedCount = data.imported || 0;
    importState.duplicateCount = data.duplicates || 0;
    importState.errorCount = data.errors || 0;

    const totalErrors = data.errors || 0;

    if (totalErrors > 0) {
      statusText.innerHTML = `<p>Import complete with ${totalErrors} error${
        totalErrors > 1 ? 's' : ''
      }</p>`;

      // Show unified error details (includes both general errors and rejections)
      showUnifiedErrorDetails();

      // Show error details if we have them
      if (window.importErrors && window.importErrors.length > 0) {
        const detailsSection = document.getElementById('importDetailsSection');
        const detailsList = document.getElementById('importDetailsList');
        const toggleBtn = document.getElementById('importDetailsToggle');

        if (detailsSection && detailsList) {
          detailsSection.style.display = 'block';
          detailsList.innerHTML = '';

          window.importErrors.forEach((err) => {
            const item = document.createElement('div');
            item.className = 'import-detail-item';
            item.innerHTML = `
              <span class="material-symbols-outlined import-detail-icon error">error</span>
              <div class="import-detail-text">
                <div>${err.file}</div>
                <div class="import-detail-message">${err.message}</div>
              </div>
            `;
            detailsList.appendChild(item);
          });

          // Keep list collapsed initially, update toggle button text
          detailsList.style.display = 'none';
          if (toggleBtn) {
            toggleBtn.classList.remove('expanded');
            toggleBtn.innerHTML = `
              <span class="material-symbols-outlined">expand_more</span>
              <span>Show details</span>
            `;
          }
        }
      }
    } else {
      statusText.innerHTML = '<p>Import complete</p>';
    }

    if (importedCount) {
      importedCount.textContent = importState.importedCount;
    }
    if (duplicateCount) {
      duplicateCount.textContent = importState.duplicateCount;
    }
    if (errorCount) {
      errorCount.textContent = importState.errorCount;
    }

    setImportActionButtons({
      showDone: true,
      showUndo: importState.importedCount > 0,
    });

    // Reload grid so the library matches the DB (imports, dupes-only, or mixed)
    loadAndRenderPhotos(false);
  }

  if (event === 'error') {
    if (statusText) {
      statusText.innerHTML = `<p>Import failed: ${data.error}</p>`;
    }
    setImportActionButtons({ showDone: true });
  }
}

// =====================
// INITIALIZATION
// =====================

/**
 * Check library health and initialize app state
 */
async function checkLibraryHealthAndInit() {
  try {
    const response = await fetch('/api/library/status');
    const status = await response.json();

    switch (status.status) {
      case 'not_configured':
        // First-time setup - show empty state

        state.hasDatabase = false;
        renderFirstRunEmptyState();
        return;

      case 'library_missing':
      case 'library_inaccessible':
        state.hasDatabase = false;
        showCriticalErrorModal('library_not_found', status.library_path);
        return;

      case 'db_missing':
      case 'db_corrupted':
      case 'db_inaccessible':
        state.hasDatabase = false;
        showCriticalErrorModal(status.status, status.db_path);
        return;

      case 'needs_migration':
        state.hasDatabase = false;
        showCriticalErrorModal('db_needs_migration', status.message);
        return;

      case 'healthy':
        state.hasDatabase = true;
        // Load photos (date picker will be populated automatically)
        await loadAndRenderPhotos();
        return;

      default:
        // 'error' or unknown status
        console.error('❌ Unknown status:', status.status);
        state.hasDatabase = false;
        showCriticalErrorModal('unknown_error', status.message);
        return;
    }
  } catch (error) {
    console.error('❌ Failed to check library status:', error);
    state.hasDatabase = false;
    showCriticalErrorModal('unknown_error', error.message);
  }
}

/**
 * Initialize app
 */
async function init() {
  // Wait for fonts to load to prevent layout shift
  await document.fonts.ready;

  // Load UI fragments first (but don't populate with data yet)
  await loadAppBar();
  await loadLightbox();
  await loadDateEditor();
  await loadDialog();
  await loadToast();
  await loadCriticalErrorModal();

  // Check library health before making any data API calls
  await checkLibraryHealthAndInit();
}

/**
 * Show unified error details (general errors + rejections) in import overlay
 */
function showUnifiedErrorDetails() {
  const detailsSection = document.getElementById('importDetailsSection');
  const detailsList = document.getElementById('importDetailsList');
  const toggleBtn = document.getElementById('importDetailsToggle');

  if (!detailsSection || !detailsList) return;

  detailsSection.style.display = 'block';
  detailsList.innerHTML = '';

  const hasGeneralErrors =
    window.importErrors && window.importErrors.length > 0;
  const hasRejections =
    window.importRejections && window.importRejections.length > 0;
  const totalErrors =
    (window.importErrors?.length || 0) + (window.importRejections?.length || 0);

  // Section 1: General errors (if any)
  if (hasGeneralErrors) {
    const header = document.createElement('div');
    header.className = 'import-detail-category-header';
    header.innerHTML = `
      <span class="material-symbols-outlined">error</span>
      <strong>Import Errors</strong> (${window.importErrors.length})
    `;
    detailsList.appendChild(header);

    window.importErrors.forEach((err) => {
      const item = document.createElement('div');
      item.className = 'import-detail-item';
      item.innerHTML = `
        <span class="material-symbols-outlined import-detail-icon error">error</span>
        <div class="import-detail-text">
          <div>${err.file}</div>
          <div class="import-detail-message">${err.message}</div>
        </div>
      `;
      detailsList.appendChild(item);
    });
  }

  // Section 2: Rejections - flat list without header
  if (hasRejections) {
    const MAX_DISPLAY = 20;

    // Show first 20 rejections
    const itemsToShow = window.importRejections.slice(0, MAX_DISPLAY);

    itemsToShow.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'import-detail-item';
      div.style.marginTop = hasGeneralErrors ? '16px' : '0';

      // Universal error icon for all rejection types
      div.innerHTML = `
        <span class="material-symbols-outlined import-detail-icon error">error</span>
        <div class="import-detail-text">
          <div>${item.file}</div>
          <div class="import-detail-message">${item.reason}</div>
        </div>
      `;
      detailsList.appendChild(div);
    });

    // Show "and N more" if capped
    if (window.importRejections.length > MAX_DISPLAY) {
      const remaining = window.importRejections.length - MAX_DISPLAY;
      const moreDiv = document.createElement('div');
      moreDiv.style.padding = '12px';
      moreDiv.style.textAlign = 'center';
      moreDiv.style.color = '#b3b3b3';
      moreDiv.style.fontStyle = 'italic';
      moreDiv.style.fontSize = '13px';
      moreDiv.textContent = `... and ${remaining} more`;
      detailsList.appendChild(moreDiv);
    }

    // Add action buttons for rejections
    const actions = document.createElement('div');
    actions.className = 'import-rejection-actions';
    actions.innerHTML = `
      <button class="btn btn-secondary" id="copyRejectedBtn">
        <span class="material-symbols-outlined">folder_copy</span>
        Collect rejected files
      </button>
      <button class="btn btn-secondary" id="exportRejectionListBtn">
        <span class="material-symbols-outlined">description</span>
        Export list
      </button>
    `;
    detailsList.appendChild(actions);

    // Wire up buttons
    document
      .getElementById('copyRejectedBtn')
      ?.addEventListener('click', copyRejectedFiles);
    document
      .getElementById('exportRejectionListBtn')
      ?.addEventListener('click', exportRejectionList);
  }

  // Keep collapsed initially
  detailsList.style.display = 'none';
  if (toggleBtn) {
    toggleBtn.classList.remove('expanded');
    toggleBtn.innerHTML = `
      <span class="material-symbols-outlined">expand_more</span>
      <span>Show details</span>
    `;

    // Wire up toggle
    const newToggleBtn = toggleBtn.cloneNode(true);
    toggleBtn.parentNode.replaceChild(newToggleBtn, toggleBtn);

    newToggleBtn.addEventListener('click', () => {
      const isExpanded = detailsList.style.display !== 'none';

      if (isExpanded) {
        detailsList.style.display = 'none';
        newToggleBtn.classList.remove('expanded');
        newToggleBtn.innerHTML = `
          <span class="material-symbols-outlined">expand_more</span>
          <span>Show details</span>
        `;
      } else {
        detailsList.style.display = 'block';
        newToggleBtn.classList.add('expanded');
        newToggleBtn.innerHTML = `
          <span class="material-symbols-outlined">expand_less</span>
          <span>Hide details</span>
        `;
      }
    });
  }
}

/**
 * Show rejection details in import overlay (DEPRECATED - use showUnifiedErrorDetails)
 */
function showRejectionDetails() {
  // Keep for backward compatibility, redirect to unified version
  showUnifiedErrorDetails();
}

/**
 * Copy rejected files to user-specified folder
 */
async function copyRejectedFiles() {
  try {
    if (!window.importRejections || window.importRejections.length === 0) {
      showToast('No rejected files to copy', 'error');
      return;
    }

    // Hide import overlay to show folder picker cleanly
    const importOverlay = document.getElementById('importOverlay');
    if (importOverlay) {
      importOverlay.style.display = 'none';
    }

    // Show folder picker
    const destFolder = await FolderPicker.show({
      intent: FolderPicker.INTENT.GENERIC_FOLDER_SELECTION,
      title: 'Copy rejected files',
      subtitle: 'Choose destination folder for rejected files',
    });

    // Restore import overlay
    if (importOverlay) {
      importOverlay.style.display = 'flex';
    }

    if (!destFolder) {
      return;
    }

    showToast('Copying files...', 'info');

    // Call backend
    const response = await fetch('/api/import/copy-rejected-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: window.importRejections,
        destination: destFolder,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Copy failed');
    }

    const result = await response.json();
    showToast(`Copied ${result.copied} files to ${result.folder}`, null, 3000);
  } catch (error) {
    console.error('Copy rejected files failed:', error);
    showToast(`Copy failed: ${error.message}`, 'error');
  }
}

/**
 * Export rejection list as text file
 */
function exportRejectionList() {
  if (!window.importRejections || window.importRejections.length === 0) {
    showToast('No rejected files to export', 'error');
    return;
  }

  // Build report text
  const timestamp = new Date().toISOString();
  let report = `Import Rejection Report\n`;
  report += `Generated: ${timestamp}\n`;
  report += `Total rejected: ${window.importRejections.length}\n\n`;
  report += `${'='.repeat(70)}\n\n`;

  window.importRejections.forEach((item, i) => {
    report += `${i + 1}. ${item.file}\n`;
    report += `   Reason: ${item.reason}\n`;
    report += `   Category: ${item.category}\n`;
    report += `   Source: ${item.source_path}\n`;
    if (item.technical_error) {
      report += `   Technical: ${item.technical_error}\n`;
    }
    report += `\n`;
  });

  // Download as text file
  const blob = new Blob([report], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rejection_report_${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('Report downloaded', null, 3000);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
