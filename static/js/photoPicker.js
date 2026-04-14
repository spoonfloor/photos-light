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
  let countGeneration = 0; // Invalidates stale background counting jobs
  let activeCountingJobs = 0; // Tracks live counting jobs for the current generation
  let fileListClickHandler = null; // Store reference to event handler for cleanup
  let keyboardHandler = null; // Store keyboard event handler for cleanup
  let thumbnailObserver = null; // IntersectionObserver for lazy loading thumbnails
  let lastClickedIndex = null; // For shift-select range selection
  let activeItemKey = null; // Keyboard-highlighted row in the visible list

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

  function invalidateBackgroundCounting() {
    countGeneration++;
    activeCountingJobs = 0;
    isCountingInBackground = false;
  }

  function isCountGenerationActive(generation) {
    return generation === countGeneration;
  }

  function isCountJobActive(generation, rootFolderPath) {
    return isCountGenerationActive(generation) && selectedPaths.has(rootFolderPath);
  }

  // Background recursive selection with progress updates
  async function selectFolderRecursiveBackground(folderPath) {
    let lastUpdateTime = Date.now();
    let filesDiscoveredSinceUpdate = 0;
    const UPDATE_INTERVAL_MS = 1000;
    const UPDATE_FILE_THRESHOLD = 50;
    const generation = countGeneration;

    activeCountingJobs++;
    isCountingInBackground = true;
    updateSelectionCount();

    async function recursiveSelect(path) {
      if (!isCountJobActive(generation, folderPath)) {
        return;
      }

      try {
        const { folders, files } = await listDirectory(path);

        if (!isCountJobActive(generation, folderPath)) {
          return;
        }

        // Add all files
        for (const file of files) {
          if (!isCountJobActive(generation, folderPath)) return;

          const filePath = path + '/' + file.name;
          if (!selectedPaths.has(filePath)) {
            selectedPaths.set(filePath, { type: 'file' });
            filesDiscoveredSinceUpdate++;
          }
        }

        // Check if we should update UI
        const now = Date.now();
        const timeSinceUpdate = now - lastUpdateTime;

        if (
          filesDiscoveredSinceUpdate >= UPDATE_FILE_THRESHOLD ||
          timeSinceUpdate >= UPDATE_INTERVAL_MS
        ) {
          if (isCountJobActive(generation, folderPath)) {
            updateSelectionCount();
            lastUpdateTime = now;
            filesDiscoveredSinceUpdate = 0;
          }
        }

        // Recursively process subfolders
        for (const folder of folders) {
          if (!isCountJobActive(generation, folderPath)) return;

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

    try {
      await recursiveSelect(folderPath);
    } finally {
      if (!isCountGenerationActive(generation)) {
        return;
      }

      activeCountingJobs = Math.max(0, activeCountingJobs - 1);
      isCountingInBackground = activeCountingJobs > 0;

      // ALWAYS update UI with final count after counting completes
      folderStateCache.clear();
      updateSelectionCount();
    }
  }

  async function unselectFolderRecursive(folderPath) {
    // Remove all paths that start with this folder path
    const toRemove = Array.from(selectedPaths.keys()).filter(
      (path) => path === folderPath || path.startsWith(folderPath + '/'),
    );

    toRemove.forEach((path) => selectedPaths.delete(path));
  }

  // Calculate folder checkbox state (checked, unchecked, indeterminate) with caching
  function getFolderState(folderPath) {
    // Check cache first
    if (folderStateCache.has(folderPath)) {
      return folderStateCache.get(folderPath);
    }

    const isChecked = selectedPaths.has(folderPath);

    // Check if any descendant is selected
    const hasSelectedDescendant = Array.from(selectedPaths.keys()).some(
      (path) => path.startsWith(folderPath + '/'),
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

  // Handle shift-select range selection (always SELECTS items in range)
  async function handleShiftSelect(currentIndex) {
    const start = Math.min(lastClickedIndex, currentIndex);
    const end = Math.max(lastClickedIndex, currentIndex);

    
    

    // Get all picker items in the DOM
    const fileList = document.getElementById('photoPickerFileList');
    const allItems = Array.from(
      fileList.querySelectorAll('.photo-picker-item[data-index]'),
    );
    

    // Filter to items within the range
    const itemsInRange = allItems.filter((item) => {
      const itemIndex = parseInt(item.dataset.index);
      return itemIndex >= start && itemIndex <= end;
    });

    

    // Select all items in range (folders and files)
    for (const item of itemsInRange) {
      const checkbox = item.querySelector('.photo-picker-checkbox');
      const path = checkbox?.dataset.path;
      const type = checkbox?.dataset.type;

      if (!path || !type) continue;

      // Skip if already selected
      if (selectedPaths.has(path)) continue;

      // Select based on type
      if (type === 'folder') {
        // Mark folder as selected and start background counting
        selectedPaths.set(path, { type: 'folder' });
        folderStateCache.clear();
        // Start background counting (non-blocking)
        selectFolderRecursiveBackground(path);
      } else {
        // Select file
        selectedPaths.set(path, { type: 'file' });
      }
    }

    // Update UI
    folderStateCache.clear();
    updateSelectionCount();
    await updateFileList();

    

    // Update last clicked index
    lastClickedIndex = currentIndex;
  }

  // ===========================================================================
  // Thumbnail Lazy Loading
  // ===========================================================================

  function setupThumbnailLazyLoading() {
    const fileList = document.getElementById('photoPickerFileList');
    const thumbnails = fileList.querySelectorAll(
      '.photo-picker-thumbnail:not([src])',
    );

    // Create observer if doesn't exist
    if (!thumbnailObserver) {
      thumbnailObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const img = entry.target;
              loadThumbnail(img);
              thumbnailObserver.unobserve(img); // Only load once
            }
          });
        },
        {
          root: fileList,
          rootMargin: '100px', // Load 100px before entering viewport
          threshold: 0.01,
        },
      );
    }

    // Observe all loading thumbnails
    thumbnails.forEach((img) => {
      thumbnailObserver.observe(img);
    });
  }

  async function loadThumbnail(imgElement) {
    const path = imgElement.dataset.path;

    try {
      const response = await fetch('/api/filesystem/preview-thumbnail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });

      if (response.ok) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);

        imgElement.src = url;

        // Clean up blob URL after image loads
        imgElement.onload = () => {
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
      } else {
        // Error state
        imgElement.classList.add('error');
      }
    } catch (error) {
      console.error('Thumbnail load error:', error);
      imgElement.classList.add('error');
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
    const topLevel = topLevelLocations.find((loc) =>
      currentPath.startsWith(loc.path),
    );
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

  function getPhotoItemKey(type, path) {
    return `${type}:${path}`;
  }

  function getPhotoPickerRows() {
    const fileList = document.getElementById('photoPickerFileList');
    return PickerUtils.getNavigableRows(
      fileList,
      '.photo-picker-item[data-item-key]',
    );
  }

  function syncActiveListItem(options = {}) {
    const rows = getPhotoPickerRows();
    let activeRow = null;

    rows.forEach((row) => {
      const isActive = row.dataset.itemKey === activeItemKey;
      row.classList.toggle('picker-keyboard-active', isActive);
      row.setAttribute('aria-selected', isActive ? 'true' : 'false');

      if (isActive) {
        activeRow = row;
      }
    });

    if (!activeRow) {
      activeItemKey = null;
      return;
    }

    if (options.scroll) {
      PickerUtils.scrollRowIntoView(activeRow);
    }
  }

  function setActiveItemKey(itemKey, options = {}) {
    activeItemKey = itemKey;
    syncActiveListItem(options);
    updateSelectionCount();
  }

  function getActiveItemLabel() {
    if (!activeItemKey) {
      return null;
    }

    const activeRow = getPhotoPickerRows().find(
      (row) => row.dataset.itemKey === activeItemKey,
    );
    if (!activeRow) {
      activeItemKey = null;
      return null;
    }

    const name = activeRow.querySelector('.photo-picker-name')?.textContent?.trim();
    return name || activeRow.dataset.itemPath || null;
  }

  function moveActiveItem(direction) {
    const rows = getPhotoPickerRows();
    const currentIndex = rows.findIndex(
      (row) => row.dataset.itemKey === activeItemKey,
    );
    const nextIndex = PickerUtils.getNextFocusIndex(
      currentIndex,
      direction,
      rows.length,
    );

    if (nextIndex === null) {
      return false;
    }

    setActiveItemKey(rows[nextIndex].dataset.itemKey, { scroll: true });
    return true;
  }

  async function updateFileList() {
    const fileList = document.getElementById('photoPickerFileList');

    // At virtual root, show curated top-level locations
    if (currentPath === VIRTUAL_ROOT) {
      fileList.innerHTML = topLevelLocations
        .map(
          (loc) => `
        <div class="photo-picker-item" data-real-path="${loc.path}" data-item-path="${loc.path}" data-item-key="${getPhotoItemKey('location', loc.path)}" data-type="location" aria-selected="false">
          <span class="photo-picker-icon material-symbols-outlined">folder</span>
          <span class="photo-picker-name">${loc.name}</span>
          <span class="photo-picker-arrow">→</span>
        </div>
      `,
        )
        .join('');

      // Add click handlers
      fileList.querySelectorAll('.photo-picker-item').forEach((item) => {
        item.addEventListener('click', () => {
          navigateTo(item.dataset.realPath);
        });
      });
      syncActiveListItem();
      return;
    }

    // Regular filesystem navigation with files + folders
    try {
      const { folders, files } = await listDirectory(currentPath);

      if (folders.length === 0 && files.length === 0) {
        // Show placeholder boxes to fill vertical space (matches folder picker pattern)
        // Calculated to fit available photo-picker-list height without scrolling
        activeItemKey = null;
        fileList.innerHTML = `
          <div class="photo-picker-placeholder-container">
            <div class="photo-picker-placeholder"></div>
            <div class="photo-picker-placeholder"></div>
            <div class="photo-picker-placeholder"></div>
            <div class="photo-picker-placeholder"></div>
            <div class="photo-picker-placeholder"></div>
            <div class="photo-picker-placeholder"></div>
          </div>
        `;
        return;
      }

      let html = '';
      let itemIndex = 0; // Track index for shift-select

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
          <div class="photo-picker-item folder-item" data-folder-path="${folderPath}" data-item-path="${folderPath}" data-item-key="${getPhotoItemKey('folder', folderPath)}" data-type="folder" data-index="${itemIndex}" aria-selected="false">
            <span class="photo-picker-checkbox material-symbols-outlined ${stateClass}" data-path="${folderPath}" data-type="folder">${iconClass}</span>
            <span class="photo-picker-name">${folder.name}</span>
            <span class="photo-picker-arrow">→</span>
          </div>
        `;
        itemIndex++;
      });

      // Render files
      files.forEach((file) => {
        const filePath = currentPath + '/' + file.name;
        const checked = isSelected(filePath);
        const baseIcon = file.type === 'video' ? 'movie' : 'image';
        const iconClass = checked ? 'check_box' : baseIcon;
        const stateClass = checked ? 'selected' : '';

        // Format file size
        const formatSize = (bytes) => {
          if (bytes < 1024) return bytes + ' B';
          if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
          return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        };

        // Format dimensions and metadata
        const dimensionsText = file.dimensions
          ? `${file.dimensions.width}×${file.dimensions.height}`
          : '';
        const sizeText = formatSize(file.size || 0);
        const metaText = dimensionsText
          ? `${dimensionsText} • ${sizeText}`
          : sizeText;

        html += `
          <div class="photo-picker-item file-item" data-file-path="${filePath}" data-item-path="${filePath}" data-item-key="${getPhotoItemKey('file', filePath)}" data-type="file" data-index="${itemIndex}" aria-selected="false">
            <span class="photo-picker-checkbox material-symbols-outlined ${stateClass}" data-path="${filePath}" data-type="file">${iconClass}</span>
            <div class="photo-picker-thumbnail-container">
              <img class="photo-picker-thumbnail" data-path="${filePath}" alt="">
            </div>
            <div class="photo-picker-file-info">
              <span class="photo-picker-name">${file.name}</span>
              <span class="photo-picker-meta">${metaText}</span>
            </div>
          </div>
        `;
        itemIndex++;
      });

      fileList.innerHTML = html;

      // Set up lazy loading for thumbnails
      setupThumbnailLazyLoading();

      // Remove old event listener if it exists to prevent duplicate handlers
      if (fileListClickHandler) {
        fileList.removeEventListener('click', fileListClickHandler);
      }

      // Wire up handlers using EVENT DELEGATION (single listener on parent)
      fileListClickHandler = async (e) => {
        const item = e.target.closest('.photo-picker-item');
        if (!item) return;

        const checkbox = item.querySelector('.photo-picker-checkbox');
        const arrow = item.querySelector('.photo-picker-arrow');
        const path = checkbox?.dataset.path;
        const type = checkbox?.dataset.type;
        const index = parseInt(item.dataset.index);

        // SHIFT-SELECT: Select range when shift is held and clicking checkbox or file row
        if (e.shiftKey && lastClickedIndex !== null) {
          const shouldTriggerShiftSelect =
            e.target.classList.contains('photo-picker-checkbox') ||
            (type === 'file' &&
              !e.target.classList.contains('photo-picker-arrow'));

          if (shouldTriggerShiftSelect) {
            e.stopPropagation();
            activeItemKey = item.dataset.itemKey || null;
            await handleShiftSelect(index);
            return;
          }
        }

        // Checkbox clicked
        if (e.target.classList.contains('photo-picker-checkbox')) {
          e.stopPropagation();
          activeItemKey = item.dataset.itemKey || null;
          if (type === 'folder') {
            await toggleFolder(path);
            await updateFileList(); // Re-render to get correct state
          } else {
            toggleFile(path);
            await updateFileList(); // Re-render to get correct state
          }
          // Update last clicked index for shift-select
          lastClickedIndex = index;
          return;
        }

        // Arrow clicked - navigate
        if (
          e.target.classList.contains('photo-picker-arrow') &&
          type === 'folder'
        ) {
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
          activeItemKey = item.dataset.itemKey || null;
          checkbox.click();
        }
      };

      fileList.addEventListener('click', fileListClickHandler);
      syncActiveListItem();
    } catch (error) {
      fileList.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
      activeItemKey = null;
    }
  }

  function updateSelectionCount() {
    const countEl = document.getElementById('photoPickerCount');
    const importBtn = document.getElementById('photoPickerImportBtn');
    const clearBtn = document.getElementById('photoPickerClearBtn');

    const count = selectedPaths.size;

    if (count === 0) {
      const activeLabel = getActiveItemLabel();
      countEl.textContent = activeLabel
        ? `Highlighted: ${activeLabel}`
        : 'No items selected';
      if (importBtn) importBtn.disabled = true;
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

    // Build count text - ALWAYS show both folder and file counts
    const folderText = `${folderCount} folder${folderCount !== 1 ? 's' : ''}`;
    const fileText = `${fileCount.toLocaleString()} file${fileCount !== 1 ? 's' : ''}`;

    // Show counting state or final count
    if (isCountingInBackground) {
      countEl.textContent = `Counting files... ${folderText}, ${fileCount.toLocaleString()}+ files selected`;
    } else {
      countEl.textContent = `${folderText}, ${fileText} selected`;
    }

    if (importBtn) importBtn.disabled = false;
    if (clearBtn) clearBtn.style.visibility = 'visible';
  }

  function clearSelection() {
    invalidateBackgroundCounting();
    selectedPaths.clear();
    folderStateCache.clear();
    lastClickedIndex = null; // Reset shift-select anchor
    activeItemKey = null;
    updateSelectionCount();
    updateFileList();
  }

  async function navigateTo(path) {
    // Disconnect observer before navigating
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
    }

    // Clear selection when navigating (Finder-style behavior)
    invalidateBackgroundCounting();
    selectedPaths.clear();
    folderStateCache.clear();
    lastClickedIndex = null; // Reset shift-select anchor when navigating
    activeItemKey = null;

    currentPath = path || VIRTUAL_ROOT;
    updateBreadcrumb();
    await updateFileList();
    updateSelectionCount();

    // Observer will be recreated in updateFileList()
  }

  // ===========================================================================
  // Keyboard Shortcuts
  // ===========================================================================

  async function handleKeyboard(e) {
    if (PickerUtils.isTypingTarget(e.target)) {
      return;
    }

    if (
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      (e.key === 'ArrowUp' || e.key === 'ArrowDown')
    ) {
      const moved = moveActiveItem(e.key === 'ArrowUp' ? -1 : 1);
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    // Enter key - trigger Import button if enabled
    if (e.key === 'Enter') {
      const importBtn = document.getElementById('photoPickerImportBtn');
      if (importBtn && !importBtn.disabled) {
        
        importBtn.click();
        e.preventDefault();
        e.stopPropagation(); // Prevent event from bubbling to global handler
      } else {
        
      }
      return;
    }

    // Command+Shift+D - Navigate to Desktop (Mac standard shortcut)
    if (e.metaKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      

      // Find user's home directory (contains /Users/ but not Shared)
      const homeLocation = topLevelLocations.find(
        (loc) => loc.path.includes('/Users/') && !loc.path.includes('Shared'),
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
  // Helper Functions
  // ===========================================================================

  /**
   * Filter selectedPaths to only root-level selections
   * (items explicitly checked by user, not auto-expanded children)
   *
   * Logic: A path is a root selection if NO other selected path is its parent
   */
  function getRootSelections() {
    const allPaths = Array.from(selectedPaths.keys());
    const rootPaths = [];

    for (const path of allPaths) {
      // Check if any OTHER path is a parent of this path
      const hasParentInSelection = allPaths.some((otherPath) => {
        if (otherPath === path) return false; // Skip self
        // Check if otherPath is a parent directory of path
        return path.startsWith(otherPath + '/');
      });

      // If no parent found in selection, this is a root selection
      if (!hasParentInSelection) {
        rootPaths.push(path);
      }
    }

    
    return rootPaths;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  async function show(options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const onOverlayReady =
          options.onOverlayReady || options.beforePickerVisible;

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
        const subtitle =
          options.subtitle || 'Choose photos and folders to import';

        document.getElementById('photoPickerTitle').textContent = title;
        document.getElementById('photoPickerSubtitle').textContent = subtitle;

        // Load locations
        topLevelLocations = await getLocations();

        // Reset selection state (but preserve currentPath if navigating within same session)
        selectedPaths = new Map();
        folderStateCache = new Map();
        invalidateBackgroundCounting();
        lastClickedIndex = null; // Reset shift-select anchor for new session
        activeItemKey = null;

        // Determine initial path
        let initialPath = VIRTUAL_ROOT;

        // If currentPath is set from previous navigation, use it
        if (currentPath !== VIRTUAL_ROOT) {
          initialPath = currentPath;
          
        }
        // Otherwise try to use last saved path from localStorage
        else {
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
            initialPath = await PickerUtils.getDefaultPath(
              topLevelLocations,
              listDirectory,
            );
          }
        }

        currentPath = initialPath;

        // Initialize UI
        updateBreadcrumb();
        await updateFileList();
        updateSelectionCount();

        // Hide name-library step if it is still visible from the wizard handoff.
        const nameLibraryOverlay = document.getElementById('nameLibraryOverlay');
        if (nameLibraryOverlay) {
          nameLibraryOverlay.style.display = 'none';
        }

        // Make the picker visible before removing the previous blocking overlay.
        overlay.style.display = 'flex';
        if (typeof onOverlayReady === 'function') {
          onOverlayReady();
        }

        // Set up keyboard shortcuts
        keyboardHandler = (e) => handleKeyboard(e);
        document.addEventListener('keydown', keyboardHandler);

        // Wire up buttons
        const closeBtn = document.getElementById('photoPickerCloseBtn');
        const cancelBtn = document.getElementById('photoPickerCancelBtn');
        const importBtn = document.getElementById('photoPickerImportBtn');
        const clearBtn = document.getElementById('photoPickerClearBtn');

        const handleCancel = () => {
          invalidateBackgroundCounting();

          // Save current path even on cancel (for next session)
          if (currentPath !== VIRTUAL_ROOT) {
            localStorage.setItem('picker.lastPath', currentPath);
            
          }

          overlay.style.display = 'none';
          if (keyboardHandler) {
            document.removeEventListener('keydown', keyboardHandler);
            keyboardHandler = null;
          }
          resolveCallback = null;
          resolve(null);
        };

        const handleImport = () => {
          if (selectedPaths.size === 0) return;

          // Save current path to localStorage for next session
          localStorage.setItem('picker.lastPath', currentPath);
          

          overlay.style.display = 'none';
          if (keyboardHandler) {
            document.removeEventListener('keydown', keyboardHandler);
            keyboardHandler = null;
          }
          resolveCallback = null;

          // Return only root selections (folders/files user checked)
          // Backend will scan folders recursively - no need to send expanded children
          const rootSelections = getRootSelections();
          invalidateBackgroundCounting();

          resolve(rootSelections);
        };

        const handleClear = () => {
          clearSelection();
        };

        // Store resolve callback
        resolveCallback = resolve;

        closeBtn.onclick = handleCancel;
        cancelBtn.onclick = handleCancel;
        importBtn.onclick = handleImport;
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
    // Clean up keyboard listener
    if (keyboardHandler) {
      document.removeEventListener('keydown', keyboardHandler);
      keyboardHandler = null;
    }
  }

  return {
    show,
    hide,
  };
})();

// Export for use in main.js
window.PhotoPicker = PhotoPicker;
