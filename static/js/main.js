// Photo Viewer - Main Entry Point
const MAIN_JS_VERSION = 'v117';
console.log(`🚀 main.js loaded: ${MAIN_JS_VERSION}`);

// =====================
// STATE MANAGEMENT
// =====================

const state = {
  currentSortOrder: 'newest', // 'newest' or 'oldest'
  selectedPhotos: new Set(),
  photos: [],
  loading: false,
  lastClickedIndex: null, // For shift-select
  lightboxOpen: false,
  lightboxPhotoIndex: null, // Index of currently viewed photo in lightbox
  lightboxUITimeout: null, // Timeout for hiding UI
  deleteInProgress: false,
  hasMore: true, // For infinite scroll
  currentOffset: 0, // Current pagination offset
  navigateToMonth: null, // Month to navigate to after closing lightbox (e.g., '2025-12')
  hasDatabase: false, // Track whether database exists and is healthy
};

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
    if (errorMsg.includes('database_corrupted') || 
        errorMsg.includes('not a database') ||
        errorMsg.includes('malformed') ||
        errorMsg.includes('corrupt')) {
      console.error('🚨 Database corruption detected:', responseData.error);
      // Show rebuild dialog using existing critical error modal
      showCriticalErrorModal('db_corrupted', responseData.message || 'Database appears corrupted');
      return true;
    }
  }
  return false;
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
  const APP_BAR_VERSION = '45'; // Increment this when appBar changes
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

  // Fetch fragment
  return fetch('fragments/appBar.html?v=19')
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
    menuBtn.addEventListener('click', () => {
      console.log('🍔 Menu clicked');
    });
  }

  if (utilitiesBtn) {
    utilitiesBtn.addEventListener('click', (e) => {
      console.log('🔧 Utilities button clicked');
      e.stopPropagation();
      toggleUtilitiesMenu();
    });
  } else {
    console.warn('⚠️ Utilities button not found in app bar');
  }

  if (addPhotoBtn) {
    addPhotoBtn.addEventListener('click', () => {
      console.log('📸 Add photo clicked');
      triggerImport();
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      const count = state.selectedPhotos.size;
      console.log(`🗑️ APP BAR Delete clicked! Selected: ${count}`);

      if (count === 0) return;

      showDialogOld(
        'Delete Photos',
        `Are you sure you want to delete ${count} photo${
          count > 1 ? 's' : ''
        }?`,
        () => deletePhotos(Array.from(state.selectedPhotos))
      );
    });
  }

  const editDateBtn = document.getElementById('editDateBtn');
  if (editDateBtn) {
    editDateBtn.addEventListener('click', () => {
      const count = state.selectedPhotos.size;
      console.log('📅 APP BAR Edit Date clicked! Selected:', count);
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
        console.log('🔽 Sorting: Newest first');
      } else {
        sortIcon.textContent = 'hourglass_arrow_up';
        sortToggleBtn.title = 'Oldest first';
        console.log('🔼 Sorting: Oldest first');
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
    }

    console.log(`📅 Loaded ${data.years.length} years`);
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
  const utilityItems = [
    'cleanOrganizeBtn',
    'rebuildDatabaseBtn',
    'removeDuplicatesBtn',
    'rebuildThumbnailsBtn',
  ];

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

    console.log(`📅 Jumping to: ${targetMonth}`);

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
      console.log(`🔍 Finding nearest month to ${targetMonth}...`);

      try {
        const nearestResponse = await fetch(
          `/api/photos/nearest_month?month=${targetMonth}&sort=${state.currentSortOrder}`
        );
        const nearestData = await nearestResponse.json();

        if (!nearestData.nearest_month) {
          console.log('❌ No photos found in database');
          return;
        }

        const actualMonth = nearestData.nearest_month;
        console.log(`📍 Nearest month with photos: ${actualMonth}`);

        // Check if that section exists
        const actualSection = document.getElementById(`month-${actualMonth}`);
        if (actualSection) {
          // Position month label near top with small offset for app bar
          const appBarHeight = 60;
          const targetY = actualSection.offsetTop - appBarHeight - 20; // 20px padding
          window.scrollTo({ top: targetY, behavior: 'smooth' });
        } else {
          console.log(
            `⚠️ Month ${actualMonth} not in DOM yet - may not have photos`
          );
        }
      } catch (error) {
        console.error('❌ Error finding nearest month:', error);
      }
    }
  };

  monthPicker.addEventListener('change', handleDateChange);
  yearPicker.addEventListener('change', handleDateChange);

  // Setup IntersectionObserver to update picker based on scroll position
  const observer = new IntersectionObserver(
    (entries) => {
      // Find the most visible month section
      let mostVisible = null;
      let maxRatio = 0;

      entries.forEach((entry) => {
        if (entry.intersectionRatio > maxRatio) {
          maxRatio = entry.intersectionRatio;
          mostVisible = entry.target;
        }
      });

      // Update picker to match visible month
      if (mostVisible && maxRatio > 0.1) {
        // At least 10% visible
        const monthId = mostVisible.dataset.month; // e.g., "2025-12"
        if (monthId) {
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
      }
    },
    {
      threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], // Track visibility at multiple points
      rootMargin: '-60px 0px 0px 0px', // Offset for app bar height
    }
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
  console.log(`❌ Deselected all (${selectedCards.length} photos)`);
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
  console.log('✅ Dialog confirm clicked');
  hideDialog();
  if (currentDialogCallback) {
    console.log('🔥 Executing callback');
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
      console.log('✅ Critical error modal loaded');
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
          `Failed to load rebuild database overlay (${r.status})`
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

      console.log('✅ Rebuild database overlay loaded');
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
    <button class="dialog-button ${
      btn.primary ? 'dialog-button-primary' : 'dialog-button-secondary'
    }" 
            data-action="${btn.action}">
      ${btn.text}
    </button>
  `
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
        await browseSwitchLibrary();
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
              5000
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
    console.log('🔍 Pre-scanning library for rebuild...');

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
    console.log('📊 Scan results:', data);

    // Show warning if large library
    if (data.requires_warning) {
      const confirmed = await showDialog(
        'Large library',
        `Your library contains ${data.file_count.toLocaleString()} photos.\n\nRebuilding will take an estimated ${
          data.estimated_display
        }. Keep the app open until rebuilding is complete.`,
        [
          { text: 'Cancel', value: false, primary: false },
          { text: 'Continue', value: true, primary: true }
        ]
      );

      if (!confirmed) {
        hideRebuildDatabaseOverlay();
        return;
      }
    }

    // Update UI to show ready state
    const estimateText = data.estimated_display ? `<p>Estimated time: ${data.estimated_display}</p>` : '';
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
  console.log('🚀 Executing database rebuild...');

  // Close lightbox if open (user should see grid during rebuild)
  const lightbox = document.getElementById('lightboxOverlay');
  if (lightbox && lightbox.style.display !== 'none') {
    console.log('🔄 Closing lightbox to show grid');
    closeLightbox();
  }

  const overlay = document.getElementById('rebuildDatabaseOverlay');
  const title = overlay.querySelector('.import-title');
  const statusText = document.getElementById('rebuildDatabaseStatusText');
  const stats = document.getElementById('rebuildDatabaseStats');
  const indexedCount = document.getElementById('rebuildIndexedCount');
  const totalCount = document.getElementById('rebuildTotalCount');
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
      '/api/recovery/rebuild-database/execute'
    );

    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      console.log('📊 Progress:', data);

      if (data.phase === 'adding_untracked') {
        indexedCount.textContent = data.current.toLocaleString();
        totalCount.textContent = data.total.toLocaleString();
        statusText.textContent = 'Indexing files...';
      } else if (data.phase === 'removing_empty') {
        statusText.textContent = 'Cleaning up';
      }
    });

    eventSource.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      console.log('✅ Rebuild complete:', data);

      // Update title and status (State 4)
      title.textContent = 'Database rebuilt';
      const totalIndexed = totalCount.textContent || data.stats.untracked_files.toLocaleString();
      statusText.innerHTML = `<p>Database rebuilt successfully.</p><p>Indexed ${totalIndexed} files.</p>`;
      doneBtn.style.display = 'block';

      eventSource.close();

      // Check library health and reload photos
      console.log('🔄 Refreshing library status after rebuild...');
      checkLibraryHealthAndInit()
        .catch((err) => {
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
function showDialogOld(title, message, onConfirm) {
  console.log('📋 showDialogOld called', { title, hasCallback: !!onConfirm });

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

  titleEl.textContent = title;
  messageEl.textContent = message;

  // Store the callback for the handler to use
  currentDialogCallback = onConfirm;
  console.log('✅ Dialog callback stored, showing overlay');

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
      buttonEl.className = `dialog-button ${
        btn.primary ? 'dialog-button-primary' : 'dialog-button-secondary'
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
  document.getElementById('dateEditorYear').addEventListener('change', window.updateDateEditorDayOptions);
  document.getElementById('dateEditorMonth').addEventListener('change', window.updateDateEditorDayOptions);

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
    'dateEditorIntervalAmount'
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

  // Parse the date from EXIF format (YYYY:MM:DD HH:MM:SS)
  const dateStr = photo.date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  const date = new Date(dateStr);

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

  console.log(
    '📅 Opened date editor for:',
    isBulk ? `${photoIds.length} photos` : `photo ${firstPhotoId}`
  );
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
  console.log('✖️ Closed date editor');
}

/**
 * Save date edit
 */
async function saveDateEdit() {
  const overlay = document.getElementById('dateEditorOverlay');
  if (!overlay) return;

  const photoIds = JSON.parse(overlay.dataset.photoIds || '[]');
  const isBulk = overlay.dataset.isBulk === 'true';

  // Get values
  const year = document.getElementById('dateEditorYear').value;
  const month = String(
    document.getElementById('dateEditorMonth').value
  ).padStart(2, '0');
  const day = String(document.getElementById('dateEditorDay').value).padStart(
    2,
    '0'
  );
  let hour = parseInt(document.getElementById('dateEditorHour').value);
  const minute = String(
    document.getElementById('dateEditorMinute').value
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

  console.log('💾 Saving date edit:', { photoIds, isBulk, newDate });

  try {
    if (isBulk) {
      // Bulk edit mode
      const mode = document.querySelector(
        'input[name="dateEditorMode"]:checked'
      ).value;

      // Capture original dates BEFORE edit (mapped by ID)
      const originalDates = photoIds.map(id => {
        const photo = state.photos.find(p => p.id === id);
        return { 
          id: id, 
          originalDate: photo.date 
        };
      });

      // Build request body
      const requestBody = {
        photo_ids: photoIds,
        new_date: newDate,
        mode: mode, // 'shift', 'same', or 'sequence'
      };

      // Add interval data if sequence mode
      if (mode === 'sequence') {
        requestBody.interval_amount = parseInt(
          document.getElementById('dateEditorIntervalAmount').value
        );
        requestBody.interval_unit = document.getElementById(
          'dateEditorIntervalUnit'
        ).value;
      }

      const response = await fetch('/api/photos/bulk_update_date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const result = await response.json();

      if (response.ok) {
        console.log(`✅ Bulk date update successful (${mode} mode)`);

        // Close date editor and lightbox
        closeDateEditor();
        if (state.lightboxOpen) closeLightbox();

        // Clear selection state
        deselectAllPhotos();

        // Show toast with undo
        showToast(
          `Updated ${photoIds.length} photo${
            photoIds.length > 1 ? 's' : ''
          }`,
          () => undoDateEdit(originalDates)
        );

        // Reload grid
        setTimeout(() => {
          loadAndRenderPhotos(false);
          populateDatePicker(); // Refresh year dropdown to include new years
        }, 300);
      } else {
        console.error('❌ Failed to update dates:', result.error);
        showToast('Failed to update dates', null);
      }
    } else {
      // Single photo edit
      const photoId = photoIds[0];

      // Capture original date BEFORE edit
      const photo = state.photos.find(p => p.id === photoId);
      const originalDate = photo.date;

      const response = await fetch('/api/photo/update_date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_id: photoId, new_date: newDate }),
      });

      const result = await response.json();

      if (response.ok) {
        if (result.dry_run) {
          console.log('🔍 DRY RUN - Date would be updated to:', newDate);
          showToast('Date updated (DRY RUN)', null);
          closeDateEditor();
        } else {
          console.log('✅ Date updated successfully');

          // Update the photo in state
          const photoIndex = state.photos.findIndex((p) => p.id === photoId);
          if (photoIndex !== -1) {
            state.photos[photoIndex].date = newDate;

            // If in lightbox, update the info panel date display
            if (state.lightboxOpen && state.lightboxPhotoIndex === photoIndex) {
              const infoDate = document.getElementById('infoDate');
              if (infoDate) {
                const dateStr = newDate.replace(
                  /^(\d{4}):(\d{2}):(\d{2})/,
                  '$1-$2-$3'
                );
                const date = new Date(dateStr);

                // Format: "Nov 2, 2025 at 3:45 PM"
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
              }
            }
          }

          // Close date editor first
          closeDateEditor();

          // Show toast with undo
          showToast('Date updated', () => undoDateEdit([{id: photoId, originalDate: originalDate}]));

          // Close lightbox to show updated grid
          closeLightbox();

          // Reload the entire grid to reflect new sort order
          setTimeout(() => {
            loadAndRenderPhotos(false); // false = reset from beginning
            populateDatePicker(); // Refresh year dropdown to include new years
          }, 300); // Longer delay to ensure lightbox is fully closed
        }
      } else {
        console.error('❌ Failed to update date:', result.error);
        showToast('Failed to update date', null);
      }
    }
  } catch (error) {
    console.error('❌ Error updating date:', error);
    showToast('Error updating date', null);
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

  if (!toast) return;

  messageEl.textContent = message;

  // Auto-select duration based on whether undo is provided
  if (duration === undefined) {
    duration = onUndo ? TOAST_DURATION_WITH_UNDO : TOAST_DURATION;
  }

  // Log actual duration being used
  console.log(`🍞 Toast: "${message}" (${duration}ms, undo: ${!!onUndo})`);

  // Show/hide undo button based on whether undo callback exists
  const newUndoBtn = undoBtn.cloneNode(true);
  undoBtn.parentNode.replaceChild(newUndoBtn, undoBtn);

  if (onUndo) {
    // Show undo button and add listener
    newUndoBtn.style.display = 'block';
    newUndoBtn.addEventListener('click', () => {
      hideToast();
      onUndo();
    });
  } else {
    // Hide undo button
    newUndoBtn.style.display = 'none';
  }

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
        `Failed to load critical error modal (${response.status})`
      );
    mount.insertAdjacentHTML('beforeend', await response.text());
    console.log('✅ Critical error modal loaded');
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

    message.innerHTML = `<p style="margin: 0;">The file your library needs to display and keep track of your photos is missing or corrupted. To continue, you can rebuild the database or switch to a different library.</p>`;

    // Add buttons
    const switchBtn = document.createElement('button');
    switchBtn.className = 'import-btn import-btn-secondary';
    switchBtn.textContent = 'Switch library';
    switchBtn.onclick = async () => {
      hideCriticalErrorModal();
      await openSwitchLibraryOverlay();
    };

    const rebuildBtn = document.createElement('button');
    rebuildBtn.className = 'import-btn import-btn-primary';
    rebuildBtn.textContent = 'Rebuild database';
    rebuildBtn.onclick = async () => {
      hideCriticalErrorModal();
      await startRebuildDatabase();
    };

    actions.appendChild(switchBtn);
    actions.appendChild(rebuildBtn);
  } else if (type === 'library_not_found') {
    title.textContent = 'Library folder not found';

    message.innerHTML = `
      <p style="margin: 0 0 12px 0;">Can't access your library:</p>
      <p style="font-family: monospace; font-size: 12px; color: var(--text-secondary); margin: 0 0 12px 0;">${path}</p>
      <p style="margin: 0;">Your library folder is no longer accessible. To continue, you can retry the connection or switch to a different library.</p>
    `;

    const switchBtn = document.createElement('button');
    switchBtn.className = 'import-btn import-btn-secondary';
    switchBtn.textContent = 'Switch library';
    switchBtn.onclick = async () => {
      hideCriticalErrorModal();
      await openSwitchLibraryOverlay();
    };

    const retryBtn = document.createElement('button');
    retryBtn.className = 'import-btn import-btn-primary';
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
    reloadBtn.className = 'import-btn import-btn-primary';
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
        console.log('❌ Closed info panel');
      } else {
        infoPanel.style.display = 'block';
        if (overlay) overlay.classList.add('info-open');
        console.log('📋 Opened info panel');
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
      console.log('❌ Closed info panel via close button');
    });
  }

  const editDateBtn = document.getElementById('lightboxEditDateBtn');
  if (editDateBtn) {
    editDateBtn.addEventListener('click', () => {
      const photoId = state.photos[state.lightboxPhotoIndex]?.id;
      console.log(`📅 LIGHTBOX Edit Date clicked! Photo: ${photoId}`);
      openDateEditor(photoId);
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      const photoId = state.photos[state.lightboxPhotoIndex]?.id;
      console.log(`🗑️ LIGHTBOX Delete clicked! Photo: ${photoId}`);

      if (!photoId) return;

      showDialogOld(
        'Delete Photo',
        'Are you sure you want to delete this photo?',
        () => {
          deletePhotos([photoId]);
          // Close lightbox after delete
          closeLightbox();
        }
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
  } else if (e.key === 'ArrowLeft' && state.lightboxOpen) {
    navigateLightbox(-1);
  } else if (e.key === 'ArrowRight' && state.lightboxOpen) {
    navigateLightbox(1);
  }
}

/**
 * Helper function to calculate dimensions based on photo AR vs viewport AR
 */
function calculateMediaDimensions(photo) {
  if (!photo.width || !photo.height) {
    return {
      width: '100vw',
      height: '75vw',
      maxHeight: '100vh'
    };
  }

  const photoAR = photo.width / photo.height;
  const viewportAR = window.innerWidth / window.innerHeight;

  console.log(`📐 Photo ${photo.id}: ${photo.width}x${photo.height} (AR ${photoAR.toFixed(3)}) | Viewport AR: ${viewportAR.toFixed(3)}`);

  if (photoAR > viewportAR) {
    // Photo is wider than viewport → constrain by width
    console.log(`  → Fill WIDTH (photo wider than viewport)`);
    return {
      width: '100vw',
      height: `calc(100vw / ${photoAR})`
    };
  } else {
    // Photo is narrower than viewport → constrain by height
    console.log(`  → Fill HEIGHT (photo narrower than viewport)`);
    return {
      height: '100vh',
      width: `calc(100vh * ${photoAR})`
    };
  }
}

/**
 * Create placeholder element
 */
function createPlaceholder(photo, dims, isDebug = false) {
  const placeholder = document.createElement('div');
  placeholder.style.position = 'absolute';
  
  if (isDebug) {
    placeholder.style.backgroundColor = 'rgba(255, 192, 203, 0.3)'; // Pink overlay for debug
    placeholder.style.zIndex = '10';
    placeholder.style.pointerEvents = 'none';
  } else {
    placeholder.style.backgroundColor = '#2a2a2a'; // Same as grid
  }
  
  if (dims.width) placeholder.style.width = dims.width;
  if (dims.height) placeholder.style.height = dims.height;
  if (dims.maxHeight) placeholder.style.maxHeight = dims.maxHeight;
  
  return placeholder;
}

/**
 * Helper function to load media into lightbox content
 */
function loadMediaIntoContent(content, photo, isVideo) {
  const dims = calculateMediaDimensions(photo);
  
  if (isVideo) {
    // For video, show placeholder and load
    const placeholder = createPlaceholder(photo, dims);
    content.appendChild(placeholder);
    
    const video = document.createElement('video');
    video.src = `/api/photo/${photo.id}/file`;
    video.controls = true;
    video.autoplay = true;
    video.style.position = 'absolute';
    
    if (dims.width) video.style.width = dims.width;
    if (dims.height) video.style.height = dims.height;
    if (dims.maxHeight) video.style.maxHeight = dims.maxHeight;
    
    video.style.objectFit = 'contain';
    video.style.backgroundColor = '#2a2a2a';
    
    video.addEventListener('loadeddata', () => {
      if (placeholder.parentNode) {
        content.removeChild(placeholder);
      }
      video.style.backgroundColor = 'transparent';
    });
    
    content.appendChild(video);
    
  } else {
    // For images, preload in memory first
    const img = new Image();
    img.src = `/api/photo/${photo.id}/file`;
    
    // Check if already cached
    if (img.complete && img.naturalWidth > 0) {
      // Already loaded - add directly
      console.log(`✅ Image ${photo.id} cached, showing immediately`);
      img.style.position = 'absolute';
      
      if (dims.width) img.style.width = dims.width;
      if (dims.height) img.style.height = dims.height;
      if (dims.maxHeight) img.style.maxHeight = dims.maxHeight;
      
      img.style.objectFit = 'contain';
      const filename = photo.path?.split('/').pop() || photo.filename || `Photo ${photo.id}`;
      img.alt = filename;
      
      content.appendChild(img);
      
    } else {
      // Not cached - show placeholder while loading
      console.log(`⏳ Image ${photo.id} loading...`);
      const placeholder = createPlaceholder(photo, dims);
      content.appendChild(placeholder);
      
      img.onload = () => {
        console.log(`✅ Image ${photo.id} loaded`);
        // Remove placeholder
        if (placeholder.parentNode) {
          content.removeChild(placeholder);
        }
        
        // Add loaded image
        img.style.position = 'absolute';
        
        if (dims.width) img.style.width = dims.width;
        if (dims.height) img.style.height = dims.height;
        if (dims.maxHeight) img.style.maxHeight = dims.maxHeight;
        
        img.style.objectFit = 'contain';
        const filename = photo.path?.split('/').pop() || photo.filename || `Photo ${photo.id}`;
        img.alt = filename;
        
        content.appendChild(img);
      };
      
      img.onerror = async () => {
        console.error(`❌ Image ${photo.id} failed to load`);
        
        // Check if failure was due to database corruption
        try {
          const response = await fetch(`/api/photo/${photo.id}/file`);
          console.log(`🔍 Corruption check - Status: ${response.status}, OK: ${response.ok}`);
          
          if (!response.ok) {
            const contentType = response.headers.get('content-type');
            console.log(`🔍 Content-Type: ${contentType}`);
            
            if (contentType && contentType.includes('application/json')) {
              const data = await response.json();
              console.log(`🔍 Response data:`, data);
              
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

  state.lightboxOpen = true;
  state.lightboxPhotoIndex = photoIndex;

  const photo = state.photos[photoIndex];

  // Clear previous content
  content.innerHTML = '';
  content.style.backgroundColor = 'transparent';

  // Determine if photo or video - check both file_type field and path extension
  const isVideo =
    photo.file_type === 'video' ||
    (photo.path && photo.path.match(/\.(mov|mp4|m4v|avi|mpg|mpeg)$/i));

  // DEBUG MODE: Show pink overlay to verify sizing
  if (DEBUG_CLICK_TO_LOAD) {
    // Load media normally (with preload logic)
    loadMediaIntoContent(content, photo, isVideo);
    
    // Add pink debug overlay on top
    const dims = calculateMediaDimensions(photo);
    const debugOverlay = createPlaceholder(photo, dims, true);
    content.appendChild(debugOverlay);
  } else {
    // PRODUCTION MODE: Auto-load media immediately
    loadMediaIntoContent(content, photo, isVideo);
  }

  overlay.style.display = 'flex';

  // Update info panel with photo details
  const infoDate = document.getElementById('infoDate');
  const infoFilename = document.getElementById('infoFilename');

  if (infoDate) {
    // Convert EXIF format (YYYY:MM:DD HH:MM:SS) to ISO format (YYYY-MM-DD HH:MM:SS)
    const dateStr = photo.date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
    const date = new Date(dateStr);

    // Format: "Nov 2, 2025 at 3:45 PM"
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

    // Wire up click to jump to month in grid
    infoDate.onclick = (e) => {
      e.preventDefault();
      const month = photo.month; // YYYY-MM format
      console.log('📅 Jumping to month:', month);

      // Set flag to navigate to month instead of photo
      state.navigateToMonth = month;

      // Close lightbox
      closeLightbox();
    };
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
      console.log('🔍 Attempting to reveal in Finder:', filename);
      try {
        const response = await fetch(`/api/photo/${photo.id}/reveal`, {
          method: 'POST',
        });

        if (!response.ok) {
          const error = await response.json();
          console.error('❌ Failed to reveal in Finder:', error);
        } else {
          console.log('✅ Revealed in Finder:', filename);
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

  console.log(`🖼️ Opened lightbox for photo ${photo.id} (index ${photoIndex})`);
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
    prevImg.src = `/api/photo/${prevPhoto.id}/file`;
  }

  // Preload next image
  if (nextIndex >= 0 && nextIndex < state.photos.length) {
    const nextPhoto = state.photos[nextIndex];
    const nextImg = new Image();
    nextImg.src = `/api/photo/${nextPhoto.id}/file`;
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
function closeLightbox() {
  const overlay = document.getElementById('lightboxOverlay');
  if (!overlay) return;

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
  state.lightboxOpen = false;
  state.lightboxPhotoIndex = null;
  overlay.style.display = 'none';

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
      console.log(
        '🔍 Looking for month section:',
        `month-${month}`,
        monthSection
      );
      if (monthSection) {
        const monthHeader = monthSection.querySelector('.month-header');
        const target = monthHeader || monthSection;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        console.log('✅ Scrolled to month:', month);
      } else {
        console.warn('⚠️ Month section not found:', month);
      }
    }, 100);
  }

  console.log('✖️ Closed lightbox');
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
    console.log('📍 Reached end of photos');
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
async function loadAndRenderPhotos(append = false) {
  if (state.loading) return;

  state.loading = true;

  console.log('📡 Loading ALL photos metadata...');

  try {
    // Fetch ALL photos (no limit) - just id, date, month, file_type
    const response = await fetch(`/api/photos?sort=${state.currentSortOrder}`);
    const data = await response.json();

    // Check for database corruption
    if (checkForDatabaseCorruption(data)) {
      state.loading = false;
      return;
    }

    state.photos = data.photos;
    state.hasDatabase = true; // Database exists if we successfully loaded photos
    console.log(`✅ Loaded ${state.photos.length.toLocaleString()} photos`);

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
  } catch (error) {
    console.error('❌ Error loading photos:', error);
    state.hasDatabase = false; // Mark database as unavailable on error
  } finally {
    state.loading = false;
  }
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
            img.src = `/api/photo/${photoId}/thumbnail`;
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
    }
  );

  // Observe all thumbnail images that don't have src yet
  const thumbnails = document.querySelectorAll('.photo-thumb:not([src])');
  thumbnails.forEach((thumb) => thumbnailObserver.observe(thumb));

  console.log(
    `👁️ Observing ${thumbnails.length.toLocaleString()} thumbnails for lazy loading`
  );
}

// =====================
// RENDERING
// =====================

/**
 * Render first-run empty state
 */
function renderFirstRunEmptyState() {
  const container = document.getElementById('photoContainer');
  if (!container) return;

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: calc(100vh - 64px); margin-top: -48px; color: var(--text-color); gap: 24px;">
      <div style="text-align: center;">
        <div style="font-size: 18px; margin-bottom: 8px;">Welcome!</div>
        <div style="font-size: 14px; color: var(--text-secondary);">Add photos or open an existing library to get started.</div>
      </div>
      <div style="display: flex; gap: 12px;">
        <button class="import-btn" onclick="browseSwitchLibrary()" style="display: flex; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.1); color: var(--text-color); white-space: nowrap;">
          <span class="material-symbols-outlined" style="font-size: 18px; width: 18px; height: 18px; display: inline-block; overflow: hidden;">folder_open</span>
          <span>Open library</span>
        </button>
        <button class="import-btn import-btn-primary" onclick="handleAddPhotosFirstRun()" style="display: flex; align-items: center; gap: 8px; white-space: nowrap;">
          <span class="material-symbols-outlined" style="font-size: 18px; width: 18px; height: 18px; display: inline-block; overflow: hidden;">add_a_photo</span>
          <span>Add photos</span>
        </button>
      </div>
    </div>
  `;
}

/**
 * Render first-run empty state (no library configured)
 */
function renderFirstRunEmptyState() {
  const container = document.getElementById('photoContainer');
  container.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: calc(100vh - 64px); margin-top: -48px; color: var(--text-color); gap: 24px;">
      <div style="text-align: center;">
        <div style="font-size: 18px; margin-bottom: 8px;">Welcome!</div>
        <div style="font-size: 14px; color: var(--text-secondary);">Add photos or open an existing library to get started.</div>
      </div>
      <div style="display: flex; gap: 12px;">
        <button class="import-btn" onclick="browseSwitchLibrary()" style="display: flex; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.1); color: var(--text-color); white-space: nowrap;">
          <span class="material-symbols-outlined" style="font-size: 18px; width: 18px; height: 18px; display: inline-block; overflow: hidden;">folder_open</span>
          <span>Open library</span>
        </button>
        <button class="import-btn import-btn-primary" onclick="triggerImportWithLibraryCheck()" style="display: flex; align-items: center; gap: 8px; white-space: nowrap;">
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
      container.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: calc(100vh - 64px); margin-top: -48px; color: var(--text-color); gap: 24px;">
          <div style="text-align: center;">
            <div style="font-size: 18px; margin-bottom: 8px;">No photos found</div>
            <div style="font-size: 14px; color: var(--text-secondary);">Add photos or switch to an existing library.</div>
          </div>
          <div style="display: flex; gap: 12px;">
            <button class="import-btn" onclick="openSwitchLibraryOverlay()" style="display: flex; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.1); color: var(--text-color); white-space: nowrap;">
              <span class="material-symbols-outlined" style="font-size: 18px; width: 18px; height: 18px; display: inline-block; overflow: hidden;">folder_open</span>
              <span>Switch library</span>
            </button>
            <button class="import-btn import-btn-primary" onclick="triggerImportWithLibraryCheck()" style="display: flex; align-items: center; gap: 8px; white-space: nowrap;">
              <span class="material-symbols-outlined" style="font-size: 18px; width: 18px; height: 18px; display: inline-block; overflow: hidden;">add_a_photo</span>
              <span>Add photos</span>
            </button>
          </div>
        </div>
      `;
    }
    return;
  }

  // Group photos by month
  const photosByMonth = {};
  photos.forEach((photo, idx) => {
    if (!photo.month) return;
    if (!photosByMonth[photo.month]) {
      photosByMonth[photo.month] = [];
    }
    // Use globalIndex if provided, otherwise use idx
    const globalIndex =
      photo.globalIndex !== undefined ? photo.globalIndex : idx;
    photosByMonth[photo.month].push({ ...photo, globalIndex });
  });

  // Render each month section
  let html = '';

  Object.keys(photosByMonth).forEach((month) => {
    const [year, monthNum] = month.split('-');
    const monthName = new Date(
      parseInt(year),
      parseInt(monthNum) - 1
    ).toLocaleString('default', { month: 'long' });

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
        card.innerHTML = `
          <img src="/api/photo/${photo.id}/thumbnail" alt="" loading="lazy" class="photo-thumb">
        `;
        grid.appendChild(card);
      });
    } else {
      // Create new month section (with select circle in header)
      html += `
        <div class="month-section" id="month-${month}" data-month="${month}">
          <div class="month-header">
            <span class="month-label">${monthName} ${year}</span>
            <div class="month-select-circle"></div>
          </div>
          <div class="photo-grid">
      `;

      photosByMonth[month].forEach((photo) => {
        const globalIndex =
          photo.globalIndex !== undefined
            ? photo.globalIndex
            : photosByMonth[month].indexOf(photo);
        html += `
          <div class="photo-card" data-id="${photo.id}" data-index="${globalIndex}">
            <img data-photo-id="${photo.id}" alt="" class="photo-thumb">
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

    console.log(`🔍 Shift-select: clicking index ${index}, last was ${state.lastClickedIndex}`);
    console.log(`🔍 Range: ${start} to ${end} (${end - start + 1} photos expected)`);
    
    // Get all photo cards in the DOM
    const allCards = Array.from(document.querySelectorAll('.photo-card'));
    console.log(`📊 Total cards in DOM: ${allCards.length}`);
    
    // Debug: show sample of indices
    const sampleIndices = allCards.slice(0, 10).map(c => parseInt(c.dataset.index));
    console.log(`📊 Sample indices (first 10 cards): ${sampleIndices.join(', ')}`);
    
    // Filter to cards within the range
    const cardsInRange = allCards.filter(c => {
      const cardIndex = parseInt(c.dataset.index);
      return cardIndex >= start && cardIndex <= end;
    });
    
    console.log(`📋 Cards in range: ${cardsInRange.length}`);
    
    // Debug: if we found fewer than expected, show what's missing
    if (cardsInRange.length < (end - start + 1)) {
      const foundIndices = new Set(cardsInRange.map(c => parseInt(c.dataset.index)));
      const missing = [];
      for (let i = start; i <= end && missing.length < 10; i++) {
        if (!foundIndices.has(i)) missing.push(i);
      }
      console.warn(`⚠️ Missing ${(end - start + 1) - cardsInRange.length} cards. First missing indices: ${missing.join(', ')}`);
    }
    
    // Select all cards in range
    cardsInRange.forEach(rangeCard => {
      const rangeId = parseInt(rangeCard.dataset.id);
      rangeCard.classList.add('selected');
      state.selectedPhotos.add(rangeId);
    });

    updateDeleteButtonVisibility();
    console.log(
      `📷 Shift-selected ${cardsInRange.length} photos (${state.selectedPhotos.size} total selected)`
    );
  }
  // NORMAL CLICK: Toggle single
  else {
    if (card.classList.contains('selected')) {
      card.classList.remove('selected');
      state.selectedPhotos.delete(id);
      console.log(
        `📷 Deselected photo ${id} at index ${index} (${state.selectedPhotos.size} selected)`
      );
    } else {
      card.classList.add('selected');
      state.selectedPhotos.add(id);
      console.log(
        `📷 Selected photo ${id} at index ${index} (${state.selectedPhotos.size} selected)`
      );
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
      const lastPhotoIndex = parseInt(monthPhotoCards[monthPhotoCards.length - 1].dataset.index);
      
      if (e.shiftKey && state.lastClickedIndex !== null) {
        // SHIFT-SELECT: Select range from last clicked to this month's LAST photo
        const start = Math.min(state.lastClickedIndex, lastPhotoIndex);
        const end = Math.max(state.lastClickedIndex, lastPhotoIndex);
        
        console.log(`🔍 Month shift-select: range ${start} to ${end}`);
        
        // Get all photo cards and select those in range
        const allCards = Array.from(document.querySelectorAll('.photo-card'));
        const cardsInRange = allCards.filter(c => {
          const cardIndex = parseInt(c.dataset.index);
          return cardIndex >= start && cardIndex <= end;
        });
        
        cardsInRange.forEach(card => {
          const cardId = parseInt(card.dataset.id);
          card.classList.add('selected');
          state.selectedPhotos.add(cardId);
        });
        
        console.log(`📷 Selected ${cardsInRange.length} photos via month shift-select`);
        
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
    parseInt(card.dataset.id)
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
    console.log(`📅 Deselected ${photoIds.length} photos from ${month}`);
  } else {
    // Select all photos in this month
    photoCards.forEach((card) => {
      card.classList.add('selected');
      const id = parseInt(card.dataset.id);
      state.selectedPhotos.add(id);
    });
    console.log(`📅 Selected ${photoIds.length} photos from ${month}`);
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
      parseInt(card.dataset.id)
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
    console.log(`🗑️ Delete response:`, result);
    console.log(`🗑️ Deleted ${result.deleted} photos from backend`);

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
    showToast(
      `Deleted ${count} photo${count > 1 ? 's' : ''}`,
      () => undoDelete(photoIds)
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
    console.log('↩️ Undoing date edit for', originalDates.length, 'photos');
    
    // Restore each photo to its original date
    const promises = originalDates.map(({id, originalDate}) => 
      fetch('/api/photo/update_date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_id: id, new_date: originalDate }),
      })
    );

    const responses = await Promise.all(promises);
    
    // Check if all succeeded
    const allSucceeded = responses.every(r => r.ok);
    
    if (allSucceeded) {
      console.log('✅ Date edit undone successfully');
      
      // Reload grid to reflect restored dates
      await loadAndRenderPhotos(false);
      await populateDatePicker();
      
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
    console.log(`↩️ Restored ${result.restored} photos from trash`);

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
};

/**
 * Load import overlay fragment
 */
async function loadImportOverlay() {
  const mount = document.getElementById('importOverlayMount');

  try {
    const response = await fetch('fragments/importOverlay.html');
    if (!response.ok)
      throw new Error(`Failed to load import overlay (${response.status})`);

    const html = await response.text();
    mount.innerHTML = html;
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
    closeBtn.addEventListener('click', closeImportOverlay);
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', cancelImport);
  }

  if (doneBtn) {
    doneBtn.addEventListener('click', () => {
      // Scroll to first imported photo if we have any
      if (window.importedPhotoIds && window.importedPhotoIds.length > 0) {
        scrollToImportedPhoto(window.importedPhotoIds);
      }
      closeImportOverlay();
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
    overlay.style.display = 'block';
  }
}

/**
 * Close import overlay
 */
function closeImportOverlay() {
  const overlay = document.getElementById('importOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
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
      `[data-photo-id="${firstVisibleId}"]`
    );
    if (element) {
      console.log(`📍 Scrolling to imported photo ID ${firstVisibleId}`);
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
      (r) => r.status === 'success' && r.photo_id
    );

    if (firstImported && firstImported.date) {
      // Extract month from date (YYYY:MM:DD HH:MM:SS -> YYYY-MM)
      const dateStr = firstImported.date.replace(/:/g, '-');
      const monthStr = dateStr.substring(0, 7); // YYYY-MM

      console.log(`📍 Scrolling to imported photo month: ${monthStr}`);

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
 * Cancel import (not implemented - would need server-side cancellation)
 */
function cancelImport() {
  console.log('⚠️ Cancel import requested');
  showToast('Cannot cancel import in progress', null);
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
    console.log(
      `⏪ Undoing import of ${importState.importedPhotoIds.length} photos`
    );

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
    console.log('✅ Undo complete:', result);

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
    const response = await fetch('fragments/utilitiesMenu.html?v=2');
    if (!response.ok) throw new Error('Failed to load utilities menu');

    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);

    // Wire up menu items
    const switchLibraryBtn = document.getElementById('switchLibraryBtn');
    const removeDuplicatesBtn = document.getElementById('removeDuplicatesBtn');
    const cleanOrganizeBtn = document.getElementById('cleanOrganizeBtn');
    const rebuildThumbnailsBtn = document.getElementById(
      'rebuildThumbnailsBtn'
    );

    if (switchLibraryBtn) {
      switchLibraryBtn.addEventListener('click', () => {
        console.log('🔧 Switch Library clicked');
        hideUtilitiesMenu();
        openSwitchLibraryOverlay();
      });
    }

    if (removeDuplicatesBtn) {
      removeDuplicatesBtn.addEventListener('click', () => {
        console.log('🔧 Remove Duplicates clicked');
        hideUtilitiesMenu();
        openDuplicatesOverlay();
      });
    }

    if (cleanOrganizeBtn) {
      cleanOrganizeBtn.addEventListener('click', () => {
        console.log('🔧 Update library index clicked');
        hideUtilitiesMenu();
        openUpdateIndexOverlay();
      });
    }

    const rebuildDatabaseBtn = document.getElementById('rebuildDatabaseBtn');
    if (rebuildDatabaseBtn) {
      rebuildDatabaseBtn.addEventListener('click', () => {
        console.log('🔧 Rebuild database clicked');
        hideUtilitiesMenu();
        startRebuildDatabase();
      });
    }

    if (rebuildThumbnailsBtn) {
      rebuildThumbnailsBtn.addEventListener('click', () => {
        console.log('🔧 Rebuild Thumbnails clicked');
        hideUtilitiesMenu();
        rebuildThumbnails();
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

  console.log('🔧 Toggle menu - menu:', menu, 'button:', utilitiesBtn);

  if (!menu || !utilitiesBtn) {
    console.warn('⚠️ Menu or button not found');
    return;
  }

  const isVisible = menu.style.display === 'block';

  console.log('🔧 Menu visible?', isVisible);

  if (isVisible) {
    hideUtilitiesMenu();
  } else {
    // Update menu availability before showing
    updateUtilityMenuAvailability();

    // Position menu below the button
    const btnRect = utilitiesBtn.getBoundingClientRect();
    console.log('🔧 Button rect:', btnRect);
    console.log(
      '🔧 Setting menu position - top:',
      btnRect.bottom + 8,
      'right:',
      window.innerWidth - btnRect.right
    );

    menu.style.top = `${btnRect.bottom + 8}px`;
    menu.style.right = `${window.innerWidth - btnRect.right}px`;
    menu.style.display = 'block';

    console.log(
      '🔧 Menu style after:',
      menu.style.top,
      menu.style.right,
      menu.style.display
    );
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
 * - Update library index: requires database (doesn't need photos)
 * - Rebuild database: requires database
 * - Remove duplicates: requires database AND 1+ photos
 * - Rebuild thumbnails: requires database AND 1+ photos
 */
function updateUtilityMenuAvailability() {
  const hasDatabase = state.hasDatabase;
  const hasPhotos = state.photos && state.photos.length > 0;

  console.log('🔧 Updating menu availability - DB:', hasDatabase, 'Photos:', hasPhotos ? state.photos.length : 0);

  // Switch library - ALWAYS available (never disabled)
  enableMenuItem('switchLibraryBtn', true);

  // Update library index - requires database (doesn't need photos)
  enableMenuItem('cleanOrganizeBtn', hasDatabase);

  // Rebuild database - requires database
  enableMenuItem('rebuildDatabaseBtn', hasDatabase);

  // Remove duplicates - requires database AND 1+ photos
  enableMenuItem('removeDuplicatesBtn', hasDatabase && hasPhotos);

  // Rebuild thumbnails - requires database AND 1+ photos
  enableMenuItem('rebuildThumbnailsBtn', hasDatabase && hasPhotos);
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

let duplicatesState = {
  duplicates: [],
  selectedForRemoval: new Set(), // photo IDs to remove
  totalExtraCopies: 0,
  totalWastedSpace: 0,
};

/**
 * Load duplicates overlay fragment
 */
async function loadDuplicatesOverlay() {
  // Check if already loaded
  if (document.getElementById('duplicatesOverlay')) {
    return;
  }

  try {
    const response = await fetch('fragments/duplicatesOverlay.html');
    if (!response.ok) throw new Error('Failed to load duplicates overlay');

    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);

    // Wire up buttons
    const closeBtn = document.getElementById('duplicatesCloseBtn');
    const cancelBtn = document.getElementById('duplicatesCancelBtn');
    const removeBtn = document.getElementById('duplicatesRemoveBtn');
    const doneBtn = document.getElementById('duplicatesDoneBtn');
    const detailsToggle = document.getElementById('duplicatesDetailsToggle');

    if (closeBtn) closeBtn.addEventListener('click', closeDuplicatesOverlay);
    if (cancelBtn) cancelBtn.addEventListener('click', closeDuplicatesOverlay);
    if (removeBtn)
      removeBtn.addEventListener('click', removeSelectedDuplicates);
    if (doneBtn) doneBtn.addEventListener('click', closeDuplicatesOverlay);

    if (detailsToggle) {
      detailsToggle.addEventListener('click', () => {
        const detailsList = document.getElementById('duplicatesDetailsList');
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
    console.error('❌ Failed to load duplicates overlay:', error);
  }
}

/**
 * Open duplicates overlay and scan for duplicates
 */
async function openDuplicatesOverlay() {
  // Check if already open
  const existingOverlay = document.getElementById('duplicatesOverlay');
  if (existingOverlay && existingOverlay.style.display === 'flex') {
    console.log('⚠️ Duplicates overlay already open');
    return;
  }

  await loadDuplicatesOverlay();

  const overlay = document.getElementById('duplicatesOverlay');
  if (!overlay) return;

  // Reset state
  duplicatesState = {
    duplicates: [],
    selectedForRemoval: new Set(),
    totalExtraCopies: 0,
    totalWastedSpace: 0,
  };

  // Reset UI to initial state
  const statsEl = document.getElementById('duplicatesStats');
  const detailsSection = document.getElementById('duplicatesDetailsSection');
  if (statsEl) statsEl.style.display = 'none';
  if (detailsSection) detailsSection.style.display = 'none';

  // Show overlay
  overlay.style.display = 'flex';

  // Start scanning
  updateDuplicatesUI('Scanning for duplicates', true);

  try {
    const startTime = performance.now();
    console.log('🔍 Starting duplicate scan...');

    const response = await fetch('/api/utilities/duplicates');
    if (!response.ok) throw new Error('Failed to fetch duplicates');

    const data = await response.json();
    const fetchTime = performance.now() - startTime;
    console.log(`⏱️ Fetch took ${fetchTime.toFixed(0)}ms`);

    duplicatesState.duplicates = data.duplicates;
    duplicatesState.totalExtraCopies = data.total_extra_copies;
    duplicatesState.totalWastedSpace = data.total_wasted_space;

    console.log(`📋 Found ${data.total_duplicate_sets} duplicate sets`);

    // Auto-select duplicates for removal (keep oldest)
    data.duplicates.forEach((dupSet) => {
      // Sort by ID (oldest first), keep first, mark rest for removal
      const sortedFiles = dupSet.files.sort((a, b) => a.id - b.id);
      for (let i = 1; i < sortedFiles.length; i++) {
        duplicatesState.selectedForRemoval.add(sortedFiles[i].id);
      }
    });

    // Update UI
    if (data.total_duplicate_sets === 0) {
      updateDuplicatesUI('No duplicates found', false);
      showDuplicatesComplete();
    } else {
      updateDuplicatesUI(
        `Found ${data.total_duplicate_sets} items with duplicates`,
        false
      );
      showDuplicatesStats();
      renderDuplicatesList();
      showDuplicatesActions();
    }
  } catch (error) {
    console.error('❌ Failed to scan for duplicates:', error);
    updateDuplicatesUI('Failed to scan for duplicates', false);
    showToast('Failed to scan for duplicates', null);
  }
}

/**
 * Update duplicates UI
 */
function updateDuplicatesUI(statusText, showSpinner = false) {
  const statusTextEl = document.getElementById('duplicatesStatusText');

  if (statusTextEl) {
    if (showSpinner) {
      statusTextEl.innerHTML = `${statusText}<span class="import-spinner"></span>`;
    } else {
      statusTextEl.textContent = statusText;
    }
  }
}

/**
 * Show duplicates statistics
 */
function showDuplicatesStats() {
  const statsEl = document.getElementById('duplicatesStats');
  const setsCountEl = document.getElementById('duplicateSetsCount');
  const copiesCountEl = document.getElementById('extraCopiesCount');

  if (statsEl) statsEl.style.display = 'flex';
  if (setsCountEl) setsCountEl.textContent = duplicatesState.duplicates.length;
  if (copiesCountEl)
    copiesCountEl.textContent = duplicatesState.totalExtraCopies;
}

/**
 * Render duplicates list
 */
function renderDuplicatesList() {
  const detailsSection = document.getElementById('duplicatesDetailsSection');
  const detailsList = document.getElementById('duplicatesDetailsList');

  if (!detailsSection || !detailsList) return;

  detailsSection.style.display = 'block';

  let html = '';

  duplicatesState.duplicates.forEach((dupSet, setIndex) => {
    const sortedFiles = dupSet.files.sort((a, b) => a.id - b.id);
    const baseFilename = sortedFiles[0].path.split('/').pop();
    const numDuplicates = dupSet.count - 1; // Total - 1 canonical = duplicates

    html += `
      <div class="duplicate-set">
        <div class="duplicate-set-header">
          <strong>${baseFilename}</strong> (${numDuplicates} duplicate${
      numDuplicates > 1 ? 's' : ''
    })
        </div>
        <div class="duplicate-files">
    `;

    sortedFiles.forEach((file, fileIndex) => {
      const isKeep = fileIndex === 0;
      const isSelected = duplicatesState.selectedForRemoval.has(file.id);
      const sizeMB = (file.file_size / (1024 * 1024)).toFixed(2);

      html += `
        <div class="duplicate-file">
          <label>
            <input 
              type="checkbox" 
              ${isKeep ? 'disabled' : ''}
              ${isSelected ? 'checked' : ''}
              data-photo-id="${file.id}"
              onchange="toggleDuplicateSelection(${file.id}, this.checked)"
            />
            <span class="duplicate-file-path">${file.path}</span>
            <span class="duplicate-file-size">${sizeMB} MB</span>
            ${isKeep ? '<span class="duplicate-keep-badge">✓ keep</span>' : ''}
          </label>
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  detailsList.innerHTML = html;
}

/**
 * Toggle duplicate selection
 */
function toggleDuplicateSelection(photoId, isChecked) {
  if (isChecked) {
    duplicatesState.selectedForRemoval.add(photoId);
  } else {
    duplicatesState.selectedForRemoval.delete(photoId);
  }

  // Update button state
  const removeBtn = document.getElementById('duplicatesRemoveBtn');
  if (removeBtn) {
    removeBtn.textContent = `Remove Selected (${duplicatesState.selectedForRemoval.size})`;
  }
}

/**
 * Show duplicates actions
 */
function showDuplicatesActions() {
  const cancelBtn = document.getElementById('duplicatesCancelBtn');
  const removeBtn = document.getElementById('duplicatesRemoveBtn');

  if (cancelBtn) cancelBtn.style.display = 'inline-block';
  if (removeBtn) {
    removeBtn.style.display = 'inline-block';
    removeBtn.textContent = `Remove Selected (${duplicatesState.selectedForRemoval.size})`;
  }
}

/**
 * Show duplicates complete state
 */
function showDuplicatesComplete() {
  const cancelBtn = document.getElementById('duplicatesCancelBtn');
  const removeBtn = document.getElementById('duplicatesRemoveBtn');
  const doneBtn = document.getElementById('duplicatesDoneBtn');
  const statsEl = document.getElementById('duplicatesStats');
  const detailsSection = document.getElementById('duplicatesDetailsSection');

  // Hide all the details/stats
  if (statsEl) statsEl.style.display = 'none';
  if (detailsSection) detailsSection.style.display = 'none';

  // Show only Done button
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (removeBtn) removeBtn.style.display = 'none';
  if (doneBtn) doneBtn.style.display = 'inline-block';
}

/**
 * Remove selected duplicates
 */
async function removeSelectedDuplicates() {
  if (duplicatesState.selectedForRemoval.size === 0) {
    showToast('No duplicates selected for removal', null);
    return;
  }

  const photoIds = Array.from(duplicatesState.selectedForRemoval);

  try {
    console.log(`🗑️ Removing ${photoIds.length} duplicate photos`);

    // Show removing state with spinner
    updateDuplicatesUI(
      `Removing ${photoIds.length} duplicate${photoIds.length > 1 ? 's' : ''}`,
      true
    );

    // Hide action buttons during removal
    const cancelBtn = document.getElementById('duplicatesCancelBtn');
    const removeBtn = document.getElementById('duplicatesRemoveBtn');
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'none';

    const response = await fetch('/api/photos/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: photoIds }),
    });

    if (!response.ok) {
      throw new Error(`Failed to remove duplicates: ${response.status}`);
    }

    const result = await response.json();
    console.log('✅ Duplicates removed:', result);

    // Show final confirmation state
    updateDuplicatesUI(
      `Removed ${result.deleted} duplicate${result.deleted > 1 ? 's' : ''}`,
      false
    );
    showDuplicatesComplete();

    // Reload grid
    await loadAndRenderPhotos(false);
  } catch (error) {
    console.error('❌ Failed to remove duplicates:', error);
    updateDuplicatesUI('Failed to remove duplicates', false);
    showToast('Failed to remove duplicates', null);

    // Show action buttons again on error
    showDuplicatesActions();
  }
}

/**
 * Close duplicates overlay
 */
function closeDuplicatesOverlay() {
  const overlay = document.getElementById('duplicatesOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

// Make toggleDuplicateSelection available globally for onclick
window.toggleDuplicateSelection = toggleDuplicateSelection;

// ==========================
// UPDATE LIBRARY INDEX OVERLAY
// ==========================

let updateIndexState = {
  missingFiles: 0,
  untrackedFiles: 0,
  nameUpdates: 0,
  emptyFolders: 0,
  details: null,
};

/**
 * Load Update Library Index overlay fragment
 */
async function loadUpdateIndexOverlay() {
  // Check if already loaded
  if (document.getElementById('updateIndexOverlay')) {
    return;
  }

  try {
    const response = await fetch('fragments/updateIndexOverlay.html');
    if (!response.ok)
      throw new Error('Failed to load Update Library Index overlay');

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
    console.error('❌ Failed to load Update Library Index overlay:', error);
  }
}

/**
 * Phase 1: Open overlay and scan
 */
async function openUpdateIndexOverlay() {
  // Check if already open
  const existingOverlay = document.getElementById('updateIndexOverlay');
  if (existingOverlay && existingOverlay.style.display === 'flex') {
    console.log('⚠️ Update library index overlay already open');
    return;
  }

  await loadUpdateIndexOverlay();

  const overlay = document.getElementById('updateIndexOverlay');
  if (!overlay) return;

  // Reset state
  updateIndexState = {
    missingFiles: 0,
    untrackedFiles: 0,
    nameUpdates: 0,
    emptyFolders: 0,
    details: null,
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
    const response = await fetch('/api/utilities/update-index/scan');
    if (!response.ok) throw new Error('Failed to scan index');

    const data = await response.json();

    updateIndexState.missingFiles = data.missing_files;
    updateIndexState.untrackedFiles = data.untracked_files;
    updateIndexState.nameUpdates = data.name_updates;
    updateIndexState.emptyFolders = data.empty_folders;

    console.log('📋 Scan results:', data);

    // Check if any changes are needed
    const hasChanges =
      data.missing_files > 0 ||
      data.untracked_files > 0 ||
      data.name_updates > 0 ||
      data.empty_folders > 0;

    if (hasChanges) {
      // Phase 2: Review (has changes - show proceed)
      updateUpdateIndexUI('Scan complete. Ready to proceed?', false);
      showUpdateIndexStats();
      showUpdateIndexButtons('cancel', 'proceed');
    } else {
      // Phase 2: No changes needed - done immediately
      updateUpdateIndexUI('Index is up to date. No changes required.', false);
      showUpdateIndexButtons('done');
    }
  } catch (error) {
    console.error('❌ Failed to scan index:', error);
    updateUpdateIndexUI('Failed to scan', false);
    showToast('Failed to scan index', null);
  }
}

/**
 * Phase 3: Execute update (after user clicks Proceed)
 */
async function executeUpdateIndex() {
  console.log('🚀 Executing update library index...');

  // Phase 3: Execution
  updateUpdateIndexUI('Removing missing files', true);
  showUpdateIndexButtons('cancel-disabled');

  try {
    const response = await fetch('/api/utilities/update-index/execute', {
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`Update failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Read SSE stream
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        console.log('📡 SSE stream ended');
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        if (line.startsWith('data:')) {
          const data = JSON.parse(line.substring(5).trim());

          // Progress updates
          if (data.phase) {
            if (data.phase === 'removing_deleted') {
              updateUpdateIndexUI(
                `Removing missing files... ${data.current}/${data.total}`,
                true
              );
            } else if (data.phase === 'adding_untracked') {
              updateUpdateIndexUI(
                `Adding untracked files... ${data.current}/${data.total}`,
                true
              );
            } else if (data.phase === 'updating_names') {
              updateUpdateIndexUI('Updating names...', true);
            } else if (data.phase === 'removing_empty') {
              updateUpdateIndexUI(
                `Removing empty folders... ${data.current}`,
                true
              );
            }
          }

          // Completion data (comes BEFORE event: complete)
          if (data.stats && data.details) {
            // Update final stats
            updateIndexState.missingFiles = data.stats.missing_files;
            updateIndexState.untrackedFiles = data.stats.untracked_files;
            updateIndexState.nameUpdates = data.stats.name_updates;
            updateIndexState.emptyFolders = data.stats.empty_folders;
            updateIndexState.details = data.details;

            console.log('✅ Update complete:', data.stats);
            console.log('📋 Details:', data.details);
          }

          if (data.error) {
            throw new Error(data.error);
          }
        }
      }

      // Check for complete event AFTER processing all data lines
      for (const line of lines) {
        if (line.startsWith('event: complete')) {
          // Phase 4: Confirmation (hide stats, show only details)
          console.log('🎯 Complete event received');
          updateUpdateIndexUI('Index updated', false);
          hideUpdateIndexStats();
          console.log('🎯 About to render details. State:', updateIndexState);
          renderUpdateIndexDetails();
          console.log('🎯 After render details');
          showUpdateIndexButtons('done');
        }
      }
    }

    // Reload grid
    await loadAndRenderPhotos(false);
  } catch (error) {
    console.error('❌ Failed to execute update:', error);
    updateUpdateIndexUI('Failed to update library index', false);
    showToast('Failed to update library index', null);
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
  const missingEl = document.getElementById('missingFilesCount');
  const untrackedEl = document.getElementById('untrackedFilesCount');
  const nameUpdatesEl = document.getElementById('nameUpdatesCount');
  const emptyFoldersEl = document.getElementById('emptyFoldersCount');

  if (statsEl) statsEl.style.display = 'flex';
  if (missingEl) missingEl.textContent = updateIndexState.missingFiles;
  if (untrackedEl) untrackedEl.textContent = updateIndexState.untrackedFiles;
  if (nameUpdatesEl) nameUpdatesEl.textContent = updateIndexState.nameUpdates;
  if (emptyFoldersEl)
    emptyFoldersEl.textContent = updateIndexState.emptyFolders;
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
  console.log('📋 renderUpdateIndexDetails called');
  console.log('📋 updateIndexState.details:', updateIndexState.details);

  if (!updateIndexState.details) {
    console.warn('⚠️ No details in state!');
    return;
  }

  const detailsSection = document.getElementById('updateIndexDetailsSection');
  const detailsList = document.getElementById('updateIndexDetailsList');

  console.log('📋 detailsSection:', detailsSection);
  console.log('📋 detailsList:', detailsList);

  if (!detailsSection || !detailsList) {
    console.warn('⚠️ Details elements not found in DOM!');
    return;
  }

  const details = updateIndexState.details;
  let html = '';

  // Missing Files
  if (details.missing_files && details.missing_files.length > 0) {
    html +=
      '<div class="update-detail-section"><strong>Missing Files:</strong><ul>';
    details.missing_files.slice(0, 20).forEach((path) => {
      html += `<li>${path}</li>`;
    });
    if (details.missing_files.length > 20) {
      html += `<li><em>... and ${
        details.missing_files.length - 20
      } more</em></li>`;
    }
    html += '</ul></div>';
  }

  // Untracked Files
  if (details.untracked_files && details.untracked_files.length > 0) {
    html +=
      '<div class="update-detail-section"><strong>Untracked Files:</strong><ul>';
    details.untracked_files.slice(0, 20).forEach((path) => {
      html += `<li>${path}</li>`;
    });
    if (details.untracked_files.length > 20) {
      html += `<li><em>... and ${
        details.untracked_files.length - 20
      } more</em></li>`;
    }
    html += '</ul></div>';
  }

  // Name Updates
  if (details.name_updates && details.name_updates.length > 0) {
    html +=
      '<div class="update-detail-section"><strong>Name Updates:</strong><ul>';
    details.name_updates.slice(0, 20).forEach((path) => {
      html += `<li>${path}</li>`;
    });
    if (details.name_updates.length > 20) {
      html += `<li><em>... and ${
        details.name_updates.length - 20
      } more</em></li>`;
    }
    html += '</ul></div>';
  }

  // Empty Folders
  if (details.empty_folders && details.empty_folders.length > 0) {
    html +=
      '<div class="update-detail-section"><strong>Empty Folders:</strong><ul>';
    details.empty_folders.slice(0, 20).forEach((path) => {
      html += `<li>${path}</li>`;
    });
    if (details.empty_folders.length > 20) {
      html += `<li><em>... and ${
        details.empty_folders.length - 20
      } more</em></li>`;
    }
    html += '</ul></div>';
  }

  // Always show details section in Phase 4
  if (html) {
    detailsList.innerHTML = html;
  } else {
    detailsList.innerHTML =
      '<div class="update-detail-section"><em>No changes were needed.</em></div>';
  }
  detailsSection.style.display = 'block';
}

/**
 * Close Update Library Index overlay
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
 * Rebuild thumbnails - 3-phase overlay pattern
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

    console.log('✅ Rebuild thumbnails overlay loaded');
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

    console.log('✅ Thumbnail check result:', result);

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

  console.log('🔧 Rebuild thumbnails overlay opened');
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
    console.log('🔧 Starting thumbnail rebuild...');

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

    console.log('✅ Thumbnails cleared:', result);

    // Visual confirmation: Clear all thumbnail images
    if (result.cleared_count > 0) {
      console.log('🎨 Clearing visible thumbnails for visual confirmation...');
      
      // Clear the grid to show user that purge happened
      const container = document.getElementById('photoContainer');
      if (container) {
        container.innerHTML = '';
      }

      // Show blank grid for 300ms before reloading
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Reload grid with fresh thumbnails
      console.log('🔄 Reloading grid with fresh thumbnails...');
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
        `Failed to load rebuild database overlay (${response.status})`
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

    console.log('✅ Rebuild database overlay loaded');
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

    console.log('✅ Switch library overlay loaded');
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

    console.log('✅ Create library overlay loaded');
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
    console.log('✅ Name library overlay loaded');
  } catch (error) {
    console.error('❌ Failed to load name library overlay:', error);
  }
}

/**
 * Show name library dialog and return user's chosen name
 * @returns {Promise<string|null>} Library name or null if cancelled
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
      subtitleEl.textContent = 'Your new library needs its own folder. Please give it a name.';
    }

    // Reset state
    input.value = 'Photo Library';
    errorDiv.style.visibility = 'hidden';
    errorDiv.textContent = '';

    // Focus input and select text
    setTimeout(() => {
      input.focus();
      input.select();
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
    async function validateName(name) {
      const sanitized = sanitizeFolderName(name);

      if (!sanitized) {
        errorDiv.textContent = 'Please enter a valid name';
        errorDiv.style.visibility = 'visible';
        return null;
      }

      if (sanitized.length > 255) {
        errorDiv.textContent = 'Name is too long (max 255 characters)';
        errorDiv.style.visibility = 'visible';
        return null;
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
            const existingFolders = data.folders.map(f => typeof f === 'string' ? f : f.name);
            
            if (existingFolders.includes(sanitized)) {
              errorDiv.textContent = `A folder named "${sanitized}" already exists here`;
              errorDiv.style.visibility = 'visible';
              return null;
            }
          }
        } catch (error) {
          // If validation fails, allow it (don't block user)
          console.warn('Failed to validate folder name:', error);
        }
      }

      // All validations passed - hide error
      errorDiv.style.visibility = 'hidden';
      return sanitized;
    }

    // Clean up listeners
    function cleanup() {
      overlay.style.display = 'none';
      // Remove event listeners by cloning (prevents duplicates)
      const newCancelBtn = cancelBtn.cloneNode(true);
      const newConfirmBtn = confirmBtn.cloneNode(true);
      const newCloseBtn = closeBtn.cloneNode(true);
      const newInput = input.cloneNode(true);

      cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
      confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
      closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
      input.parentNode.replaceChild(newInput, input);
    }

    // Handle cancel
    const handleCancel = () => {
      cleanup();
      resolve(null);
    };

    // Handle confirm
    const handleConfirm = async () => {
      const validated = await validateName(input.value);
      if (validated) {
        cleanup();
        resolve(validated);
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
      
      // Schedule validation after 150ms of no typing
      debounceTimeout = setTimeout(async () => {
        await validateName(input.value);
      }, 150);
    };

    // Wire up listeners
    cancelBtn.addEventListener('click', handleCancel);
    closeBtn.addEventListener('click', handleCancel);
    confirmBtn.addEventListener('click', handleConfirm);
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
  try {
    const response = await fetch('/api/library/current');
    const data = await response.json();
    const pathElement = document.getElementById('currentLibraryPath');
    if (pathElement) {
      pathElement.textContent = data.library_path;
    }
  } catch (error) {
    console.error('Failed to get current library:', error);
    const pathElement = document.getElementById('currentLibraryPath');
    if (pathElement) {
      pathElement.textContent = '(unable to load)';
    }
  }

  document.getElementById('switchLibraryOverlay').style.display = 'block';
  console.log('📚 Switch library overlay opened');
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

/**
 * Browse for library (uses custom folder picker)
 */
async function browseSwitchLibrary() {
  try {
    console.log('🔍 Opening custom folder picker...');

    const selectedPath = await FolderPicker.show({
      title: 'Open library',
      subtitle: 'Select an existing library folder or choose where to create one'
    });

    if (!selectedPath) {
      console.log('User cancelled folder selection');
      return false;
    }

    console.log('📂 Selected path:', selectedPath);

    // Check if path has a database
    const potentialDbPath = selectedPath + '/photo_library.db';
    
    // Try to check if library exists via backend
    const checkResponse = await fetch('/api/library/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: selectedPath }),
    });

    const checkResult = await checkResponse.json();

    if (checkResult.exists) {
      // Existing library - switch immediately
      console.log('✅ Found existing library:', selectedPath);
      closeSwitchLibraryOverlay();
      await switchToLibrary(selectedPath, potentialDbPath);
    } else {
      // No library found - go to first-run flow (reset config and reload)
      console.log('📦 No library found - redirecting to first-run flow...');
      closeSwitchLibraryOverlay();
      
      const response = await fetch('/api/library/reset', {
        method: 'DELETE',
      });

      const data = await response.json();

      if (data.status === 'success') {
        console.log('✅ Configuration reset - reloading to first-run state...');
        window.location.reload();
      } else {
        throw new Error(data.error || 'Reset failed');
      }
    }

    return true;
  } catch (error) {
    console.error('❌ Failed to browse library:', error);
    showToast(`Error: ${error.message}`, 'error');
    return false;
  }
}

/**
 * Create new library with name prompt (first-run flow)
 */
async function createNewLibraryWithName(dialogOptions = {}) {
  try {
    // Loop to allow user to go back and change location
    while (true) {
      // Step 1: Choose parent location using custom folder picker
      console.log('🔍 Opening custom folder picker for parent location...');
      
      const parentPath = await FolderPicker.show({
        title: 'Library location',
        subtitle: "Choose where you'd like to create your new library"
      });

      if (!parentPath) {
        console.log('User cancelled folder selection');
        return false;
      }

      console.log('📂 Parent location:', parentPath);

      // Step 2: Get library name from user (with validation against parent path)
      console.log('📝 Asking for library name...');
      const libraryName = await showNameLibraryDialog({
        ...dialogOptions,
        parentPath: parentPath
      });

      if (!libraryName) {
        console.log('User cancelled library naming - going back to folder picker');
        // null means cancelled - loop back to folder picker
        continue;
      }

      console.log('📚 Library name:', libraryName);

      // Step 3: Combine parent path with library name
      const cleanParentPath = parentPath.replace(/\/+$/, ''); // Remove trailing slashes
      const fullLibraryPath = `${cleanParentPath}/${libraryName}`;
      const dbPath = `${fullLibraryPath}/photo_library.db`;

      console.log('📦 Creating library at:', fullLibraryPath);

      // Step 4: Create library
      const createResponse = await fetch('/api/library/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ library_path: fullLibraryPath, db_path: dbPath }),
      });

      const createResult = await createResponse.json();

      if (!createResponse.ok) {
        throw new Error(createResult.error || 'Failed to create library');
      }

      console.log('✅ Library created');

      // Step 5: Switch to new library
      const switchResponse = await fetch('/api/library/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ library_path: fullLibraryPath, db_path: dbPath }),
      });

      const switchResult = await switchResponse.json();

      if (!switchResponse.ok) {
        throw new Error(switchResult.error || 'Failed to switch library');
      }

      console.log('✅ Switched to:', switchResult.library_path);

      // Step 6: Refresh photos (library is now empty)
      await loadAndRenderPhotos();

      // Step 7: Immediately show import dialog
      await triggerImport();

      return true;
    }
  } catch (error) {
    console.error('❌ Failed to create library:', error);
    showToast(`Error: ${error.message}`, 'error');
    return false;
  }
}

/**
 * Reset library configuration to first-run state (debug)
 */
async function resetLibraryConfig() {
  console.log('🔄 Resetting library configuration to create new library...');

  try {
    const response = await fetch('/api/library/reset', {
      method: 'DELETE',
    });

    const data = await response.json();

    if (data.status === 'success') {
      console.log('✅ Configuration reset - reloading to first-run state...');
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
  console.log('📦 Create library confirmation shown');
}

/**
 * Create new library and switch to it
 */
async function createAndSwitchLibrary(libraryPath, dbPath) {
  try {
    console.log('📦 Creating new library:', libraryPath);

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

    console.log('✅ Library created');

    // Close create overlay
    document.getElementById('createLibraryOverlay').style.display = 'none';

    // Switch to new library
    await switchToLibrary(libraryPath, dbPath);
  } catch (error) {
    console.error('❌ Failed to create library:', error);
    showToast(`Error: ${error.message}`, 'error');

    // Reset button
    const confirmBtn = document.getElementById('createLibraryConfirmBtn');
    confirmBtn.textContent = 'Create & Switch';
    confirmBtn.disabled = false;
  }
}

/**
 * Switch to a different library
 */
async function switchToLibrary(libraryPath, dbPath) {
  try {
    console.log('🔄 Switching to library:', libraryPath);

    const response = await fetch('/api/library/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: libraryPath, db_path: dbPath }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to switch library');
    }

    console.log('✅ Switched to:', result.library_path);
    
    // Get folder name for toast message
    const folderName = libraryPath.split('/').filter(Boolean).pop() || 'library';
    showToast(`Opened ${folderName}`);

    // Close overlays
    closeSwitchLibraryOverlay();
    const createOverlay = document.getElementById('createLibraryOverlay');
    if (createOverlay) createOverlay.style.display = 'none';

    // Reload photos from new library
    setTimeout(async () => {
      await loadAndRenderPhotos();
    }, 500);
  } catch (error) {
    console.error('❌ Failed to switch library:', error);
    showToast(`Error: ${error.message}`, 'error');
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
      console.log('📦 No library configured - starting library creation flow');

      // Create new library with naming (custom copy for Add photos flow)
      const created = await createNewLibraryWithName({
        title: 'Add photos',
        subtitle: "Adding photos will create a new library. Please give your library folder a name."
      });

      // If user cancelled at any point, show empty state
      if (!created) {
        console.log('User cancelled library creation');
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
 */
async function triggerImport() {
  try {
    console.log('📸 Opening photo picker...');

    const selectedPaths = await PhotoPicker.show({
      title: 'Select photos',
      subtitle: 'Choose photos and folders to import'
    });

    if (!selectedPaths || selectedPaths.length === 0) {
      console.log('User cancelled or no files selected');
      return;
    }

    console.log(`✅ Selected ${selectedPaths.length} item(s)`);
    await scanAndConfirmImport(selectedPaths);
  } catch (error) {
    console.error('❌ Failed to trigger import:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

/**
 * Import individual files
 */
async function importFiles() {
  try {
    console.log('📸 Opening file picker...');

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
        console.log('User cancelled file selection');
        return;
      }
      throw new Error(error.error || 'Failed to select files');
    }

    const result = await response.json();
    const paths = result.paths || [];

    if (paths.length === 0) {
      console.log('No files selected');
      return;
    }

    console.log(`✅ Selected ${paths.length} file(s)`);
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
    console.log('📁 Opening folder picker...');

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
        console.log('User cancelled folder selection');
        return;
      }
      throw new Error(error.error || 'Failed to select folder');
    }

    const result = await response.json();
    const paths = result.paths || [];

    if (paths.length === 0) {
      console.log('No folders selected');
      return;
    }

    console.log(`✅ Selected ${paths.length} folder(s)`);
    await scanAndConfirmImport(paths);
  } catch (error) {
    console.error('❌ Failed to import folders:', error);
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
      console.log('User cancelled import');
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
    console.log(`📥 Starting import of ${filePaths.length} files...`);

    // Load import overlay if not already loaded
    const overlay = document.getElementById('importOverlay');
    if (!overlay) {
      await loadImportOverlay();
    }

    // Show overlay
    showImportOverlay();

    // Start SSE stream
    const response = await fetch('/api/photos/import-from-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: filePaths }),
    });

    if (!response.ok) {
      throw new Error('Import request failed');
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
    console.error('❌ Import failed:', error);
    showToast(`Import failed: ${error.message}`, 'error');
    hideImportOverlay();
  }
}

/**
 * Load import overlay fragment
 */
async function loadImportOverlay() {
  try {
    const response = await fetch('/fragments/importOverlay.html');
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);

    // Wire up close button
    document
      .getElementById('importCloseBtn')
      ?.addEventListener('click', hideImportOverlay);
    document
      .getElementById('importDoneBtn')
      ?.addEventListener('click', hideImportOverlay);

    console.log('✅ Import overlay loaded');
  } catch (error) {
    console.error('❌ Failed to load import overlay:', error);
  }
}

/**
 * Show import overlay
 */
function showImportOverlay() {
  const overlay = document.getElementById('importOverlay');
  if (overlay) {
    overlay.style.display = 'block';
  }
}

/**
 * Hide import overlay
 */
async function hideImportOverlay() {
  const overlay = document.getElementById('importOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
  // Reload photos to show newly imported
  await loadAndRenderPhotos();
}

/**
 * Handle import SSE events
 */
function handleImportEvent(event, data) {
  console.log(`Import event: ${event}`, data);

  const statusText = document.getElementById('importStatusText');
  const stats = document.getElementById('importStats');
  const importedCount = document.getElementById('importedCount');
  const duplicateCount = document.getElementById('duplicateCount');
  const errorCount = document.getElementById('errorCount');
  const doneBtn = document.getElementById('importDoneBtn');

  if (event === 'start') {
    statusText.innerHTML = `<p>Importing ${data.total} files<span class="import-spinner"></span></p>`;
    stats.style.display = 'flex';

    // Initialize error tracking
    if (!window.importErrors) {
      window.importErrors = [];
    }
    window.importErrors = [];

    // Initialize photo ID tracking
    if (!window.importedPhotoIds) {
      window.importedPhotoIds = [];
    }
    window.importedPhotoIds = [];

    // Hide details section initially
    const detailsSection = document.getElementById('importDetailsSection');
    if (detailsSection) {
      detailsSection.style.display = 'none';
    }
  }

  if (event === 'progress') {
    importedCount.textContent = data.imported || 0;
    duplicateCount.textContent = data.duplicates || 0;
    errorCount.textContent = data.errors || 0;

    // Track imported photo ID if provided
    if (data.photo_id) {
      if (!window.importedPhotoIds) {
        window.importedPhotoIds = [];
      }
      window.importedPhotoIds.push(data.photo_id);
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

  if (event === 'complete') {
    const totalErrors = data.errors || 0;
    if (totalErrors > 0) {
      statusText.innerHTML = `<p>Import complete with ${totalErrors} error${
        totalErrors > 1 ? 's' : ''
      }</p>`;

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
              <span>Show error details</span>
            `;
          }
        }
      }
    } else {
      statusText.innerHTML = '<p>Import complete</p>';
    }

    importedCount.textContent = data.imported || 0;
    duplicateCount.textContent = data.duplicates || 0;
    errorCount.textContent = data.errors || 0;
    doneBtn.style.display = 'block';

    // Reload photos if any were imported
    const importedPhotos = data.imported || 0;
    if (importedPhotos > 0) {
      console.log(`🔄 Reloading ${importedPhotos} newly imported photos...`);
      loadAndRenderPhotos();
    }
  }

  if (event === 'error') {
    statusText.innerHTML = `<p>Import failed: ${data.error}</p>`;
    doneBtn.style.display = 'block';
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

    console.log('📊 Library status:', status.status);

    switch (status.status) {
      case 'not_configured':
        // First-time setup - show empty state
        console.log('⚠️ No library configured');
        state.hasDatabase = false;
        renderFirstRunEmptyState();
        return;

      case 'library_missing':
      case 'library_inaccessible':
        console.log('⚠️ Library not accessible:', status.library_path);
        state.hasDatabase = false;
        showCriticalErrorModal('library_not_found', status.library_path);
        return;

      case 'db_missing':
      case 'db_inaccessible':
        console.log('⚠️ Database not accessible:', status.db_path);
        state.hasDatabase = false;
        showCriticalErrorModal('db_missing', status.db_path);
        return;

      case 'healthy':
        console.log('✅ Library is healthy');
        state.hasDatabase = true;
        // Now it's safe to populate date picker and load photos
        await populateDatePicker();
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

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
