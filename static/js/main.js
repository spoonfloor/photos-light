// Photo Viewer - Main Entry Point
const MAIN_JS_VERSION = 'v390';
console.log(`🚀 main.js loaded: ${MAIN_JS_VERSION}`);

// =====================
// STATE MANAGEMENT
// =====================

const state = {
  currentSortOrder: 'newest', // 'newest' or 'oldest'
  activeFilters: {
    starred: false,
    video: false,
  },
  selectedPhotos: new Set(),
  photos: [],
  loading: false,
  libraryGeneration: 0,
  libraryTransitionActive: false,
  lastClickedIndex: null, // For shift-select
  lightboxOpen: false,
  lightboxPhotoIndex: null, // Index of currently viewed photo in lightbox
  lightboxUITimeout: null, // Timeout for hiding UI after pointer leaves overlay
  lightboxUIHovered: false, // True while pointer is over the lightbox overlay
  deleteInProgress: false,
  hasMore: true, // For infinite scroll
  currentOffset: 0, // Current pagination offset
  navigateToMonth: null, // Month to navigate to after closing lightbox (e.g., '2025-12')
  hasDatabase: false, // Track whether database exists and is healthy
  libraryPath: null, // Current library folder path (set on switch)
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

const debugFileCountState = {
  runId: 0,
  scanRoot: null,
  signalCounts: null,
  logEntries: [],
  scorecard: null,
  runtime: null,
  entryState: null,
};

const CLEANER_SIGNAL_DEFS = [
  { key: 'misfiled_media', label: 'MOVE/RENAME', detailKey: 'misfiled_media' },
  { key: 'unsupported_files', label: 'UNSUPPORTED', detailKey: 'unsupported_files' },
  { key: 'duplicates', label: 'DUPLICATES', detailKey: 'duplicates' },
  { key: 'metadata_cleanup', label: 'METADATA', detailKey: 'metadata_cleanup' },
  { key: 'folder_cleanup', label: 'Cleanup', detailKey: 'folder_cleanup' },
  { key: 'database_repairs', label: 'DB REPAIRS', detailKey: 'database_repairs' },
];

const CLEANER_SIGNAL_KEYS = CLEANER_SIGNAL_DEFS.map((signalDef) => signalDef.key);

const DEFAULT_CLEANER_SCORECARD_VIEW = CLEANER_SIGNAL_DEFS.map((signalDef) => ({
  key: signalDef.key,
  label: signalDef.label,
  signals: [signalDef.key],
}));

/**
 * Open-folder / recovery dock: three buckets (no cleanup column).
 * Media files = winners: M − duplicate_losers (M = supported_media_files from scan).
 * Duplicates = loser count; Unsupported = unsupported_files signal.
 *
 * During streaming, pass preflightWinnerCount = M − initialDuplicates so column 1
 * stays fixed; M is from pre-scan while duplicate signal burns down — otherwise
 * M − duplicates_remaining incorrectly rises as losers are trashed.
 */
function reduceOpenFolderRecoveryBuckets(signalCounts = {}, options = {}) {
  const c = normalizeCleanerSignalCounts(signalCounts);
  const duplicates = c.duplicates;
  const mRaw = options.supportedMediaCount;
  const m =
    mRaw === undefined || mRaw === null ? null : Math.max(0, Number(mRaw));
  const pwc = options.preflightWinnerCount;
  const mediaFiles =
    pwc !== null && pwc !== undefined && Number.isFinite(Number(pwc))
      ? Math.max(0, Number(pwc))
      : m !== null && Number.isFinite(m)
        ? Math.max(0, m - duplicates)
        : Math.max(0, c.misfiled_media - duplicates);
  return [
    {
      key: 'open_folder_media_files',
      label: 'Media files',
      value: mediaFiles,
    },
    {
      key: 'open_folder_duplicates',
      label: 'Duplicates',
      value: duplicates,
    },
    {
      key: 'open_folder_unsupported',
      label: 'Unsupported',
      value: c.unsupported_files,
    },
  ];
}

function createOpenFolderRecoveryBucketReducer(
  supportedMediaCount,
  initialDuplicateCount,
) {
  const m =
    supportedMediaCount === undefined || supportedMediaCount === null
      ? null
      : Math.max(0, Number(supportedMediaCount));
  const d0 =
    initialDuplicateCount === undefined || initialDuplicateCount === null
      ? null
      : Math.max(0, Number(initialDuplicateCount));
  let preflightWinnerCount = null;
  if (
    m !== null &&
    Number.isFinite(m) &&
    d0 !== null &&
    Number.isFinite(d0)
  ) {
    preflightWinnerCount = Math.max(0, m - d0);
  }
  return (signalCounts) =>
    reduceOpenFolderRecoveryBuckets(signalCounts, {
      supportedMediaCount,
      preflightWinnerCount,
    });
}

function getOpenFolderRecoveryPendingTotal(signalCounts = {}) {
  return Number(normalizeCleanerSignalCounts(signalCounts).operation_count || 0);
}

/** Pause between debug log lines so the scoreboard animation and console output are observable. */
const DEBUG_FILE_COUNT_LOG_STEP_MS = 200;

let currentPhotoLoad = null;
let currentPhotoLoadAbortController = null;
let photoLoadRequestId = 0;

const ROTATABLE_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
]);

const HEIC_IMAGE_EXTENSIONS = new Set(['.heic', '.heif']);

const IMPORT_PHOTO_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.heic',
  '.heif',
  '.png',
  '.gif',
  '.tiff',
  '.tif',
  '.webp',
  '.avif',
  '.jp2',
  '.raw',
  '.cr2',
  '.nef',
  '.arw',
  '.dng',
]);

const IMPORT_VIDEO_EXTENSIONS = new Set([
  '.mov',
  '.mp4',
  '.m4v',
  '.mkv',
  '.wmv',
  '.webm',
  '.flv',
  '.3gp',
  '.mpg',
  '.mpeg',
  '.vob',
  '.ts',
  '.mts',
  '.avi',
]);

const IMPORT_OVERLAY_TITLE = 'Add photos';

// ============================================================================
// DEBUG FLAG - Click-to-load lightbox (set to true for testing gray placeholder)
// ============================================================================
const DEBUG_CLICK_TO_LOAD = false; // Set to false for production

// ============================================================================
// DEBUG FLAG - First-run empty state button (TODO: delete in future cleanup)
// ============================================================================
const SHOW_FIRST_RUN_DEBUG_BUTTON = false;

const DEBUG_FLOW_PREVIEW_SCAN_MS = 4000;
const DEBUG_FLOW_PREVIEW_INFLIGHT_MS = 6000;
const DEBUG_FLOW_LOG_PATHS = {
  add: '.logs/import_20260609_143022.jsonl',
  clean: '.logs/clean_library_20260609_143022.jsonl',
  convert: '.logs/terraform_20260609_143022.jsonl',
};
const FLOW_INFLIGHT_BODY = {
  add: 'Adding photos and videos to your library.',
  clean: 'Checking media files, repairing issues, and updating library database.',
  convert: 'Converting files and organizing your library.',
};
const debugFlowPreviewState = {
  active: false,
  flow: null,
  screen: null,
  runId: 0,
  timers: [],
  photoTarget: 0,
  videoTarget: 0,
  estimatedDisplay: '',
  estimatedSeconds: 0,
  inflightTargets: null,
  onPreflightContinue: null,
  onDismiss: null,
};

const CLEAN_LIBRARY_ACTIVITY_FEED_MAX_LINES = 200;

const FLOW_ACTIVITY_LOG_REGISTRY = {
  add: {
    toggleId: 'importDetailsToggle',
    logFeedId: 'importLogFeed',
    detailsListId: 'importDetailsList',
    maxLines: 80,
    activityModeLabel: false,
  },
  clean: {
    toggleId: 'updateIndexDetailsToggle',
    logFeedId: 'updateIndexLogFeed',
    detailsListId: 'updateIndexDetailsList',
    maxLines: CLEAN_LIBRARY_ACTIVITY_FEED_MAX_LINES,
    activityModeLabel: true,
  },
  convert: {
    toggleId: 'terraformProgressDetailsToggle',
    logFeedId: 'terraformProgressLogFeed',
    detailsListId: null,
    maxLines: 80,
    activityModeLabel: false,
  },
  convertComplete: {
    toggleId: 'terraformCompleteDetailsToggle',
    logFeedId: 'terraformCompleteLogFeed',
    detailsListId: null,
    maxLines: 80,
    activityModeLabel: false,
  },
};

const flowActivityLogFeeds = {};

function trimCleanLibraryFeedLines(lines) {
  if (lines.length <= CLEAN_LIBRARY_ACTIVITY_FEED_MAX_LINES) {
    return lines;
  }
  const overflow = lines.length - CLEAN_LIBRARY_ACTIVITY_FEED_MAX_LINES;
  const startLine = lines[0]?.startsWith('Started:') ? lines[0] : null;
  if (startLine) {
    return [startLine, ...lines.slice(1 + overflow)];
  }
  return lines.slice(overflow);
}

function formatFlowLogPointer(logPath) {
  return `A detailed log can be found at:\n${logPath}`;
}

function updateFlowDetailsToggleLabel(
  toggleId,
  expanded,
  { activityMode = false } = {},
) {
  const detailsToggle = document.getElementById(toggleId);
  if (!detailsToggle) {
    return;
  }
  detailsToggle.classList.toggle('expanded', expanded);
  const icon = detailsToggle.querySelector('.material-symbols-outlined');
  if (icon) {
    icon.textContent = expanded ? 'expand_less' : 'expand_more';
  }
  const labelSpan = detailsToggle.querySelector('span:last-child');
  if (labelSpan) {
    labelSpan.textContent = expanded
      ? activityMode
        ? 'Hide activity'
        : 'Hide details'
      : activityMode
        ? 'Show activity'
        : 'Show details';
  }
}

function createFlowActivityLogFeed(flowKey) {
  const config = FLOW_ACTIVITY_LOG_REGISTRY[flowKey];
  if (!config) {
    throw new Error(`Unknown flow activity log: ${flowKey}`);
  }

  let lines = [];
  let logPointer = null;

  const trimLines = (nextLines) => {
    if (flowKey === 'clean') {
      return trimCleanLibraryFeedLines(nextLines);
    }
    if (nextLines.length <= config.maxLines) {
      return nextLines;
    }
    return nextLines.slice(-config.maxLines);
  };

  const buildDisplayLines = () => {
    const output = [...lines];
    if (logPointer) {
      output.push(logPointer);
    }
    return output;
  };

  const splitLogPointerLine = (nextLines) => {
    const adopted = [...nextLines];
    const pointerIdx = adopted.findIndex((line) =>
      String(line).startsWith('A detailed log can be found at:'),
    );
    if (pointerIdx < 0) {
      return { lines: adopted, pointer: null };
    }
    const pointer = adopted[pointerIdx];
    adopted.splice(pointerIdx, 1);
    return { lines: adopted, pointer };
  };

  const render = () => {
    const logFeed = document.getElementById(config.logFeedId);
    if (!logFeed) {
      return;
    }
    logFeed.textContent = buildDisplayLines().join('\n');
    logFeed.scrollTop = logFeed.scrollHeight;
  };

  return {
    getLines() {
      return buildDisplayLines();
    },
    hasLines() {
      return lines.length > 0 || Boolean(logPointer);
    },
    render,
    reset(logPath) {
      lines = [];
      logPointer = logPath ? formatFlowLogPointer(logPath) : null;
      render();
    },
    clear() {
      lines = [];
      logPointer = null;
      render();
    },
    append(line) {
      const text = String(line || '').trim();
      if (!text) {
        return;
      }
      lines = trimLines([...lines, text]);
      render();
    },
    prepend(line) {
      const text = String(line || '').trim();
      if (!text) {
        return;
      }
      lines = trimLines([text, ...lines]);
      render();
    },
    adoptLines(nextLines) {
      const { lines: adoptedLines, pointer } = splitLogPointerLine(nextLines);
      lines = trimLines(adoptedLines);
      logPointer = pointer;
      render();
    },
    setLogPointer(logPath) {
      logPointer = logPath ? formatFlowLogPointer(logPath) : null;
      render();
    },
    isExpanded() {
      const logFeed = document.getElementById(config.logFeedId);
      return Boolean(logFeed && logFeed.style.display !== 'none');
    },
    setExpanded(visible, { activityMode = config.activityModeLabel } = {}) {
      const logFeed = document.getElementById(config.logFeedId);
      const detailsList = config.detailsListId
        ? document.getElementById(config.detailsListId)
        : null;
      if (logFeed) {
        logFeed.style.display = visible ? 'block' : 'none';
        if (visible) {
          render();
        }
      }
      if (visible && detailsList) {
        detailsList.style.display = 'none';
      }
      updateFlowDetailsToggleLabel(config.toggleId, visible, { activityMode });
    },
    collapseDetails() {
      lines = [];
      logPointer = null;
      updateFlowDetailsToggleLabel(config.toggleId, false, {
        activityMode: config.activityModeLabel,
      });
      const logFeed = document.getElementById(config.logFeedId);
      if (logFeed) {
        logFeed.textContent = '';
        logFeed.style.display = 'none';
      }
      const detailsList = config.detailsListId
        ? document.getElementById(config.detailsListId)
        : null;
      if (detailsList) {
        detailsList.style.display = 'none';
        detailsList.innerHTML = '';
      }
    },
  };
}

function getFlowActivityLogFeed(flowKey) {
  if (!flowActivityLogFeeds[flowKey]) {
    flowActivityLogFeeds[flowKey] = createFlowActivityLogFeed(flowKey);
  }
  return flowActivityLogFeeds[flowKey];
}

function resetFlowDetailsPanel(flowKey) {
  getFlowActivityLogFeed(flowKey).collapseDetails();
}

function shouldUseFlowActivityFeed(flowKey) {
  const feed = getFlowActivityLogFeed(flowKey);
  if (feed.hasLines()) {
    return true;
  }
  if (
    debugFlowPreviewState.active &&
    debugFlowPreviewState.flow === flowKey &&
    (debugFlowPreviewState.screen === 'inflight' ||
      debugFlowPreviewState.screen === 'complete')
  ) {
    return true;
  }
  if (flowKey === 'add') {
    return Boolean(
      importState.isImporting ||
        importState.overlayPhase === 'inflight' ||
        importState.overlayPhase === 'complete',
    );
  }
  if (flowKey === 'clean') {
    return Boolean(
      updateIndexState?.workingPhaseActive ||
        updateIndexState?.overlayPhase === 'working' ||
        updateIndexState?.overlayPhase === 'finished' ||
        (cleanLibraryPreviewState?.active &&
          cleanLibraryPreviewState.phase === 'working'),
    );
  }
  if (flowKey === 'convert') {
    return Boolean(terraformProgressState.active);
  }
  return false;
}

function wireFlowDetailsToggle(flowKey) {
  const config = FLOW_ACTIVITY_LOG_REGISTRY[flowKey];
  const toggle = document.getElementById(config.toggleId);
  if (!toggle || toggle.dataset.flowDetailsWired === flowKey) {
    return;
  }
  toggle.dataset.flowDetailsWired = flowKey;

  toggle.addEventListener('click', () => {
    const feed = getFlowActivityLogFeed(flowKey);
    const activityMode = shouldUseFlowActivityFeed(flowKey);

    if (activityMode) {
      feed.setExpanded(!feed.isExpanded(), {
        activityMode: config.activityModeLabel,
      });
      if (config.detailsListId) {
        const detailsList = document.getElementById(config.detailsListId);
        if (detailsList) {
          detailsList.style.display = 'none';
        }
      }
      return;
    }

    if (!config.detailsListId) {
      return;
    }
    const detailsList = document.getElementById(config.detailsListId);
    const logFeed = document.getElementById(config.logFeedId);
    const isHidden = !detailsList || detailsList.style.display === 'none';
    if (detailsList) {
      detailsList.style.display = isHidden ? 'block' : 'none';
    }
    if (logFeed) {
      logFeed.style.display = 'none';
    }
    updateFlowDetailsToggleLabel(config.toggleId, isHidden, {
      activityMode: false,
    });
  });
}

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
  console.log(`[open-library] ${source}`);
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
  const APP_BAR_VERSION = '50'; // Increment this when appBar changes
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
        logOpenLibraryAccessPoint('critical-error-legacy-overlay');
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
    if (ev.phase === 'audit') {
      setLibraryRecoveryStats([]);
      setRecoveryDockSpinnerStatus(statusEl, label);
    } else {
      statusEl.style.display = 'flex';
      statusEl.textContent = label;
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
    setRecoveryDockSpinnerStatus(statusEl, 'Library verified');
    return;
  }
  if (ev.type === 'progress') {
    const phaseLabel =
      LIBRARY_RECOVERY_MAKE_PERFECT_PHASE_LABEL[ev.phase] ||
      ev.phase ||
      'Working';
    if (statusEl) {
      if (ev.phase === 'audit') {
        setLibraryRecoveryStats([]);
        setRecoveryDockSpinnerStatus(statusEl, phaseLabel);
        return;
      }
      statusEl.style.display = 'flex';
      statusEl.textContent = phaseLabel;
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

function createOpenFolderRecoveryStreamProgressHandler({ scorecard, runtime }) {
  return async (ev) => {
    if (runtime && typeof runtime.applyStreamEvent === 'function') {
      await runtime.applyStreamEvent(ev);
    }
    if (ev.type === 'signal_plan' || ev.type === 'signal_delta') {
      return;
    }
    if (ev.type === 'phase' && ev.status === 'starting') {
      const label =
        LIBRARY_RECOVERY_MAKE_PERFECT_PHASE_LABEL[ev.phase] || ev.phase;
      scorecard.setStatus(label, { spinner: true });
      return;
    }
    if (
      ev.type === 'phase' &&
      ev.status === 'complete' &&
      ev.phase === 'audit'
    ) {
      scorecard.setStatus('Library verified', { spinner: true });
      return;
    }
    if (ev.type === 'progress') {
      const phaseLabel =
        LIBRARY_RECOVERY_MAKE_PERFECT_PHASE_LABEL[ev.phase] ||
        ev.phase ||
        'Working';
      scorecard.setStatus(phaseLabel, { spinner: true });
      if (typeof scorecard.setSurvivorFilingProgressDebug === 'function') {
        scorecard.setSurvivorFilingProgressDebug(ev);
      }
    }
  };
}

/**
 * Same engine as POST /api/library/make-perfect, with SSE progress events.
 */
async function streamMakeLibraryPerfect(options = {}) {
  const { signal: callerSignal, onProgress } = options;

  // Internal controller lets us forcibly tear down the underlying HTTP
  // connection once we've consumed the `complete`/`error` event. Cancelling the
  // reader alone is not enough to release the socket in some browsers, which
  // stalls the next same-origin fetch (e.g. /api/photos) behind the still-open
  // SSE connection.
  const internalAbort = new AbortController();
  let callerAbortListener = null;
  if (callerSignal) {
    if (callerSignal.aborted) {
      internalAbort.abort();
    } else {
      callerAbortListener = () => internalAbort.abort();
      callerSignal.addEventListener('abort', callerAbortListener, {
        once: true,
      });
    }
  }

  const cleanupCallerSignal = () => {
    if (callerSignal && callerAbortListener) {
      callerSignal.removeEventListener('abort', callerAbortListener);
      callerAbortListener = null;
    }
  };

  const streamBody = {};
  if (options.resume === true || options.resume === false) {
    streamBody.resume = options.resume;
  }

  let response;
  try {
    response = await fetch('/api/library/make-perfect/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(streamBody),
      signal: internalAbort.signal,
    });
  } catch (err) {
    cleanupCallerSignal();
    if (callerSignal?.aborted || err?.name === 'AbortError') {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    throw err;
  }

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
    internalAbort.abort();
    cleanupCallerSignal();
    throw new Error(data.error || `Operation failed: ${response.statusText}`);
  }

  if (!response.body) {
    internalAbort.abort();
    cleanupCallerSignal();
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Forcibly release the underlying HTTP/1.1 socket so any follow-up fetch
  // (e.g. /api/photos, /api/years) isn't queued behind this connection.
  const teardown = async () => {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    try {
      internalAbort.abort();
    } catch {
      /* ignore */
    }
    cleanupCallerSignal();
    // Yield once so the browser can finish releasing the socket before the
    // caller starts its next request.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

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
    if (payload.type === 'cancelled') {
      return { done: true, result: payload.result || { status: 'CANCELLED' } };
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
          callerSignal?.aborted ||
          internalAbort.signal.aborted ||
          readErr?.name === 'AbortError'
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
            await teardown();
            return fin.result;
          }
        }
      }

      if (done) {
        for (const line of buffer.split('\n')) {
          const fin = consumeDataLine(line);
          if (fin) {
            await teardown();
            return fin.result;
          }
        }
        break;
      }
    }
  } finally {
    try {
      internalAbort.abort();
    } catch {
      /* ignore */
    }
    cleanupCallerSignal();
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  throw new Error('Stream ended without complete event');
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
function showDialog(title, message, buttons, options = {}) {
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

    overlay.classList.toggle('dialog-overlay--over-import', Boolean(options.overImport));

    titleEl.textContent = title;
    if (options.htmlMessage) {
      messageEl.innerHTML = options.htmlMessage;
    } else {
      messageEl.textContent = message;
    }

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
    overlay.classList.remove('dialog-overlay--over-import');
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
    const response = await fetch('fragments/libraryRecoveryDock.html?v=4');
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

function setLibraryRecoveryPreviewVisible(visible) {
  document.body.classList.toggle('library-recovery-preview-visible', !!visible);
}

function setLibraryRecoveryShellHidden(hidden) {
  libraryRecoveryState.shellHidden = hidden;
  if (hidden) {
    setLibraryRecoveryPreviewVisible(false);
  }
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
  setLibraryRecoveryPreviewVisible(false);
  setLibraryRecoveryShellHidden(false);
  setOpenLibraryModalHandoffShellHidden(false);
  libraryRecoveryState.hasSwitchedLibrary = false;
  libraryRecoveryState.rebuildTotal = 0;
  libraryRecoveryState.rebuildAdded = 0;
}

function renderScorecardStats(statsEl, stats = []) {
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

function setLibraryRecoveryStats(stats = []) {
  renderScorecardStats(document.getElementById('libraryRecoveryStats'), stats);
}

function setLibraryRecoveryWinnersLine({
  winnersFiled = 0,
  winnersToFile = null,
} = {}) {
  const winnersEl = document.getElementById('libraryRecoveryCleanerDebug');
  if (!winnersEl) {
    return;
  }
  const filed = Number(winnersFiled);
  const total = Number(winnersToFile);
  if (!Number.isFinite(total) || total < 0) {
    winnersEl.style.display = 'none';
    winnersEl.textContent = '';
    return;
  }
  const safeFiled = Number.isFinite(filed) ? Math.max(0, Math.min(filed, total)) : 0;
  winnersEl.textContent = `winners (${safeFiled}/${total})`;
  winnersEl.style.display = 'block';
}

function clearLibraryRecoveryWinnersLine() {
  const winnersEl = document.getElementById('libraryRecoveryCleanerDebug');
  if (!winnersEl) {
    return;
  }
  winnersEl.style.display = 'none';
  winnersEl.textContent = '';
}

const SCORECARD_STATUS_TEXT_CLASS = 'scorecard-status-text';
const SCORECARD_STATUS_SPINNER_CLASS = 'scorecard-status-spinner';

function stripRecoveryStatusEllipsis(text) {
  return String(text ?? '')
    .replace(/…\s*$/, '')
    .replace(/\.{3}\s*$/, '')
    .trimEnd();
}

/**
 * One persistent `.import-spinner` next to the label so the braille animation
 * does not restart on every status text change.
 */
function setImportSpinnerStatus(statusEl, text) {
  if (!statusEl) {
    return;
  }
  const labelText = stripRecoveryStatusEllipsis(text);
  let labelEl = statusEl.querySelector(`.${SCORECARD_STATUS_TEXT_CLASS}`);
  const spinnerEl = statusEl.querySelector(
    `.import-spinner.${SCORECARD_STATUS_SPINNER_CLASS}`,
  );
  if (!labelEl || !spinnerEl) {
    statusEl.innerHTML = `<span class="${SCORECARD_STATUS_TEXT_CLASS}"></span><span class="import-spinner ${SCORECARD_STATUS_SPINNER_CLASS}" aria-hidden="true"></span>`;
    labelEl = statusEl.querySelector(`.${SCORECARD_STATUS_TEXT_CLASS}`);
  }
  if (labelEl) {
    labelEl.textContent = labelText;
  }
}

function setRecoveryDockSpinnerStatus(statusEl, text) {
  setImportSpinnerStatus(statusEl, text);
  if (statusEl) {
    statusEl.style.display = 'flex';
  }
}

// SURVIVOR_FILING_PROGRESS_DEBUG
// User-facing line: `winners (winnersFiled/winnersToFile)`.
// Derived only from cleaner stream `progress` where `phase` is `canonicalize` or
// `rebuild_db` (survivor filing + DB insert). See make_library_perfect.py:
// move_to_canonical_locations, rebuild_photos_table.
// `winnersToFile` = first qualifying `total` (stable). `winnersFiled` = high-water
// of min(processed, winnersToFile) so rebuild_db's restarted processed counter
// does not dip the display after canonicalize. Raw event numbers, no smoothing.
const SURVIVOR_FILING_PROGRESS_PHASES = Object.freeze([
  'canonicalize',
  'rebuild_db',
]);

function createScorecardController({ statsEl, statusEl, debugEl } = {}) {
  const metrics = new Map();
  let metricOrder = [];
  const animationFrames = new Map();
  let destroyed = false;
  let winnersToFile = null;
  let winnersFiledHighWater = 0;
  let winnersTotalLocked = false;

  const render = () => {
    if (destroyed || !statsEl) {
      return;
    }

    const stats = metricOrder
      .map((key) => metrics.get(key))
      .filter(Boolean)
      .map((metric) => ({
        label: metric.label,
        value:
          typeof metric.formatValue === 'function'
            ? metric.formatValue(metric.value)
            : metric.value,
      }));

    renderScorecardStats(statsEl, stats);
  };

  const ensureMetric = (key, patch = {}) => {
    const existing = metrics.get(key) || {
      key,
      label: key,
      value: 0,
    };
    const next = {
      ...existing,
      ...patch,
      key,
      label: patch.label ?? existing.label ?? key,
      value: patch.value ?? existing.value ?? 0,
    };
    metrics.set(key, next);
    if (!metricOrder.includes(key)) {
      metricOrder.push(key);
    }
    return next;
  };

  const stopMetricAnimation = (key) => {
    const frameId = animationFrames.get(key);
    if (frameId) {
      cancelAnimationFrame(frameId);
      animationFrames.delete(key);
    }
  };

  return {
    setWinnersProgress({ winnersFiled = 0, winnersToFile: nextWinnersToFile = null } = {}) {
      if (!debugEl || destroyed) {
        return;
      }
      const total = Number(nextWinnersToFile);
      if (!Number.isFinite(total) || total < 0) {
        clearLibraryRecoveryWinnersLine();
        return;
      }
      winnersToFile = total;
      winnersFiledHighWater = Math.max(
        0,
        Math.min(Number(winnersFiled || 0), winnersToFile),
      );
      setLibraryRecoveryWinnersLine({
        winnersFiled: winnersFiledHighWater,
        winnersToFile,
      });
    },

    /**
     * SURVIVOR_FILING_PROGRESS_DEBUG — see block comment on SURVIVOR_FILING_PROGRESS_PHASES.
     */
    setSurvivorFilingProgressDebug(ev = {}) {
      if (!debugEl || destroyed) {
        return;
      }
      if (ev.type !== 'progress') {
        return;
      }
      if (!SURVIVOR_FILING_PROGRESS_PHASES.includes(ev.phase)) {
        return;
      }
      const cap = Number(ev.total);
      const processed = Number(ev.processed);
      if (!Number.isFinite(cap) || cap < 1 || !Number.isFinite(processed)) {
        return;
      }
      if (!winnersTotalLocked || winnersToFile === null || winnersToFile !== cap) {
        winnersToFile = cap;
        winnersTotalLocked = true;
      }
      const clamped = Math.min(processed, winnersToFile);
      winnersFiledHighWater = Math.max(winnersFiledHighWater, clamped);
      setLibraryRecoveryWinnersLine({
        winnersFiled: winnersFiledHighWater,
        winnersToFile,
      });
    },

    setStatus(text = '', options = {}) {
      if (!statusEl || destroyed) {
        return;
      }
      if (!text) {
        statusEl.style.display = 'none';
        statusEl.textContent = '';
        return;
      }
      const useSpinner = !!options.spinner;
      if (useSpinner) {
        setRecoveryDockSpinnerStatus(statusEl, text);
        return;
      }
      statusEl.textContent = text;
      statusEl.style.display = 'flex';
    },

    setMetrics(nextMetrics = []) {
      if (destroyed) {
        return;
      }
      metricOrder = [];
      metrics.clear();
      nextMetrics.forEach((metric) => {
        ensureMetric(metric.key, metric);
      });
      render();
    },

    updateMetric(key, patch = {}) {
      if (destroyed) {
        return;
      }
      ensureMetric(key, patch);
      render();
    },

    animateMetricTo(key, nextValue, options = {}) {
      if (destroyed) {
        return Promise.resolve(nextValue);
      }

      const duration = Math.max(0, Number(options.duration ?? 350));
      const round = options.round !== false;
      const initialMetric = ensureMetric(key, options.metric || {});
      const startValue = Number(initialMetric.value ?? 0);
      const endValue = Number(nextValue ?? 0);

      if (
        duration === 0 ||
        !Number.isFinite(startValue) ||
        !Number.isFinite(endValue)
      ) {
        ensureMetric(key, {
          ...options.metric,
          value: round && Number.isFinite(endValue) ? Math.round(endValue) : nextValue,
        });
        render();
        return Promise.resolve(nextValue);
      }

      stopMetricAnimation(key);

      return new Promise((resolve) => {
        const startedAt = performance.now();

        const tick = (now) => {
          if (destroyed) {
            animationFrames.delete(key);
            resolve(nextValue);
            return;
          }

          const progress = Math.min(1, (now - startedAt) / duration);
          const eased = 1 - Math.pow(1 - progress, 3);
          const rawValue = startValue + (endValue - startValue) * eased;
          ensureMetric(key, {
            ...options.metric,
            value: round ? Math.round(rawValue) : rawValue,
          });
          render();

          if (progress >= 1) {
            animationFrames.delete(key);
            resolve(nextValue);
            return;
          }

          const frameId = requestAnimationFrame(tick);
          animationFrames.set(key, frameId);
        };

        const frameId = requestAnimationFrame(tick);
        animationFrames.set(key, frameId);
      });
    },

    stop(key = null) {
      if (key) {
        stopMetricAnimation(key);
        return;
      }
      Array.from(animationFrames.keys()).forEach((metricKey) => {
        stopMetricAnimation(metricKey);
      });
    },

    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      this.stop();
      metricOrder = [];
      metrics.clear();
      if (statusEl) {
        statusEl.style.display = 'none';
        statusEl.textContent = '';
      }
      if (statsEl) {
        statsEl.style.display = 'none';
        statsEl.innerHTML = '';
      }
      if (debugEl) {
        debugEl.style.display = 'none';
        debugEl.textContent = '';
      }
      winnersToFile = null;
      winnersFiledHighWater = 0;
      winnersTotalLocked = false;
    },
  };
}

const OPEN_FOLDER_RECOVERY_STEP_MS = 50;
const OPEN_FOLDER_RECOVERY_METRIC_ORDER = [
  'open_folder_media_files',
  'open_folder_duplicates',
  'open_folder_unsupported',
];
const OPEN_FOLDER_RECOVERY_METRIC_LABELS = Object.freeze({
  open_folder_media_files: 'Media files',
  open_folder_duplicates: 'Duplicates',
  open_folder_unsupported: 'Unsupported',
});

function setLibraryRecoveryBodyText(text = '') {
  const bodyEl = document.getElementById('libraryRecoveryBody');
  if (bodyEl) {
    bodyEl.textContent = text;
  }
}

function buildOpenFolderRecoveryCompletionActions({
  onCancel,
  onContinue,
  continueDisabled = true,
} = {}) {
  return [
    {
      text: 'Cancel',
      value: 'cancel',
      primary: false,
      onClick: onCancel,
    },
    {
      text: 'Continue',
      value: 'continue',
      primary: true,
      disabled: continueDisabled,
      onClick: onContinue,
    },
  ];
}

function waitForLibraryRecoveryAction(actions = []) {
  return new Promise((resolve) => {
    setLibraryRecoveryActions(actions, resolve);
  });
}

async function finishOpenFolderRecoverySuccess({
  runtime,
  scorecard,
  loadLibrary,
} = {}) {
  await runtime.markComplete();
  scorecard.setStatus('Loading photos', { spinner: true });
  if (typeof loadLibrary === 'function') {
    await loadLibrary();
  }
  setLibraryRecoveryPreviewVisible(true);
  setLibraryRecoveryBodyText(
    'Cleaning complete. Review your library, then continue.',
  );
  scorecard.setStatus('Library ready', { spinner: false });
  await runtime.waitForIdle();
  return waitForLibraryRecoveryAction(
    buildOpenFolderRecoveryCompletionActions({
      continueDisabled: false,
    }),
  );
}

function createOpenFolderRecoveryRuntime({
  scorecard,
  signalCounts = {},
  supportedMediaCount = 0,
} = {}) {
  let currentSignals = normalizeCleanerSignalCounts(signalCounts);
  const initialWinnerCount = Math.max(
    0,
    Number(supportedMediaCount || 0) - Number(currentSignals?.duplicates || 0),
  );
  const phaseState = {
    canonicalize: {
      started: false,
      processed: 0,
      total: Math.max(0, initialWinnerCount),
      complete: false,
    },
    rebuild_db: {
      started: false,
      processed: 0,
      total: Math.max(0, initialWinnerCount),
      complete: false,
    },
  };
  const displayState = new Map();
  let tickIntervalId = null;
  let destroyed = false;
  let idleResolvers = [];

  const resolveIdleIfSettled = () => {
    if (tickIntervalId) {
      return;
    }
    const pending = idleResolvers;
    idleResolvers = [];
    pending.forEach((resolve) => resolve());
  };

  const phaseFraction = (phaseKey) => {
    const phase = phaseState[phaseKey];
    if (!phase) {
      return 0;
    }
    if (phase.complete) {
      return 1;
    }
    const total = Math.max(0, Number(phase.total || 0));
    if (total <= 0) {
      return 0;
    }
    return Math.max(
      0,
      Math.min(1, Number(phase.processed || 0) / total),
    );
  };

  const winnerProgressFraction = () => {
    const rebuildStarted =
      phaseState.rebuild_db.started || phaseState.rebuild_db.complete;
    const canonicalizeStarted =
      phaseState.canonicalize.started || phaseState.canonicalize.complete;
    if (rebuildStarted) {
      return 0.5 + phaseFraction('rebuild_db') * 0.5;
    }
    if (canonicalizeStarted) {
      return phaseFraction('canonicalize') * 0.5;
    }
    return 0;
  };

  const buildTargetMetrics = () => {
    const winners = Math.max(
      0,
      Math.round(initialWinnerCount * (1 - winnerProgressFraction())),
    );
    return [
      {
        key: 'open_folder_media_files',
        label: OPEN_FOLDER_RECOVERY_METRIC_LABELS.open_folder_media_files,
        value: winners,
      },
      {
        key: 'open_folder_duplicates',
        label: OPEN_FOLDER_RECOVERY_METRIC_LABELS.open_folder_duplicates,
        value: Math.max(0, Math.round(Number(currentSignals?.duplicates || 0))),
      },
      {
        key: 'open_folder_unsupported',
        label: OPEN_FOLDER_RECOVERY_METRIC_LABELS.open_folder_unsupported,
        value: Math.max(
          0,
          Math.round(Number(currentSignals?.unsupported_files || 0)),
        ),
      },
    ];
  };

  const renderDisplay = () => {
    if (destroyed || !scorecard) {
      return;
    }
    const metrics = OPEN_FOLDER_RECOVERY_METRIC_ORDER.map((key) => {
      const metric =
        displayState.get(key) || {
          label: OPEN_FOLDER_RECOVERY_METRIC_LABELS[key] || key,
          display: 0,
          target: 0,
        };
      return {
        key,
        label: metric.label,
        value: metric.display,
      };
    });
    scorecard.setMetrics(metrics);
  };

  const stopTicker = () => {
    if (tickIntervalId !== null) {
      window.clearInterval(tickIntervalId);
      tickIntervalId = null;
    }
  };

  const startTickerIfNeeded = () => {
    if (destroyed || tickIntervalId !== null) {
      return;
    }
    const hasPending = Array.from(displayState.values()).some(
      (metric) => metric.display > metric.target,
    );
    if (!hasPending) {
      resolveIdleIfSettled();
      return;
    }
    tickIntervalId = window.setInterval(() => {
      if (destroyed) {
        stopTicker();
        return;
      }
      let changed = false;
      OPEN_FOLDER_RECOVERY_METRIC_ORDER.forEach((key) => {
        const metric = displayState.get(key);
        if (!metric || metric.display <= metric.target) {
          return;
        }
        metric.display = Math.max(metric.target, metric.display - 1);
        changed = true;
      });
      if (changed) {
        renderDisplay();
      }
      const stillPending = Array.from(displayState.values()).some(
        (metric) => metric.display > metric.target,
      );
      if (!stillPending) {
        stopTicker();
        resolveIdleIfSettled();
      }
    }, OPEN_FOLDER_RECOVERY_STEP_MS);
  };

  const syncTargets = ({ initialize = false } = {}) => {
    const metrics = buildTargetMetrics();
    metrics.forEach((metric) => {
      const numericValue = Math.max(0, Math.round(Number(metric.value || 0)));
      if (initialize || !displayState.has(metric.key)) {
        displayState.set(metric.key, {
          label: metric.label,
          display: numericValue,
          target: numericValue,
        });
        return;
      }
      const current = displayState.get(metric.key);
      current.label = metric.label;
      current.target = Math.min(current.target, current.display, numericValue);
    });
    renderDisplay();
    startTickerIfNeeded();
    resolveIdleIfSettled();
    return metrics;
  };

  const applyPhaseEvent = (event = {}) => {
    if (event.type === 'phase') {
      if (event.phase === 'canonicalize' || event.phase === 'rebuild_db') {
        const phase = phaseState[event.phase];
        phase.started = true;
        if (event.total !== undefined) {
          phase.total = Math.max(0, Number(event.total || 0));
        }
        if (event.status === 'complete') {
          phase.complete = true;
          phase.processed = phase.total;
        }
        return true;
      }
      return false;
    }
    if (event.type === 'progress') {
      if (event.phase !== 'canonicalize' && event.phase !== 'rebuild_db') {
        return false;
      }
      const phase = phaseState[event.phase];
      phase.started = true;
      if (event.total !== undefined) {
        phase.total = Math.max(0, Number(event.total || 0));
      }
      phase.processed = Math.max(
        0,
        Math.min(Number(phase.total || 0), Number(event.processed || 0)),
      );
      return true;
    }
    return false;
  };

  syncTargets({ initialize: true });

  return {
    async setSignalCounts(nextSignals = {}) {
      currentSignals = normalizeCleanerSignalCounts(nextSignals);
      return syncTargets();
    },

    async applyStreamEvent(event = {}) {
      if (event?.type === 'signal_plan') {
        currentSignals = normalizeCleanerSignalCounts(event.summary || {});
        return syncTargets();
      }
      if (event?.type === 'signal_delta') {
        currentSignals = normalizeCleanerSignalCounts(
          event.remaining ||
            applyCleanerSignalDeltas(currentSignals, event.deltas || {}),
        );
        return syncTargets();
      }
      if (applyPhaseEvent(event)) {
        return syncTargets();
      }
      return buildTargetMetrics();
    },

    async markComplete() {
      phaseState.canonicalize.started = true;
      phaseState.canonicalize.complete = true;
      phaseState.canonicalize.processed = phaseState.canonicalize.total;
      phaseState.rebuild_db.started = true;
      phaseState.rebuild_db.complete = true;
      phaseState.rebuild_db.processed = phaseState.rebuild_db.total;
      currentSignals = normalizeCleanerSignalCounts({});
      return syncTargets();
    },

    waitForIdle() {
      const pending = Array.from(displayState.values()).some(
        (metric) => metric.display > metric.target,
      );
      if (!pending && tickIntervalId === null) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        idleResolvers.push(resolve);
      });
    },

    destroy() {
      destroyed = true;
      stopTicker();
      resolveIdleIfSettled();
    },
  };
}

