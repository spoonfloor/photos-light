// Photo Viewer - Main Entry Point

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
};

// =====================
// APP BAR
// =====================

// Load app bar fragment
function loadAppBar() {
  const mount = document.getElementById('appBarMount');

  // Check session cache first (with version check)
  const APP_BAR_VERSION = '39'; // Increment this when appBar changes
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
  return fetch('fragments/appBar.html?v=14')
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

  if (addPhotoBtn) {
    addPhotoBtn.addEventListener('click', () => {
      console.log('📸 Add photo clicked');
      openFilePicker();
    });
  }

  // Populate and wire date picker
  populateDatePicker();
  wireDatePicker();
}

/**
 * Populate year picker with years from DB
 */
async function populateDatePicker() {
  try {
    const response = await fetch('/api/years');
    const data = await response.json();

    const yearPicker = document.getElementById('yearPicker');
    if (!yearPicker) return;

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
    }

    console.log(`📅 Loaded ${data.years.length} years`);
  } catch (error) {
    console.error('❌ Error loading years:', error);
  }
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
    })
    .catch((err) => {
      console.error('❌ Dialog load failed:', err);
    });
}

/**
 * Show confirmation dialog (old callback-based version)
 */
function showDialogOld(title, message, onConfirm) {
  const overlay = document.getElementById('dialogOverlay');
  const titleEl = document.getElementById('dialogTitle');
  const messageEl = document.getElementById('dialogMessage');
  const confirmBtn = document.getElementById('dialogConfirmBtn');
  const cancelBtn = document.getElementById('dialogCancelBtn');

  if (!overlay) return;

  titleEl.textContent = title;
  messageEl.textContent = message;

  // Remove old listeners
  const newConfirmBtn = confirmBtn.cloneNode(true);
  const newCancelBtn = cancelBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

  // Add new listeners
  newConfirmBtn.addEventListener('click', () => {
    hideDialog();
    onConfirm();
  });

  newCancelBtn.addEventListener('click', hideDialog);

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

    if (!overlay) {
      resolve(false);
      return;
    }

    titleEl.textContent = title;
    messageEl.textContent = message;

    // Clear and rebuild buttons
    actionsEl.innerHTML = '';

    buttons.forEach(btn => {
      const buttonEl = document.createElement('button');
      buttonEl.className = `dialog-button ${btn.primary ? 'dialog-button-primary' : 'dialog-button-secondary'}`;
      buttonEl.textContent = btn.text;
      buttonEl.addEventListener('click', () => {
        hideDialog();
        resolve(btn.value);
      });
      actionsEl.appendChild(buttonEl);
    });

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

        // Show toast
        showToast(
          `✅ Updated ${photoIds.length} photo${
            photoIds.length > 1 ? 's' : ''
          }`,
          null
        );

        // Reload grid
        setTimeout(() => {
          loadAndRenderPhotos(false);
        }, 300);
      } else {
        console.error('❌ Failed to update dates:', result.error);
        showToast('❌ Failed to update dates', null);
      }
    } else {
      // Single photo edit
      const photoId = photoIds[0];

      const response = await fetch('/api/photo/update_date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_id: photoId, new_date: newDate }),
      });

      const result = await response.json();

      if (response.ok) {
        if (result.dry_run) {
          console.log('🔍 DRY RUN - Date would be updated to:', newDate);
          showToast('✅ Date updated (DRY RUN)', null);
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

          // Show toast
          showToast('✅ Date updated', null);

          // Close lightbox to show updated grid
          closeLightbox();

          // Reload the entire grid to reflect new sort order
          setTimeout(() => {
            loadAndRenderPhotos(false); // false = reset from beginning
          }, 300); // Longer delay to ensure lightbox is fully closed
        }
      } else {
        console.error('❌ Failed to update date:', result.error);
        showToast('❌ Failed to update date', null);
      }
    }
  } catch (error) {
    console.error('❌ Error updating date:', error);
    showToast('❌ Error updating date', null);
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
function showToast(message, onUndo, duration = 5000) {
  const toast = document.getElementById('toast');
  const messageEl = document.getElementById('toastMessage');
  const undoBtn = document.getElementById('toastUndoBtn');

  if (!toast) return;

  messageEl.textContent = message;

  // Remove old listener
  const newUndoBtn = undoBtn.cloneNode(true);
  undoBtn.parentNode.replaceChild(newUndoBtn, undoBtn);

  // Add new listener
  newUndoBtn.addEventListener('click', () => {
    hideToast();
    onUndo();
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

  // Determine if photo or video - check both file_type field and path extension
  const isVideo = photo.file_type === 'video' || 
                  (photo.path && photo.path.match(/\.(mov|mp4|m4v|avi|mpg|mpeg)$/i));

  if (isVideo) {
    // Create video element
    const video = document.createElement('video');
    video.src = `/api/photo/${photo.id}/file`;
    video.controls = true;
    video.autoplay = true;

    // Videos self-report dimensions - don't set aspect-ratio

    content.appendChild(video);
  } else {
    // Create image element
    const img = document.createElement('img');
    img.src = `/api/photo/${photo.id}/file`;
    const filename = photo.path ? photo.path.split('/').pop() : (photo.filename || `Photo ${photo.id}`);
    img.alt = filename;

    // Set aspect ratio if available to prevent layout shift
    if (photo.width && photo.height) {
      img.style.aspectRatio = `${photo.width} / ${photo.height}`;
    }

    // Gray background while loading, remove once loaded
    img.style.backgroundColor = '#2a2a2a';
    img.addEventListener('load', () => {
      img.style.backgroundColor = 'transparent';
    });

    content.appendChild(img);
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
      const filename = photo.path ? photo.path.split('/').pop() : (photo.filename || photo.id);
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

    state.photos = data.photos;
    console.log(`✅ Loaded ${state.photos.length.toLocaleString()} photos`);

    // Render entire grid structure immediately (placeholders)
    renderPhotoGrid(state.photos, false);

    // Setup lazy loading for thumbnails
    setupThumbnailLazyLoading();
  } catch (error) {
    console.error('❌ Error loading photos:', error);
  } finally {
    state.loading = false;
  }
}

/**
 * Setup lazy loading for thumbnails (only load when visible)
 */
let thumbnailObserver = null;

function setupThumbnailLazyLoading() {
  // Create observer if it doesn't exist
  if (!thumbnailObserver) {
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
  }

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
      container.innerHTML =
        '<div style="padding: 2rem; text-align: center; color: var(--text-color);">No photos found</div>';
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

    // Select all cards in range
    for (let i = start; i <= end; i++) {
      const rangeCard = document.querySelector(`[data-index="${i}"]`);
      if (rangeCard) {
        const rangeId = parseInt(rangeCard.dataset.id);
        rangeCard.classList.add('selected');
        state.selectedPhotos.add(rangeId);
      }
    }

    updateDeleteButtonVisibility();
    console.log(
      `📷 Shift-selected ${end - start + 1} photos (${
        state.selectedPhotos.size
      } total selected)`
    );
  }
  // NORMAL CLICK: Toggle single
  else {
    if (card.classList.contains('selected')) {
      card.classList.remove('selected');
      state.selectedPhotos.delete(id);
      console.log(
        `📷 Deselected photo ${id} (${state.selectedPhotos.size} selected)`
      );
    } else {
      card.classList.add('selected');
      state.selectedPhotos.add(id);
      console.log(
        `📷 Selected photo ${id} (${state.selectedPhotos.size} selected)`
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
      toggleMonthSelection(month);
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
    console.log(`🗑️ Deleted ${result.deleted} photos from backend`);

    // Clear selection
    state.selectedPhotos.clear();
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
      () => undoDelete(photoIds),
      5000
    );
  } catch (error) {
    console.error('❌ Delete error:', error);
    showToast('Delete failed', null, 3000);
  } finally {
    state.deleteInProgress = false;
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

    showToast('Restored', null, 2000);
  } catch (error) {
    console.error('❌ Restore error:', error);
    showToast('Restore failed', null, 3000);
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
    doneBtn.addEventListener('click', async () => {
      closeImportOverlay();

      // Reload grid to show new photos
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
 * Open file picker for importing photos
 */
function openFilePicker() {
  // Create hidden file input
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,video/*';

  input.onchange = (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      startImport(files);
    }
  };

  input.click();
}

/**
 * Start import process with SSE
 */
async function startImport(files) {
  console.log(`📥 Starting import of ${files.length} file(s)`);

  // Reset state
  importState = {
    isImporting: true,
    totalFiles: files.length,
    importedCount: 0,
    duplicateCount: 0,
    errorCount: 0,
    backupPath: null,
    importedPhotoIds: [],
    results: [],
  };

  // Load and show import overlay
  await loadImportOverlay();
  showImportOverlay();

  // Update UI
  updateImportUI('Preparing import', true);

  // Create FormData
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));

  try {
    // Start SSE connection
    const response = await fetch('/api/photos/import', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Import failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastActivityTime = Date.now();
    const ACTIVITY_TIMEOUT = 60000; // 60 seconds of no data = connection dead

    // Read SSE stream
    while (true) {
      // Check for timeout (no data received for 60 seconds)
      if (Date.now() - lastActivityTime > ACTIVITY_TIMEOUT) {
        throw new Error('Import connection timed out - no data received for 60 seconds');
      }

      const { done, value } = await reader.read();

      if (done) {
        console.log('📭 SSE stream ended');
        break;
      }

      lastActivityTime = Date.now(); // Reset activity timer

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('event:')) {
          const eventType = line.substring(7).trim();
          continue;
        }

        if (line.startsWith('data:')) {
          const data = JSON.parse(line.substring(5).trim());

          // Handle different event types based on data structure
          if (data.total && !data.filename) {
            // Start event
            console.log(`📦 Starting import of ${data.total} files`);
            importState.totalFiles = data.total;
            updateImportUI(
              `Processing ${data.total} item${data.total > 1 ? 's' : ''}`,
              true
            );
          } else if (data.filename) {
            // Progress event
            console.log(
              `📄 ${data.file_index}/${data.total}: ${data.filename} - ${data.status}`
            );

            // Update counts
            importState.importedCount = data.imported;
            importState.duplicateCount = data.duplicates;
            importState.errorCount = data.errors;
            
            // Track this file result (in case completion event never arrives)
            importState.results.push({
              filename: data.filename,
              status: data.status,
              message: data.status === 'duplicate' ? 'Already in library' : null
            });

            // Update UI to show animated count changes
            updateImportUI(
              `Processing ${data.total} item${data.total > 1 ? 's' : ''}`,
              true
            );
          } else if (data.results) {
            // Complete event
            console.log('✅ Import complete:', data);

            importState.importedCount = data.imported;
            importState.duplicateCount = data.duplicates;
            importState.errorCount = data.errors;
            importState.backupPath = data.backup_path;
            importState.results = data.results;

            // Track imported photo IDs for undo
            importState.importedPhotoIds = data.results
              .filter((r) => r.status === 'success' && r.photo_id)
              .map((r) => r.photo_id);

            // Update UI to complete state
            const message =
              data.imported > 0
                ? `${data.total} item${data.total > 1 ? 's' : ''} processed. ${data.imported} imported.`
                : `${data.total} item${data.total > 1 ? 's' : ''} processed. None imported.`;

            updateImportUI(message, false);
            showImportComplete();
          } else if (data.error) {
            // Error event
            throw new Error(data.error);
          }
        }
      }
    }

    // If we exit the loop without getting a completion event, check if import is done
    if (importState.isImporting) {
      console.warn('⚠️ SSE stream ended but no completion event received');
      console.log('📊 Current state:', importState);
      
      // If all files accounted for (imported + duplicates + errors = total), mark as complete
      const accountedFor = importState.importedCount + importState.duplicateCount + importState.errorCount;
      if (accountedFor === importState.totalFiles) {
        console.log('✅ All files accounted for - marking import as complete');
        
        const message =
          importState.importedCount > 0
            ? `${importState.totalFiles} item${importState.totalFiles > 1 ? 's' : ''} processed. ${importState.importedCount} imported.`
            : `${importState.totalFiles} item${importState.totalFiles > 1 ? 's' : ''} processed. None imported.`;

        updateImportUI(message, false);
        showImportComplete();
      } else {
        throw new Error(`Import incomplete: ${accountedFor}/${importState.totalFiles} files processed`);
      }
    }
  } catch (error) {
    console.error('❌ Import error:', error);
    
    // Provide more helpful error message
    let errorMessage = 'Import failed';
    if (error.message.includes('timeout')) {
      errorMessage = 'Import connection lost - server may have restarted';
    } else if (error.message.includes('incomplete')) {
      errorMessage = error.message;
    }
    
    updateImportUI(errorMessage, false);
    showToast(errorMessage, null, 5000);
  } finally {
    importState.isImporting = false;
  }
}

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
    if (statusText.startsWith('Preparing') || statusText.startsWith('Processing')) {
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
 * Show import complete UI (show details, done, undo buttons)
 */
function showImportComplete() {
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
  showToast('Cannot cancel import in progress', null, 2000);
}

/**
 * Undo import - delete all imported photos
 */
async function undoImport() {
  if (importState.importedPhotoIds.length === 0) {
    showToast('Nothing to undo', null, 2000);
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

    showToast(`Undid import of ${result.deleted} photos`, null, 3000);
    closeImportOverlay();

    // Reload grid
    await loadAndRenderPhotos(false);
  } catch (error) {
    console.error('❌ Undo error:', error);
    showToast('Undo failed', null, 3000);
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
    const response = await fetch('fragments/utilitiesMenu.html');
    if (!response.ok) throw new Error('Failed to load utilities menu');
    
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
    
    // Wire up menu items
    const switchLibraryBtn = document.getElementById('switchLibraryBtn');
    const removeDuplicatesBtn = document.getElementById('removeDuplicatesBtn');
    const verifyIndexBtn = document.getElementById('verifyIndexBtn');
    const cleanOrganizeBtn = document.getElementById('cleanOrganizeBtn');
    const rebuildThumbnailsBtn = document.getElementById('rebuildThumbnailsBtn');
    const rebuildIndexBtn = document.getElementById('rebuildIndexBtn');
    
    if (switchLibraryBtn) {
      switchLibraryBtn.addEventListener('click', () => {
        console.log('🔧 Switch Library clicked (not yet implemented)');
        hideUtilitiesMenu();
        showToast('Switch library - Coming soon', null, 2000);
      });
    }
    
    if (removeDuplicatesBtn) {
      removeDuplicatesBtn.addEventListener('click', () => {
        console.log('🔧 Remove Duplicates clicked');
        hideUtilitiesMenu();
        openDuplicatesOverlay();
      });
    }
    
    if (verifyIndexBtn) {
      verifyIndexBtn.addEventListener('click', () => {
        console.log('🔧 Verify Index clicked (not yet implemented)');
        hideUtilitiesMenu();
        showToast('Verify index - Coming soon', null, 2000);
      });
    }
    
    if (cleanOrganizeBtn) {
      cleanOrganizeBtn.addEventListener('click', () => {
        console.log('🔧 Clean & Organize clicked');
        hideUtilitiesMenu();
        openUpdateIndexOverlay();
      });
    }
    
    if (rebuildThumbnailsBtn) {
      rebuildThumbnailsBtn.addEventListener('click', () => {
        console.log('🔧 Rebuild Thumbnails clicked');
        hideUtilitiesMenu();
        rebuildThumbnails();
      });
    }
    
    if (rebuildIndexBtn) {
      rebuildIndexBtn.addEventListener('click', () => {
        console.log('🔧 Rebuild Index clicked (not yet implemented)');
        hideUtilitiesMenu();
        showToast('Rebuild index - Coming soon', null, 2000);
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
    // Position menu below the button
    const btnRect = utilitiesBtn.getBoundingClientRect();
    console.log('🔧 Button rect:', btnRect);
    console.log('🔧 Setting menu position - top:', btnRect.bottom + 8, 'right:', window.innerWidth - btnRect.right);
    
    menu.style.top = `${btnRect.bottom + 8}px`;
    menu.style.right = `${window.innerWidth - btnRect.right}px`;
    menu.style.display = 'block';
    
    console.log('🔧 Menu style after:', menu.style.top, menu.style.right, menu.style.display);
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
    if (removeBtn) removeBtn.addEventListener('click', removeSelectedDuplicates);
    if (doneBtn) doneBtn.addEventListener('click', closeDuplicatesOverlay);
    
    if (detailsToggle) {
      detailsToggle.addEventListener('click', () => {
        const detailsList = document.getElementById('duplicatesDetailsList');
        const icon = detailsToggle.querySelector('.material-symbols-outlined');
        
        if (detailsList.style.display === 'none') {
          detailsList.style.display = 'block';
          icon.textContent = 'expand_less';
          detailsToggle.querySelector('span:last-child').textContent = 'Hide details';
        } else {
          detailsList.style.display = 'none';
          icon.textContent = 'expand_more';
          detailsToggle.querySelector('span:last-child').textContent = 'Show details';
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
    data.duplicates.forEach(dupSet => {
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
      updateDuplicatesUI(`Found ${data.total_duplicate_sets} items with duplicates`, false);
      showDuplicatesStats();
      renderDuplicatesList();
      showDuplicatesActions();
    }
  } catch (error) {
    console.error('❌ Failed to scan for duplicates:', error);
    updateDuplicatesUI('Failed to scan for duplicates', false);
    showToast('Failed to scan for duplicates', null, 3000);
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
  if (copiesCountEl) copiesCountEl.textContent = duplicatesState.totalExtraCopies;
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
          <strong>${baseFilename}</strong> (${numDuplicates} duplicate${numDuplicates > 1 ? 's' : ''})
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
    showToast('No duplicates selected for removal', null, 2000);
    return;
  }
  
  const photoIds = Array.from(duplicatesState.selectedForRemoval);
  
  try {
    console.log(`🗑️ Removing ${photoIds.length} duplicate photos`);
    
    // Show removing state with spinner
    updateDuplicatesUI(`Removing ${photoIds.length} duplicate${photoIds.length > 1 ? 's' : ''}`, true);
    
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
    updateDuplicatesUI(`Removed ${result.deleted} duplicate${result.deleted > 1 ? 's' : ''}`, false);
    showDuplicatesComplete();
    
    // Reload grid
    await loadAndRenderPhotos(false);
  } catch (error) {
    console.error('❌ Failed to remove duplicates:', error);
    updateDuplicatesUI('Failed to remove duplicates', false);
    showToast('Failed to remove duplicates', null, 3000);
    
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
// CLEAN & ORGANIZE OVERLAY
// ==========================

let updateIndexState = {
  missingFiles: 0,
  untrackedFiles: 0,
  nameUpdates: 0,
  emptyFolders: 0,
  details: null,
};

/**
 * Load Clean & Organize overlay fragment
 */
async function loadUpdateIndexOverlay() {
  // Check if already loaded
  if (document.getElementById('updateIndexOverlay')) {
    return;
  }
  
  try {
    const response = await fetch('fragments/updateIndexOverlay.html');
    if (!response.ok) throw new Error('Failed to load Clean & Organize overlay');
    
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
          detailsToggle.querySelector('span:last-child').textContent = 'Hide details';
        } else {
          detailsList.style.display = 'none';
          icon.textContent = 'expand_more';
          detailsToggle.querySelector('span:last-child').textContent = 'Show details';
        }
      });
    }
  } catch (error) {
    console.error('❌ Failed to load Clean & Organize overlay:', error);
  }
}

/**
 * Phase 1: Open overlay and scan
 */
async function openUpdateIndexOverlay() {
  // Check if already open
  const existingOverlay = document.getElementById('updateIndexOverlay');
  if (existingOverlay && existingOverlay.style.display === 'flex') {
    console.log('⚠️ Clean & Organize overlay already open');
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
    const hasChanges = data.missing_files > 0 || data.untracked_files > 0 || 
                       data.name_updates > 0 || data.empty_folders > 0;
    
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
    showToast('Failed to scan index', null, 3000);
  }
}

/**
 * Phase 3: Execute update (after user clicks Proceed)
 */
async function executeUpdateIndex() {
  console.log('🚀 Executing Clean & Organize...');
  
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
              updateUpdateIndexUI(`Removing missing files... ${data.current}/${data.total}`, true);
            } else if (data.phase === 'adding_untracked') {
              updateUpdateIndexUI(`Adding untracked files... ${data.current}/${data.total}`, true);
            } else if (data.phase === 'updating_names') {
              updateUpdateIndexUI('Updating names...', true);
            } else if (data.phase === 'removing_empty') {
              updateUpdateIndexUI(`Removing empty folders... ${data.current}`, true);
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
    updateUpdateIndexUI('Failed to clean & organize', false);
    showToast('Failed to clean & organize', null, 3000);
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
  if (emptyFoldersEl) emptyFoldersEl.textContent = updateIndexState.emptyFolders;
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
  buttons.forEach(btn => {
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
    html += '<div class="update-detail-section"><strong>Missing Files:</strong><ul>';
    details.missing_files.slice(0, 20).forEach(path => {
      html += `<li>${path}</li>`;
    });
    if (details.missing_files.length > 20) {
      html += `<li><em>... and ${details.missing_files.length - 20} more</em></li>`;
    }
    html += '</ul></div>';
  }
  
  // Untracked Files
  if (details.untracked_files && details.untracked_files.length > 0) {
    html += '<div class="update-detail-section"><strong>Untracked Files:</strong><ul>';
    details.untracked_files.slice(0, 20).forEach(path => {
      html += `<li>${path}</li>`;
    });
    if (details.untracked_files.length > 20) {
      html += `<li><em>... and ${details.untracked_files.length - 20} more</em></li>`;
    }
    html += '</ul></div>';
  }
  
  // Name Updates
  if (details.name_updates && details.name_updates.length > 0) {
    html += '<div class="update-detail-section"><strong>Name Updates:</strong><ul>';
    details.name_updates.slice(0, 20).forEach(path => {
      html += `<li>${path}</li>`;
    });
    if (details.name_updates.length > 20) {
      html += `<li><em>... and ${details.name_updates.length - 20} more</em></li>`;
    }
    html += '</ul></div>';
  }
  
  // Empty Folders
  if (details.empty_folders && details.empty_folders.length > 0) {
    html += '<div class="update-detail-section"><strong>Empty Folders:</strong><ul>';
    details.empty_folders.slice(0, 20).forEach(path => {
      html += `<li>${path}</li>`;
    });
    if (details.empty_folders.length > 20) {
      html += `<li><em>... and ${details.empty_folders.length - 20} more</em></li>`;
    }
    html += '</ul></div>';
  }
  
  // Always show details section in Phase 4
  if (html) {
    detailsList.innerHTML = html;
  } else {
    detailsList.innerHTML = '<div class="update-detail-section"><em>No changes were needed.</em></div>';
  }
  detailsSection.style.display = 'block';
}

/**
 * Close Clean & Organize overlay
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
    document.getElementById('rebuildThumbnailsCloseBtn')?.addEventListener('click', closeRebuildThumbnailsOverlay);
    document.getElementById('rebuildThumbnailsCancelBtn')?.addEventListener('click', closeRebuildThumbnailsOverlay);
    document.getElementById('rebuildThumbnailsProceedBtn')?.addEventListener('click', executeRebuildThumbnails);
    document.getElementById('rebuildThumbnailsDoneBtn')?.addEventListener('click', async () => {
      closeRebuildThumbnailsOverlay();
      // Force thumbnail reload by adding cache-buster
      const thumbnails = document.querySelectorAll('.photo-thumb');
      const cacheBuster = Date.now();
      thumbnails.forEach(img => {
        const src = img.src.split('?')[0];
        img.src = `${src}?t=${cacheBuster}`;
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
function openRebuildThumbnailsOverlay() {
  const overlay = document.getElementById('rebuildThumbnailsOverlay');
  if (!overlay) return;
  
  // Reset to Phase 1
  const statusText = document.getElementById('rebuildThumbnailsStatusText');
  const cancelBtn = document.getElementById('rebuildThumbnailsCancelBtn');
  const proceedBtn = document.getElementById('rebuildThumbnailsProceedBtn');
  const doneBtn = document.getElementById('rebuildThumbnailsDoneBtn');
  
  statusText.innerHTML = 'This will clear all cached thumbnails. They will regenerate automatically as you scroll.<br><br>Ready to delete existing thumbnails?';
  cancelBtn.style.display = 'block';
  proceedBtn.style.display = 'block';
  doneBtn.style.display = 'none';
  
  overlay.style.display = 'block';
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
    statusText.innerHTML = 'Clearing thumbnails<span class="import-spinner"></span>';
    cancelBtn.disabled = true;
    cancelBtn.style.opacity = '0.5';
    proceedBtn.style.display = 'none';
    
    // Execute rebuild
    const response = await fetch('/api/utilities/rebuild-thumbnails', {
      method: 'POST'
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(result.error || 'Failed to rebuild thumbnails');
    }
    
    console.log('✅ Thumbnails cleared:', result);
    
    // Show Phase 3 (confirmation)
    statusText.textContent = "Old thumbnails have been removed. New ones will be created automatically as you scroll.";
    cancelBtn.style.display = 'none';
    doneBtn.style.display = 'block';
    
  } catch (error) {
    console.error('❌ Failed to rebuild thumbnails:', error);
    showToast(`Error: ${error.message}`, 'error', 5000);
    closeRebuildThumbnailsOverlay();
  }
}

// =====================
// INITIALIZATION
// =====================

/**
 * Initialize app
 */
async function init() {
  await loadAppBar();
  await loadLightbox();
  await loadDateEditor();
  await loadDialog();
  await loadToast();
  await loadAndRenderPhotos(); // This now loads ALL photos and sets up lazy loading
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
