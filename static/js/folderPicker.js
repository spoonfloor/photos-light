// Folder Picker - Custom folder picker for library creation
//
// This replaces the native macOS folder picker with a custom web-based implementation
// that provides consistent UX across platforms and avoids AppleScript limitations.

const FolderPicker = (() => {
  // State
  const VIRTUAL_ROOT = '__LOCATIONS__';
  let currentPath = VIRTUAL_ROOT;
  let selectedPath = VIRTUAL_ROOT;
  let topLevelLocations = [];
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
    return data.folders;
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
      const folders = await listDirectory(currentPath);

      if (folders.length === 0) {
        folderList.innerHTML = '<div class="empty-state">No subfolders found</div>';
        return;
      }

      folderList.innerHTML = folders
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

      // Add click handlers
      folderList.querySelectorAll('.folder-item').forEach((item) => {
        item.addEventListener('click', () => {
          const folder = item.dataset.folder;
          const newPath = currentPath + '/' + folder;
          navigateTo(newPath);
        });
      });
    } catch (error) {
      folderList.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
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

  async function navigateTo(path) {
    currentPath = path || VIRTUAL_ROOT;
    selectedPath = path || VIRTUAL_ROOT;
    updateBreadcrumb();
    await updateFolderList();
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

        // Reset to root
        currentPath = VIRTUAL_ROOT;
        selectedPath = VIRTUAL_ROOT;

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
          resolve(null);
        };

        const handleChoose = () => {
          if (selectedPath === VIRTUAL_ROOT) {
            // No path selected
            return;
          }
          overlay.style.display = 'none';
          resolve(selectedPath);
        };

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