function normalizeCleanerSignalCounts(summary = {}) {
  const counts = {};
  let total = 0;
  CLEANER_SIGNAL_KEYS.forEach((key) => {
    const value = Math.max(0, Number(summary?.[key] || 0));
    counts[key] = value;
    total += value;
  });
  counts.operation_count = total;
  return counts;
}

function normalizeCleanerScorecardView(view = null) {
  const rawBuckets = Array.isArray(view)
    ? view
    : Array.isArray(view?.buckets)
      ? view.buckets
      : DEFAULT_CLEANER_SCORECARD_VIEW;

  return rawBuckets
    .map((bucket, index) => {
      const signals = Array.isArray(bucket?.signals)
        ? bucket.signals.filter((signal) => CLEANER_SIGNAL_KEYS.includes(signal))
        : [];
      if (!signals.length) {
        return null;
      }
      return {
        key: bucket?.key || `cleaner_bucket_${index + 1}`,
        label: bucket?.label || bucket?.key || `Bucket ${index + 1}`,
        signals: [...new Set(signals)],
      };
    })
    .filter(Boolean);
}

function reduceCleanerSignalsToBuckets(summary = {}, view = null) {
  const signalCounts = normalizeCleanerSignalCounts(summary);
  const buckets = normalizeCleanerScorecardView(view);
  return buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    value: bucket.signals.reduce(
      (sum, signalKey) => sum + Number(signalCounts?.[signalKey] || 0),
      0,
    ),
  }));
}

function applyCleanerSignalDeltas(summary = {}, deltas = {}) {
  const next = normalizeCleanerSignalCounts(summary);
  CLEANER_SIGNAL_KEYS.forEach((key) => {
    const delta = Math.max(0, Number(deltas?.[key] || 0));
    next[key] = Math.max(0, next[key] - delta);
  });
  next.operation_count = CLEANER_SIGNAL_KEYS.reduce(
    (sum, key) => sum + Number(next[key] || 0),
    0,
  );
  return next;
}

function createCleanerScorecardRuntime({
  scorecard,
  signalCounts = {},
  view = null,
  bucketReducer = null,
} = {}) {
  let currentSignals = normalizeCleanerSignalCounts(signalCounts);
  let currentView = normalizeCleanerScorecardView(view);

  const render = async ({ animate = false, duration = 200 } = {}) => {
    const metrics =
      typeof bucketReducer === 'function'
        ? bucketReducer(currentSignals)
        : reduceCleanerSignalsToBuckets(currentSignals, currentView);
    if (!scorecard) {
      return metrics;
    }
    if (!animate) {
      scorecard.setMetrics(metrics);
      return metrics;
    }
    await Promise.all(
      metrics.map((metric) =>
        scorecard.animateMetricTo(metric.key, metric.value, {
          duration,
          metric,
        }),
      ),
    );
    return metrics;
  };

  return {
    getSignalCounts() {
      return { ...currentSignals };
    },

    getView() {
      return currentView.map((bucket) => ({
        ...bucket,
        signals: [...bucket.signals],
      }));
    },

    async setSignalCounts(nextSignals = {}, options = {}) {
      currentSignals = normalizeCleanerSignalCounts(nextSignals);
      return render(options);
    },

    async applySignalDeltas(deltas = {}, options = {}) {
      currentSignals = applyCleanerSignalDeltas(currentSignals, deltas);
      return render(options);
    },

    async setView(nextView = null, options = {}) {
      if (typeof bucketReducer === 'function') {
        return render(options);
      }
      currentView = normalizeCleanerScorecardView(nextView);
      return render(options);
    },

    async applyStreamEvent(event = {}, options = {}) {
      if (event?.type === 'signal_plan') {
        return this.setSignalCounts(event.summary || {}, options);
      }
      if (event?.type === 'signal_delta') {
        if (event?.remaining) {
          return this.setSignalCounts(event.remaining || {}, options);
        }
        return this.applySignalDeltas(event.deltas || {}, options);
      }
      return null;
    },

    async render(options = {}) {
      return render(options);
    },
  };
}

if (typeof window !== 'undefined') {
  window.CleanerScorecardHelper = Object.freeze({
    SIGNAL_DEFS: CLEANER_SIGNAL_DEFS.map((signalDef) => ({ ...signalDef })),
    DEFAULT_VIEW: DEFAULT_CLEANER_SCORECARD_VIEW.map((bucket) => ({
      ...bucket,
      signals: [...bucket.signals],
    })),
    reduceOpenFolderRecoveryBuckets,
    createOpenFolderRecoveryBucketReducer,
    getOpenFolderRecoveryPendingTotal,
    normalizeSignalCounts: normalizeCleanerSignalCounts,
    normalizeView: normalizeCleanerScorecardView,
    reduceToBuckets: reduceCleanerSignalsToBuckets,
    applySignalDeltas: applyCleanerSignalDeltas,
    createRuntime: createCleanerScorecardRuntime,
  });
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

  if (options.showWinnersLine) {
    setLibraryRecoveryWinnersLine({
      winnersFiled: options.winnersFiled,
      winnersToFile: options.winnersToFile,
    });
  } else {
    clearLibraryRecoveryWinnersLine();
  }

  if (options.omitStats) {
    setLibraryRecoveryStats([]);
  } else {
    setLibraryRecoveryStats(options.stats || []);
  }
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

async function loadDebugFileCountOverlay() {
  if (document.getElementById('debugFileCountOverlay')) {
    return;
  }

  const response = await fetch('fragments/debugFileCountOverlay.html');
  if (!response.ok) {
    throw new Error(`Failed to load debug file count overlay (${response.status})`);
  }

  document.body.insertAdjacentHTML('beforeend', await response.text());
}

function getDebugFileCountOverlayElements() {
  return {
    overlay: document.getElementById('debugFileCountOverlay'),
    titleEl: document.getElementById('debugFileCountTitle'),
    statusEl: document.getElementById('debugFileCountStatusText'),
    statsEl: document.getElementById('debugFileCountStats'),
    canonicalLineEl: document.getElementById('debugFileCountCanonicalLine'),
    closeBtn: document.getElementById('debugFileCountCloseBtn'),
    cancelBtn: document.getElementById('debugFileCountCancelBtn'),
    proceedBtn: document.getElementById('debugFileCountProceedBtn'),
  };
}

function resetDebugFileCountScorecard() {
  debugFileCountState.scorecard?.destroy();
  debugFileCountState.scorecard = null;
}

function captureDebugFileCountEntryState() {
  const datePickerContainer = document.querySelector('.date-picker');
  return {
    hasDatabase: !!state.hasDatabase,
    photos: Array.isArray(state.photos)
      ? state.photos.map((photo) => ({ ...photo }))
      : [],
    selectedPhotoIds: Array.from(state.selectedPhotos),
    lastClickedIndex: state.lastClickedIndex,
    datePickerVisibility: datePickerContainer?.style.visibility || '',
  };
}

function restoreDebugFileCountEntryState() {
  const entryState = debugFileCountState.entryState || {
    hasDatabase: false,
    photos: [],
    selectedPhotoIds: [],
    lastClickedIndex: null,
    datePickerVisibility: 'hidden',
  };

  advanceLibraryGeneration();
  state.photos = entryState.photos.map((photo) => ({ ...photo }));
  state.hasDatabase = !!entryState.hasDatabase;
  state.selectedPhotos.clear();
  entryState.selectedPhotoIds.forEach((photoId) => {
    state.selectedPhotos.add(photoId);
  });
  state.lastClickedIndex = entryState.lastClickedIndex ?? null;

  renderPhotoGrid(getFilteredPhotos(state.photos), false);
  if (state.photos.length > 0) {
    setupThumbnailLazyLoading();
  }

  const datePickerContainer = document.querySelector('.date-picker');
  if (datePickerContainer) {
    datePickerContainer.style.visibility =
      state.photos.length > 0
        ? entryState.datePickerVisibility || 'visible'
        : 'hidden';
  }

  updateFilterChipRailVisibility();

  enableAppBarButtons();
  updateUtilityMenuAvailability();
  debugFileCountState.entryState = null;
}

function closeDebugFileCountOverlay() {
  debugFileCountState.runId += 1;
  debugFileCountState.scanRoot = null;
  debugFileCountState.signalCounts = null;
  debugFileCountState.logEntries = [];
  debugFileCountState.runtime = null;
  resetDebugFileCountScorecard();

  const { overlay, titleEl, closeBtn, cancelBtn, proceedBtn } =
    getDebugFileCountOverlayElements();
  if (titleEl) {
    titleEl.textContent = 'Debug file count';
  }
  if (closeBtn) {
    closeBtn.disabled = false;
  }
  if (cancelBtn) {
    cancelBtn.disabled = false;
    cancelBtn.style.display = 'inline-block';
  }
  if (proceedBtn) {
    proceedBtn.disabled = false;
    proceedBtn.textContent = 'Proceed';
    proceedBtn.style.display = 'none';
    proceedBtn.onclick = null;
  }
  if (overlay) {
    overlay.style.display = 'none';
  }
  const { canonicalLineEl } = getDebugFileCountOverlayElements();
  if (canonicalLineEl) {
    canonicalLineEl.textContent = '';
    canonicalLineEl.style.display = 'none';
  }
}

function setDebugFileCountCanonicalLine({
  summary = {},
  serverOperationCount,
  rawIssueCount,
  usedIssuesFallback = false,
} = {}) {
  const { canonicalLineEl } = getDebugFileCountOverlayElements();
  if (!canonicalLineEl) {
    return;
  }
  const n = Number(summary?.operation_count ?? 0);
  const lines = [
    `Canonical cleaner operations: ${Number.isFinite(n) ? n.toLocaleString() : '0'}`,
  ];
  if (
    Number.isFinite(serverOperationCount) &&
    Number(serverOperationCount) !== n
  ) {
    lines.push(
      `(API operation_count ${Number(serverOperationCount).toLocaleString()} ≠ sum of detail rows)`,
    );
  }
  if (rawIssueCount !== undefined && rawIssueCount !== null) {
    const m = Number(rawIssueCount);
    lines.push(
      `Raw audit issue_count: ${Number.isFinite(m) ? m.toLocaleString() : `${rawIssueCount}`}`,
    );
  }
  if (usedIssuesFallback) {
    lines.push('Warning: operations.details missing; used top-level details (issue buckets).');
  }
  canonicalLineEl.textContent = lines.join('\n');
  canonicalLineEl.style.display = 'block';
  canonicalLineEl.style.whiteSpace = 'pre-line';
}

function buildDebugScorecardMetrics(summary = {}) {
  return reduceCleanerSignalsToBuckets(summary, DEFAULT_CLEANER_SCORECARD_VIEW);
}

/** Single source of truth: counts come from detail list lengths (must match log line totals). */
function buildDebugFileCountSummaryFromDetails(details = {}) {
  const summary = {};
  CLEANER_SIGNAL_DEFS.forEach((taskDef) => {
    const items = Array.isArray(details[taskDef.detailKey])
      ? details[taskDef.detailKey]
      : [];
    summary[taskDef.key] = items.length;
  });
  return normalizeCleanerSignalCounts(summary);
}

function buildDebugScorecardLogEntries(details = {}) {
  const entries = [];
  CLEANER_SIGNAL_DEFS.forEach((taskDef) => {
    const items = Array.isArray(details?.[taskDef.detailKey])
      ? details[taskDef.detailKey]
      : [];
    items
      .slice()
      .sort((left, right) => {
        const leftPath = `${left?.path || ''}`.toLowerCase();
        const rightPath = `${right?.path || ''}`.toLowerCase();
        if (leftPath !== rightPath) {
          return leftPath.localeCompare(rightPath);
        }
        const leftMessage = `${left?.message || ''}`.toLowerCase();
        const rightMessage = `${right?.message || ''}`.toLowerCase();
        return leftMessage.localeCompare(rightMessage);
      })
      .forEach((item) => {
      entries.push({
        metricKey: taskDef.key,
        label: taskDef.label,
        path: item?.path || '',
        kind: item?.kind || '',
        message: item?.message || '',
      });
      });
  });
  return entries;
}

function renderDebugFileCountReview({
  details = {},
  serverOperationCount,
  rawIssueCount,
  usedIssuesFallback = false,
}) {
  const {
    overlay,
    titleEl,
    statusEl,
    statsEl,
    closeBtn,
    cancelBtn,
    proceedBtn,
  } = getDebugFileCountOverlayElements();

  if (!overlay || !statusEl || !statsEl || !proceedBtn) {
    throw new Error('Debug file count overlay is unavailable');
  }

  resetDebugFileCountScorecard();
  debugFileCountState.scorecard = createScorecardController({
    statusEl,
    statsEl,
  });
  debugFileCountState.runtime = createCleanerScorecardRuntime({
    scorecard: debugFileCountState.scorecard,
    view: DEFAULT_CLEANER_SCORECARD_VIEW,
  });

  const signalCounts = buildDebugFileCountSummaryFromDetails(details);
  debugFileCountState.signalCounts = { ...signalCounts };
  debugFileCountState.logEntries = buildDebugScorecardLogEntries(details);

  if (titleEl) {
    titleEl.textContent = 'Debug file count';
  }

  setDebugFileCountCanonicalLine({
    summary: signalCounts,
    serverOperationCount,
    rawIssueCount,
    usedIssuesFallback,
  });

  debugFileCountState.scorecard.setStatus('Ready to log every pending task.');
  void debugFileCountState.runtime?.setSignalCounts(signalCounts);

  if (closeBtn) {
    closeBtn.disabled = false;
    closeBtn.onclick = closeDebugFileCountOverlay;
  }
  if (cancelBtn) {
    cancelBtn.disabled = false;
    cancelBtn.style.display = 'inline-block';
    cancelBtn.onclick = closeDebugFileCountOverlay;
  }
  proceedBtn.disabled = false;
  proceedBtn.textContent = 'Proceed';
  proceedBtn.style.display = 'inline-block';
  proceedBtn.onclick = () => {
    void runDebugFileCountLogging();
  };

  overlay.style.display = 'flex';
}

async function runDebugFileCountLogging() {
  const {
    closeBtn,
    cancelBtn,
    proceedBtn,
  } = getDebugFileCountOverlayElements();
  const logEntries = [...debugFileCountState.logEntries];
  const totalCount = logEntries.length;
  const runId = ++debugFileCountState.runId;

  if (!debugFileCountState.scorecard || !debugFileCountState.runtime || !proceedBtn) {
    return false;
  }

  debugFileCountState.scorecard.setStatus(
    totalCount
      ? `Logging task paths (0 / ${totalCount})`
      : 'Logging task paths',
    { spinner: true },
  );
  await debugFileCountState.runtime.setSignalCounts(debugFileCountState.signalCounts || {});

  if (closeBtn) {
    closeBtn.disabled = true;
  }
  if (cancelBtn) {
    cancelBtn.disabled = true;
  }
  proceedBtn.disabled = true;
  proceedBtn.textContent = 'Working...';

  try {
    for (let index = 0; index < logEntries.length; index += 1) {
      if (runId !== debugFileCountState.runId) {
        return false;
      }

      const entry = logEntries[index];
      const line = entry.path || entry.message || '(missing path)';
      debugFileCountState.scorecard.setStatus(
        `Logging task paths (${index + 1} / ${totalCount})`,
        { spinner: true },
      );
      console.log(`[${entry.label}] ${line}`);

      if (entry.metricKey && CLEANER_SIGNAL_KEYS.includes(entry.metricKey)) {
        await debugFileCountState.runtime.applySignalDeltas(
          { [entry.metricKey]: 1 },
          { animate: true, duration: DEBUG_FILE_COUNT_LOG_STEP_MS },
        );
      } else {
        await new Promise((resolve) => {
          setTimeout(resolve, DEBUG_FILE_COUNT_LOG_STEP_MS);
        });
      }
    }

    closeDebugFileCountOverlay();

    const action = await showDialog(
      'Success',
      `Logged ${totalCount.toLocaleString()} task path${totalCount === 1 ? '' : 's'}.`,
      [{ text: 'Go to library', value: 'go_to_library', primary: true }],
    );

    if (action === 'go_to_library') {
      restoreDebugFileCountEntryState();
    }

    return true;
  } catch (error) {
    console.error('❌ Debug file count failed:', error);
    closeDebugFileCountOverlay();
    showToast(`Error: ${error.message}`);
    return false;
  }
}

async function startDebugFileCountFlow() {
  try {
    debugFileCountState.entryState = captureDebugFileCountEntryState();

    const selectedPath = await FolderPicker.show({
      intent: FolderPicker.INTENT.GENERIC_FOLDER_SELECTION,
      title: 'Debug scoreboard',
      subtitle: 'Choose a folder to scan with the cleaner rulebook.',
    });

    if (!selectedPath) {
      return false;
    }

    await loadDebugFileCountOverlay();

    const {
      overlay,
      titleEl,
      statusEl,
      statsEl,
      closeBtn,
      cancelBtn,
      proceedBtn,
    } = getDebugFileCountOverlayElements();

    if (!overlay || !statusEl || !statsEl) {
      throw new Error('Debug file count overlay is unavailable');
    }

    resetDebugFileCountScorecard();
    debugFileCountState.scorecard = createScorecardController({
      statusEl,
      statsEl,
    });
    debugFileCountState.runtime = createCleanerScorecardRuntime({
      scorecard: debugFileCountState.scorecard,
      view: DEFAULT_CLEANER_SCORECARD_VIEW,
    });

    if (titleEl) {
      titleEl.textContent = 'Debug file count';
    }
    if (closeBtn) {
      closeBtn.disabled = false;
      closeBtn.onclick = closeDebugFileCountOverlay;
    }
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.style.display = 'inline-block';
      cancelBtn.onclick = closeDebugFileCountOverlay;
    }
    if (proceedBtn) {
      proceedBtn.style.display = 'none';
      proceedBtn.disabled = true;
      proceedBtn.textContent = 'Proceed';
      proceedBtn.onclick = null;
    }

    debugFileCountState.scanRoot = selectedPath;

    debugFileCountState.scorecard.setStatus('Scanning cleaner tasks', { spinner: true });
    await debugFileCountState.runtime.setSignalCounts({});
    overlay.style.display = 'flex';

    const response = await fetch('/api/debug/scan-clean-library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selectedPath }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to scan cleaner tasks');
    }

    const usedIssuesFallback =
      !result.operations?.details && Boolean(result.details);
    const operationDetails =
      result.operations?.details || result.details || {};

    renderDebugFileCountReview({
      details: operationDetails,
      serverOperationCount: result.operations?.summary?.operation_count,
      rawIssueCount: result.summary?.issue_count,
      usedIssuesFallback,
    });
    return true;
  } catch (error) {
    console.error('❌ Failed to start debug file count flow:', error);
    closeDebugFileCountOverlay();
    showToast(`Error: ${error.message}`);
    return false;
  }
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
      void openExistingLibrary();
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
      void openExistingLibrary();
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
      void openExistingLibrary();
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

