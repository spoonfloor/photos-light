// Photo Picker - Custom photo/video picker with multi-select
//
// Allows selection of files and folders with recursive awareness

const PhotoPicker = (() => {
  // State
  const VIRTUAL_ROOT = '__LOCATIONS__';
  let currentPath = VIRTUAL_ROOT;
  let selectedPaths = new Set(); // Full paths of selected files/folders
  let topLevelLocations = [];
  let resolveCallback = null;

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
      selectedPaths.add(filePath);
    }
    updateSelectionCount();
  }

  async function toggleFolder(folderPath) {
    if (selectedPaths.has(folderPath)) {
      // Uncheck - remove folder and all its contents
      await unselectFolderRecursive(folderPath);
    } else {
      // Check - add folder and all its contents
      await selectFolderRecursive(folderPath);
    }
    updateSelectionCount();
  }

  async function selectFolderRecursive(folderPath) {
    selectedPaths.add(folderPath);
    
    try {
      const { folders, files } = await listDirectory(folderPath);
      
      // Add all files
      for (const file of files) {
        const filePath = folderPath + '/' + file.name;
        selectedPaths.add(filePath);
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

  async function unselectFolderRecursive(folderPath) {
    // Remove all paths that start with this folder path
    const toRemove = Array.from(selectedPaths).filter(path => 
      path === folderPath || path.startsWith(folderPath + '/')
    );
    
    toRemove.forEach(path => selectedPaths.delete(path));
  }

  // Calculate folder checkbox state (checked, unchecked, indeterminate)
  function getFolderState(folderPath) {
    const isChecked = selectedPaths.has(folderPath);
    
    // Check if any descendant is selected
    const hasSelectedDescendant = Array.from(selectedPaths).some(path => 
      path.startsWith(folderPath + '/')
    );
    
    if (isChecked) {
      return 'checked';
    } else if (hasSelectedDescendant) {
      return 'indeterminate';
    } else {
      return 'unchecked';
    }
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

      // Wire up checkbox and navigation handlers
      fileList.querySelectorAll('.photo-picker-item').forEach((item) => {
        const checkbox = item.querySelector('.photo-picker-checkbox');
        const arrow = item.querySelector('.photo-picker-arrow');
        const path = checkbox?.dataset.path;
        const type = checkbox?.dataset.type;

        if (checkbox) {
          // Checkbox click
          checkbox.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (type === 'folder') {
              await toggleFolder(path);
              // Re-render to update icon states
              await updateFileList();
            } else {
              toggleFile(path);
              // Update icon directly
              const currentIcon = checkbox.textContent;
              if (currentIcon === 'check_box') {
                checkbox.textContent = 'image'; // or could detect if it was 'movie'
                checkbox.classList.remove('selected');
              } else {
                checkbox.textContent = 'check_box';
                checkbox.classList.add('selected');
              }
            }
          });
        }

        if (arrow && type === 'folder') {
          // Arrow click - navigate
          arrow.addEventListener('click', (e) => {
            e.stopPropagation();
            navigateTo(path);
          });
          
          // Also make the rest of the row (excluding checkbox) navigate
          item.addEventListener('click', (e) => {
            if (e.target === checkbox) return;
            navigateTo(path);
          });
        } else if (type === 'file') {
          // For files, entire row toggles selection
          item.addEventListener('click', (e) => {
            if (e.target === checkbox) return;
            checkbox.click();
          });
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
    } else {
      // Count folders vs files
      let folderCount = 0;
      let fileCount = 0;
      
      selectedPaths.forEach(path => {
        // Simple heuristic: if path has extension, it's a file
        if (path.match(/\.[a-z0-9]+$/i)) {
          fileCount++;
        } else {
          folderCount++;
        }
      });
      
      const parts = [];
      if (folderCount > 0) parts.push(`${folderCount} folder${folderCount !== 1 ? 's' : ''}`);
      if (fileCount > 0) parts.push(`${fileCount} file${fileCount !== 1 ? 's' : ''}`);
      
      countEl.textContent = parts.join(', ') + ' selected';
      if (continueBtn) continueBtn.disabled = false;
      if (clearBtn) clearBtn.style.visibility = 'visible';
    }
  }

  function clearSelection() {
    selectedPaths.clear();
    updateFileList();
    updateSelectionCount();
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
        selectedPaths = new Set();

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
          overlay.style.display = 'none';
          resolveCallback = null;
          resolve(null);
        };

        const handleContinue = () => {
          if (selectedPaths.size === 0) return;
          overlay.style.display = 'none';
          resolveCallback = null;
          resolve(Array.from(selectedPaths));
        };

        const handleClear = () => {
          clearSelection();
        };

        // Store resolve callback
        resolveCallback = resolve;

        closeBtn.onclick = handleCancel;
        cancelBtn.onclick = handleCancel;
        continueBtn.onclick = handleContinue;
        clearBtn.onclick = handleClear;
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
