// Photo Picker - Custom photo/video picker with multi-select
//
// Allows selection of files and folders with recursive awareness

const PhotoPicker = (() => {
  // State
  const VIRTUAL_ROOT = '__LOCATIONS__';
  let currentPath = VIRTUAL_ROOT;
  let selectedPaths = new Map(); // Full paths → { type: 'file' | 'folder' }
  let folderStateCache = new Map(); // folder path → 'checked' | 'unchecked' | 'indeterminate'
  let topLevelLocations = [];
  let resolveCallback = null;
  let isCountingInBackground = false;
  let countingAborted = false; // Flag to abort ongoing counting operations

  // ===========================================================================
  // API Calls
  // ===========================================================================

  async function getLocations() {
    const response = await fetch('/api/filesystem/get-locations');
    if (!response.ok) {
      throw new Error('Failed to get locations');
    }
    const data = await response.json();
    return data.locations;
  }

  async function listDirectory(path) {
    const response = await fetch('/api/filesystem/list-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, include_files: true }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to list directory');
    }

    const data = await response.json();
    return {
      folders: data.folders || [],
      files: data.files || [],
    };
  }

  // ===========================================================================
  // Selection Logic
  // ===========================================================================

  function isSelected(path) {
    return selectedPaths.has(path);
  }

  function toggleFile(filePath) {
    if (selectedPaths.has(filePath)) {
      selectedPaths.delete(filePath);
    } else {
      selectedPaths.set(filePath, { type: 'file' });
    }
    folderStateCache.clear(); // Invalidate cache
    updateSelectionCount();
  }

  async function toggleFolder(folderPath) {
    if (selectedPaths.has(folderPath)) {
      // Uncheck - remove folder and all its contents
      await unselectFolderRecursive(folderPath);
      folderStateCache.clear();
      updateSelectionCount();
    } else {
      // Check - OPTIMISTIC UI: mark as selected immediately
      selectedPaths.set(folderPath, { type: 'folder' });
      folderStateCache.clear();
      updateSelectionCount();
      
      // Start background counting
      selectFolderRecursiveBackground(folderPath);
    }
  }

  async function selectFolderRecursive(folderPath) {
    selectedPaths.set(folderPath, { type: 'folder' });
    
    try {
      const { folders, files } = await listDirectory(folderPath);
      
      // Add all files
      for (const file of files) {
        const filePath = folderPath + '/' + file.name;
        selectedPaths.set(filePath, { type: 'file' });
      }
      
      // Recursively add all subfolders
      for (const folder of folders) {
        const subFolderPath = folderPath + '/' + folder.name;
        await selectFolderRecursive(subFolderPath);
      }
    } catch (error) {
      console.error('Error selecting folder:', error);
    }
  }

  // Background recursive selection with progress updates
  async function selectFolderRecursiveBackground(folderPath) {
    const startTime = Date.now();
    let lastUpdateTime = startTime;
    let filesDiscoveredSinceUpdate = 0;
    const UPDATE_INTERVAL_MS = 1000;
    const UPDATE_FILE_THRESHOLD = 50;
    
    isCountingInBackground = true;
    
    async function recursiveSelect(path) {
      // Check if counting was aborted
      if (countingAborted) {
        return;
      }
      
      try {
        const { folders, files } = await listDirectory(path);
        
        // Check abort again after async operation
        if (countingAborted) {
          return;
        }
        
        // Add all files
        for (const file of files) {
          if (countingAborted) return; // Check during loop
          
          const filePath = path + '/' + file.name;
          if (!selectedPaths.has(filePath)) {
            selectedPaths.set(filePath, { type: 'file' });
            filesDiscoveredSinceUpdate++;
          }
        }
        
        // Check if we should update UI
        const now = Date.now();
        const timeSinceUpdate = now - lastUpdateTime;
        
        if (filesDiscoveredSinceUpdate >= UPDATE_FILE_THRESHOLD || 
            timeSinceUpdate >= UPDATE_INTERVAL_MS) {
          if (!countingAborted) {
            updateSelectionCount();
            lastUpdateTime = now;
            filesDiscoveredSinceUpdate = 0;
          }
        }
        
        // Recursively process subfolders
        for (const folder of folders) {
          if (countingAborted) return; // Check during loop
          
          const subFolderPath = path + '/' + folder.name;
          if (!selectedPaths.has(subFolderPath)) {
            selectedPaths.set(subFolderPath, { type: 'folder' });
          }
          await recursiveSelect(subFolderPath);
        }
      } catch (error) {
        console.error('Error selecting folder:', error);
      }
    }
    
    await recursiveSelect(folderPath);
    
    // Only finish if not aborted
    if (!countingAborted) {
      const totalTime = Date.now() - startTime;
      isCountingInBackground = false;
      
      // Only show counting state if it took > 300ms
      if (totalTime > 300) {
        folderStateCache.clear();
        updateSelectionCount();
      }
    }
  }

  async function unselectFolderRecursive(folderPath) {
    // Remove all paths that start with this folder path
    const toRemove = Array.from(selectedPaths.keys()).filter(path => 
      path === folderPath || path.startsWith(folderPath + '/')
    );
    
    toRemove.forEach(path => selectedPaths.delete(path));
  }

  // Calculate folder checkbox state (checked, unchecked, indeterminate) with caching
  function getFolderState(folderPath) {
    // Check cache first
    if (folderStateCache.has(folderPath)) {
      return folderStateCache.get(folderPath);
    }
    
    const isChecked = selectedPaths.has(folderPath);
    
    // Check if any descendant is selected
    const hasSelectedDescendant = Array.from(selectedPaths.keys()).some(path => 
      path.startsWith(folderPath + '/')
    );
    
    let state;
    if (isChecked) {
      state = 'checked';
    } else if (hasSelectedDescendant) {
      state = 'indeterminate';
    } else {
      state = 'unchecked';
    }
    
    // Cache the result
    folderStateCache.set(folderPath, state);
    return state;
  }

  // ===========================================================================
  // UI Updates
  // ===========================================================================

  function updateBreadcrumb() {
    const breadcrumb = document.getElementById('photoPickerBreadcrumb');

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

  async function updateFileList() {
    const fileList = document.getElementById('photoPickerFileList');

    // At virtual root, show curated top-level locations
    if (currentPath === VIRTUAL_ROOT) {
      fileList.innerHTML = topLevelLocations
        .map(
          (loc) => `
        <div class="photo-picker-item" data-real-path="${loc.path}" data-type="location">
          <span class="photo-picker-icon material-symbols-outlined">folder</span>
          <span class="photo-picker-name">${loc.name}</span>
          <span class="photo-picker-arrow">→</span>
        </div>
      `
        )
        .join('');

      // Add click handlers
      fileList.querySelectorAll('.photo-picker-item').forEach((item) => {
        item.addEventListener('click', () => {
          navigateTo(item.dataset.realPath);
        });
      });
      return;
    }

    // Regular filesystem navigation with files + folders
    try {
      const { folders, files } = await listDirectory(currentPath);

      if (folders.length === 0 && files.length === 0) {
        fileList.innerHTML = '<div class="empty-state">No photos or folders found</div>';
        return;
      }

      let html = '';

      // Render folders first
      folders.forEach((folder) => {
        const folderPath = currentPath + '/' + folder.name;
        const state = getFolderState(folderPath);

        let iconClass = 'folder'; // unchecked
        let stateClass = '';
        if (state === 'checked') {
          iconClass = 'check_box';
          stateClass = 'selected';
        } else if (state === 'indeterminate') {
          iconClass = 'indeterminate_check_box';
          stateClass = 'selected';
        }

        html += `
          <div class="photo-picker-item folder-item" data-folder-path="${folderPath}" data-type="folder">
            <span class="photo-picker-checkbox material-symbols-outlined ${stateClass}" data-path="${folderPath}" data-type="folder">${iconClass}</span>
            <span class="photo-picker-name">${folder.name}</span>
            <span class="photo-picker-arrow">→</span>
          </div>
        `;
      });

      // Render files
      files.forEach((file) => {
        const filePath = currentPath + '/' + file.name;
        const checked = isSelected(filePath);
        const baseIcon = file.type === 'video' ? 'movie' : 'image';
        const iconClass = checked ? 'check_box' : baseIcon;
        const stateClass = checked ? 'selected' : '';

        html += `
          <div class="photo-picker-item file-item" data-file-path="${filePath}" data-type="file">
            <span class="photo-picker-checkbox material-symbols-outlined ${stateClass}" data-path="${filePath}" data-type="file">${iconClass}</span>
            <span class="photo-picker-name">${file.name}</span>
          </div>
        `;
      });

      fileList.innerHTML = html;

      // Wire up handlers using EVENT DELEGATION (single listener on parent)
      fileList.addEventListener('click', async (e) => {
        const item = e.target.closest('.photo-picker-item');
        if (!item) return;

        const checkbox = item.querySelector('.photo-picker-checkbox');
        const arrow = item.querySelector('.photo-picker-arrow');
        const path = checkbox?.dataset.path;
        const type = checkbox?.dataset.type;

        // Checkbox clicked
        if (e.target.classList.contains('photo-picker-checkbox')) {
          e.stopPropagation();
          if (type === 'folder') {
            toggleFolder(path);
            // Update checkbox icon directly (no re-fetch needed)
            const newState = getFolderState(path);
            if (newState === 'checked') {
              checkbox.textContent = 'check_box';
              checkbox.classList.add('selected');
            } else if (newState === 'unchecked') {
              checkbox.textContent = 'folder';
              checkbox.classList.remove('selected');
            } else {
              checkbox.textContent = 'indeterminate_check_box';
              checkbox.classList.add('selected');
            }
          } else {
            toggleFile(path);
            // Update icon directly (optimistic)
            const currentIcon = checkbox.textContent;
            if (currentIcon === 'check_box') {
              checkbox.textContent = 'image';
              checkbox.classList.remove('selected');
            } else {
              checkbox.textContent = 'check_box';
              checkbox.classList.add('selected');
            }
          }
          return;
        }

        // Arrow clicked - navigate
        if (e.target.classList.contains('photo-picker-arrow') && type === 'folder') {
          e.stopPropagation();
          navigateTo(path);
          return;
        }

        // Row clicked
        if (type === 'folder' && arrow) {
          // Folder row (not checkbox) - navigate
          navigateTo(path);
        } else if (type === 'file') {
          // File row - toggle selection
          checkbox.click();
        }
      });
    } catch (error) {
      fileList.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
    }
  }

  function updateSelectionCount() {
    const countEl = document.getElementById('photoPickerCount');
    const continueBtn = document.getElementById('photoPickerContinueBtn');
    const clearBtn = document.getElementById('photoPickerClearBtn');
    
    const count = selectedPaths.size;
    
    if (count === 0) {
      countEl.textContent = 'No items selected';
      if (continueBtn) continueBtn.disabled = true;
      if (clearBtn) clearBtn.style.visibility = 'hidden';
      return;
    }
    
    // Count folders vs files using stored type (no regex!)
    let folderCount = 0;
    let fileCount = 0;
    
    selectedPaths.forEach((value) => {
      if (value.type === 'folder') {
        folderCount++;
      } else {
        fileCount++;
      }
    });
    
    // Build count text
    const parts = [];
    if (folderCount > 0) parts.push(`${folderCount} folder${folderCount !== 1 ? 's' : ''}`);
    if (fileCount > 0) parts.push(`${fileCount} file${fileCount !== 1 ? 's' : ''}`);
    
    // Show counting state or final count
    if (isCountingInBackground) {
      countEl.textContent = `Counting files... ${fileCount}+`;
    } else {
      countEl.textContent = parts.join(', ') + ' selected';
    }
    
    if (continueBtn) continueBtn.disabled = false;
    if (clearBtn) clearBtn.style.visibility = 'visible';
  }

  function clearSelection() {
    countingAborted = true; // Abort any ongoing counting
    selectedPaths.clear();
    folderStateCache.clear();
    isCountingInBackground = false;
    updateSelectionCount();
    updateFileList();
  }

  async function navigateTo(path) {
    currentPath = path || VIRTUAL_ROOT;
    updateBreadcrumb();
    await updateFileList();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  async function show(options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        // Load fragment if not already in DOM
        let overlay = document.getElementById('photoPickerOverlay');
        if (!overlay) {
          const response = await fetch('/fragments/photoPicker.html');
          const html = await response.text();
          document.body.insertAdjacentHTML('beforeend', html);
          overlay = document.getElementById('photoPickerOverlay');
        }

        // Configure picker
        const title = options.title || 'Select photos';
        const subtitle = options.subtitle || 'Choose photos and folders to import';

        document.getElementById('photoPickerTitle').textContent = title;
        document.getElementById('photoPickerSubtitle').textContent = subtitle;

        // Load locations
        topLevelLocations = await getLocations();

        // Reset state
        currentPath = VIRTUAL_ROOT;
        selectedPaths = new Map();
        folderStateCache = new Map();
        isCountingInBackground = false;
        countingAborted = false; // Reset abort flag for new session

        // Try to default to Desktop
        let initialPath = VIRTUAL_ROOT;
        for (const loc of topLevelLocations) {
          if (loc.path.includes('/Users/') && !loc.path.includes('Shared')) {
            const desktopPath = loc.path + '/Desktop';
            console.log(`🔍 Trying Desktop path: ${desktopPath}`);
            try {
              await listDirectory(desktopPath);
              initialPath = desktopPath;
              console.log('✅ Starting at Desktop:', desktopPath);
              break;
            } catch (error) {
              console.log(`⚠️ Desktop check failed: ${error.message}`);
              console.log(`📁 Falling back to home folder: ${loc.path}`);
              initialPath = loc.path;
              break;
            }
          }
        }
        
        // If still at virtual root, force to first non-Shared location
        if (initialPath === VIRTUAL_ROOT && topLevelLocations.length > 0) {
          const firstLocation = topLevelLocations.find(loc => !loc.path.includes('Shared'));
          if (firstLocation) {
            initialPath = firstLocation.path;
            console.log(`📁 Using first location: ${initialPath}`);
          }
        }

        currentPath = initialPath;

        // Initialize UI
        updateBreadcrumb();
        await updateFileList();
        updateSelectionCount();

        // Show overlay
        overlay.style.display = 'flex';

        // Wire up buttons
        const closeBtn = document.getElementById('photoPickerCloseBtn');
        const cancelBtn = document.getElementById('photoPickerCancelBtn');
        const continueBtn = document.getElementById('photoPickerContinueBtn');
        const clearBtn = document.getElementById('photoPickerClearBtn');

        const handleCancel = () => {
          countingAborted = true; // Abort any ongoing counting
          overlay.style.display = 'none';
          resolveCallback = null;
          resolve(null);
        };

        const handleContinue = () => {
          if (selectedPaths.size === 0) return;
          overlay.style.display = 'none';
          resolveCallback = null;
          // Return array of paths (not the Map values)
          resolve(Array.from(selectedPaths.keys()));
        };

        const handleClear = () => {
          clearSelection();
        };

        // Store resolve callback
        resolveCallback = resolve;

        closeBtn.onclick = handleCancel;
        cancelBtn.onclick = handleCancel;
        continueBtn.onclick = handleContinue;
        clearBtn.onclick = clearSelection;
      } catch (error) {
        console.error('Failed to show photo picker:', error);
        reject(error);
      }
    });
  }

  function hide() {
    const overlay = document.getElementById('photoPickerOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
  }

  return {
    show,
    hide,
  };
})();

// Export for use in main.js
window.PhotoPicker = PhotoPicker;
