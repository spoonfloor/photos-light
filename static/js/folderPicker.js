// Folder Picker - Custom folder picker for library creation
//
// This replaces the native macOS folder picker with a custom web-based implementation
// that provides consistent UX across platforms and avoids AppleScript limitations.

const FolderPicker = (() => {
  // State
  const VIRTUAL_ROOT = '__LOCATIONS__';
  const PICKER_INTENT = {
    OPEN_EXISTING_LIBRARY: 'open_existing_library',
    CHOOSE_LIBRARY_LOCATION: 'choose_library_location',
    GENERIC_FOLDER_SELECTION: 'generic_folder_selection',
  };
  let currentPath = VIRTUAL_ROOT;
  let selectedPath = VIRTUAL_ROOT; // Explicitly selected folder (via checkbox)
  let currentHasDb = false; // Track if current selected folder has database
  let currentHasOpenableDb = false; // Track if current folder's DB looks openable
  let selectedHasOpenableDb = false; // Track if the resolved picker action should read as "Open"
  let pickerIntent = PICKER_INTENT.GENERIC_FOLDER_SELECTION;
  let topLevelLocations = [];
  let resolveCallback = null; // Store resolve callback for database click handler
  let onSelectCallback = null;
  let onCancelCallback = null;
  let keyboardHandler = null; // Store keyboard event handler for cleanup
  let folderListClickHandler = null; // Store reference to event handler for cleanup
  let folderListRequestId = 0;
  let selectionProbeRequestId = 0;

  async function readErrorMessage(response, fallbackMessage) {
    try {
      const error = await response.json();
      return error.error || fallbackMessage;
    } catch (_) {
      return fallbackMessage;
    }
  }

  async function readErrorPayload(response, fallbackMessage) {
    try {
      const body = await response.json();
      return { message: body.error || fallbackMessage, code: body.code };
    } catch (_) {
      return { message: fallbackMessage, code: undefined };
    }
  }

  function buildHttpError(response, message) {
    const error = new Error(message);
    error.status = response.status;
    if (response.status === 404) {
      error.code = 'filesystem_api_unavailable';
    }
    return error;
  }

  // ===========================================================================
  // API Calls
  // ===========================================================================

  async function getLocations() {
    const response = await fetch('/api/filesystem/get-locations');
    if (!response.ok) {
      const message = await readErrorMessage(response, 'Failed to get locations');
      throw buildHttpError(response, message);
    }
    const data = await response.json();
    return data.locations;
  }

  async function listDirectory(path) {
    const response = await fetch('/api/filesystem/list-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });

    if (!response.ok) {
      const { message, code } = await readErrorPayload(response, 'Failed to list directory');
      const err = buildHttpError(response, message);
      if (code) err.code = code;
      throw err;
    }

    const data = await response.json();
    return {
      folders: data.folders,
      has_db: data.has_db || false,
      has_openable_db: data.has_openable_db || false,
    };
  }

  async function probeLibraryPath(path) {
    const response = await fetch('/api/library/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: path }),
    });

    if (!response.ok) {
      const { message, code } = await readErrorPayload(response, 'Failed to inspect library path');
      const err = buildHttpError(response, message);
      if (code) err.code = code;
      throw err;
    }

    const data = await response.json();
    return {
      has_db: data.has_db || false,
      has_openable_db: data.has_openable_db || false,
    };
  }

  async function showNativeFolderPicker(options = {}) {
    const nameLibraryOverlay = document.getElementById('nameLibraryOverlay');
    if (nameLibraryOverlay) {
      nameLibraryOverlay.style.display = 'none';
    }

    const prompt = (options.title || 'Select folder').replace(/"/g, '\\"');
    const script = `POSIX path of (choose folder with prompt "${prompt}")`;

    const response = await fetch('/api/library/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to open folder picker');
    }

    if (data.status === 'cancelled') {
      return null;
    }

    return data.library_path || null;
  }

  function isFilesystemApiUnavailable(error) {
    if (error?.code === 'path_not_found') return false;
    return error?.code === 'filesystem_api_unavailable' || error?.status === 404;
  }

  function shouldUseOpenLibraryCta() {
    return pickerIntent === PICKER_INTENT.OPEN_EXISTING_LIBRARY;
  }

  function getPrimaryActionLabel() {
    if (!shouldUseOpenLibraryCta()) {
      return 'Continue';
    }

    return selectedHasOpenableDb ? 'Open' : 'Continue';
  }

  // ===========================================================================
  // UI Updates
  // ===========================================================================

  function updateBreadcrumb() {
    const breadcrumb = document.getElementById('folderPickerBreadcrumb');

    // At virtual root, show just icon + ellipsis with trailing slash
    if (currentPath === VIRTUAL_ROOT) {
      breadcrumb.innerHTML = `
        <span class="breadcrumb-root at-root">
          <span class="breadcrumb-icon material-symbols-outlined">folder</span>
          <span class="breadcrumb-item active">…</span>
        </span>
        <span class="breadcrumb-separator">/</span>
      `;
      return;
    }

    // Build breadcrumb for real paths
    let html = `
      <span class="breadcrumb-root">
        <span class="breadcrumb-icon material-symbols-outlined">folder</span>
        <span class="breadcrumb-item" data-path="${VIRTUAL_ROOT}">…</span>
      </span>
    `;

    // Find which top-level location we're under
    const topLevel = topLevelLocations.find((loc) => currentPath.startsWith(loc.path));
    if (topLevel) {
      html += '<span class="breadcrumb-separator">/</span>';
      html += `<span class="breadcrumb-item" data-path="${topLevel.path}">${topLevel.name}</span>`;

      // Add remaining path parts after the top-level location
      const relativePath = currentPath.substring(topLevel.path.length);
      const relativeParts = relativePath.split('/').filter((p) => p);

      let buildPath = topLevel.path;
      relativeParts.forEach((part, index) => {
        buildPath += '/' + part;
        const isLast = index === relativeParts.length - 1;
        html += '<span class="breadcrumb-separator">/</span>';
        html += `<span class="breadcrumb-item ${
          isLast ? 'active' : ''
        }" data-path="${buildPath}">${part}</span>`;
      });
    }

    breadcrumb.innerHTML = html;

    // Add click handler to root wrapper
    const rootElement = breadcrumb.querySelector('.breadcrumb-root');
    if (rootElement && !rootElement.classList.contains('at-root')) {
      rootElement.addEventListener('click', () => {
        navigateTo(VIRTUAL_ROOT);
      });
    }

    // Add click handlers to other breadcrumb items
    breadcrumb.querySelectorAll('.breadcrumb-item').forEach((item) => {
      if (item.dataset.path && !item.closest('.breadcrumb-root')) {
        item.addEventListener('click', () => {
          navigateTo(item.dataset.path);
        });
      }
    });
  }

  async function updateFolderList() {
    const folderList = document.getElementById('folderPickerFolderList');
    const requestId = ++folderListRequestId;
    const pathForRequest = currentPath;

    // At virtual root, show curated top-level locations
    if (currentPath === VIRTUAL_ROOT) {
      currentHasDb = false;
      currentHasOpenableDb = false;
      selectedHasOpenableDb = false;
      updateButtonText();
      
      folderList.innerHTML = topLevelLocations
        .map(
          (loc) => `
        <div class="folder-item" data-real-path="${loc.path}">
          <span class="folder-icon material-symbols-outlined">folder</span>
          <span class="folder-name">${loc.name}</span>
          <span class="folder-arrow">→</span>
        </div>
      `
        )
        .join('');

      // Remove old event listener if it exists
      if (folderListClickHandler) {
        folderList.removeEventListener('click', folderListClickHandler);
      }

      // Wire up handlers using EVENT DELEGATION for top-level locations
      folderListClickHandler = (e) => {
        const item = e.target.closest('.folder-item[data-real-path]');
        if (!item) return;
        navigateTo(item.dataset.realPath);
      };
      
      folderList.addEventListener('click', folderListClickHandler);
      return;
    }

    // Regular filesystem navigation
    try {
      const result = await listDirectory(currentPath);
      if (requestId !== folderListRequestId || pathForRequest !== currentPath) {
        return;
      }
      const folders = result.folders;
      currentHasDb = result.has_db;
      currentHasOpenableDb = result.has_openable_db;
      if (shouldUseOpenLibraryCta() && selectedPath === currentPath) {
        selectedHasOpenableDb = currentHasOpenableDb;
      } else if (!shouldUseOpenLibraryCta()) {
        selectedHasOpenableDb = false;
      }
      
      // Update button based on database presence
      updateButtonText();

      if (folders.length === 0 && !currentHasDb) {
        // Show placeholder boxes to fill vertical space without scrolling
        // Calculated to fit available folder-list height (~350px / 54px per item = 6)
        folderList.innerHTML = `
          <div class="folder-placeholder-container">
            <div class="folder-placeholder"></div>
            <div class="folder-placeholder"></div>
            <div class="folder-placeholder"></div>
            <div class="folder-placeholder"></div>
            <div class="folder-placeholder"></div>
            <div class="folder-placeholder"></div>
          </div>
        `;
        return;
      }

      let html = '';
      
      // Add folders first
      folders.forEach((folder) => {
        const folderPath = currentPath + '/' + folder;
        const isSelected = selectedPath === folderPath;
        const iconClass = isSelected ? 'check_box' : 'folder';
        const selectedClass = isSelected ? 'selected' : '';
        
        html += `
          <div class="folder-item" data-folder="${folder}" data-folder-path="${folderPath}">
            <span class="folder-checkbox material-symbols-outlined ${selectedClass}" data-path="${folderPath}">${iconClass}</span>
            <span class="folder-name">${folder}</span>
            <span class="folder-arrow">→</span>
          </div>
        `;
      });

      // Show database file at bottom if it exists
      if (currentHasDb) {
        html += `
          <div class="folder-item folder-item-db" data-is-db="true">
            <span class="folder-icon material-symbols-outlined">description</span>
            <span class="folder-name">photo_library.db</span>
          </div>
        `;
      }

      folderList.innerHTML = html;

      // Remove old event listener if it exists to prevent duplicate handlers
      if (folderListClickHandler) {
        folderList.removeEventListener('click', folderListClickHandler);
      }

      // Wire up handlers using EVENT DELEGATION (single listener on parent)
      folderListClickHandler = async (e) => {
        const item = e.target.closest('.folder-item[data-folder]');
        if (!item) {
          // Check if database file was clicked
          const dbItem = e.target.closest('.folder-item[data-is-db]');
          if (dbItem) {
            // Same action as clicking "Choose" button
            if (currentPath !== VIRTUAL_ROOT && resolveCallback) {
              localStorage.setItem('picker.lastPath', currentPath);
              
              
              const overlay = document.getElementById('folderPickerOverlay');
              if (overlay) {
                overlay.style.display = 'none';
              }
              resolveCallback(currentPath);
            }
          }
          return;
        }

        const checkbox = item.querySelector('.folder-checkbox');
        const folderPath = checkbox?.dataset.path;

        // Checkbox clicked - select this folder
        if (e.target.classList.contains('folder-checkbox')) {
          e.stopPropagation();
          selectFolder(folderPath);
          return;
        }

        // Arrow or folder name clicked - navigate into folder
        const folder = item.dataset.folder;
        const newPath = currentPath + '/' + folder;
        navigateTo(newPath);
      };

      folderList.addEventListener('click', folderListClickHandler);
    } catch (error) {
      if (requestId !== folderListRequestId || pathForRequest !== currentPath) {
        return;
      }
      folderList.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
      currentHasDb = false;
      currentHasOpenableDb = false;
      if (shouldUseOpenLibraryCta() && selectedPath === currentPath) {
        selectedHasOpenableDb = false;
      } else if (!shouldUseOpenLibraryCta()) {
        selectedHasOpenableDb = false;
      }
      updateButtonText();
    }
  }

  function updateSelectedPath() {
    const pathDisplay = document.getElementById('folderPickerSelectedPath');
    // Show real path (not virtual root)
    if (selectedPath === VIRTUAL_ROOT) {
      pathDisplay.textContent = 'No path selected';
    } else {
      pathDisplay.textContent = selectedPath;
    }
  }

  function updateButtonText() {
    const chooseBtn = document.getElementById('folderPickerChooseBtn');
    if (chooseBtn) {
      chooseBtn.textContent = getPrimaryActionLabel();
    }
  }

  async function syncSelectedPathProbe() {
    const requestId = ++selectionProbeRequestId;

    if (!shouldUseOpenLibraryCta()) {
      selectedHasOpenableDb = false;
      updateButtonText();
      return;
    }

    if (selectedPath === VIRTUAL_ROOT) {
      selectedHasOpenableDb = false;
      updateButtonText();
      return;
    }

    if (selectedPath === currentPath) {
      selectedHasOpenableDb = currentHasOpenableDb;
      updateButtonText();
      return;
    }

    // While probing an explicitly selected sibling folder, fall back to the safe CTA.
    selectedHasOpenableDb = false;
    updateButtonText();

    try {
      const result = await probeLibraryPath(selectedPath);
      if (requestId !== selectionProbeRequestId) {
        return;
      }
      selectedHasOpenableDb = result.has_openable_db;
      updateButtonText();
    } catch (_) {
      if (requestId !== selectionProbeRequestId) {
        return;
      }
      selectedHasOpenableDb = false;
      updateButtonText();
    }
  }

  async function selectFolder(path) {
    // Toggle behavior - clicking same folder deselects it
    if (selectedPath === path) {
      selectedPath = currentPath; // Revert to current location
      
    } else {
      selectedPath = path; // Select (radio button - clears others)
      
    }
    
    // Re-render folder list to update checkbox states
    await updateFolderList();
    await syncSelectedPathProbe();
    updateSelectedPath();
  }

  async function navigateTo(path) {
    currentPath = path || VIRTUAL_ROOT;
    // When navigating, selected path becomes where you are (unless you explicitly checked something)
    selectedPath = currentPath;
    updateBreadcrumb();
    await updateFolderList(); // This now updates currentHasDb and button text
    await syncSelectedPathProbe();
    updateSelectedPath();
  }

  // ===========================================================================
  // Keyboard Shortcuts
  // ===========================================================================

  async function handleKeyboard(e) {
    // Command+Shift+D - Navigate to Desktop (Mac standard shortcut)
    if (e.metaKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      
      
      // Find user's home directory (contains /Users/ but not Shared)
      const homeLocation = topLevelLocations.find(loc => 
        loc.path.includes('/Users/') && !loc.path.includes('Shared')
      );
      
      if (homeLocation) {
        const desktopPath = homeLocation.path + '/Desktop';
        
        
        try {
          // Validate Desktop exists before navigating
          await listDirectory(desktopPath);
          await navigateTo(desktopPath);
        } catch (error) {
          console.warn('⚠️ Desktop not accessible:', error.message);
          // Fallback to home directory if Desktop doesn't exist
          await navigateTo(homeLocation.path);
        }
      } else {
        console.warn('⚠️ Home directory not found in topLevelLocations');
      }
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  async function show(options = {}) {
    return new Promise(async (resolve, reject) => {
      let wizardActions = false;
      try {
        wizardActions = !!options.wizardActions;
        pickerIntent = options.intent || PICKER_INTENT.GENERIC_FOLDER_SELECTION;
        // Load fragment if not already in DOM
        let overlay = document.getElementById('folderPickerOverlay');
        if (!overlay) {
          const response = await fetch('/fragments/folderPicker.html');
          const html = await response.text();
          document.body.insertAdjacentHTML('beforeend', html);
          overlay = document.getElementById('folderPickerOverlay');
        }

        // Configure picker
        const title = options.title || 'Open library';
        const subtitle = options.subtitle || 'Select an existing library folder (or choose where to create one).';

        document.getElementById('folderPickerTitle').textContent = title;
        document.getElementById('folderPickerSubtitle').textContent = subtitle;

        const showGoBack = wizardActions && !!options.showGoBack;
        const goBackBtn = document.getElementById('folderPickerGoBackBtn');
        if (goBackBtn) {
          goBackBtn.style.display = showGoBack ? '' : 'none';
        }

        // Load locations
        topLevelLocations = await getLocations();

        // Determine initial path
        let initialPath = options.initialPath || VIRTUAL_ROOT;
        
        // If no initial path provided and currentPath is set from previous session, use it
        if (!options.initialPath && currentPath !== VIRTUAL_ROOT) {
          initialPath = currentPath;
          
        }
        // Otherwise try to use last saved path from localStorage
        else if (initialPath === VIRTUAL_ROOT) {
          const savedPath = localStorage.getItem('picker.lastPath');
          if (savedPath) {
            
            try {
              // Validate saved path exists and is accessible
              await listDirectory(savedPath);
              initialPath = savedPath;
              
            } catch (error) {
              
              // Fall through to Desktop default
            }
          }
          
          // If still at virtual root, use shared utility to get default path
          if (initialPath === VIRTUAL_ROOT) {
            initialPath = await PickerUtils.getDefaultPath(topLevelLocations, listDirectory);
          }
        }

        // Set initial path
        currentPath = initialPath;
        selectedPath = initialPath;
        currentHasDb = false;
        currentHasOpenableDb = false;
        selectedHasOpenableDb = false;

        // Initialize UI
        updateBreadcrumb();
        await updateFolderList();
        await syncSelectedPathProbe();
        updateSelectedPath();

        // Hide name-library step if still visible (wizard kept it until this paints).
        const nameLibraryOverlay = document.getElementById('nameLibraryOverlay');
        if (nameLibraryOverlay) {
          nameLibraryOverlay.style.display = 'none';
        }

        // Show overlay
        overlay.style.display = 'flex';
        overlay.style.pointerEvents = '';

        // Wire up buttons
        const closeBtn = document.getElementById('folderPickerCloseBtn');
        const cancelBtn = document.getElementById('folderPickerCancelBtn');
        const chooseBtn = document.getElementById('folderPickerChooseBtn');

        const handleCancel = () => {
          overlay.style.display = 'none';
          if (keyboardHandler) {
            document.removeEventListener('keydown', keyboardHandler);
            keyboardHandler = null;
          }
          resolveCallback = null;
          resolve(wizardActions ? { action: 'cancel' } : null);
        };

        const handleGoBack = () => {
          overlay.style.display = 'none';
          if (keyboardHandler) {
            document.removeEventListener('keydown', keyboardHandler);
            keyboardHandler = null;
          }
          resolveCallback = null;
          resolve({ action: 'back' });
        };

        const handleChoose = async () => {
          if (selectedPath === VIRTUAL_ROOT) {
            // No path selected
            return;
          }

          // Save selected path to localStorage for next session
          localStorage.setItem('picker.lastPath', selectedPath);

          if (typeof options.beforeResolveChoose === 'function') {
            await options.beforeResolveChoose();
          }

          if (keyboardHandler) {
            document.removeEventListener('keydown', keyboardHandler);
            keyboardHandler = null;
          }
          resolveCallback = null;
          if (options.keepVisibleOnChoose) {
            overlay.style.pointerEvents = 'none';
            resolve(selectedPath);
            return;
          }

          overlay.style.display = 'none';
          resolve(selectedPath);
        };

        // Store resolve callback for database click handler
        resolveCallback = resolve;

        closeBtn.onclick = handleCancel;
        cancelBtn.onclick = handleCancel;
        chooseBtn.onclick = handleChoose;
        if (goBackBtn) {
          goBackBtn.onclick = showGoBack ? handleGoBack : null;
        }

        keyboardHandler = (e) => {
          void handleKeyboard(e);
          const isEnter = e.key === 'Enter' || e.key === 'NumpadEnter';
          if (!isEnter) return;
          const t = e.target;
          const actionBtn =
            t && typeof t.closest === 'function' ? t.closest('button') : null;
          if (
            actionBtn === chooseBtn ||
            actionBtn === cancelBtn ||
            actionBtn === closeBtn ||
            (showGoBack && goBackBtn && actionBtn === goBackBtn)
          ) {
            return;
          }
          e.preventDefault();
          void handleChoose();
        };
        document.addEventListener('keydown', keyboardHandler);
      } catch (error) {
        console.error('Failed to show folder picker:', error);
        if (isFilesystemApiUnavailable(error)) {
          try {
            const nativePath = await showNativeFolderPicker(options);
            if (wizardActions) {
              resolve(nativePath ? nativePath : { action: 'cancel' });
            } else {
              resolve(nativePath);
            }
            return;
          } catch (nativeError) {
            console.error('Native folder picker fallback failed:', nativeError);
            reject(nativeError);
            return;
          }
        }
        reject(error);
      }
    });
  }

  function hide() {
    const overlay = document.getElementById('folderPickerOverlay');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.style.pointerEvents = '';
    }
    // Clean up keyboard listener
    if (keyboardHandler) {
      document.removeEventListener('keydown', keyboardHandler);
      keyboardHandler = null;
    }
  }

  return {
    INTENT: PICKER_INTENT,
    show,
    hide,
  };
})();

// Export for use in main.js
window.FolderPicker = FolderPicker;
