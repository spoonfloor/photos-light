// Folder Picker - Custom folder picker for library creation
//
// This replaces the native macOS folder picker with a custom web-based implementation
// that provides consistent UX across platforms and avoids AppleScript limitations.

const FolderPicker = (() => {
  // State
  const VIRTUAL_ROOT = '__LOCATIONS__';
  let currentPath = VIRTUAL_ROOT;
  let selectedPath = VIRTUAL_ROOT;
  let currentHasDb = false; // Track if current selected folder has database
  let topLevelLocations = [];
  let resolveCallback = null; // Store resolve callback for database click handler
  let onSelectCallback = null;
  let onCancelCallback = null;

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
      body: JSON.stringify({ path }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to list directory');
    }

    const data = await response.json();
    return {
      folders: data.folders,
      has_db: data.has_db || false
    };
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

    // At virtual root, show curated top-level locations
    if (currentPath === VIRTUAL_ROOT) {
      currentHasDb = false;
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

      // Add click handlers
      folderList.querySelectorAll('.folder-item').forEach((item) => {
        item.addEventListener('click', () => {
          navigateTo(item.dataset.realPath);
        });
      });
      return;
    }

    // Regular filesystem navigation
    try {
      const result = await listDirectory(currentPath);
      const folders = result.folders;
      currentHasDb = result.has_db;
      
      // Update button based on database presence
      updateButtonText();

      if (folders.length === 0 && !currentHasDb) {
        folderList.innerHTML = '<div class="empty-state">Select \'Create new\' to create a library here</div>';
        return;
      }

      let html = '';
      
      // Add folders first
      html += folders
        .map(
          (folder) => `
        <div class="folder-item" data-folder="${folder}">
          <span class="folder-icon material-symbols-outlined">folder</span>
          <span class="folder-name">${folder}</span>
          <span class="folder-arrow">→</span>
        </div>
      `
        )
        .join('');

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

      // Add click handlers to folders
      folderList.querySelectorAll('.folder-item[data-folder]').forEach((item) => {
        item.addEventListener('click', () => {
          const folder = item.dataset.folder;
          const newPath = currentPath + '/' + folder;
          navigateTo(newPath);
        });
      });

      // Add click handler to database file (acts like "Choose" button)
      const dbItem = folderList.querySelector('.folder-item[data-is-db]');
      if (dbItem) {
        dbItem.addEventListener('click', () => {
          // Same action as clicking "Choose" button
          if (currentPath !== VIRTUAL_ROOT && resolveCallback) {
            const overlay = document.getElementById('folderPickerOverlay');
            if (overlay) {
              overlay.style.display = 'none';
            }
            resolveCallback(currentPath);
          }
        });
      }
    } catch (error) {
      folderList.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
      currentHasDb = false;
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
      if (currentHasDb) {
        chooseBtn.textContent = 'Choose';
      } else {
        chooseBtn.textContent = 'Create new';
      }
    }
  }

  async function navigateTo(path) {
    currentPath = path || VIRTUAL_ROOT;
    selectedPath = path || VIRTUAL_ROOT;
    updateBreadcrumb();
    await updateFolderList(); // This now updates currentHasDb and button text
    updateSelectedPath();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  async function show(options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        // Load fragment if not already in DOM
        let overlay = document.getElementById('folderPickerOverlay');
        if (!overlay) {
          const response = await fetch('/fragments/folderPicker.html');
          const html = await response.text();
          document.body.insertAdjacentHTML('beforeend', html);
          overlay = document.getElementById('folderPickerOverlay');
        }

        // Configure picker
        const title = options.title || 'Library location';
        const subtitle = options.subtitle || "Choose where you'd like to create your new library";

        document.getElementById('folderPickerTitle').textContent = title;
        document.getElementById('folderPickerSubtitle').textContent = subtitle;

        // Load locations
        topLevelLocations = await getLocations();

        // Try to default to Desktop
        let initialPath = VIRTUAL_ROOT;
        
        // Find user's home directory from locations (it's usually the first one)
        for (const loc of topLevelLocations) {
          // Look for home directory by checking if it contains /Users/ or is the first non-Shared location
          if (loc.path.includes('/Users/') && !loc.path.includes('Shared')) {
            const desktopPath = loc.path + '/Desktop';
            // Try to navigate to Desktop
            try {
              const desktopCheck = await listDirectory(desktopPath);
              // Desktop exists, use it as initial path
              initialPath = desktopPath;
              console.log('✅ Starting at Desktop:', desktopPath);
              break;
            } catch (error) {
              // Desktop doesn't exist or not accessible, fall back to virtual root
              console.log('⚠️ Desktop not accessible, using virtual root');
            }
          }
        }

        // Set initial path
        currentPath = initialPath;
        selectedPath = initialPath;
        currentHasDb = false;

        // Initialize UI
        updateBreadcrumb();
        await updateFolderList();
        updateSelectedPath();

        // Show overlay
        overlay.style.display = 'flex';

        // Wire up buttons
        const closeBtn = document.getElementById('folderPickerCloseBtn');
        const cancelBtn = document.getElementById('folderPickerCancelBtn');
        const chooseBtn = document.getElementById('folderPickerChooseBtn');

        const handleCancel = () => {
          overlay.style.display = 'none';
          resolveCallback = null;
          resolve(null);
        };

        const handleChoose = () => {
          if (selectedPath === VIRTUAL_ROOT) {
            // No path selected
            return;
          }
          overlay.style.display = 'none';
          resolveCallback = null;
          resolve(selectedPath);
        };

        // Store resolve callback for database click handler
        resolveCallback = resolve;

        closeBtn.onclick = handleCancel;
        cancelBtn.onclick = handleCancel;
        chooseBtn.onclick = handleChoose;
      } catch (error) {
        console.error('Failed to show folder picker:', error);
        reject(error);
      }
    });
  }

  function hide() {
    const overlay = document.getElementById('folderPickerOverlay');
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
window.FolderPicker = FolderPicker;