function getRotateTooltip(photo) {
  const reason = getRotateDisabledReason(photo);
  if (reason) return reason;

  const ext = getPhotoExtension(photo);
  const hasPending = getRotationStillNeeded(photo.id) !== 0;
  if (HEIC_IMAGE_EXTENSIONS.has(ext)) {
    return hasPending
      ? 'Back saves as TIFF · Esc cancels'
      : 'Rotate left (Back saves as TIFF · Esc cancels)';
  }

  return hasPending
    ? 'Back saves rotation · Esc cancels'
    : 'Rotate left (Back saves · Esc cancels)';
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
  rotateBtn.title = getRotateTooltip(photo);
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

function discardPendingLightboxRotations() {
  state.lightboxRotationSessions = {};
}

async function commitPendingLightboxRotations() {
  const pendingEntries = Object.entries(state.lightboxRotationSessions).filter(
    ([photoId]) => getRotationStillNeeded(Number(photoId)) !== 0,
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
  session.mode = 'staged';
  invalidatePendingLightboxReloads();
  applyCurrentLightboxPreviewRotation();
  updateLightboxRotateButtonState();
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
    backBtn.addEventListener('click', () => closeLightbox({ commitRotations: true }));
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

        if (hasActivePhotoFilters()) {
          applyPhotoFilters();
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
        },
      );
    });
  }

  // Auto-hide UI only after pointer leaves the overlay (not while hovering)
  if (overlay) {
    overlay.addEventListener('mouseenter', () => {
      state.lightboxUIHovered = true;
      showLightboxUI();
      clearLightboxUIHideTimeout();
    });

    overlay.addEventListener('mouseleave', () => {
      state.lightboxUIHovered = false;
      scheduleLightboxUIHide();
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

function clearLightboxUIHideTimeout() {
  if (state.lightboxUITimeout) {
    clearTimeout(state.lightboxUITimeout);
    state.lightboxUITimeout = null;
  }
}

function scheduleLightboxUIHide() {
  clearLightboxUIHideTimeout();
  state.lightboxUITimeout = setTimeout(() => {
    if (state.lightboxOpen && !state.lightboxUIHovered) {
      hideLightboxUI();
    }
  }, 2000);
}

function syncLightboxUIHoverState() {
  const overlay = document.getElementById('lightboxOverlay');
  if (!overlay || !state.lightboxOpen) return;

  state.lightboxUIHovered = overlay.matches(':hover');
  showLightboxUI();
  clearLightboxUIHideTimeout();
  if (!state.lightboxUIHovered) {
    scheduleLightboxUIHide();
  }
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

    // Priority 2: Close lightbox without saving staged rotations
    if (state.lightboxOpen) {
      closeLightbox({ commitRotations: false });
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

    video.addEventListener('error', async () => {
      try {
        const response = await fetch(`/api/photo/${photo.id}/file`);
        if (response.status !== 404) return;

        const data = await response.json().catch(() => ({}));
        if (data.error === 'Photo not found') {
          await handleStalePhoto(photo.id);
        }
      } catch (error) {
        console.error('❌ Error checking video availability:', error);
      }
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

        // Check if failure was due to database corruption or stale grid entry
        try {
          const response = await fetch(`/api/photo/${photo.id}/file`);

          if (!response.ok) {
            const contentType = response.headers.get('content-type');

            if (contentType && contentType.includes('application/json')) {
              const data = await response.json();

              if (checkForDatabaseCorruption(data)) {
                return; // Corruption dialog shown, stop here
              }

              if (response.status === 404 && data.error === 'Photo not found') {
                await handleStalePhoto(photo.id);
                return;
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
          if (response.status === 404 && error.error === 'Photo not found') {
            await handleStalePhoto(photo.id);
          }
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

  // Show UI; hide timer starts only after pointer leaves the overlay
  syncLightboxUIHoverState();

  // Update arrow states based on position
  updateLightboxArrowStates();
}

/**
 * Preload adjacent images for smooth navigation
 */
function preloadAdjacentImages(currentIndex) {
  const preloadPhoto = (libraryIndex) => {
    if (libraryIndex < 0 || libraryIndex >= state.photos.length) {
      return;
    }
    const photo = state.photos[libraryIndex];
    const img = new Image();
    img.src = getPhotoFileUrl(photo.id);
  };

  if (hasActivePhotoFilters()) {
    preloadPhoto(getAdjacentLightboxLibraryIndex(-1));
    preloadPhoto(getAdjacentLightboxLibraryIndex(1));
    return;
  }

  preloadPhoto(currentIndex - 1);
  preloadPhoto(currentIndex + 1);
}

/**
 * Update lightbox placeholder dimensions based on aspect ratio
 * (No longer needed with real images, keeping for compatibility)
 */
function updateLightboxDimensions(placeholder, aspectRatio) {
  // Deprecated - real images handle their own aspect ratio
}

/**
 * Close lightbox.
 * commitRotations: true (back button) saves staged rotations; false (Esc) discards them.
 */
async function closeLightbox({ commitRotations = true } = {}) {
  const overlay = document.getElementById('lightboxOverlay');
  if (!overlay) return;
  if (state.lightboxClosing) return;

  state.lightboxClosing = true;
  updateLightboxRotateButtonState();

  if (commitRotations) {
    const saved = await commitPendingLightboxRotations();
    if (!saved) {
      state.lightboxClosing = false;
      updateLightboxRotateButtonState();

      return;
    }
  } else {
    discardPendingLightboxRotations();
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

  // Clear UI timeout and hover tracking
  clearLightboxUIHideTimeout();
  state.lightboxUIHovered = false;

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
  if (currentIndex === null) {
    return;
  }

  if (hasActivePhotoFilters()) {
    const currentPhotoId = state.photos[currentIndex]?.id;
    const navPhotoIds = getLightboxNavPhotoIds();
    const navIndex = navPhotoIds.indexOf(currentPhotoId);

    if (navIndex <= 0) {
      prevBtn.classList.add('inactive');
    } else {
      prevBtn.classList.remove('inactive');
    }

    if (navIndex === -1 || navIndex >= navPhotoIds.length - 1) {
      nextBtn.classList.add('inactive');
    } else {
      nextBtn.classList.remove('inactive');
    }
    return;
  }

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

  let newIndex;
  if (hasActivePhotoFilters()) {
    newIndex = getAdjacentLightboxLibraryIndex(direction);
    if (newIndex === null) {
      return;
    }
  } else {
    newIndex = state.lightboxPhotoIndex + direction;
    if (newIndex < 0 || newIndex >= state.photos.length) {
      return;
    }
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

      renderPhotoGrid(getFilteredPhotos(state.photos), false);

      setupThumbnailLazyLoading();

      updateUtilityMenuAvailability();
      updateFilterChipRailVisibility();

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
// PHOTO FILTERS
// =====================

function hasActivePhotoFilters() {
  return state.activeFilters.starred || state.activeFilters.video;
}

function getFilteredPhotos(photos = state.photos) {
  const { starred, video } = state.activeFilters;
  if (!starred && !video) {
    return photos;
  }

  return photos.filter((photo) => {
    if (starred && photo.rating !== 5) {
      return false;
    }
    if (video && photo.file_type !== 'video') {
      return false;
    }
    return true;
  });
}

function getPhotoLibraryIndex(photoId) {
  return state.photos.findIndex((photo) => photo.id === photoId);
}

function buildPhotoLibraryIndexMap() {
  const indexById = new Map();
  state.photos.forEach((photo, index) => {
    indexById.set(photo.id, index);
  });
  return indexById;
}

function getLightboxNavPhotoIds() {
  return getFilteredPhotos(state.photos).map((photo) => photo.id);
}

function getAdjacentLightboxLibraryIndex(direction) {
  if (state.lightboxPhotoIndex === null) {
    return null;
  }

  const currentPhotoId = state.photos[state.lightboxPhotoIndex]?.id;
  if (!currentPhotoId) {
    return null;
  }

  const navPhotoIds = getLightboxNavPhotoIds();
  const navIndex = navPhotoIds.indexOf(currentPhotoId);
  if (navIndex === -1) {
    return null;
  }

  const nextNavIndex = navIndex + direction;
  if (nextNavIndex < 0 || nextNavIndex >= navPhotoIds.length) {
    return null;
  }

  return getPhotoLibraryIndex(navPhotoIds[nextNavIndex]);
}

function updateFilterChipUI() {
  const chips = document.querySelectorAll('.filter-chip[data-filter]');
  chips.forEach((chip) => {
    const filterKey = chip.dataset.filter;
    const isActive = !!state.activeFilters[filterKey];
    chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function updateFilterChipRailVisibility() {
  const rail = document.getElementById('filterChipRailMount');
  const shouldShow = state.hasDatabase && state.photos.length > 0;
  if (!rail) {
    document.body.classList.toggle('filter-chip-rail-visible', shouldShow);
    return;
  }

  if (shouldShow) {
    rail.removeAttribute('hidden');
  } else {
    rail.setAttribute('hidden', '');
  }
  document.body.classList.toggle('filter-chip-rail-visible', shouldShow);
}

function applyPhotoFilters() {
  const filteredPhotos = getFilteredPhotos(state.photos);
  renderPhotoGrid(filteredPhotos, false);
  if (filteredPhotos.length > 0) {
    setupThumbnailLazyLoading();
  }
  updateFilterChipUI();
  updateFilterChipRailVisibility();
}

function togglePhotoFilter(filterKey) {
  if (!(filterKey in state.activeFilters)) {
    return;
  }

  state.activeFilters[filterKey] = !state.activeFilters[filterKey];
  state.lastClickedIndex = null;
  applyPhotoFilters();
}

function clearPhotoFilters() {
  state.activeFilters.starred = false;
  state.activeFilters.video = false;
  state.lastClickedIndex = null;
  applyPhotoFilters();
}

function resetPhotoFilters() {
  state.activeFilters.starred = false;
  state.activeFilters.video = false;
  updateFilterChipUI();
}

function wireFilterChipRail() {
  const rail = document.getElementById('filterChipRailMount');
  if (!rail) {
    return;
  }

  rail.querySelectorAll('.filter-chip[data-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      togglePhotoFilter(chip.dataset.filter);
    });
  });

  updateFilterChipUI();
  updateFilterChipRailVisibility();
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
        <button class="btn" onclick="logOpenLibraryAccessPoint('first-run-empty-state'); void openExistingLibrary();" style="display: flex; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.1); color: var(--text-primary); white-space: nowrap;">
          <span class="material-symbols-outlined" style="font-size: 18px; width: 18px; height: 18px; display: inline-block; overflow: hidden;">folder_open</span>
          <span>Open library</span>
        </button>
        <button class="btn btn-primary" onclick="triggerImportWithLibraryCheck()" style="display: flex; align-items: center; gap: 8px; white-space: nowrap;">
          <span class="material-symbols-outlined" style="font-size: 18px; width: 18px; height: 18px; display: inline-block; overflow: hidden;">add_a_photo</span>
          <span>Add photos</span>
        </button>
        ${SHOW_FIRST_RUN_DEBUG_BUTTON ? `
        <button class="btn" onclick="void openDebugFlowPicker()" style="display: flex; align-items: center; gap: 8px; white-space: nowrap;">
          <span class="material-symbols-outlined" style="font-size: 18px; width: 18px; height: 18px; display: inline-block; overflow: hidden;">bug_report</span>
          <span>Debug</span>
        </button>
        ` : ''}
      </div>
    </div>
  `;
}

function getLibraryDisplayName(libraryPath = state.libraryPath) {
  if (!libraryPath) {
    return null;
  }
  const name = libraryPath.split('/').filter(Boolean).pop();
  return name || null;
}

function getEmptyLibraryHeading() {
  const displayName = getLibraryDisplayName();
  return displayName ? `${displayName} is empty` : 'This library is empty';
}

/**
 * Active filters returned no matches — offer to clear filters
 */
function renderFilterEmptyState() {
  const container = document.getElementById('photoContainer');
  if (!container) return;

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: calc(100vh - 64px); margin-top: -48px; color: var(--text-color); gap: 24px;">
      <div style="text-align: center;">
        <div style="font-size: 18px; margin-bottom: 8px;">No results found</div>
        <div style="font-size: 14px; color: var(--text-secondary);">No images match the current filters.</div>
      </div>
      <div style="display: flex; gap: 12px;">
        <button class="btn btn-primary" onclick="clearPhotoFilters()" style="display: flex; align-items: center; gap: 8px; white-space: nowrap;">
          <span>Clear filters</span>
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

  const heading = escapeHtml(getEmptyLibraryHeading());

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: calc(100vh - 64px); margin-top: -48px; color: var(--text-color); gap: 24px;">
      <div style="text-align: center;">
        <div style="font-size: 18px; margin-bottom: 8px;">${heading}</div>
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
      if (state.photos.length > 0 && hasActivePhotoFilters()) {
        renderFilterEmptyState();
      } else if (state.hasDatabase) {
        renderEmptyLibraryState();
      } else {
        renderFirstRunEmptyState();
      }
    }
    return;
  }

  // Group photos by month (O(n) index map — avoid findIndex per photo on large libraries)
  const libraryIndexById = buildPhotoLibraryIndexMap();
  const photosByMonth = {};
  photos.forEach((photo) => {
    const monthKey = photo.month || 'undated';
    if (!photosByMonth[monthKey]) {
      photosByMonth[monthKey] = [];
    }
    const libraryIndex = libraryIndexById.get(photo.id);
    photosByMonth[monthKey].push({
      ...photo,
      globalIndex: libraryIndex === undefined ? 0 : libraryIndex,
    });
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
        const starBadgeHTML =
          photo.rating === 5
            ? '<div class="star-badge"><span class="material-symbols-outlined">star</span></div>'
            : '';

        const videoBadgeHTML =
          photo.file_type === 'video'
            ? '<div class="video-badge"><span class="material-symbols-outlined">play_circle</span></div>'
            : '';

        html += `
          <div class="photo-card" data-id="${photo.id}" data-index="${photo.globalIndex}">
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
      const photoId = parseInt(card.dataset.id, 10);
      const libraryIndex = getPhotoLibraryIndex(photoId);
      if (libraryIndex >= 0) {
        openLightbox(libraryIndex);
      }
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
 * Drop photos from in-memory grid state and re-render immediately.
 */
function removePhotosFromState(photoIds) {
  const idSet = new Set(photoIds.map((id) => Number(id)));
  if (!idSet.size) return false;

  const prevCount = state.photos.length;
  state.photos = state.photos.filter((photo) => !idSet.has(photo.id));
  if (state.photos.length === prevCount) return false;

  idSet.forEach((id) => state.selectedPhotos.delete(id));
  state.lastClickedIndex = null;

  renderPhotoGrid(getFilteredPhotos(state.photos), false);
  setupThumbnailLazyLoading();
  updateDeleteButtonVisibility();
  return true;
}

/**
 * Photo exists in client state but not on server (already deleted / stale cache).
 */
async function handleStalePhoto(photoId, { closeLightbox = true } = {}) {
  const wasViewingInLightbox =
    state.lightboxOpen &&
    state.lightboxPhotoIndex !== null &&
    state.photos[state.lightboxPhotoIndex]?.id === photoId;

  const removed = removePhotosFromState([photoId]);
  if (!removed) return false;

  if (closeLightbox && wasViewingInLightbox) {
    await closeLightbox({ commitRotations: false });
  }

  showToast('Photo is no longer in the library', null);
  loadAndRenderPhotos(false);
  return true;
}

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
      await closeLightbox({ commitRotations: false });
    }

    const deletedCount = result.deleted || 0;
    const errors = Array.isArray(result.errors) ? result.errors : [];
    const notFoundIds = photoIds.filter((id) =>
      errors.some((message) => message === `Photo ${id} not found`),
    );

    if (deletedCount > 0) {
      removePhotosFromState(photoIds);
    } else if (notFoundIds.length > 0) {
      removePhotosFromState(notFoundIds);
    }

    // Full reload can take a long time on large libraries; run in background.
    loadAndRenderPhotos(false);

    if (deletedCount > 0) {
      showToast(
        `Deleted ${deletedCount} photo${deletedCount > 1 ? 's' : ''}`,
        () => undoDelete(photoIds),
      );
    } else if (notFoundIds.length > 0) {
      showToast('Photo was already deleted', null);
    } else if (errors.length > 0) {
      showToast(errors[0], null);
    } else {
      showToast('Nothing to delete', null);
    }
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
  preflight: null,
  preflightResolve: null,
  overlayPhase: null,
  runStartedAtMs: null,
  estimatedSeconds: null,
  estimatedDisplay: null,
  inflightRemainingTimer: null,
};

let terraformProgressState = {
  active: false,
  runStartedAtMs: null,
  estimatedSeconds: null,
  estimatedDisplay: null,
  remainingTimer: null,
  abortController: null,
};

// Toggle this on if cancelling an import should require confirmation.
const IMPORT_CANCEL_CONFIRMATION_ENABLED = false;

function setImportActionButtons({
  showCancel = false,
  showContinue = false,
  showDone = false,
  showUndo = false,
  continueDisabled = false,
} = {}) {
  const cancelBtn = document.getElementById('importCancelBtn');
  const continueBtn = document.getElementById('importContinueBtn');
  const doneBtn = document.getElementById('importDoneBtn');
  const undoBtn = document.getElementById('importUndoBtn');
  const actionsSection = document.querySelector('#importOverlay .import-actions');

  if (cancelBtn) {
    cancelBtn.style.display = showCancel ? 'block' : 'none';
    cancelBtn.disabled = false;
  }
  if (continueBtn) {
    continueBtn.style.display = showContinue ? 'block' : 'none';
    continueBtn.disabled = showContinue ? continueDisabled : false;
  }
  if (doneBtn) doneBtn.style.display = showDone ? 'block' : 'none';
  if (undoBtn) undoBtn.style.display = showUndo ? 'block' : 'none';
  if (actionsSection && (showCancel || showContinue || showDone || showUndo)) {
    actionsSection.style.display = 'flex';
  }
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
  const preflightStats = document.getElementById('importPreflightStats');
  const stats = document.getElementById('importStats');
  const detailsSection = document.getElementById('importDetailsSection');
  const importedCount = document.getElementById('importedCount');
  const duplicateCount = document.getElementById('duplicateCount');
  const errorCount = document.getElementById('errorCount');

  setImportOverlayTitle();

  if (statusText) {
    statusText.textContent = `Preparing import of ${totalFiles} file${
      totalFiles === 1 ? '' : 's'
    }...`;
  }
  if (preflightStats) preflightStats.style.display = 'none';
  if (stats) stats.style.display = 'none';
  if (detailsSection) detailsSection.style.display = 'none';
  resetImportDetailsExpanded();
  if (importedCount) importedCount.textContent = '0';
  if (duplicateCount) duplicateCount.textContent = '0';
  if (errorCount) errorCount.textContent = '0';

  setImportActionButtons({ showCancel: true });
}

function finishImportSession() {
  importState.isImporting = false;
  importState.abortController = null;
  importState.cancelRequested = false;
  importState.overlayPhase = null;
  stopImportInflightRemainingTicker();
}

function setImportInflightCounts(imported, duplicates, skipped) {
  const preflightEl = document.getElementById('importPreflightStats');
  const statsEl = document.getElementById('importStats');
  const importedEl = document.getElementById('importedCount');
  const duplicateEl = document.getElementById('duplicateCount');
  const skippedEl = document.getElementById('errorCount');
  if (preflightEl) preflightEl.style.display = 'none';
  if (statsEl) statsEl.style.display = 'grid';
  if (importedEl) importedEl.textContent = Number(imported).toLocaleString();
  if (duplicateEl) duplicateEl.textContent = Number(duplicates).toLocaleString();
  if (skippedEl) skippedEl.textContent = Number(skipped).toLocaleString();
}

function stopImportInflightRemainingTicker() {
  if (importState.inflightRemainingTimer) {
    clearInterval(importState.inflightRemainingTimer);
    importState.inflightRemainingTimer = null;
  }
}

function syncImportInflightRemainingDisplay() {
  const secondaryEl = document.getElementById('importSecondaryStatus');
  if (!secondaryEl) {
    return;
  }
  const totalSec = Number(importState.estimatedSeconds);
  if (!importState.runStartedAtMs || !Number.isFinite(totalSec) || totalSec <= 0) {
    secondaryEl.style.display = 'none';
    return;
  }
  const elapsed = (Date.now() - importState.runStartedAtMs) / 1000;
  const done = Math.min(
    importState.totalFiles || 0,
    (importState.importedCount || 0) +
      (importState.duplicateCount || 0) +
      (importState.errorCount || 0),
  );
  const total = Math.max(1, importState.totalFiles || 1);
  const ratio = done / total;
  const remainingSec = Math.max(5, totalSec * (1 - ratio));
  secondaryEl.style.display = 'block';
  secondaryEl.textContent = `Total time remaining: ${formatAboutDurationFromSeconds(
    Math.max(5, remainingSec - Math.min(elapsed, totalSec * ratio)),
  )}`;
}

function startImportInflightRemainingTicker() {
  stopImportInflightRemainingTicker();
  syncImportInflightRemainingDisplay();
  importState.inflightRemainingTimer = setInterval(
    syncImportInflightRemainingDisplay,
    400,
  );
}

function beginImportInflightUi() {
  importState.overlayPhase = 'inflight';
  importState.runStartedAtMs = Date.now();

  const explainerEl = document.getElementById('importExplainer');
  if (explainerEl) {
    explainerEl.textContent = FLOW_INFLIGHT_BODY.add;
    explainerEl.style.display = 'block';
  }

  setImportInflightCounts(0, 0, 0);

  const detailsSection = document.getElementById('importDetailsSection');
  if (detailsSection) {
    detailsSection.style.display = 'block';
  }
  resetFlowDetailsPanel('add');
  getFlowActivityLogFeed('add').prepend(
    `Started: ${formatCleanLibraryFeedTimestamp(new Date(importState.runStartedAtMs))}`,
  );
  getFlowActivityLogFeed('add').setExpanded(false);

  setImportActionButtons({ showCancel: true });
  startImportInflightRemainingTicker();
}

function syncImportInflightStatus(current, total) {
  const statusEl = document.getElementById('importStatusText');
  if (statusEl && total > 0) {
    setImportSpinnerStatus(
      statusEl,
      `Processing ${Math.min(current, total).toLocaleString()} of ${total.toLocaleString()} files`,
    );
  }
  syncImportInflightRemainingDisplay();
}

function appendImportActivityLine(line) {
  const text = String(line || '').trim();
  if (!text) {
    return;
  }
  getFlowActivityLogFeed('add').append(text);
}

function renderImportCompleteUi({ hasErrors = false, logPath = null } = {}) {
  stopImportInflightRemainingTicker();
  importState.overlayPhase = 'complete';

  const explainerEl = document.getElementById('importExplainer');
  if (explainerEl) {
    explainerEl.style.display = 'none';
  }
  const secondaryEl = document.getElementById('importSecondaryStatus');
  if (secondaryEl) {
    secondaryEl.style.display = 'none';
  }

  const imported = importState.importedCount || 0;
  const skipped = importState.errorCount || 0;
  const statusEl = document.getElementById('importStatusText');
  if (statusEl) {
    if (hasErrors) {
      statusEl.textContent = `Added ${imported.toLocaleString()} file${
        imported === 1 ? '' : 's'
      } with ${skipped} error${skipped === 1 ? '' : 's'}.`;
    } else {
      statusEl.textContent = `Added ${imported.toLocaleString()} file${
        imported === 1 ? '' : 's'
      } to your library.`;
    }
  }

  setImportInflightCounts(
    imported,
    importState.duplicateCount || 0,
    skipped,
  );

  appendImportActivityLine(
    `Finished: ${formatCleanLibraryFeedTimestamp(new Date())}`,
  );
  if (logPath) {
    getFlowActivityLogFeed('add').setLogPointer(logPath);
  }

  const detailsSection = document.getElementById('importDetailsSection');
  if (detailsSection) {
    detailsSection.style.display = 'block';
  }

  if (hasErrors) {
    showUnifiedErrorDetails();
  } else {
    getFlowActivityLogFeed('add').setExpanded(false);
  }

  setImportActionButtons({
    showDone: true,
    showUndo: imported > 0,
  });
}

function animateTerraformPreflightCounts(photoTarget, videoTarget, totalTarget, durationMs) {
  const resolvedTotalTarget = totalTarget ?? photoTarget + videoTarget;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      const elapsed = Date.now() - startedAt;
      const ratio = Math.min(1, elapsed / durationMs);
      const eased = 1 - (1 - ratio) ** 2;
      setTerraformDebugPreflightCounts(
        Math.round(photoTarget * eased),
        Math.round(videoTarget * eased),
        Math.round(resolvedTotalTarget * eased),
      );
      if (ratio >= 1) {
        setTerraformDebugPreflightCounts(
          photoTarget,
          videoTarget,
          resolvedTotalTarget,
        );
        resolve();
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function animateImportPreflightCounts(photoTarget, videoTarget, totalTarget, durationMs) {
  const resolvedTotalTarget = totalTarget ?? photoTarget + videoTarget;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      const elapsed = Date.now() - startedAt;
      const ratio = Math.min(1, elapsed / durationMs);
      const eased = 1 - (1 - ratio) ** 2;
      setImportDebugPreflightCounts(
        Math.round(photoTarget * eased),
        Math.round(videoTarget * eased),
        Math.round(resolvedTotalTarget * eased),
      );
      if (ratio >= 1) {
        setImportDebugPreflightCounts(
          photoTarget,
          videoTarget,
          resolvedTotalTarget,
        );
        resolve();
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
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
    const response = await fetch('fragments/importOverlay.html?v=5');
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
  const continueBtn = document.getElementById('importContinueBtn');
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

  if (continueBtn) {
    continueBtn.addEventListener('click', () => {
      resolveImportPreflight(true);
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

  wireFlowDetailsToggle('add');
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
      setImportSpinnerStatus(statusTextEl, statusText);
    } else {
      statusTextEl.textContent = statusText;
    }
  }
  if (statusText.startsWith('Processing') && importStatsEl) {
    importStatsEl.style.display = 'grid';
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

function resolveImportPreflight(shouldContinue) {
  if (debugFlowPreviewState.active && debugFlowPreviewState.flow === 'add') {
    if (debugFlowPreviewState.screen === 'preflight' && shouldContinue) {
      triggerDebugPreflightContinue();
    } else {
      dismissDebugFlowPreview();
    }
    return;
  }

  if (!importState.preflightResolve) {
    return;
  }

  const resolve = importState.preflightResolve;
  importState.preflightResolve = null;
  resolve(shouldContinue);
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
  if (debugFlowPreviewState.active && debugFlowPreviewState.flow === 'add') {
    dismissDebugFlowPreview();
    return;
  }

  if (importState.preflightResolve) {
    resolveImportPreflight(false);
    await hideImportOverlay(false);
    return;
  }

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
  if (importState.preflightResolve) {
    resolveImportPreflight(false);
    await hideImportOverlay(false);
    return;
  }

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
  if (debugFlowPreviewState.active && debugFlowPreviewState.flow === 'add') {
    dismissDebugFlowPreview();
    return;
  }

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
    const response = await fetch('fragments/utilitiesMenu.html?v=7');
    if (!response.ok) throw new Error('Failed to load utilities menu');

    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);

    // Wire up menu items
    const switchLibraryBtn = document.getElementById('switchLibraryBtn');
    const convertToLibraryBtn = document.getElementById('convertToLibraryBtn');
    const cleanOrganizeBtn = document.getElementById('cleanOrganizeBtn');
    const closeLibraryBtn = document.getElementById('closeLibraryBtn');

    if (switchLibraryBtn) {
      switchLibraryBtn.addEventListener('click', () => {
        hideUtilitiesMenu();
        logOpenLibraryAccessPoint('utilities-menu');
        void openExistingLibrary();
      });
    }

    if (convertToLibraryBtn) {
      convertToLibraryBtn.addEventListener('click', () => {
        hideUtilitiesMenu();
        void convertToLibrary();
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
  preflight: null,
  isRunning: false,
  abortController: null,
  cancelRequested: false,
  resumeIntent: null,
  overlayPhase: null,
  workingPhaseActive: false,
  runStartedAtMs: null,
  estimatedSeconds: 0,
  estimatedDisplay: '',
  onInterruptedChoice: null,
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
    const response = await fetch('fragments/updateIndexOverlay.html?v=2');
    if (!response.ok) throw new Error('Failed to load Update Database overlay');

    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);

    // Wire up buttons
    const closeBtn = document.getElementById('updateIndexCloseBtn');
    const cancelBtn = document.getElementById('updateIndexCancelBtn');
    const proceedBtn = document.getElementById('updateIndexProceedBtn');
    const doneBtn = document.getElementById('updateIndexDoneBtn');
    const startOverBtn = document.getElementById('updateIndexStartOverBtn');
    const detailsToggle = document.getElementById('updateIndexDetailsToggle');

    if (closeBtn) closeBtn.addEventListener('click', handleUpdateIndexCancelClick);
    if (cancelBtn) cancelBtn.addEventListener('click', handleUpdateIndexCancelClick);
    if (proceedBtn) proceedBtn.addEventListener('click', handleUpdateIndexProceedClick);
    if (startOverBtn) {
      startOverBtn.addEventListener('click', handleUpdateIndexStartOverClick);
    }
    if (doneBtn) doneBtn.addEventListener('click', closeUpdateIndexOverlay);

    wireFlowDetailsToggle('clean');
  } catch (error) {
    console.error('❌ Failed to load Update Database overlay:', error);
  }
}

function stopDebugFlowPreview() {
  debugFlowPreviewState.runId += 1;
  debugFlowPreviewState.active = false;
  debugFlowPreviewState.flow = null;
  debugFlowPreviewState.screen = null;
  debugFlowPreviewState.onDismiss = null;
  debugFlowPreviewState.onPreflightContinue = null;
  debugFlowPreviewState.inflightTargets = null;
  Object.keys(FLOW_ACTIVITY_LOG_REGISTRY).forEach(resetFlowDetailsPanel);
  debugFlowPreviewState.timers.forEach((timerId) => {
    clearTimeout(timerId);
    clearInterval(timerId);
  });
  debugFlowPreviewState.timers = [];

  cleanLibraryPreviewState.active = false;
  cleanLibraryPreviewState.onProceed = null;
  cleanLibraryPreviewState.onInterruptedChoice = null;

  [
    'importOverlay',
    'updateIndexOverlay',
    'terraformPreviewOverlay',
    'terraformProgressOverlay',
    'terraformCompleteOverlay',
  ].forEach((id) => {
    const overlay = document.getElementById(id);
    if (overlay) {
      overlay.style.display = 'none';
    }
  });
}

function dismissDebugFlowPreview() {
  if (debugFlowPreviewState.onDismiss) {
    debugFlowPreviewState.onDismiss();
  } else {
    stopDebugFlowPreview();
  }
}

function triggerDebugPreflightContinue() {
  if (debugFlowPreviewState.onPreflightContinue) {
    debugFlowPreviewState.onPreflightContinue();
  }
}

function waitForDebugPreflightContinue(runId) {
  return new Promise((resolve, reject) => {
    debugFlowPreviewState.onPreflightContinue = () => {
      if (runId !== debugFlowPreviewState.runId) {
        reject(new Error('cancelled'));
        return;
      }
      debugFlowPreviewState.onPreflightContinue = null;
      resolve(true);
    };
    debugFlowPreviewState.onDismiss = () => {
      if (runId !== debugFlowPreviewState.runId) {
        reject(new Error('cancelled'));
        return;
      }
      debugFlowPreviewState.onDismiss = null;
      resolve(false);
    };
  });
}

function waitForDebugFlowDismiss(runId) {
  return new Promise((resolve, reject) => {
    debugFlowPreviewState.onDismiss = () => {
      if (runId !== debugFlowPreviewState.runId) {
        reject(new Error('cancelled'));
        return;
      }
      debugFlowPreviewState.onDismiss = null;
      resolve();
    };
  });
}

function getDebugFlowTotalCount() {
  return (
    debugFlowPreviewState.photoTarget + debugFlowPreviewState.videoTarget
  );
}

function deriveDebugInflightTargets(total) {
  const safeTotal = Math.max(1, Number(total) || 1);
  const duplicates = Math.max(0, Math.round(safeTotal * 0.08));
  const skipped = Math.max(0, Math.round(safeTotal * 0.03));
  const primary = Math.max(0, safeTotal - duplicates - skipped);
  return { primary, duplicates, skipped };
}

function resetDebugLogFeed(flow, logPath = DEBUG_FLOW_LOG_PATHS[flow]) {
  getFlowActivityLogFeed(flow).reset(logPath);
}

function appendDebugLogFeed(flow, line) {
  getFlowActivityLogFeed(flow).append(line);
}

function showDebugDetailsSection(flow, visible = true) {
  if (flow === 'add') {
    const section = document.getElementById('importDetailsSection');
    if (section) {
      section.style.display = visible ? 'block' : 'none';
    }
    return;
  }
  if (flow === 'clean') {
    showCleanLibraryDetailsSection(visible);
    return;
  }
  if (flow === 'convert') {
    const section = document.getElementById('terraformProgressDetailsSection');
    if (section) {
      section.style.display = visible ? 'block' : 'none';
    }
  }
}

function setDebugInflightCounts(flow, primary, duplicates, skipped) {
  if (flow === 'add') {
    const preflightEl = document.getElementById('importPreflightStats');
    const statsEl = document.getElementById('importStats');
    const importedEl = document.getElementById('importedCount');
    const duplicateEl = document.getElementById('duplicateCount');
    const skippedEl = document.getElementById('errorCount');
    if (preflightEl) preflightEl.style.display = 'none';
    if (statsEl) statsEl.style.display = 'grid';
    if (importedEl) importedEl.textContent = Number(primary).toLocaleString();
    if (duplicateEl) duplicateEl.textContent = Number(duplicates).toLocaleString();
    if (skippedEl) skippedEl.textContent = Number(skipped).toLocaleString();
    return;
  }
  if (flow === 'clean') {
    const preflightEl = document.getElementById('updateIndexPreflightStats');
    const statsEl = document.getElementById('updateIndexInflightStats');
    const processedEl = document.getElementById('updateIndexInflightProcessed');
    const duplicateEl = document.getElementById('updateIndexInflightDuplicates');
    const skippedEl = document.getElementById('updateIndexInflightSkipped');
    if (preflightEl) preflightEl.style.display = 'none';
    if (statsEl) statsEl.style.display = 'grid';
    hideUpdateIndexStats();
    if (processedEl) processedEl.textContent = Number(primary).toLocaleString();
    if (duplicateEl) duplicateEl.textContent = Number(duplicates).toLocaleString();
    if (skippedEl) skippedEl.textContent = Number(skipped).toLocaleString();
    return;
  }
  if (flow === 'convert') {
    const processedEl = document.getElementById('terraformProgressProcessed');
    const duplicateEl = document.getElementById('terraformProgressDuplicates');
    const skippedEl = document.getElementById('terraformProgressSkipped');
    if (processedEl) processedEl.textContent = Number(primary).toLocaleString();
    if (duplicateEl) duplicateEl.textContent = Number(duplicates).toLocaleString();
    if (skippedEl) skippedEl.textContent = Number(skipped).toLocaleString();
  }
}

function animateDebugInflightCounts(runId, flow, targets, durationMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (runId !== debugFlowPreviewState.runId) {
        reject(new Error('cancelled'));
        return;
      }
      const elapsed = Date.now() - startedAt;
      const ratio = Math.min(1, elapsed / durationMs);
      const eased = 1 - (1 - ratio) ** 2;
      setDebugInflightCounts(
        flow,
        Math.round(targets.primary * eased),
        Math.round(targets.duplicates * eased),
        Math.round(targets.skipped * eased),
      );
      if (ratio >= 1) {
        setDebugInflightCounts(
          flow,
          targets.primary,
          targets.duplicates,
          targets.skipped,
        );
        resolve();
        return;
      }
      const timerId = setTimeout(tick, 50);
      debugFlowPreviewState.timers.push(timerId);
    };
    tick();
  });
}

function buildDebugInflightStatusLine(flow, ratio) {
  const total = getDebugFlowTotalCount();
  const current = Math.max(1, Math.round(total * ratio));
  if (flow === 'add') {
    return `Processing ${current.toLocaleString()} of ${total.toLocaleString()} files`;
  }
  if (flow === 'clean') {
    const stepNumber = Math.min(
      6,
      Math.max(1, Math.ceil(ratio * CLEAN_LIBRARY_PREVIEW_WORKING_STEPS.length)),
    );
    const stepLabel = CLEAN_LIBRARY_PREVIEW_WORKING_STEPS[stepNumber - 1];
    return `Step ${stepNumber} of 6: ${stepLabel}`;
  }
  const stepNumber = Math.min(3, Math.max(1, Math.ceil(ratio * 3)));
  const labels = ['Converting files', 'Cleaning folders', 'Final verification'];
  return `Step ${stepNumber} of 3: ${labels[stepNumber - 1]} (${current.toLocaleString()} / ${total.toLocaleString()})`;
}

function buildDebugInflightSecondaryStatus(ratio) {
  const remainingSec = Math.max(
    5,
    Math.round(
      (debugFlowPreviewState.estimatedSeconds || 30) * (1 - ratio),
    ),
  );
  return `Total time remaining: ${formatAboutDurationFromSeconds(remainingSec)}`;
}

async function simulateDebugInflightPhase(flow, runId) {
  debugFlowPreviewState.screen = 'inflight';
  const total = getDebugFlowTotalCount();
  const targets = deriveDebugInflightTargets(total);
  debugFlowPreviewState.inflightTargets = targets;

  if (flow === 'convert') {
    const previewOverlay = document.getElementById('terraformPreviewOverlay');
    if (previewOverlay) {
      previewOverlay.style.display = 'none';
    }
    let progressOverlay = document.getElementById('terraformProgressOverlay');
    if (!progressOverlay) {
      await loadTerraformProgressOverlay();
      progressOverlay = document.getElementById('terraformProgressOverlay');
    }
    if (!progressOverlay) {
      return;
    }
    resetFlowDetailsPanel('convert');
    progressOverlay.style.display = 'flex';
    wireFlowDetailsToggle('convert');
    wireDebugConvertProgressHandlers(runId);
  }

  if (flow === 'add') {
    const explainerEl = document.getElementById('importExplainer');
    if (explainerEl) {
      explainerEl.textContent = FLOW_INFLIGHT_BODY.add;
      explainerEl.style.display = 'block';
    }
    setImportActionButtons({ showCancel: true });
    setDebugInflightCounts(flow, 0, 0, 0);
    resetFlowDetailsPanel(flow);
    showDebugDetailsSection(flow, true);
    resetDebugLogFeed(flow);
    appendDebugLogFeed(
      flow,
      `Started: ${formatCleanLibraryFeedTimestamp(new Date())}`,
    );
  }

  if (flow === 'clean') {
    showCleanLibraryWorkingBody();
    setCleanLibrarySecondaryStatus(null, false);
    showUpdateIndexButtons('cancel');
    setDebugInflightCounts(flow, 0, 0, 0);
    resetDebugLogFeed(flow);
    showDebugDetailsSection(flow, true);
    appendDebugLogFeed(
      flow,
      `Started: ${formatCleanLibraryFeedTimestamp(new Date())}`,
    );
  }

  if (flow === 'convert') {
    const explainerEl = document.getElementById('terraformProgressExplainer');
    if (explainerEl) {
      explainerEl.textContent = FLOW_INFLIGHT_BODY.convert;
    }
    setDebugInflightCounts(flow, 0, 0, 0);
    resetFlowDetailsPanel(flow);
    showDebugDetailsSection(flow, true);
    resetDebugLogFeed(flow);
    appendDebugLogFeed(
      flow,
      `Started: ${formatCleanLibraryFeedTimestamp(new Date())}`,
    );
  }

  const startedAt = Date.now();
  let logTicker = null;
  const updateStatus = () => {
    if (runId !== debugFlowPreviewState.runId) {
      return;
    }
    const ratio = Math.min(
      1,
      (Date.now() - startedAt) / DEBUG_FLOW_PREVIEW_INFLIGHT_MS,
    );
    const statusLine = buildDebugInflightStatusLine(flow, ratio);
    if (flow === 'add') {
      const statusEl = document.getElementById('importStatusText');
      if (statusEl) {
        setImportSpinnerStatus(statusEl, statusLine);
      }
      const secondaryEl = document.getElementById('importSecondaryStatus');
      if (secondaryEl) {
        secondaryEl.style.display = 'block';
        secondaryEl.textContent = buildDebugInflightSecondaryStatus(ratio);
      }
    } else if (flow === 'clean') {
      const statusEl = document.getElementById('updateIndexStatusText');
      if (statusEl) {
        setImportSpinnerStatus(statusEl, statusLine);
      }
      setCleanLibrarySecondaryStatus(buildDebugInflightSecondaryStatus(ratio));
    } else if (flow === 'convert') {
      const statusEl = document.getElementById('terraformProgressStatus');
      if (statusEl) {
        setImportSpinnerStatus(statusEl, statusLine);
      }
      const secondaryEl = document.getElementById(
        'terraformProgressSecondaryStatus',
      );
      if (secondaryEl) {
        secondaryEl.style.display = 'block';
        secondaryEl.textContent = buildDebugInflightSecondaryStatus(ratio);
      }
    }
  };

  updateStatus();
  const statusTicker = setInterval(updateStatus, 400);
  debugFlowPreviewState.timers.push(statusTicker);
  logTicker = setInterval(() => {
    if (runId !== debugFlowPreviewState.runId) {
      return;
    }
    appendDebugLogFeed(flow, buildPreviewFakeLogLine());
  }, 900);
  debugFlowPreviewState.timers.push(logTicker);

  try {
    await animateDebugInflightCounts(
      runId,
      flow,
      targets,
      DEBUG_FLOW_PREVIEW_INFLIGHT_MS,
    );
  } finally {
    clearInterval(statusTicker);
    if (logTicker) {
      clearInterval(logTicker);
    }
  }
}

async function showDebugAddComplete(runId) {
  if (runId !== debugFlowPreviewState.runId) {
    return;
  }
  debugFlowPreviewState.screen = 'complete';
  const targets = debugFlowPreviewState.inflightTargets || deriveDebugInflightTargets(
    getDebugFlowTotalCount(),
  );
  const explainerEl = document.getElementById('importExplainer');
  if (explainerEl) {
    explainerEl.style.display = 'none';
  }
  const secondaryEl = document.getElementById('importSecondaryStatus');
  if (secondaryEl) {
    secondaryEl.style.display = 'none';
  }
  const statusEl = document.getElementById('importStatusText');
  if (statusEl) {
    statusEl.textContent = `Added ${targets.primary.toLocaleString()} file${
      targets.primary === 1 ? '' : 's'
    } to your library.`;
  }
  setDebugInflightCounts('add', targets.primary, targets.duplicates, targets.skipped);
  showDebugDetailsSection('add', true);
  setImportActionButtons({ showDone: true, showUndo: targets.primary > 0 });
}

async function showDebugCleanComplete(runId) {
  if (runId !== debugFlowPreviewState.runId) {
    return;
  }
  debugFlowPreviewState.screen = 'complete';
  const targets = debugFlowPreviewState.inflightTargets || deriveDebugInflightTargets(
    getDebugFlowTotalCount(),
  );
  setCleanLibraryExplainerVisible(false);
  setCleanLibrarySecondaryStatus(
    `Total time: ${debugFlowPreviewState.estimatedDisplay}`,
    true,
  );
  const inflightEl = document.getElementById('updateIndexInflightStats');
  if (inflightEl) {
    inflightEl.style.display = 'grid';
  }
  setDebugInflightCounts(
    'clean',
    targets.primary,
    targets.duplicates,
    targets.skipped,
  );
  updateUpdateIndexUI(
    'Library check complete. Your library is clean and organized.',
  );
  showDebugDetailsSection('clean', true);
  appendDebugLogFeed(
    'clean',
    `Finished: ${formatCleanLibraryFeedTimestamp(new Date())}`,
  );
  const detailsList = document.getElementById('updateIndexDetailsList');
  if (detailsList) {
    detailsList.style.display = 'none';
  }
  const detailsToggle = document.getElementById('updateIndexDetailsToggle');
  const feed = getFlowActivityLogFeed('clean');
  const feedExpanded =
    feed.isExpanded() || Boolean(detailsToggle?.classList.contains('expanded'));
  feed.setExpanded(feedExpanded, { activityMode: true });
  showUpdateIndexButtons('done');
}

async function showDebugConvertComplete(runId) {
  if (runId !== debugFlowPreviewState.runId) {
    return;
  }
  debugFlowPreviewState.screen = 'complete';
  const targets = debugFlowPreviewState.inflightTargets || deriveDebugInflightTargets(
    getDebugFlowTotalCount(),
  );
  const progressOverlay = document.getElementById('terraformProgressOverlay');
  if (progressOverlay) {
    progressOverlay.style.display = 'none';
  }

  let completeOverlay = document.getElementById('terraformCompleteOverlay');
  if (!completeOverlay) {
    await loadTerraformCompleteOverlay();
    completeOverlay = document.getElementById('terraformCompleteOverlay');
  }
  if (!completeOverlay) {
    return;
  }

  wireFlowDetailsToggle('convertComplete');

  document.getElementById('terraformCompleteProcessed').textContent =
    targets.primary.toLocaleString();
  document.getElementById('terraformCompleteDuplicates').textContent =
    targets.duplicates.toLocaleString();
  document.getElementById('terraformCompleteSkipped').textContent =
    targets.skipped.toLocaleString();

  const statusEl = document.getElementById('terraformCompleteStatusText');
  if (statusEl) {
    statusEl.textContent = `Converted ${targets.primary.toLocaleString()} file${
      targets.primary === 1 ? '' : 's'
    } to your library.`;
  }

  populateTerraformCompleteActivityFeed({
    logPath: DEBUG_FLOW_LOG_PATHS.convert,
    copyFromFlow: 'convert',
  });
  showTerraformCompleteDetailsSection(true);

  const closeBtn = document.getElementById('terraformCompleteCloseBtn');
  const doneBtn = document.getElementById('terraformCompleteDoneBtn');
  const dismissHandler = () => dismissDebugFlowPreview();
  if (closeBtn) closeBtn.onclick = dismissHandler;
  if (doneBtn) doneBtn.onclick = dismissHandler;

  completeOverlay.style.display = 'flex';
}

function wireDebugConvertPreviewHandlers() {
  const dismissHandler = () => dismissDebugFlowPreview();
  const continueHandler = () => {
    if (debugFlowPreviewState.screen === 'preflight') {
      triggerDebugPreflightContinue();
    } else {
      dismissDebugFlowPreview();
    }
  };

  ['terraformPreviewCloseBtn', 'terraformPreviewCancelBtn', 'terraformPreviewGoBackBtn'].forEach(
    (id) => {
      const btn = document.getElementById(id);
      if (btn) btn.onclick = dismissHandler;
    },
  );
  const continueBtn = document.getElementById('terraformPreviewContinueBtn');
  if (continueBtn) continueBtn.onclick = continueHandler;
}

function wireDebugConvertProgressHandlers(runId) {
  const dismissHandler = () => dismissDebugFlowPreview();
  const cancelBtn = document.getElementById('terraformProgressCancelBtn');
  if (cancelBtn) cancelBtn.onclick = dismissHandler;
}

async function waitDebugPreflightOrientDelay(runId, orientStartedAtMs) {
  const elapsed = Date.now() - orientStartedAtMs;
  const remaining = Math.max(
    0,
    CLEAN_LIBRARY_PREFLIGHT_SCOREBOARD_DELAY_MS - elapsed,
  );
  if (remaining <= 0) {
    return;
  }
  await new Promise((resolve, reject) => {
    const timerId = setTimeout(() => {
      if (runId !== debugFlowPreviewState.runId) {
        reject(new Error('cancelled'));
        return;
      }
      resolve();
    }, remaining);
    debugFlowPreviewState.timers.push(timerId);
  });
}

function animateDebugPreflightCounts(
  runId,
  photoTarget,
  videoTarget,
  durationMs,
  setCounts,
  totalTarget = null,
) {
  const resolvedTotalTarget = totalTarget ?? photoTarget + videoTarget;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const tick = () => {
      if (runId !== debugFlowPreviewState.runId) {
        reject(new Error('cancelled'));
        return;
      }
      const elapsed = Date.now() - startedAt;
      const ratio = Math.min(1, elapsed / durationMs);
      const eased = 1 - (1 - ratio) ** 2;
      setCounts(
        Math.round(photoTarget * eased),
        Math.round(videoTarget * eased),
        Math.round(resolvedTotalTarget * eased),
      );
      if (ratio >= 1) {
        setCounts(photoTarget, videoTarget, resolvedTotalTarget);
        resolve();
        return;
      }
      const timerId = setTimeout(tick, 50);
      debugFlowPreviewState.timers.push(timerId);
    };

    tick();
  });
}

function setImportDebugPreflightCounts(photoCount, videoCount, totalCount) {
  const preflightEl = document.getElementById('importPreflightStats');
  const runtimeEl = document.getElementById('importStats');
  const photoEl = document.getElementById('importPhotoCount');
  const videoEl = document.getElementById('importVideoCount');
  const totalEl = document.getElementById('importTotalCount');
  if (photoEl) photoEl.textContent = Number(photoCount).toLocaleString();
  if (videoEl) videoEl.textContent = Number(videoCount).toLocaleString();
  if (totalEl) totalEl.textContent = Number(totalCount).toLocaleString();
  if (preflightEl) preflightEl.style.display = 'grid';
  if (runtimeEl) runtimeEl.style.display = 'none';
}

function setTerraformDebugPreflightCounts(photoCount, videoCount, totalCount) {
  const pairs = [
    ['terraformPreviewPreflightPhotos', photoCount],
    ['terraformPreviewPreflightVideos', videoCount],
    ['terraformPreviewPreflightTotal', totalCount],
    ['terraformPreviewPhotos', photoCount],
    ['terraformPreviewVideos', videoCount],
    ['terraformPreviewTotal', totalCount],
  ];
  pairs.forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = Number(value).toLocaleString();
    }
  });
}

function setTerraformPreviewPhase(phase) {
  const scanningSection = document.getElementById('terraformPreviewScanningSection');
  const confirmSection = document.getElementById('terraformPreviewConfirmSection');
  const isScanning = phase === 'scanning';

  if (scanningSection) {
    scanningSection.style.display = isScanning ? 'block' : 'none';
  }
  if (confirmSection) {
    confirmSection.style.display = isScanning ? 'none' : 'block';
  }
}

function setTerraformPreviewActionButtons({ continueDisabled = false } = {}) {
  const actionsSection = document.getElementById('terraformPreviewActions');
  const cancelBtn = document.getElementById('terraformPreviewCancelBtn');
  const goBackBtn = document.getElementById('terraformPreviewGoBackBtn');
  const continueBtn = document.getElementById('terraformPreviewContinueBtn');

  if (actionsSection) {
    actionsSection.style.display = 'flex';
  }
  if (cancelBtn) {
    cancelBtn.style.display = 'inline-block';
    cancelBtn.disabled = false;
  }
  if (goBackBtn) {
    goBackBtn.style.display = 'inline-block';
    goBackBtn.disabled = false;
  }
  if (continueBtn) {
    continueBtn.style.display = 'inline-block';
    continueBtn.disabled = continueDisabled;
  }
}

function initDebugFlowTargets() {
  debugFlowPreviewState.photoTarget = previewRandomMediaCount();
  debugFlowPreviewState.videoTarget = previewRandomMediaCount();
  const estimate = estimatePreviewCleanDuration(
    debugFlowPreviewState.photoTarget,
    debugFlowPreviewState.videoTarget,
  );
  debugFlowPreviewState.estimatedDisplay = estimate.display;
  debugFlowPreviewState.estimatedSeconds = estimate.seconds;
}

async function prepareDebugFlowOverlay(flow) {
  if (flow === 'add') {
    await loadImportOverlay();
    return document.getElementById('importOverlay');
  }
  if (flow === 'clean') {
    await loadUpdateIndexOverlay();
    return document.getElementById('updateIndexOverlay');
  }
  if (flow === 'convert') {
    let overlay = document.getElementById('terraformPreviewOverlay');
    if (!overlay) {
      await loadTerraformPreviewOverlay();
      overlay = document.getElementById('terraformPreviewOverlay');
    }
    return overlay;
  }
  return null;
}

function setupDebugFlowInitialUi(flow, overlay) {
  overlay.style.display = 'flex';
  resetFlowDetailsPanel(flow);

  if (flow === 'add') {
    setImportOverlayTitle();
    const explainerEl = document.getElementById('importExplainer');
    if (explainerEl) {
      explainerEl.style.display = 'none';
    }
    showDebugDetailsSection('add', false);
    setImportDebugPreflightCounts(0, 0, 0);
    setImportActionButtons({
      showCancel: true,
      showContinue: true,
      continueDisabled: true,
    });
    return;
  }

  if (flow === 'clean') {
    resetUpdateIndexOverlayTitle();
    resetCleanLibraryLogFeed();
    showCleanLibraryPreflightExplainer();
    setCleanLibrarySecondaryStatus(null, false);
    showDebugDetailsSection('clean', false);
    showUpdateIndexPreflightStats(null);
    hideUpdateIndexStats();
    const inflightEl = document.getElementById('updateIndexInflightStats');
    if (inflightEl) {
      inflightEl.style.display = 'none';
    }
    showUpdateIndexButtons('cancel', 'proceed-disabled');
    showPreflightScoreboardZeros();
    return;
  }

  const pathEl = document.getElementById('terraformPreviewPath');
  if (pathEl) {
    pathEl.textContent = '/Users/example/Photos/library';
  }
  setTerraformPreviewPhase('scanning');
  setTerraformDebugPreflightCounts(0, 0, 0);
  setTerraformPreviewActionButtons({ continueDisabled: true });
  wireDebugConvertPreviewHandlers();
}

async function runDebugPreflightScan(flow, runId) {
  let statusEl = null;
  if (flow === 'add') {
    statusEl = document.getElementById('importStatusText');
    if (statusEl) {
      setImportSpinnerStatus(statusEl, 'Scanning library…');
    }
  } else if (flow === 'clean') {
    statusEl = document.getElementById('updateIndexStatusText');
    if (statusEl) {
      setImportSpinnerStatus(statusEl, 'Scanning library…');
    }
  } else {
    statusEl = document.getElementById('terraformPreviewScanStatus');
    if (statusEl) {
      setImportSpinnerStatus(statusEl, 'Scanning library…');
    }
  }

  const orientStartedAt = Date.now();
  await waitDebugPreflightOrientDelay(runId, orientStartedAt);

  const setCounts =
    flow === 'add'
      ? setImportDebugPreflightCounts
      : flow === 'clean'
        ? (photos, videos, total) => {
            setPreviewPreflightCounts(photos, videos, total);
          }
        : setTerraformDebugPreflightCounts;

  await animateDebugPreflightCounts(
    runId,
    debugFlowPreviewState.photoTarget,
    debugFlowPreviewState.videoTarget,
    DEBUG_FLOW_PREVIEW_SCAN_MS,
    setCounts,
  );

  if (flow === 'convert') {
    setTerraformPreviewPhase('confirm');
    setTerraformDebugPreflightCounts(
      debugFlowPreviewState.photoTarget,
      debugFlowPreviewState.videoTarget,
      getDebugFlowTotalCount(),
    );
    setTerraformPreviewActionButtons({ continueDisabled: false });
    return;
  }

  if (flow === 'clean') {
    showCleanLibraryPreflightExplainer();
    setPreviewPreflightCounts(
      debugFlowPreviewState.photoTarget,
      debugFlowPreviewState.videoTarget,
    );
    if (statusEl) {
      statusEl.textContent = `Time required: ${debugFlowPreviewState.estimatedDisplay}`;
    }
    showUpdateIndexButtons('cancel', 'proceed');
    return;
  }

  if (statusEl) {
    statusEl.textContent = `Time required: ${debugFlowPreviewState.estimatedDisplay}`;
  }
  setImportActionButtons({
    showCancel: true,
    showContinue: true,
    continueDisabled: false,
  });
}

async function runDebugFlowPreview(flow) {
  stopDebugFlowPreview();

  const overlay = await prepareDebugFlowOverlay(flow);
  if (!overlay) {
    return;
  }

  debugFlowPreviewState.active = true;
  debugFlowPreviewState.flow = flow;
  if (flow === 'clean') {
    cleanLibraryPreviewState.active = true;
    if (!updateIndexState) {
      updateIndexState = {};
    }
  }

  const runId = (debugFlowPreviewState.runId += 1);
  initDebugFlowTargets();
  setupDebugFlowInitialUi(flow, overlay);

  try {
    debugFlowPreviewState.screen = 'preflight';
    await runDebugPreflightScan(flow, runId);
    const continued = await waitForDebugPreflightContinue(runId);
    if (!continued) {
      return;
    }

    await simulateDebugInflightPhase(flow, runId);

    if (flow === 'add') {
      await showDebugAddComplete(runId);
    } else if (flow === 'clean') {
      await showDebugCleanComplete(runId);
    } else {
      await showDebugConvertComplete(runId);
    }

    await waitForDebugFlowDismiss(runId);
  } catch (error) {
    if (error?.message !== 'cancelled') {
      console.error(`❌ ${flow} flow preview failed:`, error);
    }
  } finally {
    stopDebugFlowPreview();
  }
}

async function openDebugFlowPicker() {
  const choice = await showDialog('Debug flows', 'Pick a flow to preview.', [
    { text: 'Cancel', value: 'cancel', primary: false },
    { text: 'Add photos', value: 'add', primary: false },
    { text: 'Clean library', value: 'clean', primary: false },
    { text: 'Convert to library', value: 'convert', primary: false },
  ]);

  if (choice === 'add' || choice === 'clean' || choice === 'convert') {
    await runDebugFlowPreview(choice);
  }
}

const CLEAN_LIBRARY_PREVIEW_SCAN_MS = 4000;
const CLEAN_LIBRARY_PREVIEW_WORKING_MS = 20000;
const CLEAN_LIBRARY_PREVIEW_INTERRUPTED_CHANCE = 0.2;
const CLEAN_LIBRARY_PREFLIGHT_SCOREBOARD_DELAY_MS = 500;
const CLEAN_LIBRARY_PREFLIGHT_COUNT_ANIMATION_MS = 1500;

const PREVIEW_MEDIA_COUNT_TIERS = [
  { id: 'xs', min: 0, max: 9 },
  { id: 's', min: 10, max: 99 },
  { id: 'm', min: 100, max: 999 },
  { id: 'l', min: 1000, max: 9999 },
  { id: 'xl', min: 10000, max: 100000 },
];

const CLEAN_LIBRARY_OVERLAY_TITLE = 'Clean library';
const CLEAN_LIBRARY_CONTINUE_TITLE = 'Continue cleanup';
const CLEAN_LIBRARY_PAUSE_TOAST =
  'Cleanup paused. You can continue it later.';
const CLEAN_LIBRARY_PREFLIGHT_EXPLAINER =
  'This will organize your library, remove duplicates and corrupted media, and fix any database issues.';
const CLEAN_LIBRARY_WORKING_BODY =
  'Checking media files, repairing issues, and updating library database.';

const CLEAN_LIBRARY_PREVIEW_WORKING_STEPS = [
  'Scanning files',
  'Removing duplicates',
  'Organizing media',
  'Cleaning folders',
  'Rebuilding database',
  'Final verification',
];

const CLEAN_LIBRARY_PHASE_STEP_INDEX = {
  setup: 1,
  scan: 1,
  dedupe: 2,
  canonicalize: 3,
  folders: 4,
  rebuild_db: 5,
  audit: 6,
};

const CLEAN_LIBRARY_WORKING_STEP_MIN_MS = 50;

// Phases where processed/total is a natural file count for the step line.
const CLEAN_LIBRARY_STEP_PROGRESS_PHASES = new Set([
  'scan',
  'canonicalize',
  'rebuild_db',
  'audit',
]);

const CLEAN_LIBRARY_FEED_PROGRESS_VERBS = {
  scan: 'Scanned',
  canonicalize: 'Organized',
  rebuild_db: 'Rebuilt',
  audit: 'Verifying',
};

const CLEAN_LIBRARY_LOG_SKIP_ACTIONS = new Set([
  'scan_unchanged_skip',
  'operation_started',
  'operation_complete',
  'operation_cancelled',
  'operation_failed',
  'orientation_kept',
  'folder_remove_skipped',
  'date_metadata_canonicalized',
  'metadata_artifacts_quarantined',
  'db_migrated_to_hidden_folder',
]);

let cleanLibraryWorkingStepState = null;

let cleanLibraryActivityFeedState = {
  lastMilestoneByPhase: {},
  lastEmittedAtMsByPhase: {},
};

const cleanLibraryPreviewState = {
  active: false,
  runId: 0,
  timers: [],
  photoTarget: 0,
  videoTarget: 0,
  estimatedDisplay: '',
  estimatedSeconds: 0,
  phase: null,
  onProceed: null,
  onStartOver: null,
  onInterruptedChoice: null,
  workingProgress: null,
};

let cleanLibraryRunUiPaused = false;

function pauseCleanLibraryWorkingProgress() {
  const progress = cleanLibraryPreviewState.workingProgress;
  if (!progress || progress.pauseStartedAt != null) {
    return;
  }
  progress.pauseStartedAt = Date.now();
}

function resumeCleanLibraryWorkingProgress() {
  const progress = cleanLibraryPreviewState.workingProgress;
  if (!progress || progress.pauseStartedAt == null) {
    return;
  }
  progress.pauseAccumMs += Date.now() - progress.pauseStartedAt;
  progress.pauseStartedAt = null;
}

function getPreviewWorkingElapsedMs() {
  const progress = cleanLibraryPreviewState.workingProgress;
  if (!progress) {
    return 0;
  }
  let elapsed = Date.now() - progress.startedAt - progress.pauseAccumMs;
  if (progress.pauseStartedAt) {
    elapsed -= Date.now() - progress.pauseStartedAt;
  }
  return Math.max(0, elapsed);
}

function isCleanLibraryWorkingProgressPaused() {
  const progress = cleanLibraryPreviewState.workingProgress;
  return Boolean(progress?.pauseStartedAt);
}

function pauseCleanLibraryRunUiUpdates() {
  cleanLibraryRunUiPaused = true;
}

function resumeCleanLibraryRunUiUpdates() {
  cleanLibraryRunUiPaused = false;
}

function stopCleanLibraryPreview() {
  const workingProgress = cleanLibraryPreviewState.workingProgress;
  cleanLibraryPreviewState.runId += 1;
  cleanLibraryPreviewState.active = false;
  cleanLibraryPreviewState.workingProgress = null;
  cleanLibraryRunUiPaused = false;
  cleanLibraryPreviewState.onProceed = null;
  cleanLibraryPreviewState.onStartOver = null;
  cleanLibraryPreviewState.onInterruptedChoice = null;
  cleanLibraryPreviewState.timers.forEach((timerId) => {
    clearTimeout(timerId);
    clearInterval(timerId);
  });
  cleanLibraryPreviewState.timers = [];
  if (workingProgress?.rejectCompletion) {
    workingProgress.rejectCompletion(new Error('cancelled'));
  }
}

function previewRandomMediaCount() {
  const tier =
    PREVIEW_MEDIA_COUNT_TIERS[
      Math.floor(Math.random() * PREVIEW_MEDIA_COUNT_TIERS.length)
    ];
  return tier.min + Math.floor(Math.random() * (tier.max - tier.min + 1));
}

function estimatePreviewCleanDuration(photoCount, videoCount) {
  const photoSec = Math.max(0, photoCount) * 1.7;
  const videoSec = Math.max(0, videoCount) * 1.2;
  const totalSeconds = (photoSec + videoSec) * 1.05;
  return {
    seconds: totalSeconds,
    display: formatAboutDurationFromSeconds(totalSeconds),
  };
}

function setCleanLibraryExplainerVisible(visible) {
  const explainerEl = document.getElementById('updateIndexExplainer');
  if (explainerEl) {
    explainerEl.style.display = visible ? 'block' : 'none';
  }
}

function setCleanLibraryExplainerText(text) {
  const explainerEl = document.getElementById('updateIndexExplainer');
  if (explainerEl) {
    explainerEl.textContent = text;
  }
}

function showCleanLibraryPreflightExplainer() {
  setCleanLibraryExplainerText(CLEAN_LIBRARY_PREFLIGHT_EXPLAINER);
  setCleanLibraryExplainerVisible(true);
}

function showCleanLibraryWorkingBody() {
  setCleanLibraryExplainerText(CLEAN_LIBRARY_WORKING_BODY);
  setCleanLibraryExplainerVisible(true);
}

function setUpdateIndexOverlayTitle(title) {
  const overlay = document.getElementById('updateIndexOverlay');
  const titleEl = overlay?.querySelector('.import-title');
  if (titleEl) {
    titleEl.textContent = title;
  }
}

function resetUpdateIndexOverlayTitle() {
  setUpdateIndexOverlayTitle(CLEAN_LIBRARY_OVERLAY_TITLE);
}

function showContinueLibraryCleanupTitle() {
  setUpdateIndexOverlayTitle(CLEAN_LIBRARY_CONTINUE_TITLE);
}

function setCleanLibraryOverlayInert(inert) {
  const overlay = document.getElementById('updateIndexOverlay');
  if (!overlay || overlay.style.display !== 'flex') {
    return;
  }
  overlay.classList.toggle('import-overlay--inert', inert);
  if (inert) {
    overlay.setAttribute('aria-hidden', 'true');
  } else {
    overlay.removeAttribute('aria-hidden');
  }
}

function setCleanLibrarySecondaryStatus(text, visible = true) {
  const secondaryEl = document.getElementById('updateIndexSecondaryStatus');
  if (!secondaryEl) return;
  if (!visible || !text) {
    secondaryEl.style.display = 'none';
    secondaryEl.textContent = '';
    return;
  }
  secondaryEl.style.display = 'block';
  secondaryEl.textContent = text;
}

function resetCleanLibraryActivityFeedState() {
  cleanLibraryActivityFeedState = {
    lastMilestoneByPhase: {},
    lastEmittedAtMsByPhase: {},
  };
}

const CLEAN_LIBRARY_ACTIVITY_FEED_TIME_FALLBACK_MS = 5000;
const CLEAN_LIBRARY_ACTIVITY_FEED_TIME_FALLBACK_INCREMENT = 5;

function cleanLibraryProgressMilestoneInterval(total) {
  const cap = Math.max(1, Number(total) || 1);
  if (cap <= 25) return 1;
  if (cap <= 100) return 5;
  if (cap <= 500) return 10;
  if (cap <= 2500) return 25;
  if (cap < 50000) return 50;
  return 100;
}

function formatCleanLibraryLogEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const action = entry.action;
  if (!action || CLEAN_LIBRARY_LOG_SKIP_ACTIONS.has(action)) {
    return null;
  }

  switch (action) {
    case 'media_moved':
      if (entry.source && entry.destination) {
        return `Moved ${entry.source} → ${entry.destination}`;
      }
      return null;
    case 'duplicate_trashed':
      if (entry.loser) {
        return `Removed duplicate: ${entry.loser}`;
      }
      return null;
    case 'moved_to_trash':
      if (entry.source) {
        return `Moved to trash: ${entry.source}`;
      }
      return null;
    case 'orientation_baked':
      if (entry.file) {
        return `Baked rotation: ${entry.file}`;
      }
      return null;
    case 'rating_stripped':
      if (entry.file) {
        return `Stripped rating flag: ${entry.file}`;
      }
      return null;
    case 'folder_removed':
      if (entry.path) {
        return `Removed empty folder: ${entry.path}`;
      }
      return null;
    case 'photos_table_rebuilt': {
      const rows = Number(entry.row_count);
      if (Number.isFinite(rows) && rows > 0) {
        return `Database rebuilt (${rows.toLocaleString()} rows)`;
      }
      return 'Database rebuilt';
    }
    case 'scan_complete': {
      const count = Number(entry.media_count);
      if (Number.isFinite(count) && count > 0) {
        return `Scan complete (${count.toLocaleString()} media files)`;
      }
      return 'Scan complete';
    }
    case 'final_audit_failed': {
      const count = Number(entry.issue_count);
      if (Number.isFinite(count)) {
        return `Final verification found ${count.toLocaleString()} issue(s)`;
      }
      return 'Final verification found issues';
    }
    default:
      return null;
  }
}

function formatCleanLibraryManifestLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    return formatCleanLibraryLogEntry(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function setDetailsToggleCollapsed(
  toggleId,
  { label = 'Show details', activityMode = false } = {},
) {
  const detailsToggle = document.getElementById(toggleId);
  if (!detailsToggle) {
    return;
  }
  detailsToggle.classList.remove('expanded');
  const icon = detailsToggle.querySelector('.material-symbols-outlined');
  if (icon) {
    icon.textContent = 'expand_more';
  }
  const labelSpan = detailsToggle.querySelector('span:last-child');
  if (labelSpan) {
    labelSpan.textContent = activityMode ? 'Show activity' : label;
  }
}

function resetImportDetailsExpanded() {
  resetFlowDetailsPanel('add');
}

function resetTerraformProgressDetailsExpanded() {
  resetFlowDetailsPanel('convert');
}

function updateCleanLibraryDetailsToggleLabel(expanded, { activityMode = false } = {}) {
  updateFlowDetailsToggleLabel('updateIndexDetailsToggle', expanded, {
    activityMode,
  });
}

function formatCleanLibraryFeedTimestamp(date) {
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function isCleanLibraryActivityFeedExpanded() {
  return getFlowActivityLogFeed('clean').isExpanded();
}

function shouldUseCleanLibraryActivityFeedToggle() {
  return shouldUseFlowActivityFeed('clean');
}

function setCleanLibraryActivityFeedVisible(visible, { activityMode = false } = {}) {
  getFlowActivityLogFeed('clean').setExpanded(visible, { activityMode });
}

function renderCleanLibraryActivityFeed() {
  getFlowActivityLogFeed('clean').render();
}

function canWriteCleanLibraryActivityFeed({
  previewOnly = false,
  allowInactive = false,
} = {}) {
  if (previewOnly && cleanLibraryPreviewState.active) {
    return true;
  }
  return Boolean(
    updateIndexState &&
      (updateIndexState.workingPhaseActive || allowInactive),
  );
}

function prependCleanLibraryActivityLine(
  line,
  { previewOnly = false, allowInactive = false } = {},
) {
  if (!canWriteCleanLibraryActivityFeed({ previewOnly, allowInactive })) {
    return;
  }
  getFlowActivityLogFeed('clean').prepend(line);
}

function appendCleanLibraryActivityLine(
  line,
  { previewOnly = false, allowInactive = false } = {},
) {
  if (!canWriteCleanLibraryActivityFeed({ previewOnly, allowInactive })) {
    return;
  }
  getFlowActivityLogFeed('clean').append(line);
}

function maybeAppendCleanLibraryProgressMilestone(phase, processed, total) {
  if (!CLEAN_LIBRARY_FEED_PROGRESS_VERBS[phase]) {
    return;
  }
  const done = Number(processed);
  const cap = Number(total);
  if (!Number.isFinite(done) || !Number.isFinite(cap) || cap < 1) {
    return;
  }

  const interval = cleanLibraryProgressMilestoneInterval(cap);
  const lastMarker = cleanLibraryActivityFeedState.lastMilestoneByPhase[phase] ?? 0;
  const lastEmittedAtMs =
    cleanLibraryActivityFeedState.lastEmittedAtMsByPhase[phase] ?? null;
  const now = Date.now();
  let marker = null;

  if (done >= cap) {
    marker = cap;
  } else {
    const bucket = Math.floor(done / interval) * interval;
    if (bucket > 0 && bucket > lastMarker) {
      marker = bucket;
    } else if (lastEmittedAtMs === null) {
      cleanLibraryActivityFeedState.lastEmittedAtMsByPhase[phase] = now;
    } else if (
      now - lastEmittedAtMs >= CLEAN_LIBRARY_ACTIVITY_FEED_TIME_FALLBACK_MS
    ) {
      const timeBucket =
        Math.floor(done / CLEAN_LIBRARY_ACTIVITY_FEED_TIME_FALLBACK_INCREMENT) *
        CLEAN_LIBRARY_ACTIVITY_FEED_TIME_FALLBACK_INCREMENT;
      if (timeBucket > 0 && timeBucket > lastMarker) {
        marker = timeBucket;
      }
    }
  }

  if (marker === null || marker <= lastMarker) {
    return;
  }

  cleanLibraryActivityFeedState.lastMilestoneByPhase[phase] = marker;
  cleanLibraryActivityFeedState.lastEmittedAtMsByPhase[phase] = now;
  const verb = CLEAN_LIBRARY_FEED_PROGRESS_VERBS[phase];
  appendCleanLibraryActivityLine(
    `${verb} ${Math.min(marker, cap).toLocaleString()} of ${cap.toLocaleString()}`,
  );
}

function appendCleanLibraryEngineLogEntry(entry, { previewOnly = false } = {}) {
  const line = formatCleanLibraryLogEntry(entry);
  if (line) {
    appendCleanLibraryActivityLine(line, { previewOnly });
  }
}

function resetCleanLibraryLogFeed() {
  resetCleanLibraryActivityFeedState();
  resetFlowDetailsPanel('clean');
}

function appendCleanLibraryLogLine(line, { previewOnly = false } = {}) {
  if (previewOnly && !cleanLibraryPreviewState.active) {
    return;
  }
  const trimmed = String(line || '').trim();
  if (!trimmed) {
    return;
  }
  try {
    appendCleanLibraryEngineLogEntry(JSON.parse(trimmed), { previewOnly });
  } catch {
    appendCleanLibraryActivityLine(trimmed, { previewOnly });
  }
}

function showCleanLibraryDetailsSection(visible) {
  const detailsSection = document.getElementById('updateIndexDetailsSection');
  if (detailsSection) {
    detailsSection.style.display = visible ? 'block' : 'none';
  }
}

function getCleanLibraryPreflightTotal(scanResult, photos, videos) {
  return (
    scanResult?.summary?.media_count ??
    scanResult?.inventory?.media_count ??
    scanResult?.supported_media_files ??
    photos + videos
  );
}

function setPreviewPreflightCounts(photoCount, videoCount, totalCount = null) {
  const total = totalCount ?? photoCount + videoCount;
  showUpdateIndexPreflightStats({
    summary: {
      photo_count: photoCount,
      video_count: videoCount,
      media_count: total,
    },
  });
}

async function waitPreflightScoreboardOrientDelay(
  orientStartedAtMs,
  { runId = null, previewOnly = false } = {},
) {
  const elapsed = Date.now() - orientStartedAtMs;
  const remaining = Math.max(0, CLEAN_LIBRARY_PREFLIGHT_SCOREBOARD_DELAY_MS - elapsed);
  if (remaining <= 0) {
    return;
  }
  await new Promise((resolve, reject) => {
    const timerId = setTimeout(() => {
      if (previewOnly && runId !== cleanLibraryPreviewState.runId) {
        reject(new Error('cancelled'));
        return;
      }
      resolve();
    }, remaining);
    if (previewOnly) {
      cleanLibraryPreviewState.timers.push(timerId);
    }
  });
}

function animatePreflightScoreboardCounts(
  photoTarget,
  videoTarget,
  durationMs,
  { runId = null, previewOnly = false, totalTarget = null } = {},
) {
  const resolvedTotalTarget = totalTarget ?? photoTarget + videoTarget;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const tick = () => {
      if (previewOnly && runId !== cleanLibraryPreviewState.runId) {
        reject(new Error('cancelled'));
        return;
      }
      const elapsed = Date.now() - startedAt;
      const ratio = Math.min(1, elapsed / durationMs);
      const eased = 1 - (1 - ratio) ** 2;
      setPreviewPreflightCounts(
        Math.round(photoTarget * eased),
        Math.round(videoTarget * eased),
        Math.round(resolvedTotalTarget * eased),
      );
      if (ratio >= 1) {
        setPreviewPreflightCounts(photoTarget, videoTarget, resolvedTotalTarget);
        resolve();
        return;
      }
      const timerId = setTimeout(tick, 50);
      if (previewOnly) {
        cleanLibraryPreviewState.timers.push(timerId);
      }
    };

    tick();
  });
}

function animatePreviewPreflightCounts(runId, photoTarget, videoTarget, durationMs) {
  return animatePreflightScoreboardCounts(photoTarget, videoTarget, durationMs, {
    runId,
    previewOnly: true,
  });
}

function waitForPreviewProceed(runId) {
  return new Promise((resolve, reject) => {
    cleanLibraryPreviewState.onProceed = () => {
      if (runId !== cleanLibraryPreviewState.runId) {
        reject(new Error('cancelled'));
        return;
      }
      cleanLibraryPreviewState.onProceed = null;
      resolve();
    };
  });
}

function waitForPreviewInterruptedChoice(runId) {
  return new Promise((resolve, reject) => {
    cleanLibraryPreviewState.onInterruptedChoice = (choice) => {
      if (runId !== cleanLibraryPreviewState.runId) {
        reject(new Error('cancelled'));
        return;
      }
      cleanLibraryPreviewState.onInterruptedChoice = null;
      resolve(choice);
    };
  });
}

function buildPreviewFakeLogLine() {
  const hash = Math.random().toString(16).slice(2, 10);
  const year = 2020 + Math.floor(Math.random() * 6);
  const templates = [
    `Scanned ${(Math.floor(Math.random() * 20) + 1) * 500} of 13,899`,
    `Moved batch/photo_${hash.slice(0, 4)}.jpg → ${year}/${year}-03-12/img_${hash}.jpg`,
    `Removed duplicate: imports/dup_${hash.slice(0, 4)}.jpg`,
    `Baked rotation: ${year}/${year}-03-12/img_${hash}.jpg`,
    `Removed empty folder: batch/old_folder`,
    `Database rebuilt (${(Math.floor(Math.random() * 9000) + 100).toLocaleString()} rows)`,
    `Verifying ${(Math.floor(Math.random() * 20) + 1) * 500} of 13,899`,
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

async function showPreviewInterruptedScreen(runId) {
  cleanLibraryPreviewState.phase = 'interrupted';
  showContinueLibraryCleanupTitle();
  setCleanLibraryExplainerVisible(false);
  setCleanLibrarySecondaryStatus(null, false);
  showUpdateIndexPreflightStats(null);
  hideUpdateIndexStats();
  showCleanLibraryDetailsSection(false);
  resetCleanLibraryLogFeed();
  updateUpdateIndexUI(
    'It looks like a previous library cleanup was not completed. You can continue it, start a new cleanup, or cancel.',
    false,
  );
  showUpdateIndexButtons('cancel', 'start-over', 'proceed');
  return waitForPreviewInterruptedChoice(runId);
}

async function showPreviewScanningPhase(runId) {
  cleanLibraryPreviewState.phase = 'scanning';
  showCleanLibraryPreflightExplainer();
  setCleanLibrarySecondaryStatus(null, false);
  showCleanLibraryDetailsSection(false);
  resetCleanLibraryLogFeed();
  updateUpdateIndexUI('Scanning library', true);
  showUpdateIndexButtons('cancel', 'proceed-disabled');
  showPreflightScoreboardZeros();

  const orientStartedAt = Date.now();
  await waitPreflightScoreboardOrientDelay(orientStartedAt, {
    runId,
    previewOnly: true,
  });
  await animatePreviewPreflightCounts(
    runId,
    cleanLibraryPreviewState.photoTarget,
    cleanLibraryPreviewState.videoTarget,
    CLEAN_LIBRARY_PREVIEW_SCAN_MS,
  );
}

async function showPreviewEtaScreen(runId) {
  cleanLibraryPreviewState.phase = 'eta';
  const { photoTarget, videoTarget, estimatedDisplay } = cleanLibraryPreviewState;
  showCleanLibraryPreflightExplainer();
  setCleanLibrarySecondaryStatus(null, false);
  setPreviewPreflightCounts(photoTarget, videoTarget);
  updateUpdateIndexUI(`Time required: ${estimatedDisplay}`, false);
  showUpdateIndexButtons('cancel', 'proceed');
  await waitForPreviewProceed(runId);
}

async function showPreviewWorkingPhase(runId) {
  cleanLibraryPreviewState.phase = 'working';
  resetUpdateIndexOverlayTitle();
  resetCleanLibraryLogFeed();
  showCleanLibraryDetailsSection(true);
  showUpdateIndexPreflightStats(null);
  hideUpdateIndexStats();
  showCleanLibraryWorkingBody();
  showUpdateIndexButtons('cancel');

  const workingProgress = {
    startedAt: Date.now(),
    pauseAccumMs: 0,
    pauseStartedAt: null,
    resolveCompletion: null,
    rejectCompletion: null,
  };
  cleanLibraryPreviewState.workingProgress = workingProgress;
  cleanLibraryPreviewState.runStartedAtMs = workingProgress.startedAt;
  prependCleanLibraryActivityLine(
    `Started: ${formatCleanLibraryFeedTimestamp(new Date(workingProgress.startedAt))}`,
    { previewOnly: true },
  );

  let logTicker = null;
  let frameTicker = null;
  let workingUiActive = true;

  const stopWorkingTickers = () => {
    workingUiActive = false;
    if (logTicker !== null) {
      clearInterval(logTicker);
      logTicker = null;
    }
    if (frameTicker !== null) {
      clearInterval(frameTicker);
      frameTicker = null;
    }
  };

  const finishWorkingPhase = () => {
    if (!workingUiActive) {
      return;
    }
    stopWorkingTickers();
    if (workingProgress.resolveCompletion) {
      workingProgress.resolveCompletion();
    }
  };

  const updateWorkingUi = () => {
    if (!workingUiActive || runId !== cleanLibraryPreviewState.runId) return;
    if (isCleanLibraryWorkingProgressPaused()) return;

    const elapsed = getPreviewWorkingElapsedMs();
    if (elapsed >= CLEAN_LIBRARY_PREVIEW_WORKING_MS) {
      finishWorkingPhase();
      return;
    }

    const stepNumber = Math.min(
      CLEAN_LIBRARY_PREVIEW_WORKING_STEPS.length,
      Math.max(
        1,
        Math.floor(
          (elapsed / CLEAN_LIBRARY_PREVIEW_WORKING_MS) *
            CLEAN_LIBRARY_PREVIEW_WORKING_STEPS.length,
        ) + 1,
      ),
    );
    const stepLabel = CLEAN_LIBRARY_PREVIEW_WORKING_STEPS[stepNumber - 1];
    updateUpdateIndexUI(`Step ${stepNumber} of 6: ${stepLabel}`, true);
    setCleanLibrarySecondaryStatus(
      `Total time remaining: ${formatAboutDurationFromSeconds(
        Math.max(
          5,
          cleanLibraryPreviewState.estimatedSeconds *
            (1 - elapsed / CLEAN_LIBRARY_PREVIEW_WORKING_MS),
        ),
      )}`,
    );
  };

  updateWorkingUi();
  logTicker = setInterval(() => {
    if (isCleanLibraryWorkingProgressPaused()) return;
    appendCleanLibraryActivityLine(buildPreviewFakeLogLine(), { previewOnly: true });
  }, 450);
  cleanLibraryPreviewState.timers.push(logTicker);

  frameTicker = setInterval(updateWorkingUi, 200);
  cleanLibraryPreviewState.timers.push(frameTicker);

  try {
    await new Promise((resolve, reject) => {
      workingProgress.resolveCompletion = resolve;
      workingProgress.rejectCompletion = reject;
      if (getPreviewWorkingElapsedMs() >= CLEAN_LIBRARY_PREVIEW_WORKING_MS) {
        finishWorkingPhase();
      }
    });
  } catch (error) {
    if (error?.message !== 'cancelled') {
      throw error;
    }
  } finally {
    stopWorkingTickers();
    if (cleanLibraryPreviewState.workingProgress === workingProgress) {
      cleanLibraryPreviewState.workingProgress = null;
    }
  }
}

function showPreviewFinishedScreen() {
  const feedExpanded = isCleanLibraryActivityFeedExpanded();
  const finishedAt = new Date();
  const startedAtMs =
    cleanLibraryPreviewState.runStartedAtMs ||
    cleanLibraryPreviewState.workingProgress?.startedAt;
  const elapsedSec = startedAtMs
    ? (finishedAt.getTime() - startedAtMs) / 1000
    : Number(cleanLibraryPreviewState.estimatedSeconds) || 0;
  const totalDisplay = formatPreciseDurationFromSeconds(elapsedSec);

  appendCleanLibraryFinishFeedLines(finishedAt, elapsedSec, { previewOnly: true });

  cleanLibraryPreviewState.phase = 'finished';
  setCleanLibraryExplainerVisible(false);
  setCleanLibrarySecondaryStatus(`Total time: ${totalDisplay}`, true);
  updateUpdateIndexUI(
    'Library check complete. Your library is clean and organized.',
  );
  showCleanLibraryDetailsSection(true);
  showUpdateIndexButtons('done');

  const detailsList = document.getElementById('updateIndexDetailsList');
  if (detailsList) {
    detailsList.style.display = 'none';
  }
  setCleanLibraryActivityFeedVisible(feedExpanded, { activityMode: true });
}

async function startCleanLibraryPreviewFlow() {
  await runDebugFlowPreview('clean');
}

function handleUpdateIndexProceedClick() {
  if (debugFlowPreviewState.active && debugFlowPreviewState.flow === 'clean') {
    if (debugFlowPreviewState.screen === 'preflight') {
      triggerDebugPreflightContinue();
    } else {
      dismissDebugFlowPreview();
    }
    return;
  }

  if (cleanLibraryPreviewState.active) {
    if (cleanLibraryPreviewState.onProceed) {
      cleanLibraryPreviewState.onProceed();
    } else if (cleanLibraryPreviewState.onInterruptedChoice) {
      cleanLibraryPreviewState.onInterruptedChoice('continue');
    }
    return;
  }
  if (updateIndexState.onInterruptedChoice) {
    updateIndexState.onInterruptedChoice('continue');
    return;
  }
  void executeUpdateIndex();
}

function handleUpdateIndexStartOverClick() {
  if (cleanLibraryPreviewState.active) {
    if (cleanLibraryPreviewState.onInterruptedChoice) {
      cleanLibraryPreviewState.onInterruptedChoice('start-over');
      return;
    }
    void restartCleanLibraryPreviewFromStartOver();
    return;
  }
  if (updateIndexState.onInterruptedChoice) {
    updateIndexState.onInterruptedChoice('start-over');
    return;
  }
  if (
    updateIndexState.overlayPhase === 'eta' &&
    updateIndexState.preflight?.status === 'RESUME'
  ) {
    void restartCleanLibraryPreflightFromStartOver();
  }
}

async function restartCleanLibraryPreflightFromStartOver() {
  try {
    await abandonCleanLibraryCheckpoint();
    updateIndexState.resumeIntent = false;
    resetUpdateIndexOverlayTitle();
    const scanResult = await runUpdateIndexPreflightScan();
    renderUpdateIndexPreflightResult(scanResult);
  } catch (error) {
    console.error('❌ Clean library start over failed:', error);
    updateUpdateIndexUI('Failed to scan library', false);
    showToast(`Scan failed: ${error.message}`, 'error');
    showUpdateIndexButtons('cancel');
  }
}

async function restartCleanLibraryPreviewFromStartOver() {
  const runId = cleanLibraryPreviewState.runId;
  resetUpdateIndexOverlayTitle();
  try {
    await showPreviewScanningPhase(runId);
    await showPreviewEtaScreen(runId);
    await showPreviewWorkingPhase(runId);
    showPreviewFinishedScreen();
  } catch (error) {
    if (error?.message !== 'cancelled') {
      console.error('❌ Clean library preview restart failed:', error);
    }
  }
}

const CLEAN_LIBRARY_PHASE_LABELS = {
  setup: 'Preparing…',
  scan: 'Scanning files…',
  dedupe: 'Removing duplicates…',
  canonicalize: 'Organizing media…',
  folders: 'Cleaning folders…',
  rebuild_db: 'Rebuilding database…',
  audit: 'Final verification…',
};

const CLEAN_LIBRARY_ETA_MIN_SAMPLES = 25;
const CLEAN_LIBRARY_SCAN_TAIL_RATIO = 1.05;

let cleanLibraryRunEtaState = null;

function resetCleanLibraryRunEtaState() {
  cleanLibraryRunEtaState = {
    startedAtMs: Date.now(),
    lastPhase: null,
  };
}

function formatAboutDurationFromSeconds(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  if (seconds < 45) return 'less than a minute';
  if (seconds < 90) return 'about 1 minute';
  const minutes = seconds / 60;
  if (minutes < 60) {
    const rounded = Math.max(1, Math.round(minutes));
    return `about ${rounded} minute${rounded === 1 ? '' : 's'}`;
  }
  const hours = seconds / 3600;
  const rounded = Math.max(1, Math.round(hours));
  return `about ${rounded} hour${rounded === 1 ? '' : 's'}`;
}

function formatPreciseDurationFromSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 60) {
    return `${seconds} sec`;
  }
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) {
    if (remSec === 0) {
      return `${minutes} min`;
    }
    return `${minutes} min ${remSec} sec`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  const parts = [`${hours} hr`];
  if (remMin > 0) {
    parts.push(`${remMin} min`);
  }
  if (remSec > 0) {
    parts.push(`${remSec} sec`);
  }
  return parts.join(' ');
}

function appendCleanLibraryFinishFeedLines(finishedAt, elapsedSec, options = {}) {
  appendCleanLibraryActivityLine(
    `Finished: ${formatCleanLibraryFeedTimestamp(finishedAt)}`,
    options,
  );
  appendCleanLibraryActivityLine(
    `Total time: ${formatPreciseDurationFromSeconds(elapsedSec)}`,
    options,
  );
}

function estimateCleanRunRemainingSeconds(processed, total, elapsedSec, phase) {
  const done = Math.max(0, Number(processed) || 0);
  const cap = Math.max(1, Number(total) || 1);
  if (done < CLEAN_LIBRARY_ETA_MIN_SAMPLES || elapsedSec <= 0) {
    return null;
  }
  const rate = elapsedSec / done;
  let remaining = Math.max(0, cap - done) * rate;
  if (phase === 'scan') {
    remaining *= CLEAN_LIBRARY_SCAN_TAIL_RATIO;
  }
  return remaining;
}

function storeCleanLibraryPreflightEstimate(scanResult) {
  if (scanResult.status === 'RESUME') {
    updateIndexState.estimatedSeconds =
      Number(scanResult.estimated_remaining_seconds) || 0;
    updateIndexState.estimatedDisplay = scanResult.estimated_remaining_display || '';
  } else {
    updateIndexState.estimatedSeconds =
      Number(scanResult.estimated_seconds ?? scanResult.inventory?.estimated_seconds) ||
      0;
    updateIndexState.estimatedDisplay =
      scanResult.estimated_display ||
      scanResult.inventory?.estimated_display ||
      '';
  }
}

function resetCleanLibraryWorkingStepState() {
  if (cleanLibraryWorkingStepState?.pumpTimer) {
    clearTimeout(cleanLibraryWorkingStepState.pumpTimer);
  }
  cleanLibraryWorkingStepState = {
    stepNumber: null,
    phase: null,
    shownAtMs: 0,
    progress: {},
    queue: [],
    pumpTimer: null,
  };
}

function clearCleanLibraryWorkingStepState() {
  if (cleanLibraryWorkingStepState?.pumpTimer) {
    clearTimeout(cleanLibraryWorkingStepState.pumpTimer);
  }
  cleanLibraryWorkingStepState = null;
}

function updateCleanLibraryWorkingProgress(phase, processed, total) {
  if (!CLEAN_LIBRARY_STEP_PROGRESS_PHASES.has(phase)) {
    return;
  }
  const done = Number(processed);
  const cap = Number(total);
  if (!Number.isFinite(done) || !Number.isFinite(cap) || cap < 1) {
    return;
  }
  if (!cleanLibraryWorkingStepState) {
    return;
  }
  cleanLibraryWorkingStepState.progress[phase] = {
    processed: Math.max(0, Math.min(done, cap)),
    total: cap,
  };
}

function formatCleanLibraryWorkingProgressSuffix(phase) {
  if (!CLEAN_LIBRARY_STEP_PROGRESS_PHASES.has(phase)) {
    return '';
  }
  const progress = cleanLibraryWorkingStepState?.progress?.[phase];
  if (!progress) {
    return '';
  }
  return ` (${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()})`;
}

function buildCleanLibraryWorkingStepText(stepNumber, phase) {
  const stepLabel = CLEAN_LIBRARY_PREVIEW_WORKING_STEPS[stepNumber - 1] || 'Working';
  return `Step ${stepNumber} of 6: ${stepLabel}${formatCleanLibraryWorkingProgressSuffix(phase)}`;
}

function renderCleanLibraryWorkingStepDisplay() {
  const state = cleanLibraryWorkingStepState;
  if (!state || state.stepNumber === null) {
    return;
  }
  updateUpdateIndexUI(
    buildCleanLibraryWorkingStepText(state.stepNumber, state.phase),
  );
  syncCleanLibraryWorkingRemainingDisplay();
}

function enqueueCleanLibraryWorkingStep(stepNumber, phase) {
  const state = cleanLibraryWorkingStepState;
  if (!state) {
    return;
  }
  const last = state.queue[state.queue.length - 1];
  if (last && last.stepNumber === stepNumber && last.phase === phase) {
    return;
  }
  state.queue.push({ stepNumber, phase });
}

function pumpCleanLibraryWorkingStepQueue() {
  const state = cleanLibraryWorkingStepState;
  if (!state || state.pumpTimer) {
    return;
  }

  const tick = () => {
    state.pumpTimer = null;
    if (!state.queue.length) {
      return;
    }

    const now = Date.now();
    if (
      state.stepNumber !== null &&
      now - state.shownAtMs < CLEAN_LIBRARY_WORKING_STEP_MIN_MS
    ) {
      state.pumpTimer = setTimeout(
        tick,
        CLEAN_LIBRARY_WORKING_STEP_MIN_MS - (now - state.shownAtMs),
      );
      return;
    }

    const next = state.queue.shift();
    state.stepNumber = next.stepNumber;
    state.phase = next.phase;
    state.shownAtMs = Date.now();
    renderCleanLibraryWorkingStepDisplay();

    if (state.queue.length > 0) {
      state.pumpTimer = setTimeout(tick, CLEAN_LIBRARY_WORKING_STEP_MIN_MS);
    }
  };

  tick();
}

function requestCleanLibraryWorkingStep(phase) {
  const stepNumber = CLEAN_LIBRARY_PHASE_STEP_INDEX[phase] || 1;
  const state = cleanLibraryWorkingStepState;
  if (!state) {
    updateUpdateIndexUI(buildCleanLibraryWorkingStepText(stepNumber, phase));
    syncCleanLibraryWorkingRemainingDisplay();
    return;
  }

  if (state.stepNumber === stepNumber) {
    state.phase = phase;
    renderCleanLibraryWorkingStepDisplay();
    return;
  }

  enqueueCleanLibraryWorkingStep(stepNumber, phase);
  pumpCleanLibraryWorkingStepQueue();
}

function seedCleanLibraryWorkingProgressFromPhaseEvent(event = {}) {
  if (event.type !== 'phase' || event.status !== 'starting' || !event.phase) {
    return;
  }
  if (event.phase === 'scan' && event.total_candidates != null) {
    updateCleanLibraryWorkingProgress(
      'scan',
      Number(event.resumed_files) || 0,
      event.total_candidates,
    );
  } else if (event.phase === 'canonicalize' && event.total != null) {
    updateCleanLibraryWorkingProgress(
      'canonicalize',
      Number(event.resumed_index) || 0,
      event.total,
    );
  } else if (event.phase === 'rebuild_db' && event.total != null) {
    updateCleanLibraryWorkingProgress('rebuild_db', 0, event.total);
  } else if (event.phase === 'audit' && event.total != null) {
    updateCleanLibraryWorkingProgress('audit', 0, event.total);
  }
}

function handleCleanLibraryWorkingProgressEvent(event = {}) {
  if (event.type !== 'progress' || !event.phase) {
    return;
  }
  updateCleanLibraryWorkingProgress(event.phase, event.processed, event.total);
  syncCleanLibraryInflightFromProgress(event);
  maybeAppendCleanLibraryProgressMilestone(
    event.phase,
    event.processed,
    event.total,
  );

  const stepNumber = CLEAN_LIBRARY_PHASE_STEP_INDEX[event.phase] || 1;
  const state = cleanLibraryWorkingStepState;
  if (!state) {
    return;
  }

  if (state.stepNumber === stepNumber) {
    state.phase = event.phase;
    renderCleanLibraryWorkingStepDisplay();
    return;
  }

  if (state.stepNumber === null && !state.queue.length) {
    requestCleanLibraryWorkingStep(event.phase);
  }
}

function beginCleanLibraryWorkingUi() {
  updateIndexState.workingPhaseActive = true;
  updateIndexState.overlayPhase = 'working';
  updateIndexState.runStartedAtMs = Date.now();
  resetCleanLibraryWorkingStepState();
  resetUpdateIndexOverlayTitle();
  showCleanLibraryWorkingBody();
  showUpdateIndexPreflightStats(null);
  hideUpdateIndexStats();
  initCleanLibraryInflightStats();
  showCleanLibraryDetailsSection(true);
  resetCleanLibraryLogFeed();
  prependCleanLibraryActivityLine(
    `Started: ${formatCleanLibraryFeedTimestamp(new Date(updateIndexState.runStartedAtMs))}`,
    { allowInactive: true },
  );
  showUpdateIndexButtons('cancel');
  requestCleanLibraryWorkingStep('setup');
}

function endCleanLibraryWorkingUi() {
  updateIndexState.workingPhaseActive = false;
  clearCleanLibraryWorkingStepState();
  setCleanLibraryExplainerVisible(false);
  setCleanLibrarySecondaryStatus(null, false);
}

function syncCleanLibraryWorkingRemainingDisplay() {
  const totalSec = Number(updateIndexState.estimatedSeconds) || 0;
  if (!updateIndexState.runStartedAtMs || totalSec <= 0) {
    setCleanLibrarySecondaryStatus('Total time remaining: estimating…');
    return;
  }
  const elapsed = (Date.now() - updateIndexState.runStartedAtMs) / 1000;
  setCleanLibrarySecondaryStatus(
    `Total time remaining: ${formatAboutDurationFromSeconds(Math.max(5, totalSec - elapsed))}`,
  );
}

function showCleanLibraryFinishedUi() {
  const feedExpanded = isCleanLibraryActivityFeedExpanded();
  const finishedAt = new Date();
  const elapsedSec = updateIndexState.runStartedAtMs
    ? (finishedAt.getTime() - updateIndexState.runStartedAtMs) / 1000
    : Number(updateIndexState.estimatedSeconds) || 0;
  const totalDisplay = formatPreciseDurationFromSeconds(elapsedSec);

  syncCleanLibraryInflightFromResultStats(updateIndexState.resultStats);
  appendCleanLibraryFinishFeedLines(finishedAt, elapsedSec, { allowInactive: true });

  endCleanLibraryWorkingUi();
  updateIndexState.overlayPhase = 'finished';
  setCleanLibrarySecondaryStatus(`Total time: ${totalDisplay}`, true);
  updateUpdateIndexUI(
    'Library check complete. Your library is clean and organized.',
  );
  showCleanLibraryDetailsSection(true);
  showUpdateIndexButtons('done');

  const detailsList = document.getElementById('updateIndexDetailsList');
  if (detailsList) {
    detailsList.style.display = 'none';
  }
  setCleanLibraryActivityFeedVisible(feedExpanded, { activityMode: true });
}

function resolveCleanLibraryStreamResume() {
  if (updateIndexState.resumeIntent === false) {
    return false;
  }
  if (updateIndexState.resumeIntent === true) {
    return true;
  }
  return undefined;
}

async function reconcileCleanLibraryStreamResume() {
  const intent = resolveCleanLibraryStreamResume();
  if (intent !== true) {
    return intent;
  }
  try {
    const checkpoint = await probeCleanLibraryCheckpoint();
    if (checkpoint?.resumable) {
      return true;
    }
    updateIndexState.resumeIntent = false;
    return false;
  } catch (error) {
    console.warn('Checkpoint probe failed before run:', error);
    updateIndexState.resumeIntent = false;
    return false;
  }
}

async function probeCleanLibraryCheckpoint() {
  const response = await fetch('/api/library/make-perfect/checkpoint');
  if (response.status === 404) {
    return { status: 'NONE', resumable: false };
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Checkpoint probe failed (${response.status})`);
  }
  return response.json();
}

async function abandonCleanLibraryCheckpoint() {
  const response = await fetch('/api/library/make-perfect/checkpoint/abandon', {
    method: 'POST',
  });
  if (response.status === 404) {
    return { ok: true, abandoned: false };
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Abandon failed (${response.status})`);
  }
  return response.json();
}

async function loadCleanLibraryManifestTail(manifestPath, lines = 40) {
  if (!manifestPath) {
    return;
  }
  const url =
    `/api/library/make-perfect/manifest-tail?path=${encodeURIComponent(manifestPath)}&lines=${lines}`;
  const response = await fetch(url);
  if (response.status === 404) {
    return;
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Manifest tail failed (${response.status})`);
  }
  const data = await response.json();
  for (const line of data.lines || []) {
    const formatted = formatCleanLibraryManifestLine(line);
    if (formatted) {
      appendCleanLibraryActivityLine(formatted);
    }
  }
}

async function prefetchCleanLibraryManifestTail() {
  if (updateIndexState.resumeIntent !== true) {
    return;
  }
  const manifestPath = updateIndexState.preflight?.resume?.manifest_path;
  if (!manifestPath) {
    return;
  }
  try {
    await loadCleanLibraryManifestTail(manifestPath);
  } catch (error) {
    console.warn('Manifest tail load failed:', error);
  }
}

function showCleanLibraryInterruptedGate() {
  updateIndexState.overlayPhase = 'interrupted';
  showContinueLibraryCleanupTitle();
  setCleanLibraryExplainerVisible(false);
  setCleanLibrarySecondaryStatus(null, false);
  showUpdateIndexPreflightStats(null);
  hideUpdateIndexStats();
  showCleanLibraryDetailsSection(false);
  resetCleanLibraryLogFeed();
  updateUpdateIndexUI(
    'It looks like a previous library cleanup was not completed. You can continue it, start a new cleanup, or cancel.',
    false,
  );
  showUpdateIndexButtons('cancel', 'start-over', 'proceed');
  return new Promise((resolve) => {
    updateIndexState.onInterruptedChoice = (choice) => {
      updateIndexState.onInterruptedChoice = null;
      resolve(choice);
    };
  });
}

function applyCleanerStreamToUpdateIndex(event = {}) {
  if (event.type === 'log' && event.entry) {
    if (updateIndexState.workingPhaseActive) {
      appendCleanLibraryEngineLogEntry(event.entry);
    }
    return;
  }
  if (updateIndexState.workingPhaseActive) {
    return;
  }
  if (event.type === 'stats') {
    const summary = event.summary || {};
    updateIndexState.misfiledMedia = summary.misfiled_media || 0;
    updateIndexState.duplicates = summary.duplicates || 0;
    updateIndexState.unsupportedFiles = summary.unsupported_files || 0;
    updateIndexState.metadataCleanup = summary.metadata_cleanup || 0;
    updateIndexState.databaseRepairs = summary.database_repairs || 0;
    showUpdateIndexStats();
    return;
  }
  if (event.type === 'signal_plan' && event.feedback_only) {
    showUpdateIndexStats();
    return;
  }
  if (event.type === 'signal_delta' && event.remaining) {
    const remaining = event.remaining;
    updateIndexState.misfiledMedia = remaining.misfiled_media || 0;
    updateIndexState.duplicates = remaining.duplicates || 0;
    updateIndexState.unsupportedFiles = remaining.unsupported_files || 0;
    updateIndexState.metadataCleanup = remaining.metadata_cleanup || 0;
    updateIndexState.databaseRepairs = remaining.database_repairs || 0;
    showUpdateIndexStats();
  }
}

function updateIndexStatusForCleanerPhase(event = {}) {
  if (updateIndexState.workingPhaseActive) {
    if (event.type === 'resume') {
      const phase = event.resumed_from?.phase || 'scan';
      requestCleanLibraryWorkingStep(phase);
      return;
    }
    if (event.type === 'phase' && event.status === 'starting' && event.phase) {
      if (cleanLibraryRunEtaState) {
        cleanLibraryRunEtaState.lastPhase = event.phase;
      }
      seedCleanLibraryWorkingProgressFromPhaseEvent(event);
      requestCleanLibraryWorkingStep(event.phase);
      return;
    }
    if (event.type === 'progress' && event.phase) {
      if (cleanLibraryRunEtaState) {
        cleanLibraryRunEtaState.lastPhase = event.phase;
      }
      handleCleanLibraryWorkingProgressEvent(event);
      const stepNumber = CLEAN_LIBRARY_PHASE_STEP_INDEX[event.phase] || 1;
      const state = cleanLibraryWorkingStepState;
      if (state && state.stepNumber !== null && state.stepNumber !== stepNumber) {
        requestCleanLibraryWorkingStep(event.phase);
      }
    }
    return;
  }

  if (event.type === 'resume') {
    const doneCount = event.resumed_from?.scan_completed_count ?? 0;
    const phase = event.resumed_from?.phase || 'scan';
    updateUpdateIndexUI(
      `Resuming clean (${doneCount.toLocaleString()} files already processed, phase ${phase})…`,
      true,
    );
    return;
  }

  if (event.type === 'phase') {
    const phase = event.phase;
    if (event.status === 'starting' && CLEAN_LIBRARY_PHASE_LABELS[phase]) {
      if (cleanLibraryRunEtaState) {
        cleanLibraryRunEtaState.lastPhase = phase;
      }
      updateUpdateIndexUI(CLEAN_LIBRARY_PHASE_LABELS[phase], true);
    }
    return;
  }

  if (event.type !== 'progress' || !cleanLibraryRunEtaState) {
    return;
  }

  const phase = event.phase;
  const label = CLEAN_LIBRARY_PHASE_LABELS[phase] || phase || 'Cleaning';
  const processed = Number(event.processed);
  const total = Number(event.total);
  if (!Number.isFinite(processed) || !Number.isFinite(total) || total < 1) {
    return;
  }

  const elapsedSec = (Date.now() - cleanLibraryRunEtaState.startedAtMs) / 1000;
  const remainingSec = estimateCleanRunRemainingSeconds(
    processed,
    total,
    elapsedSec,
    phase,
  );

  if (remainingSec === null) {
    updateUpdateIndexUI(`${label} — estimating…`, true);
    return;
  }

  updateUpdateIndexUI(
    `${label} — ${formatAboutDurationFromSeconds(remainingSec)} left`,
    true,
  );
}

function showUpdateIndexPreflightStats(scanResult = null) {
  const preflightEl = document.getElementById('updateIndexPreflightStats');
  const runStatsEl = document.getElementById('updateIndexStats');
  const photoEl = document.getElementById('updateIndexPhotoCount');
  const videoEl = document.getElementById('updateIndexVideoCount');
  const totalEl = document.getElementById('updateIndexTotalCount');

  if (runStatsEl) runStatsEl.style.display = 'none';
  if (!scanResult) {
    if (preflightEl) preflightEl.style.display = 'none';
    return;
  }

  const photos =
    scanResult.summary?.photo_count ?? scanResult.inventory?.photo_count ?? 0;
  const videos =
    scanResult.summary?.video_count ?? scanResult.inventory?.video_count ?? 0;
  const total = getCleanLibraryPreflightTotal(scanResult, photos, videos);
  if (photoEl) photoEl.textContent = Number(photos).toLocaleString();
  if (videoEl) videoEl.textContent = Number(videos).toLocaleString();
  if (totalEl) totalEl.textContent = Number(total).toLocaleString();
  if (preflightEl) preflightEl.style.display = 'grid';
}

function showPreflightScoreboardZeros() {
  const preflightEl = document.getElementById('updateIndexPreflightStats');
  const runStatsEl = document.getElementById('updateIndexStats');
  const photoEl = document.getElementById('updateIndexPhotoCount');
  const videoEl = document.getElementById('updateIndexVideoCount');
  const totalEl = document.getElementById('updateIndexTotalCount');
  if (runStatsEl) runStatsEl.style.display = 'none';
  if (photoEl) photoEl.textContent = '0';
  if (videoEl) videoEl.textContent = '0';
  if (totalEl) totalEl.textContent = '0';
  if (preflightEl) preflightEl.style.display = 'grid';
}

async function runUpdateIndexPreflightScan() {
  updateIndexState.overlayPhase = 'scanning';
  resetCleanLibraryLogFeed();
  updateUpdateIndexUI('Scanning library…', true);
  showUpdateIndexButtons('cancel', 'proceed-disabled');
  showCleanLibraryPreflightExplainer();
  showPreflightScoreboardZeros();
  hideUpdateIndexStats();

  const orientStartedAt = Date.now();
  const response = await fetch('/api/library/make-perfect/scan');
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Scan failed (${response.status})`);
  }
  const scanResult = await response.json();

  await waitPreflightScoreboardOrientDelay(orientStartedAt);

  const photos =
    scanResult.summary?.photo_count ?? scanResult.inventory?.photo_count ?? 0;
  const videos =
    scanResult.summary?.video_count ?? scanResult.inventory?.video_count ?? 0;
  const total = getCleanLibraryPreflightTotal(scanResult, photos, videos);
  await animatePreflightScoreboardCounts(
    photos,
    videos,
    CLEAN_LIBRARY_PREFLIGHT_COUNT_ANIMATION_MS,
    { totalTarget: total },
  );

  return scanResult;
}

function renderUpdateIndexPreflightResult(scanResult) {
  updateIndexState.preflight = scanResult;
  storeCleanLibraryPreflightEstimate(scanResult);
  updateIndexState.overlayPhase = 'eta';

  if (scanResult.status === 'INVENTORY' || scanResult.status === 'RESUME') {
    if (scanResult.status === 'RESUME') {
      updateIndexState.resumeIntent = true;
      showContinueLibraryCleanupTitle();
    } else if (updateIndexState.resumeIntent === true) {
      updateIndexState.resumeIntent = false;
      resetUpdateIndexOverlayTitle();
    }
    showUpdateIndexPreflightStats(scanResult);
    const photos =
      scanResult.summary?.photo_count ?? scanResult.inventory?.photo_count ?? 0;
    const videos =
      scanResult.summary?.video_count ?? scanResult.inventory?.video_count ?? 0;
    const timeLabel =
      scanResult.status === 'RESUME'
        ? scanResult.estimated_remaining_display
        : scanResult.estimated_display;
    updateUpdateIndexUI(`Time required: ${timeLabel}`, false);
    if (scanResult.status === 'RESUME') {
      showUpdateIndexButtons('cancel', 'start-over', 'proceed');
    } else {
      showUpdateIndexButtons('cancel', 'proceed');
    }
    return;
  }

  if (scanResult.status === 'DIRTY' || scanResult.status === 'CLEAN') {
    const summary = scanResult.summary || {};
    updateIndexState.misfiledMedia = summary.misfiled_media || 0;
    updateIndexState.duplicates = summary.duplicates || 0;
    updateIndexState.unsupportedFiles = summary.unsupported_files || 0;
    updateIndexState.metadataCleanup = summary.metadata_cleanup || 0;
    updateIndexState.databaseRepairs = summary.database_repairs || 0;
    showUpdateIndexStats();
    const issueCount = summary.issue_count ?? summary.operation_count ?? 0;
    updateUpdateIndexUI(
      scanResult.status === 'CLEAN'
        ? 'Library looks clean. Continue anyway?'
        : `Found ${Number(issueCount).toLocaleString()} issues. Continue to clean?`,
      false,
    );
    showUpdateIndexButtons('cancel', 'proceed');
    return;
  }

  throw new Error(scanResult.error || 'Unexpected preflight scan response');
}

/**
 * Clean library overlay — cheap inventory preflight, then Continue to run.
 */
async function openUpdateIndexOverlay() {
  const existingOverlay = document.getElementById('updateIndexOverlay');
  if (existingOverlay && existingOverlay.style.display === 'flex') {
    return;
  }

  await loadUpdateIndexOverlay();

  const overlay = document.getElementById('updateIndexOverlay');
  if (!overlay) return;

  updateIndexState = {
    misfiledMedia: 0,
    duplicates: 0,
    unsupportedFiles: 0,
    metadataCleanup: 0,
    databaseRepairs: 0,
    details: null,
    resultStats: null,
    preflight: null,
    isRunning: false,
    abortController: null,
    cancelRequested: false,
    resumeIntent: null,
    overlayPhase: null,
    workingPhaseActive: false,
    runStartedAtMs: null,
    estimatedSeconds: 0,
    estimatedDisplay: '',
    onInterruptedChoice: null,
  };

  const detailsSection = document.getElementById('updateIndexDetailsSection');
  if (detailsSection) detailsSection.style.display = 'none';
  resetCleanLibraryLogFeed();

  overlay.style.display = 'flex';
  resetUpdateIndexOverlayTitle();

  try {
    const checkpoint = await probeCleanLibraryCheckpoint();
    if (checkpoint?.resumable) {
      const choice = await showCleanLibraryInterruptedGate();
      if (choice === 'cancel') {
        closeUpdateIndexOverlayImmediate();
        return;
      }
      if (choice === 'start-over') {
        await abandonCleanLibraryCheckpoint();
        updateIndexState.resumeIntent = false;
        resetUpdateIndexOverlayTitle();
      } else {
        updateIndexState.resumeIntent = true;
      }
    }

    const scanResult = await runUpdateIndexPreflightScan();
    renderUpdateIndexPreflightResult(scanResult);
  } catch (error) {
    console.error('❌ Clean library preflight failed:', error);
    updateUpdateIndexUI('Failed to scan library', false);
    showToast(`Scan failed: ${error.message}`, 'error');
    showUpdateIndexButtons('cancel');
  }
}

async function executeUpdateIndex() {
  const overlay = document.getElementById('updateIndexOverlay');
  if (!overlay || overlay.style.display !== 'flex') {
    return;
  }
  if (updateIndexState?.isRunning) {
    return;
  }

  updateIndexState.isRunning = true;
  updateIndexState.cancelRequested = false;
  updateIndexState.abortController = new AbortController();
  resetCleanLibraryRunEtaState();
  beginCleanLibraryWorkingUi();
  await prefetchCleanLibraryManifestTail();

  try {
    const resume = await reconcileCleanLibraryStreamResume();
    const result = await streamMakeLibraryPerfect({
      signal: updateIndexState.abortController.signal,
      resume,
      onProgress: (event) => {
        if (cleanLibraryRunUiPaused) {
          return;
        }
        applyCleanerStreamToUpdateIndex(event);
        updateIndexStatusForCleanerPhase(event);
      },
    });

    if (result?.status === 'CANCELLED') {
      updateIndexState.resumeIntent = null;
      showToast(CLEAN_LIBRARY_PAUSE_TOAST, null);
      closeUpdateIndexOverlayImmediate();
      return;
    }

    updateIndexState.resumeIntent = null;
    updateIndexState.resultStats = result?.stats || null;
    showCleanLibraryFinishedUi();
    await loadAndRenderPhotos(false);
  } catch (error) {
    if (error?.name === 'AbortError' || updateIndexState?.cancelRequested) {
      updateIndexState.resumeIntent = null;
      showToast(CLEAN_LIBRARY_PAUSE_TOAST, null);
      closeUpdateIndexOverlayImmediate();
      return;
    }
    console.error('❌ Failed to clean library:', error);
    endCleanLibraryWorkingUi();
    updateUpdateIndexUI('Failed to clean library', false);
    showToast('Failed to clean library', null);
    showUpdateIndexButtons('cancel');
  } finally {
    if (updateIndexState) {
      updateIndexState.isRunning = false;
      updateIndexState.abortController = null;
      updateIndexState.cancelRequested = false;
      updateIndexState.workingPhaseActive = false;
    }
    cleanLibraryRunEtaState = null;
    clearCleanLibraryWorkingStepState();
  }
}

/**
 * Update Clean library overlay status text (no spinner — use n/m counts instead).
 */
function updateUpdateIndexUI(statusText, showSpinner = false) {
  const statusTextEl = document.getElementById('updateIndexStatusText');
  if (!statusTextEl) {
    return;
  }
  if (showSpinner) {
    setImportSpinnerStatus(statusTextEl, statusText);
  } else {
    statusTextEl.textContent = statusText;
  }
}

function setCleanLibraryInflightCounts(processed, duplicates, skipped) {
  const preflightEl = document.getElementById('updateIndexPreflightStats');
  const statsEl = document.getElementById('updateIndexInflightStats');
  const processedEl = document.getElementById('updateIndexInflightProcessed');
  const duplicateEl = document.getElementById('updateIndexInflightDuplicates');
  const skippedEl = document.getElementById('updateIndexInflightSkipped');
  if (preflightEl) {
    preflightEl.style.display = 'none';
  }
  if (statsEl) {
    statsEl.style.display = 'grid';
  }
  hideUpdateIndexStats();
  if (processedEl) {
    processedEl.textContent = Number(processed).toLocaleString();
  }
  if (duplicateEl) {
    duplicateEl.textContent = Number(duplicates).toLocaleString();
  }
  if (skippedEl) {
    skippedEl.textContent = Number(skipped).toLocaleString();
  }
}

function initCleanLibraryInflightStats() {
  updateIndexState.inflightStats = { processed: 0, duplicates: 0, skipped: 0 };
  setCleanLibraryInflightCounts(0, 0, 0);
}

function syncCleanLibraryInflightFromProgress(event = {}) {
  if (!updateIndexState.inflightStats) {
    return;
  }
  const processed = Number(event.processed);
  if (Number.isFinite(processed)) {
    updateIndexState.inflightStats.processed = Math.max(
      updateIndexState.inflightStats.processed,
      processed,
    );
  }
  setCleanLibraryInflightCounts(
    updateIndexState.inflightStats.processed,
    updateIndexState.inflightStats.duplicates,
    updateIndexState.inflightStats.skipped,
  );
}

function syncCleanLibraryInflightFromResultStats(resultStats) {
  if (!resultStats) {
    return;
  }
  const duplicates = Number(resultStats.duplicates_trashed) || 0;
  const skipped = Math.max(
    0,
    (Number(resultStats.moved_to_trash) || 0) - duplicates,
  );
  const processed = updateIndexState.inflightStats?.processed || 0;
  if (updateIndexState.inflightStats) {
    updateIndexState.inflightStats.duplicates = duplicates;
    updateIndexState.inflightStats.skipped = skipped;
  }
  setCleanLibraryInflightCounts(processed, duplicates, skipped);
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

  if (statsEl) statsEl.style.display = 'grid';
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
  const startOverBtn = document.getElementById('updateIndexStartOverBtn');

  // Hide all first
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (proceedBtn) {
    proceedBtn.style.display = 'none';
    proceedBtn.disabled = false;
  }
  if (doneBtn) doneBtn.style.display = 'none';
  if (startOverBtn) {
    startOverBtn.style.display = 'none';
    startOverBtn.disabled = false;
  }

  // Show requested buttons
  buttons.forEach((btn) => {
    if (btn === 'cancel' && cancelBtn) {
      cancelBtn.style.display = 'inline-block';
      cancelBtn.disabled = false;
    } else if (btn === 'cancel-disabled' && cancelBtn) {
      cancelBtn.style.display = 'inline-block';
      cancelBtn.disabled = true;
    } else if (btn === 'start-over' && startOverBtn) {
      startOverBtn.style.display = 'inline-block';
      startOverBtn.disabled = false;
    } else if (btn === 'proceed' && proceedBtn) {
      proceedBtn.style.display = 'inline-block';
      proceedBtn.disabled = false;
    } else if (btn === 'proceed-disabled' && proceedBtn) {
      proceedBtn.style.display = 'inline-block';
      proceedBtn.disabled = true;
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
function closeUpdateIndexOverlayImmediate() {
  stopCleanLibraryPreview();
  setCleanLibraryOverlayInert(false);
  setCleanLibraryExplainerVisible(false);
  setCleanLibrarySecondaryStatus(null, false);
  resetCleanLibraryLogFeed();
  showCleanLibraryDetailsSection(false);
  resetUpdateIndexOverlayTitle();
  const overlay = document.getElementById('updateIndexOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

async function confirmStopCleanLibraryRun() {
  pauseCleanLibraryWorkingProgress();
  pauseCleanLibraryRunUiUpdates();
  setCleanLibraryOverlayInert(true);
  try {
    return await showDialog(
      'Stop cleanup?',
      'Progress so far will be saved. You can continue later from Clean library.',
      [
        { text: 'Keep cleaning', value: false, secondary: true },
        { text: 'Stop cleanup', value: true, primary: true },
      ],
      { overImport: true },
    );
  } finally {
    setCleanLibraryOverlayInert(false);
    resumeCleanLibraryRunUiUpdates();
    resumeCleanLibraryWorkingProgress();
  }
}

async function handleUpdateIndexCancelClick() {
  if (debugFlowPreviewState.active && debugFlowPreviewState.flow === 'clean') {
    dismissDebugFlowPreview();
    return;
  }

  if (cleanLibraryPreviewState.active) {
    if (cleanLibraryPreviewState.phase === 'working') {
      const confirmed = await confirmStopCleanLibraryRun();
      if (!confirmed) {
        return;
      }
      showToast(CLEAN_LIBRARY_PAUSE_TOAST, null);
    }
    stopCleanLibraryPreview();
    closeUpdateIndexOverlayImmediate();
    return;
  }

  if (updateIndexState?.onInterruptedChoice) {
    updateIndexState.onInterruptedChoice('cancel');
    return;
  }

  if (updateIndexState?.isRunning) {
    const confirmed = await confirmStopCleanLibraryRun();
    if (!confirmed) {
      return;
    }
    updateIndexState.cancelRequested = true;
    updateIndexState.abortController?.abort();
    return;
  }

  closeUpdateIndexOverlayImmediate();
}

function closeUpdateIndexOverlay() {
  if (
    debugFlowPreviewState.active &&
    debugFlowPreviewState.flow === 'clean' &&
    debugFlowPreviewState.screen === 'complete'
  ) {
    dismissDebugFlowPreview();
    return;
  }
  void handleUpdateIndexCancelClick();
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
      ?.addEventListener('click', openExistingLibrary);
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

function hideCreateLibraryOverlay() {
  const overlay = document.getElementById('nameLibraryOverlay');
  if (!overlay) {
    return;
  }
  overlay.classList.remove('expanded');
  const expandedPanel = document.getElementById('libraryLocationExpanded');
  if (expandedPanel) {
    expandedPanel.hidden = true;
  }
  overlay.style.display = 'none';
  FolderPicker.unmountEmbedded();
}

function prefetchPhotoPickerFragment() {
  if (document.getElementById('photoPickerOverlay')) {
    return;
  }
  fetch('/fragments/photoPicker.html')
    .then((response) => response.text())
    .then((html) => {
      if (!document.getElementById('photoPickerOverlay')) {
        document.body.insertAdjacentHTML('beforeend', html);
      }
    })
    .catch(() => {});
}

function sanitizeLibraryFolderName(name) {
  return name
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .trim();
}

function buildFullLibraryPath(parentPath, rawName) {
  const sanitized = sanitizeLibraryFolderName(rawName);
  if (!sanitized || !parentPath) {
    return '';
  }
  return `${parentPath.replace(/\/+$/, '')}/${sanitized}`;
}

function formatCompactLibraryLocationPath(parentPath, rawName) {
  const fullPath = buildFullLibraryPath(parentPath, rawName);
  if (!fullPath) {
    return '';
  }

  const usersMatch = fullPath.match(/^\/Users\/([^/]+)\/(.+)$/);
  if (usersMatch) {
    return `Users/${usersMatch[1]}/${usersMatch[2]}`;
  }

  return fullPath.replace(/^\//, '');
}

async function suggestUniqueLibraryName(parentPath, baseName = 'Photo Library') {
  const sanitizedBase = sanitizeLibraryFolderName(baseName) || 'Photo Library';
  try {
    const response = await fetch('/api/filesystem/list-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: parentPath }),
    });
    if (!response.ok) {
      return sanitizedBase;
    }

    const data = await response.json();
    const existingFolders = data.folders.map((f) =>
      typeof f === 'string' ? f : f.name,
    );

    let candidate = sanitizedBase;
    let suffix = 2;
    while (existingFolders.includes(candidate)) {
      candidate = `${sanitizedBase} ${suffix}`;
      suffix += 1;
    }
    return candidate;
  } catch (_) {
    return sanitizedBase;
  }
}

/**
 * Combined create-library dialog: name + location in one step (SS3).
 * @returns {Promise<{ name: string, parentPath: string }|{ action: 'cancel' }>}
 */
async function showCreateLibraryDialog(options = {}) {
  return new Promise(async (resolve) => {
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
    const compactBtn = document.getElementById('libraryLocationCompact');
    const compactPathEl = document.getElementById('libraryLocationCompactPath');
    const expandedPanel = document.getElementById('libraryLocationExpanded');
    const selectedPathEl = document.getElementById('createLibrarySelectedPath');

    let mode = 'compact';
    let parentPath = null;
    let embeddedPicker = null;
    let listenersDetached = false;
    let isSubmitting = false;
    let latestValidationTicket = 0;
    let expandedEscapeHandler = null;
    const keepVisibleOnContinue = options.keepVisibleOnContinue !== false;

    function setActionButtonsDisabled(disabled) {
      cancelBtn.disabled = disabled;
      confirmBtn.disabled = disabled;
      closeBtn.disabled = disabled;
      if (goBackBtn) {
        goBackBtn.disabled = disabled;
      }
      if (compactBtn) {
        compactBtn.disabled = disabled;
      }
    }

    const titleEl = overlay.querySelector('.import-title');
    const subtitleEl = overlay.querySelector('.import-status-text p');

    if (titleEl && options.title) {
      titleEl.textContent = options.title;
    } else if (titleEl) {
      titleEl.textContent = 'Add to new library';
    }

    if (subtitleEl && options.subtitle) {
      subtitleEl.textContent = options.subtitle;
    } else if (subtitleEl) {
      subtitleEl.textContent =
        'To add photos, first create a new library. Give your library a name and location to continue.';
    }

    parentPath = await FolderPicker.getDefaultParentPath();
    const defaultName = await suggestUniqueLibraryName(
      parentPath,
      options.initialLibraryName || 'Photo Library',
    );

    isSubmitting = false;
    setActionButtonsDisabled(false);
    input.value = defaultName;
    errorDiv.style.visibility = 'hidden';
    errorDiv.textContent = '';

    if (options.duplicateNameError) {
      errorDiv.textContent = options.duplicateNameError;
      errorDiv.style.visibility = 'visible';
    }

    function updatePathPreviews() {
      compactPathEl.textContent = formatCompactLibraryLocationPath(
        parentPath,
        input.value,
      );
      const fullPath = buildFullLibraryPath(parentPath, input.value);
      if (selectedPathEl) {
        selectedPathEl.textContent = fullPath || 'No path selected';
      }
    }

    async function computeNameValidation(name) {
      const sanitized = sanitizeLibraryFolderName(name);

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

      if (parentPath) {
        const taken = await libraryFolderNameExistsAtParent(parentPath, sanitized);
        if (taken) {
          return {
            sanitized: null,
            errorMessage: `A folder named "${sanitized}" already exists here`,
          };
        }
      }

      return {
        sanitized,
        errorMessage: null,
      };
    }

    async function validateName() {
      const ticket = ++latestValidationTicket;
      const result = await computeNameValidation(input.value);

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
        confirmBtn.disabled = !result.sanitized || !parentPath;
      }

      updatePathPreviews();
      return result.sanitized;
    }

    async function expandPicker() {
      embeddedPicker = await FolderPicker.initEmbedded({
        initialPath: parentPath,
        intent: FolderPicker.INTENT.CHOOSE_LIBRARY_LOCATION,
        enableKeyboard: true,
        onPathChange: (path) => {
          if (path) {
            parentPath = path;
          }
          void validateName();
        },
      });
      updatePathPreviews();
    }

    function collapsePicker() {
      if (expandedEscapeHandler) {
        document.removeEventListener('keydown', expandedEscapeHandler);
        expandedEscapeHandler = null;
      }
      if (embeddedPicker) {
        parentPath = embeddedPicker.getSelectedPath() || parentPath;
        embeddedPicker = null;
      }
      FolderPicker.unmountEmbedded();
      updatePathPreviews();
    }

    function setMode(nextMode) {
      mode = nextMode;
      overlay.classList.toggle('expanded', mode === 'expanded');
      if (expandedPanel) {
        expandedPanel.hidden = mode !== 'expanded';
      }
      if (goBackBtn) {
        goBackBtn.style.display = mode === 'expanded' ? '' : 'none';
      }

      if (mode === 'expanded') {
        expandedEscapeHandler = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setMode('compact');
          }
        };
        document.addEventListener('keydown', expandedEscapeHandler);
        void expandPicker();
      } else {
        collapsePicker();
        void validateName();
      }
    }

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
      const newCompactBtn = compactBtn ? compactBtn.cloneNode(true) : null;

      cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
      confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
      closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
      input.parentNode.replaceChild(newInput, input);
      if (goBackBtn && newGoBackBtn && goBackBtn.parentNode) {
        goBackBtn.parentNode.replaceChild(newGoBackBtn, goBackBtn);
      }
      if (compactBtn && newCompactBtn && compactBtn.parentNode) {
        compactBtn.parentNode.replaceChild(newCompactBtn, compactBtn);
      }
      listenersDetached = true;
    }

    function cleanup() {
      collapsePicker();
      overlay.classList.remove('expanded');
      if (expandedPanel) {
        expandedPanel.hidden = true;
      }
      overlay.style.display = 'none';
      detachListeners();
    }

    const handleCancel = () => {
      cleanup();
      resolve({ action: 'cancel' });
    };

    const handleGoBack = () => {
      setMode('compact');
    };

    const handleExpand = () => {
      setMode('expanded');
    };

    const handleConfirm = async () => {
      if (isSubmitting) {
        return;
      }

      if (embeddedPicker) {
        parentPath = embeddedPicker.getSelectedPath() || parentPath;
      }

      isSubmitting = true;
      setActionButtonsDisabled(true);
      try {
        const validated = await validateName();
        if (!validated || !parentPath) {
          isSubmitting = false;
          setActionButtonsDisabled(false);
          confirmBtn.disabled = true;
          return;
        }

        isSubmitting = false;
        detachListeners();
        overlay.classList.remove('expanded');
        if (expandedPanel) {
          expandedPanel.hidden = true;
        }
        collapsePicker();
        if (!keepVisibleOnContinue) {
          overlay.style.display = 'none';
        }
        resolve({ name: validated, parentPath });
      } catch (error) {
        console.error('❌ Failed to confirm create library dialog:', error);
        isSubmitting = false;
        setActionButtonsDisabled(false);
        errorDiv.textContent = 'Something went wrong. Please try again.';
        errorDiv.style.visibility = 'visible';
      }
    };

    const handleKeyPress = (e) => {
      if (e.key === 'Enter' && mode === 'compact') {
        handleConfirm();
      } else if (e.key === 'Escape') {
        if (mode === 'expanded') {
          setMode('compact');
        } else {
          handleCancel();
        }
      }
    };

    let debounceTimeout = null;
    const handleInput = () => {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      errorDiv.style.visibility = 'hidden';
      errorDiv.textContent = '';
      if (!isSubmitting) {
        confirmBtn.disabled = true;
      }
      debounceTimeout = setTimeout(() => {
        void validateName();
      }, 150);
    };

    cancelBtn.addEventListener('click', handleCancel);
    closeBtn.addEventListener('click', handleCancel);
    confirmBtn.addEventListener('click', handleConfirm);
    if (goBackBtn) {
      goBackBtn.addEventListener('click', handleGoBack);
    }
    if (compactBtn) {
      compactBtn.addEventListener('click', handleExpand);
    }
    input.addEventListener('keydown', handleKeyPress);
    input.addEventListener('input', handleInput);

    setMode('compact');
    updatePathPreviews();

    setTimeout(() => {
      input.focus();
      input.select();
      void validateName();
    }, 100);

    overlay.style.display = 'flex';
  });
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
    const response = await fetch('/fragments/terraformPreviewOverlay.html?v=8');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    console.error('❌ Failed to load terraform preview overlay:', error);
  }
}

function stopTerraformProgressRemainingTicker() {
  if (terraformProgressState.remainingTimer) {
    clearInterval(terraformProgressState.remainingTimer);
    terraformProgressState.remainingTimer = null;
  }
}

function syncTerraformProgressRemainingDisplay() {
  const secondaryEl = document.getElementById('terraformProgressSecondaryStatus');
  if (!secondaryEl) {
    return;
  }
  const totalSec = Number(terraformProgressState.estimatedSeconds);
  if (
    !terraformProgressState.runStartedAtMs ||
    !Number.isFinite(totalSec) ||
    totalSec <= 0
  ) {
    secondaryEl.style.display = 'block';
    secondaryEl.textContent = `Estimated time: ${terraformProgressState.estimatedDisplay || 'calculating...'}`;
    return;
  }
  const elapsed = (Date.now() - terraformProgressState.runStartedAtMs) / 1000;
  secondaryEl.style.display = 'block';
  secondaryEl.textContent = `Total time remaining: ${formatAboutDurationFromSeconds(
    Math.max(5, totalSec - elapsed),
  )}`;
}

function startTerraformProgressRemainingTicker() {
  stopTerraformProgressRemainingTicker();
  syncTerraformProgressRemainingDisplay();
  terraformProgressState.remainingTimer = setInterval(
    syncTerraformProgressRemainingDisplay,
    400,
  );
}

function endTerraformProgressUi() {
  terraformProgressState.active = false;
  stopTerraformProgressRemainingTicker();
  terraformProgressState.abortController = null;
}

function beginTerraformProgressUi(preflight = {}) {
  terraformProgressState.active = true;
  terraformProgressState.runStartedAtMs = Date.now();
  terraformProgressState.estimatedSeconds = Number(preflight.estimated_seconds) || null;
  terraformProgressState.estimatedDisplay = preflight.estimated_display || null;

  const explainerEl = document.getElementById('terraformProgressExplainer');
  if (explainerEl) {
    explainerEl.textContent = FLOW_INFLIGHT_BODY.convert;
  }
  const detailsSection = document.getElementById('terraformProgressDetailsSection');
  if (detailsSection) {
    detailsSection.style.display = 'block';
  }
  resetFlowDetailsPanel('convert');
  getFlowActivityLogFeed('convert').prepend(
    `Started: ${formatCleanLibraryFeedTimestamp(new Date(terraformProgressState.runStartedAtMs))}`,
  );
  getFlowActivityLogFeed('convert').setExpanded(false);

  const statusEl = document.getElementById('terraformProgressStatus');
  if (statusEl) {
    setImportSpinnerStatus(statusEl, 'Step 1 of 3: Converting files');
  }

  startTerraformProgressRemainingTicker();

  const cancelBtn = document.getElementById('terraformProgressCancelBtn');
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      if (terraformProgressState.abortController) {
        terraformProgressState.abortController.abort();
      }
      endTerraformProgressUi();
      const progressOverlay = document.getElementById('terraformProgressOverlay');
      if (progressOverlay) {
        progressOverlay.style.display = 'none';
      }
    };
  }
}

/**
 * Show terraform preview dialog
 * @param {Object} options - { path: string, photo_count: number, video_count: number, estimated_display?: string }
 * @returns {Promise<true | false | 'back_to_picker'>}
 */
async function showTerraformPreviewDialog(options = {}) {
  return new Promise(async (resolve) => {
    let overlay = document.getElementById('terraformPreviewOverlay');
    if (!overlay) {
      await loadTerraformPreviewOverlay();
      overlay = document.getElementById('terraformPreviewOverlay');
    }

    const photoCount = Number(options.photo_count) || 0;
    const videoCount = Number(options.video_count) || 0;
    const totalCount = photoCount + videoCount;

    document.getElementById('terraformPreviewPath').textContent = options.path;
    setTerraformPreviewPhase('scanning');
    setTerraformDebugPreflightCounts(0, 0, 0);
    setTerraformPreviewActionButtons({ continueDisabled: true });

    const statusEl = document.getElementById('terraformPreviewScanStatus');
    if (statusEl) {
      setImportSpinnerStatus(statusEl, 'Scanning library…');
    }

    const closeBtn = document.getElementById('terraformPreviewCloseBtn');
    const cancelBtn = document.getElementById('terraformPreviewCancelBtn');
    const goBackBtn = document.getElementById('terraformPreviewGoBackBtn');
    const continueBtn = document.getElementById('terraformPreviewContinueBtn');

    const handleCancel = () => {
      overlay.style.display = 'none';
      resolve(false);
    };

    const handleGoBack = () => {
      overlay.style.display = 'none';
      resolve('back_to_picker');
    };

    const handleContinue = () => {
      overlay.style.display = 'none';
      resolve(true);
    };

    closeBtn.onclick = handleCancel;
    cancelBtn.onclick = handleCancel;
    if (goBackBtn) goBackBtn.onclick = handleGoBack;
    continueBtn.onclick = handleContinue;

    overlay.style.display = 'flex';

    const orientStartedAt = Date.now();
    await waitPreflightScoreboardOrientDelay(orientStartedAt);
    await animateTerraformPreflightCounts(
      photoCount,
      videoCount,
      totalCount,
      CLEAN_LIBRARY_PREFLIGHT_COUNT_ANIMATION_MS,
    );

    setTerraformPreviewPhase('confirm');
    setTerraformDebugPreflightCounts(photoCount, videoCount, totalCount);
    setTerraformPreviewActionButtons({ continueDisabled: false });
    if (statusEl && options.estimated_display) {
      statusEl.textContent = `Time required: ${options.estimated_display}`;
    }
  });
}

/**
 * Load terraform warning overlay
 */
async function loadTerraformWarningOverlay() {
  try {
    const response = await fetch('/fragments/terraformWarningOverlay.html?v=3');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    console.error('❌ Failed to load terraform warning overlay:', error);
  }
}

/**
 * Show terraform warning dialog
 * @param {Object} options - { media_count: number, incompatible_count: number, estimated_time: string }
 * @returns {Promise<true | false | 'back_to_picker'>}
 */
async function showTerraformWarningDialog(options = {}) {
  return new Promise(async (resolve) => {
    // Load overlay if needed
    let overlay = document.getElementById('terraformWarningOverlay');
    if (!overlay) {
      await loadTerraformWarningOverlay();
      overlay = document.getElementById('terraformWarningOverlay');
    }

    const mediaCount = Number(options.media_count) || 0;
    const incompatibleCount = Number(options.incompatible_count) || 0;

    document.getElementById('terraformWarningMediaCount').textContent =
      mediaCount.toLocaleString();
    document.getElementById('terraformWarningIncompatibleCount').textContent =
      incompatibleCount.toLocaleString();
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
      resolve('back_to_picker');
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
  if (document.getElementById('terraformProgressOverlay')) {
    return;
  }
  try {
    const response = await fetch('/fragments/terraformProgressOverlay.html?v=3');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
    wireFlowDetailsToggle('convert');
  } catch (error) {
    console.error('❌ Failed to load terraform progress overlay:', error);
  }
}

/**
 * Load terraform complete overlay
 */
function showTerraformCompleteDetailsSection(visible = true) {
  const section = document.getElementById('terraformCompleteDetailsSection');
  if (section) {
    section.style.display = visible ? 'block' : 'none';
  }
}

function populateTerraformCompleteActivityFeed({
  logPath = null,
  copyFromFlow = null,
} = {}) {
  const feed = getFlowActivityLogFeed('convertComplete');
  const sourceLines = copyFromFlow
    ? getFlowActivityLogFeed(copyFromFlow).getLines()
    : [];
  resetFlowDetailsPanel('convertComplete');
  if (sourceLines.length > 0) {
    feed.adoptLines(sourceLines);
  } else if (logPath) {
    feed.reset(logPath);
  }
  feed.setExpanded(false);
}

async function loadTerraformCompleteOverlay() {
  if (document.getElementById('terraformCompleteOverlay')) {
    return;
  }
  try {
    const response = await fetch('/fragments/terraformCompleteOverlay.html?v=3');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
    wireFlowDetailsToggle('convertComplete');
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

    wireFlowDetailsToggle('convertComplete');

    document.getElementById('terraformCompleteProcessed').textContent =
      results.processed.toLocaleString();
    document.getElementById('terraformCompleteDuplicates').textContent =
      results.duplicates.toLocaleString();
    document.getElementById('terraformCompleteSkipped').textContent =
      (Number(results.errors) || 0).toLocaleString();

    const processed = Number(results.processed) || 0;
    const statusEl = document.getElementById('terraformCompleteStatusText');
    if (statusEl) {
      statusEl.textContent = `Converted ${processed.toLocaleString()} file${
        processed === 1 ? '' : 's'
      } to your library.`;
    }

    populateTerraformCompleteActivityFeed({
      logPath: results.log_path,
      copyFromFlow: 'convert',
    });
    showTerraformCompleteDetailsSection(true);

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

const TERRAFORM_PHASE_STEPS = {
  convert: { step: 1, label: 'Converting files' },
  folders: { step: 2, label: 'Cleaning folders' },
  audit: { step: 3, label: 'Final verification' },
};

function formatTerraformStepStatus(phase, payload = {}) {
  const step = TERRAFORM_PHASE_STEPS[phase] || TERRAFORM_PHASE_STEPS.convert;
  let suffix = '';
  if (
    phase === 'convert' &&
    Number.isFinite(Number(payload.current)) &&
    Number.isFinite(Number(payload.total)) &&
    Number(payload.total) > 0
  ) {
    suffix = ` (${Number(payload.current).toLocaleString()} / ${Number(payload.total).toLocaleString()})`;
  }
  if (phase === 'audit' && payload.status === 'failed') {
    return `Step ${step.step} of 3: ${step.label} failed`;
  }
  return `Step ${step.step} of 3: ${step.label}${suffix}`;
}

const CONVERT_OS_PRIMARY_MESSAGE =
  'Unable to convert primary OS directories. Pick another folder to continue.';

async function fetchTerraformPreflight(path) {
  const response = await fetch('/api/library/terraform/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library_path: path }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.convert_blocked) {
      return { convert_blocked: true };
    }
    throw new Error(data.error || 'Failed to scan folder');
  }
  return data;
}

async function showTerraformPoorCandidateDialog(_warning = {}) {
  return await showDialog(
    'Are you sure?',
    '',
    [
      { text: 'Cancel', value: 'cancel', primary: false },
      { text: 'Go back', value: 'back_to_picker', primary: false },
      { text: 'Yes, convert', value: 'continue', primary: true },
    ],
    {
      htmlMessage:
        '<span class="dialog-message-warning">This may not be a good folder for conversion.</span>' +
        '<span class="dialog-message-body">This folder mixes photos and videos with many other files, subfolders, or workspace-related content. Please ensure that you\'ve selected the correct folder to convert.</span>',
    },
  );
}

/**
 * Execute terraform conversion (preflight → bad-folder speedbump → warning → convert → complete)
 * @param {Object} options - { path: string, media_count: number }
 */
async function executeTerraformFlow(options = {}) {
  try {
    const { path } = options;
    if (!path) {
      throw new Error('No folder selected');
    }

    const preflight = await fetchTerraformPreflight(path);
    if (preflight.convert_blocked) {
      showToast(CONVERT_OS_PRIMARY_MESSAGE);
      return 'back_to_picker';
    }

    const mediaCount = Number(preflight.media_count) || 0;
    if (mediaCount <= 0) {
      showToast('No supported photos or videos found in this folder.');
      return false;
    }

    const continuePreview = await showTerraformPreviewDialog({
      path,
      photo_count: Number(preflight.photo_count) || 0,
      video_count: Number(preflight.video_count) || 0,
      estimated_display: preflight.estimated_display || 'calculating...',
    });

    if (continuePreview === 'back_to_picker') {
      return 'back_to_picker';
    }

    if (!continuePreview) {
      return false;
    }

    if (preflight.convert_folder_warning?.show) {
      const candidateChoice = await showTerraformPoorCandidateDialog(
        preflight.convert_folder_warning,
      );
      if (candidateChoice === 'back_to_picker') {
        return 'back_to_picker';
      }
      if (candidateChoice !== 'continue') {
        return false;
      }
    }

    const continueWarning = await showTerraformWarningDialog({
      media_count: mediaCount,
      incompatible_count: Number(preflight.non_media_count) || 0,
      estimated_time: preflight.estimated_display || 'calculating...',
    });

    if (continueWarning === 'back_to_picker') {
      return 'back_to_picker';
    }

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
    beginTerraformProgressUi(preflight);
    document.getElementById('terraformProgressProcessed').textContent = '0';
    document.getElementById('terraformProgressDuplicates').textContent = '0';
    document.getElementById('terraformProgressSkipped').textContent = '0';

    const terraformAbort = new AbortController();
    terraformProgressState.abortController = terraformAbort;

    // Start SSE
    const response = await fetch('/api/library/terraform', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: path }),
      signal: terraformAbort.signal,
    });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to start conversion');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';

    let processed = 0;
    let duplicates = 0;
    let errors = 0;
    let log_path = '';
    let dbPath = null;
    let completed = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        if (line.startsWith('event: ')) {
          currentEvent = line.substring(7).trim();
          continue;
        }

        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.substring(6));
          const eventType = currentEvent;
          currentEvent = 'message';

          if (eventType === 'error') {
            throw new Error(data.error || 'Conversion failed');
          }

          if (eventType === 'phase') {
            const statusEl = document.getElementById('terraformProgressStatus');
            if (statusEl && data.phase) {
              setImportSpinnerStatus(
                statusEl,
                formatTerraformStepStatus(data.phase, data),
              );
            }
            if (data.status === 'starting' && data.phase) {
              getFlowActivityLogFeed('convert').append(
                formatTerraformStepStatus(data.phase, data),
              );
            }
            const secondaryStatus = document.getElementById(
              'terraformProgressSecondaryStatus',
            );
            if (secondaryStatus && data.phase === 'audit') {
              secondaryStatus.textContent =
                data.status === 'complete'
                  ? 'Final verification complete'
                  : 'Verifying converted library before opening it…';
            } else {
              syncTerraformProgressRemainingDisplay();
            }
            continue;
          }

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
            document.getElementById('terraformProgressSkipped').textContent =
              errors.toLocaleString();
          }
          if (data.log_path) {
            log_path = data.log_path;
          }
          if (data.db_path) {
            dbPath = data.db_path;
          }

          if (eventType === 'complete') {
            completed = true;
          } else if (data.total) {
            const statusEl = document.getElementById('terraformProgressStatus');
            setImportSpinnerStatus(
              statusEl,
              formatTerraformStepStatus('convert', data),
            );
            syncTerraformProgressRemainingDisplay();
          }
        }
      }
    }

    if (!completed || !dbPath) {
      throw new Error('Conversion did not complete');
    }

    endTerraformProgressUi();
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
    if (error?.name !== 'AbortError') {
      showToast(`Terraform failed: ${error.message}`);
    }

    endTerraformProgressUi();
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
  state.libraryPath = null;
  state.selectedPhotos.clear();
  state.lastClickedIndex = null;
  resetPhotoFilters();
  const datePickerContainer = document.querySelector('.date-picker');
  if (datePickerContainer) {
    datePickerContainer.style.visibility = 'hidden';
  }
  renderFirstRunEmptyState();
  updateFilterChipRailVisibility();
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

  return await switchToLibraryWithBlockingNormalize(
    libraryPath,
    createResult.db_path,
  );
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
  const waitBeforeRetry = (ms) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }

      const timeoutId = window.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        window.clearTimeout(timeoutId);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch('/api/library/make-perfect/scan?verify=1', {
        signal,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to scan recovered library');
      }

      const op = data.operations || {};
      const rawSummary = op.summary || data.summary || {};
      const details = op.details || data.details || {};
      const signal_summary = normalizeCleanerSignalCounts(rawSummary);
      const supported_media_files = Math.max(
        0,
        Number(data.supported_media_files ?? fallback.media_count ?? 0),
      );
      const buckets = reduceOpenFolderRecoveryBuckets(signal_summary, {
        supportedMediaCount: supported_media_files,
      });
      const mediaFiles = buckets[0]?.value ?? 0;
      const pending_total = getOpenFolderRecoveryPendingTotal(signal_summary);
      return {
        signal_summary,
        supported_media_files,
        pending_total,
        /** Winners (M − duplicates), for body copy */
        media_files: mediaFiles,
        duplicate_count: signal_summary.duplicates,
        incompatible_count: signal_summary.unsupported_files,
        cleanup_count:
          signal_summary.metadata_cleanup +
          signal_summary.folder_cleanup +
          signal_summary.database_repairs,
        estimated_time: fallback.media_eta || 'less than a minute',
        scan_succeeded: true,
        details,
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw error;
      }
      lastError = error;
      if (attempt === 0) {
        await waitBeforeRetry(150);
      }
    }
  }

  console.warn('⚠️ Failed to scan recovered media:', lastError);
  return {
    signal_summary: null,
    supported_media_files: 0,
    pending_total: 0,
    media_files: 0,
    duplicate_count: 0,
    incompatible_count: 0,
    cleanup_count: 0,
    estimated_time: fallback.media_eta || 'less than a minute',
    scan_succeeded: false,
    scan_error: lastError?.message || 'Failed to scan recovered library',
  };
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

    if (!recoverMediaInfo.pending_total) {
      await loadAndRenderPhotosCommitted(hydrationGeneration);
      finishLibraryRecoveryJourney();
      return true;
    }

    const mediaCount = Number(recoverMediaInfo.media_files || 0);
    const mediaCountLabel = mediaCount.toLocaleString();
    const mediaFileLabel = mediaCount === 1 ? 'media file' : 'media files';
    const addClosingPhrase =
      mediaCount === 1 ? 'Add the file' : 'Add the files';
    const pendingLabel = Number(recoverMediaInfo.pending_total || 0).toLocaleString();
    const etaLabel = formatDurationEstimateForItShouldTake(
      recoverMediaInfo.estimated_time,
    );
    const scanCompleteBody =
      mediaCount > 0
        ? `This folder has ${mediaCountLabel} ${mediaFileLabel} that could be added to your library. It should take ${etaLabel}. ${addClosingPhrase} or go directly to your library.`
        : `This folder has ${pendingLabel} pending library tasks. It should take ${etaLabel}. Continue with cleanup or go directly to your library.`;
    const scanCompleteStats = recoverMediaInfo.signal_summary
      ? reduceOpenFolderRecoveryBuckets(recoverMediaInfo.signal_summary, {
          supportedMediaCount: recoverMediaInfo.supported_media_files,
        }).map((b) => ({ label: b.label, value: b.value }))
      : [];
    const preflightWinnersToFile = Math.max(0, mediaCount);
    const recoverMediaChoice = await promptLibraryRecoveryDock({
      title: 'Scan complete',
      body: scanCompleteBody,
      stats: scanCompleteStats,
      showWinnersLine: true,
      winnersFiled: 0,
      winnersToFile: preflightWinnersToFile,
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
      body:
        mediaCount > 0
          ? `Repairing your library and adding ${mediaCountLabel} ${mediaFileLabel} to your database. Stay on this screen until it finishes.`
          : `Repairing your library (${pendingLabel} pending tasks). Stay on this screen until it finishes.`,
      omitStats: true,
      showWinnersLine: true,
      winnersFiled: 0,
      winnersToFile: preflightWinnersToFile,
      showCloseButton: false,
      actionsJustify: 'flex-end',
      actions: buildOpenFolderRecoveryCompletionActions({
        onCancel: dismissRebuild,
        continueDisabled: true,
      }),
    });

    const statsEl = document.getElementById('libraryRecoveryStats');
    const statusEl = document.getElementById('libraryRecoveryStatus');
    const debugEl = document.getElementById('libraryRecoveryCleanerDebug');
    const scorecard = createScorecardController({ statsEl, statusEl, debugEl });
    const runtime = createOpenFolderRecoveryRuntime({
      scorecard,
      signalCounts: recoverMediaInfo.signal_summary,
      supportedMediaCount: recoverMediaInfo.supported_media_files,
    });
    await runtime.setSignalCounts(recoverMediaInfo.signal_summary);
    scorecard.setWinnersProgress({
      winnersFiled: 0,
      winnersToFile: preflightWinnersToFile,
    });
    scorecard.setStatus('Preparing library', { spinner: false });

    try {
      await streamMakeLibraryPerfect({
        signal: rebuildAbort.signal,
        onProgress: createOpenFolderRecoveryStreamProgressHandler({
          scorecard,
          runtime,
        }),
      });
      const completionChoice = await finishOpenFolderRecoverySuccess({
        runtime,
        scorecard,
        loadLibrary: async () => {
          await loadAndRenderPhotosCommitted(hydrationGeneration);
        },
      });
      runtime.destroy();
      scorecard.destroy();
      finishLibraryRecoveryJourney();
      if (completionChoice === 'continue') {
        showToast('Library ready');
      }
      return true;
    } catch (error) {
      runtime.destroy();
      scorecard.destroy();
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

// =============================================================================
// LEGACY open-library flow (dialogs + recovery dock + streaming rebuild)
// -----------------------------------------------------------------------------
// Do not call from product UI. For DevTools / manual comparison only
// (`window.__browseSwitchLibraryLegacyAfterCheck`). Production open-library:
// `openExistingLibrary`. Legacy recover picker: `browseSwitchLibraryLegacy`.
// Delete with `runLibraryRecoveryJourney` when unified path is fully verified.
//
// DevTools: `await __browseSwitchLibraryLegacyAfterCheck(selectedPath, checkResult)`
// (`checkResult` = JSON from POST /api/library/check).
// =============================================================================
async function browseSwitchLibraryLegacyAfterCheck(selectedPath, checkResult) {
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
}

if (typeof window !== 'undefined') {
  window.__browseSwitchLibraryLegacyAfterCheck = browseSwitchLibraryLegacyAfterCheck;
}

/**
 * After the server library is set: blocking make-perfect (same as Clean), then grid.
 */
async function runSwitchDeferReloadNormalizeAndLoad(libraryPath, dbPath) {
  const folderName = libraryPath.split('/').filter(Boolean).pop() || 'library';
  const switched = await switchToLibrary(libraryPath, dbPath, {
    deferPhotoReload: true,
    skipTransitionOverlay: true,
    suppressSuccessToast: true,
    suppressFailureToast: false,
  });

  if (!switched) {
    return false;
  }

  await requestMakeLibraryPerfect();
  await loadAndRenderPhotos(false, { throwOnError: true });
  showToast(`Opened ${folderName}`);
  return true;
}

// -----------------------------------------------------------------------------
// INVARIANT — Product library actions
//
// • Open: `openExistingLibrary` only (readable DB required).
// • Convert: `convertToLibrary` (media folder → library; destructive).
// • Legacy recover picker: `browseSwitchLibraryLegacy` (DevTools only).
// -----------------------------------------------------------------------------

const CONVERT_TO_LIBRARY_PICKER_SUBTITLE =
  'Select a folder containing media files to convert into a new library.\nWARNING: This process permanently renames and reorganizes media files, and moves incompatible files to a trash folder for review.';

async function loadConvertToLibraryCompleteOverlay() {
  if (document.getElementById('convertToLibraryCompleteOverlay')) {
    return;
  }

  try {
    const response = await fetch('/fragments/convertToLibraryCompleteOverlay.html');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    console.error('❌ Failed to load convert-to-library complete overlay:', error);
    throw error;
  }
}

/**
 * Stub completion screen shown after convert (real conversion not wired yet).
 */
async function showConvertToLibraryCompleteDialog(options = {}) {
  return new Promise(async (resolve) => {
    await loadConvertToLibraryCompleteOverlay();

    const overlay = document.getElementById('convertToLibraryCompleteOverlay');
    const pathEl = document.getElementById('convertToLibraryCompletePath');
    if (!overlay || !pathEl) {
      resolve(false);
      return;
    }

    pathEl.textContent = options.path || '';

    const closeBtn = document.getElementById('convertToLibraryCompleteCloseBtn');
    const doneBtn = document.getElementById('convertToLibraryCompleteDoneBtn');

    const handleDone = () => {
      overlay.style.display = 'none';
      resolve(true);
    };

    if (closeBtn) closeBtn.onclick = handleDone;
    if (doneBtn) doneBtn.onclick = handleDone;

    overlay.style.display = 'flex';
  });
}

/**
 * Convert a folder of media files into a photo library (destructive).
 * Product entry point — currently stubs through to the completion screen.
 */
async function convertToLibrary() {
  try {
    while (true) {
      const selectedPath = await FolderPicker.show({
        intent: FolderPicker.INTENT.CONVERT_TO_LIBRARY,
        title: 'Convert to library',
        subtitle: CONVERT_TO_LIBRARY_PICKER_SUBTITLE,
      });

      if (!selectedPath) {
        return false;
      }

      const result = await executeTerraformFlow({ path: selectedPath });
      if (result !== 'back_to_picker') {
        return result;
      }
    }
  } catch (error) {
    console.error('❌ Failed to convert to library:', error);
    showToast(`Error: ${error.message}`);
    return false;
  }
}

/**
 * Open an existing library folder that already has a readable database.
 * Product entry point for More menu, first-run, error recovery, etc.
 */
async function openExistingLibrary() {
  try {
    closeSwitchLibraryOverlay();

    const selectedPath = await FolderPicker.show({
      intent: FolderPicker.INTENT.OPEN_EXISTING_LIBRARY,
      title: 'Open library',
      subtitle: 'Select a library folder to open.',
    });

    if (!selectedPath) {
      return false;
    }

    await showLibraryTransitionOverlay({
      title: 'Opening library',
      message: 'Checking your library and preparing to load photos.',
    });

    let checkResult;
    try {
      const checkResponse = await fetch('/api/library/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ library_path: selectedPath, fast: true }),
      });
      checkResult = await checkResponse.json();

      if (!checkResponse.ok) {
        throw new Error(checkResult.error || 'Failed to inspect selected folder');
      }

      if (checkResult.has_openable_db) {
        const opened = await switchToLibrary(selectedPath, checkResult.db_path, {
          skipTransitionOverlay: true,
        });
        if (opened) {
          hideLibraryTransitionOverlay();
        }
        return opened;
      }

      if (checkResult.has_db) {
        showToast(
          checkResult.db_message ||
            "Can't open library: database is damaged or incompatible.",
        );
      } else {
        showToast('No photo library found in this folder.');
      }
      return false;
    } catch (error) {
      console.error('❌ Failed to open library:', error);
      showToast(`Error: ${error.message}`);
      return false;
    } finally {
      if (!state.libraryTransitionActive) {
        hideLibraryTransitionOverlay();
      }
    }
  } catch (error) {
    console.error('❌ Failed to open library:', error);
    showToast(`Error: ${error.message}`);
    hideLibraryTransitionOverlay();
    return false;
  }
}

/**
 * Unified open-library path: optional recover-database, then switch + blocking
 * make-perfect + grid. Legacy reference: `browseSwitchLibraryLegacyAfterCheck`.
 */
async function openLibraryFromBrowseUnified(selectedPath, checkResult) {
  const scanCopy = window.LibraryRecoveryUI?.dock?.scanLibrary || {
    title: 'Scanning library',
    body: 'Reviewing the database and searching for available media.',
    statusText: 'Preparing your library',
    statusSpinner: true,
    showCloseButton: true,
  };
  const scanCompleteCopy = window.LibraryRecoveryUI?.dock?.scanComplete || {
    title: 'Scan complete',
    buildBody({ mediaCountLabel, mediaFileLabel, etaLabel, addClosingPhrase }) {
      return `This folder has ${mediaCountLabel} ${mediaFileLabel} that could be added to your library. It should take ${etaLabel}. ${addClosingPhrase} or go directly to your library.`;
    },
    stats: [
      { label: 'Media files', key: 'media_files' },
      { label: 'Duplicates', key: 'duplicate_count' },
      { label: 'Unsupported', key: 'incompatible_count' },
    ],
    actions: [
      { text: 'Cancel', value: 'cancel', primary: false },
      { text: 'See my library', value: 'see_library', primary: false },
      { text: 'Add media', value: 'add_media', primary: true },
    ],
  };
  const rebuildingCopy = window.LibraryRecoveryUI?.dock?.rebuildingLibrary || {
    title: 'Rebuilding library',
    buildBody({ mediaCountLabel, mediaFileLabel }) {
      return `Repairing your library and adding ${mediaCountLabel} ${mediaFileLabel} to your database. Stay on this screen until it finishes.`;
    },
    actionsJustify: 'flex-end',
    actions: [
      { text: 'Cancel', value: 'cancel', primary: false },
      { text: 'Continue', value: 'continue', primary: true, disabled: true },
    ],
    showCloseButton: false,
  };
  const generalPurposeFolderWarningCopy =
    window.LibraryRecoveryUI?.dialogs?.generalPurposeFolderWarning || {
      title: 'Use this folder for your library?',
      body: 'This folder has many non-media files. You can continue, or create a subfolder instead.',
    };
  const folderName = selectedPath.split('/').filter(Boolean).pop() || 'library';
  let dockFlowActive = false;
  let switchedGeneration = null;
  /** Set when user cancels the post-scan rebuild; avoids double hydrate on AbortError. */
  let openFolderRebuildCancelled = false;
  const finishDockFlow = () => {
    if (!dockFlowActive) {
      return;
    }
    dockFlowActive = false;
    finishLibraryRecoveryJourney();
  };

  try {
    if (checkResult.has_openable_db) {
      return await switchToLibrary(selectedPath, checkResult.db_path);
    }

    const recoverChoice = await showRecoverDatabaseDialog();
    if (recoverChoice !== 'continue') {
      return false;
    }

    if (checkResult.folder_warning?.show) {
      showToast(`Error: ${generalPurposeFolderWarningCopy.body}`);
      return false;
    }

    const recoverAbort = new AbortController();
    setLibraryRecoveryShellHidden(true);
    dockFlowActive = true;
    const dockShown = await showLibraryRecoveryDockCard({
      title: scanCopy.title,
      body: scanCopy.body,
      statusText: scanCopy.statusText,
      statusSpinner: scanCopy.statusSpinner,
      showCloseButton: scanCopy.showCloseButton,
      onClose: () => recoverAbort.abort(),
    });
    if (!dockShown) {
      finishDockFlow();
      showToast(`Error: ${scanCopy.title}`);
      return false;
    }

    const recoverResponse = await fetch('/api/library/recover-database', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: selectedPath }),
      signal: recoverAbort.signal,
    });
    const recoverResult = await recoverResponse.json();

    if (!recoverResponse.ok) {
      throw new Error(recoverResult.error || 'Failed to create library database');
    }

    if (recoverAbort.signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    await switchToLibrary(selectedPath, recoverResult.db_path, {
      deferPhotoReload: true,
      skipTransitionOverlay: true,
      suppressSuccessToast: true,
      suppressFailureToast: true,
      throwOnError: true,
      signal: recoverAbort.signal,
    });
    switchedGeneration = state.libraryGeneration;

    const recoverMediaInfo = await scanRecoverMediaAfterOpen(
      {
        media_count: checkResult.media_count || 0,
        media_eta: checkResult.media_eta || 'less than a minute',
      },
      { signal: recoverAbort.signal },
    );

    if (recoverMediaInfo.scan_succeeded === false) {
      try {
        if (switchedGeneration !== null) {
          await loadAndRenderPhotosCommitted(switchedGeneration);
        }
      } catch (hydrateErr) {
        console.error('❌ Failed to show library after scan failure:', hydrateErr);
        showToast(`Error: ${hydrateErr.message}`);
      }
      finishDockFlow();
      showToast(`Error: ${recoverMediaInfo.scan_error}`);
      return true;
    }

    const mediaCount = Number(recoverMediaInfo.media_files || 0);
    if ((recoverMediaInfo.pending_total || 0) > 0) {
      const mediaCountLabel = mediaCount.toLocaleString();
      const mediaFileLabel = mediaCount === 1 ? 'media file' : 'media files';
      const addClosingPhrase =
        mediaCount === 1 ? 'Add the file' : 'Add the files';
      const pendingLabel = Number(recoverMediaInfo.pending_total || 0).toLocaleString();
      const etaLabel = formatDurationEstimateForItShouldTake(
        recoverMediaInfo.estimated_time,
      );
      const scanCompleteBody =
        mediaCount > 0
          ? scanCompleteCopy.buildBody({
              mediaCountLabel,
              mediaFileLabel,
              etaLabel,
              addClosingPhrase,
            })
          : `This folder has ${pendingLabel} pending library tasks. It should take ${etaLabel}. Continue with cleanup or go directly to your library.`;
      const scanCompleteStats = recoverMediaInfo.signal_summary
        ? reduceOpenFolderRecoveryBuckets(recoverMediaInfo.signal_summary, {
            supportedMediaCount: recoverMediaInfo.supported_media_files,
          }).map((b) => ({ label: b.label, value: b.value }))
        : (scanCompleteCopy.stats || []).map((stat) => ({
            label: stat.label,
            value: Number(recoverMediaInfo[stat.key] ?? 0),
          }));
      const preflightWinnersToFile = Math.max(0, mediaCount);
      const scanCompleteChoice = await promptLibraryRecoveryDock({
        title: scanCompleteCopy.title,
        body: scanCompleteBody,
        stats: scanCompleteStats,
        showWinnersLine: true,
        winnersFiled: 0,
        winnersToFile: preflightWinnersToFile,
        actions: scanCompleteCopy.actions,
      });

      if (scanCompleteChoice !== 'add_media') {
        try {
          if (switchedGeneration !== null) {
            await loadAndRenderPhotosCommitted(switchedGeneration);
          }
        } catch (hydrateErr) {
          console.error(
            '❌ Failed to show library after scan-complete choice:',
            hydrateErr,
          );
          showToast(`Error: ${hydrateErr.message}`);
        }
        finishDockFlow();
        return true;
      }

      const rebuildAbort = new AbortController();
      const dismissUnifiedRebuild = async () => {
        if (openFolderRebuildCancelled) {
          return;
        }
        openFolderRebuildCancelled = true;
        rebuildAbort.abort();
        try {
          if (switchedGeneration !== null) {
            await loadAndRenderPhotosCommitted(switchedGeneration);
          }
        } catch (hydrateErr) {
          console.warn('Hydrate after rebuild cancel:', hydrateErr);
        }
        finishDockFlow();
      };

      const rebuildingBody =
        mediaCount > 0
          ? rebuildingCopy.buildBody({
              mediaCountLabel,
              mediaFileLabel,
            })
          : `Repairing your library (${pendingLabel} pending tasks). Stay on this screen until it finishes.`;
      const rebuildingShown = await showLibraryRecoveryDockCard({
        title: rebuildingCopy.title,
        body: rebuildingBody,
        omitStats: true,
        showWinnersLine: true,
        winnersFiled: 0,
        winnersToFile: preflightWinnersToFile,
        showCloseButton: false,
        actionsJustify: rebuildingCopy.actionsJustify,
        actions: buildOpenFolderRecoveryCompletionActions({
          onCancel: dismissUnifiedRebuild,
          continueDisabled: true,
        }),
      });
      if (!rebuildingShown) {
        finishDockFlow();
        showToast(`Error: ${rebuildingCopy.title}`);
        return false;
      }

      const statsEl = document.getElementById('libraryRecoveryStats');
      const statusEl = document.getElementById('libraryRecoveryStatus');
      const debugEl = document.getElementById('libraryRecoveryCleanerDebug');
      const scorecard = createScorecardController({ statsEl, statusEl, debugEl });
      const runtime = createOpenFolderRecoveryRuntime({
        scorecard,
        signalCounts: recoverMediaInfo.signal_summary,
        supportedMediaCount: recoverMediaInfo.supported_media_files,
      });
      await runtime.setSignalCounts(recoverMediaInfo.signal_summary);
      scorecard.setWinnersProgress({
        winnersFiled: 0,
        winnersToFile: preflightWinnersToFile,
      });
      scorecard.setStatus('Preparing library', { spinner: true });

      try {
        try {
          await streamMakeLibraryPerfect({
            signal: rebuildAbort.signal,
            onProgress: createOpenFolderRecoveryStreamProgressHandler({
              scorecard,
              runtime,
            }),
          });
        } catch (streamErr) {
          if (
            streamErr?.name === 'AbortError' ||
            rebuildAbort.signal.aborted ||
            openFolderRebuildCancelled
          ) {
            throw streamErr;
          }
          console.warn(
            'Streaming cleanup failed; falling back to blocking cleanup:',
            streamErr,
          );
          scorecard.setStatus('Finishing cleanup', { spinner: true });
          await requestMakeLibraryPerfect({ signal: rebuildAbort.signal });
        }
        const completionChoice = await finishOpenFolderRecoverySuccess({
          runtime,
          scorecard,
          loadLibrary: async () => {
            if (switchedGeneration !== null) {
              await loadAndRenderPhotosCommitted(switchedGeneration);
            } else {
              await loadAndRenderPhotos(false, { throwOnError: true });
            }
          },
        });
        runtime.destroy();
        scorecard.destroy();
        finishDockFlow();
        if (completionChoice === 'continue') {
          showToast(`Opened ${folderName}`);
        }
        return true;
      } finally {
        runtime.destroy();
        scorecard.destroy();
      }
    } else {
      finishDockFlow();
      await showLibraryTransitionOverlay({
        title: 'Cleaning library',
        message:
          'Normalizing your library. Please keep this window open until it finishes.',
      });
      await requestMakeLibraryPerfect();
    }

    finishDockFlow();
    if (switchedGeneration !== null) {
      await loadAndRenderPhotosCommitted(switchedGeneration);
    } else {
      await loadAndRenderPhotos(false, { throwOnError: true });
    }
    showToast(`Opened ${folderName}`);
    return true;
  } catch (error) {
    finishDockFlow();
    if (error.name === 'AbortError') {
      if (openFolderRebuildCancelled) {
        return true;
      }
      if (switchedGeneration !== null) {
        try {
          await loadAndRenderPhotosCommitted(switchedGeneration);
          return true;
        } catch (hydrateErr) {
          console.error('❌ Failed to hydrate aborted recovery flow:', hydrateErr);
          showToast(`Error: ${hydrateErr.message}`);
        }
      }
      return false;
    }
    console.error('❌ Open library failed:', error);
    showToast(`Error: ${error.message}`);
    return false;
  } finally {
    finishDockFlow();
    hideLibraryTransitionOverlay();
  }
}

/**
 * LEGACY — Open library with recover/create fallback when no readable DB exists.
 * Disconnected from product UI. DevTools: `await browseSwitchLibraryLegacy()`
 */
async function browseSwitchLibraryLegacy() {
  try {
    closeSwitchLibraryOverlay();

    const selectedPath = await FolderPicker.show({
      intent: FolderPicker.INTENT.GENERIC_FOLDER_SELECTION,
      title: 'Open library (legacy)',
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

    setOpenLibraryModalHandoffShellHidden(false);

    return await openLibraryFromBrowseUnified(selectedPath, checkResult);
  } catch (error) {
    console.error('❌ Failed to browse library (legacy):', error);
    setOpenLibraryModalHandoffShellHidden(false);
    showToast(`Error: ${error.message}`);
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.__browseSwitchLibraryLegacy = browseSwitchLibraryLegacy;
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
 * Create new library with combined name + location step (SS3), then create → import
 */
async function createNewLibraryWithName(dialogOptions = {}) {
  try {
    let libraryName = null;
    let selectedParentPath = null;
    let duplicateNameError = null;

    while (true) {
      const dialogResult = await showCreateLibraryDialog({
        ...dialogOptions,
        subtitle:
          dialogOptions.subtitle ||
          'To add photos, first create a new library. Give your library a name and location to continue.',
        initialLibraryName: libraryName,
        duplicateNameError,
      });

      if (
        !dialogResult ||
        (typeof dialogResult === 'object' && dialogResult.action === 'cancel')
      ) {
        return false;
      }

      libraryName = dialogResult.name;
      selectedParentPath = dialogResult.parentPath;
      duplicateNameError = null;
      prefetchPhotoPickerFragment();

      const taken = await libraryFolderNameExistsAtParent(
        selectedParentPath,
        libraryName,
      );
      if (taken) {
        duplicateNameError = `A folder named "${libraryName}" already exists here`;
        continue;
      }

      const fullLibraryPath = buildFullLibraryPath(
        selectedParentPath,
        libraryName,
      );

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
          duplicateNameError = `A folder named "${libraryName}" already exists here`;
          continue;
        }

        throw new Error(createResult.error || 'Failed to create library');
      }

      const switched = await switchToLibrary(
        fullLibraryPath,
        createResult.db_path,
        {
          skipTransitionOverlay: true,
          deferPhotoReload: true,
        },
      );
      if (!switched) {
        hideCreateLibraryOverlay();
        return false;
      }

      state.photos = [];
      state.hasDatabase = true;
      renderEmptyLibraryState();
      enableAppBarButtons();

      await triggerImport({
        onPickerVisible: () => hideCreateLibraryOverlay(),
      });
      return true;
    }
  } catch (error) {
    hideCreateLibraryOverlay();
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
    state.libraryPath = libraryPath;
    resetPhotoFilters();

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

/**
 * Switch to a library, run blocking POST /api/library/make-perfect (same engine as
 * Clean library), then load the photo grid.
 */
async function switchToLibraryWithBlockingNormalize(libraryPath, dbPath) {
  await showLibraryTransitionOverlay({
    title: 'Cleaning library',
    message:
      'Normalizing your library. Please keep this window open until it finishes.',
  });

  try {
    return await runSwitchDeferReloadNormalizeAndLoad(libraryPath, dbPath);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw error;
    }
    console.error('❌ Library normalize after switch failed:', error);
    showToast(`Error: ${error.message}`);
    return false;
  } finally {
    hideLibraryTransitionOverlay();
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
          'To add photos, first create a new library. Give your library a name and location to continue.',
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

function getImportEstimateDisplay(scanResult) {
  if (scanResult?.estimated_display) {
    return scanResult.estimated_display;
  }
  if (Number.isFinite(Number(scanResult?.estimated_seconds))) {
    return formatAboutDurationFromSeconds(scanResult.estimated_seconds);
  }
  return 'less than a minute';
}

function getImportMediaKindFromPath(filePath) {
  if (!filePath) {
    return null;
  }
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) {
    return null;
  }
  const ext = filePath.slice(dot).toLowerCase();
  if (IMPORT_VIDEO_EXTENSIONS.has(ext)) {
    return 'video';
  }
  if (IMPORT_PHOTO_EXTENSIONS.has(ext)) {
    return 'photo';
  }
  return null;
}

function countImportMediaFromPaths(filePaths) {
  let photos = 0;
  let videos = 0;
  for (const filePath of filePaths) {
    const kind = getImportMediaKindFromPath(filePath);
    if (kind === 'photo') {
      photos += 1;
    } else if (kind === 'video') {
      videos += 1;
    }
  }
  return { photos, videos };
}

function getImportPreflightCounts(scanResult) {
  const files = Array.isArray(scanResult?.files) ? scanResult.files : [];
  const total = Number(scanResult?.total_count ?? files.length ?? 0);
  let photos = Number(scanResult?.photo_count);
  let videos = Number(scanResult?.video_count);

  const countsMissing = !Number.isFinite(photos) || !Number.isFinite(videos);
  const countsZeroWithFiles = photos === 0 && videos === 0 && total > 0;

  if ((countsMissing || countsZeroWithFiles) && files.length > 0) {
    const derived = countImportMediaFromPaths(files);
    photos = derived.photos;
    videos = derived.videos;
  }

  return {
    photos: Number.isFinite(photos) ? photos : 0,
    videos: Number.isFinite(videos) ? videos : 0,
    total,
  };
}

function setImportOverlayTitle(title = IMPORT_OVERLAY_TITLE) {
  const titleEl = document.querySelector('#importOverlay .import-title');
  if (titleEl) {
    titleEl.textContent = title;
  }
}

async function scanImportPaths(paths) {
  const response = await fetch('/api/import/scan-paths', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || 'Failed to scan paths');
  }

  return result;
}

async function runImportPreflightInOverlay(paths) {
  await loadImportOverlay();

  const overlay = document.getElementById('importOverlay');
  if (!overlay) {
    throw new Error('Import overlay unavailable');
  }

  importState.overlayPhase = 'scanning';
  setImportOverlayTitle();

  const explainerEl = document.getElementById('importExplainer');
  if (explainerEl) {
    explainerEl.style.display = 'none';
  }
  const detailsSection = document.getElementById('importDetailsSection');
  if (detailsSection) {
    detailsSection.style.display = 'none';
  }
  resetFlowDetailsPanel('add');

  const preflightStats = document.getElementById('importPreflightStats');
  const runtimeStats = document.getElementById('importStats');
  if (preflightStats) {
    preflightStats.style.display = 'grid';
  }
  if (runtimeStats) {
    runtimeStats.style.display = 'none';
  }
  setImportDebugPreflightCounts(0, 0, 0);
  setImportActionButtons({
    showCancel: true,
    showContinue: true,
    continueDisabled: true,
  });

  const statusEl = document.getElementById('importStatusText');
  if (statusEl) {
    setImportSpinnerStatus(statusEl, 'Scanning library…');
  }

  showImportOverlay();

  const orientStartedAt = Date.now();
  let scanResult;
  try {
    scanResult = await scanImportPaths(paths);
  } catch (error) {
    await closeImportOverlay();
    throw error;
  }

  await waitPreflightScoreboardOrientDelay(orientStartedAt);

  if ((scanResult.total_count || 0) === 0) {
    await closeImportOverlay();
    showToast('No media files found', null);
    return null;
  }

  const { photos, videos, total } = getImportPreflightCounts(scanResult);
  await animateImportPreflightCounts(
    photos,
    videos,
    total,
    CLEAN_LIBRARY_PREFLIGHT_COUNT_ANIMATION_MS,
  );

  importState.preflight = scanResult;
  importState.estimatedDisplay = getImportEstimateDisplay(scanResult);
  importState.estimatedSeconds = Number(scanResult.estimated_seconds) || null;
  importState.overlayPhase = 'preflight';

  if (statusEl) {
    statusEl.textContent = `Time required: ${importState.estimatedDisplay}`;
  }
  setImportActionButtons({
    showCancel: true,
    showContinue: true,
    continueDisabled: false,
  });

  const confirmed = await new Promise((resolve) => {
    importState.preflightResolve = resolve;
  });

  importState.preflightResolve = null;
  importState.preflight = null;
  importState.overlayPhase = null;

  if (!confirmed) {
    await closeImportOverlay();
    return null;
  }

  return scanResult;
}

/**
 * Scan paths in-overlay, show preflight, then import on Continue.
 */
async function scanAndImport(paths) {
  try {
    const result = await runImportPreflightInOverlay(paths);
    if (!result) {
      return;
    }
    await startImportFromPaths(result.files);
  } catch (error) {
    console.error('❌ Failed to scan paths:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Scan selected paths and show confirmation
 */
async function scanAndConfirmImport(paths) {
  return scanAndImport(paths);
}

/**
 * Start import process from file paths (SSE streaming version)
 */
async function startImportFromPaths(filePaths) {
  let reader = null;
  let internalAbort = null;
  let callerAbortListener = null;

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

    internalAbort = new AbortController();
    if (controller.signal.aborted) {
      internalAbort.abort();
    } else {
      callerAbortListener = () => internalAbort.abort();
      controller.signal.addEventListener('abort', callerAbortListener, {
        once: true,
      });
    }

    const cleanupCallerSignal = () => {
      if (callerAbortListener) {
        controller.signal.removeEventListener('abort', callerAbortListener);
        callerAbortListener = null;
      }
    };

    // Start SSE stream
    const response = await fetch('/api/photos/import-from-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: filePaths }),
      signal: internalAbort.signal,
    });

    if (!response.ok) {
      cleanupCallerSignal();
      throw new Error('Import request failed');
    }

    if (!response.body) {
      cleanupCallerSignal();
      throw new Error('Import stream unavailable');
    }

    // Handle SSE stream
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const teardown = async () => {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      try {
        internalAbort.abort();
      } catch {
        /* ignore */
      }
      cleanupCallerSignal();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const consumeImportChunk = async (chunk) => {
      const eventMatch = chunk.match(/^event: (.+)$/m);
      const dataMatch = chunk.match(/^data: (.+)$/m);

      if (!eventMatch || !dataMatch) {
        return false;
      }

      const event = eventMatch[1];
      const data = JSON.parse(dataMatch[1]);
      handleImportEvent(event, data);

      if (event === 'complete' || event === 'error') {
        await teardown();
        return true;
      }

      return false;
    };

    while (true) {
      let done;
      let value;
      try {
        ({ done, value } = await reader.read());
      } catch (readError) {
        if (
          controller.signal.aborted ||
          internalAbort.signal.aborted ||
          readError?.name === 'AbortError'
        ) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        throw readError;
      }

      if (value) {
        buffer += decoder.decode(value, { stream: !done });
      }

      let sep;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (chunk.trim() && (await consumeImportChunk(chunk))) {
          return;
        }
      }

      if (done) {
        if (buffer.trim() && (await consumeImportChunk(buffer))) {
          return;
        }
        break;
      }
    }
  } catch (error) {
    if (error.name === 'AbortError' || importState.cancelRequested) {
      return;
    }

    console.error('❌ Import failed:', error);
    showToast(`Import failed: ${error.message}`, null);
    await hideImportOverlay(false);
  } finally {
    if (internalAbort) {
      try {
        internalAbort.abort();
      } catch {
        /* ignore */
      }
    }
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    if (callerAbortListener && importState.abortController?.signal) {
      importState.abortController.signal.removeEventListener(
        'abort',
        callerAbortListener,
      );
    }
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

    setImportOverlayTitle();
    beginImportInflightUi();
    syncImportInflightStatus(0, importState.totalFiles);
  }

  if (event === 'progress') {
    importState.importedCount = data.imported || 0;
    importState.duplicateCount = data.duplicates || 0;
    importState.errorCount = data.errors || 0;
    const current = Number(data.current || 0);
    const total = Number(data.total || importState.totalFiles || 0);

    syncImportInflightStatus(current, total);
    setImportInflightCounts(
      importState.importedCount,
      importState.duplicateCount,
      importState.errorCount,
    );

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
      appendImportActivityLine(`${data.error_file}: ${data.error}`);
    }
  }

  // Handle rejection events
  if (event === 'rejected') {
    if (Number.isFinite(Number(data.imported))) {
      importState.importedCount = data.imported || 0;
    }
    if (Number.isFinite(Number(data.duplicates))) {
      importState.duplicateCount = data.duplicates || 0;
    }
    if (Number.isFinite(Number(data.errors))) {
      importState.errorCount = data.errors || 0;
    }

    const current = Number(data.current || 0);
    const total = Number(data.total || importState.totalFiles || 0);
    syncImportInflightStatus(current, total);
    setImportInflightCounts(
      importState.importedCount,
      importState.duplicateCount,
      importState.errorCount,
    );

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
    if (data.file && data.reason) {
      appendImportActivityLine(`${data.file}: ${data.reason}`);
    }
  }

  if (event === 'complete') {
    importState.importedCount = data.imported || 0;
    importState.duplicateCount = data.duplicates || 0;
    importState.errorCount = data.errors || 0;

    renderImportCompleteUi({
      hasErrors: (data.errors || 0) > 0,
      logPath: data.log_path || null,
    });

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
        state.libraryPath = null;
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
        state.libraryPath = status.library_path || null;
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
  wireFilterChipRail();
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
