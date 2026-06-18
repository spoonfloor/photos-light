// Folder Picker - Custom folder picker for library creation
//
// This replaces the native macOS folder picker with a custom web-based implementation
// that provides consistent UX across platforms and avoids AppleScript limitations.

const FolderPicker = (() => {
  // State
  const VIRTUAL_ROOT = '__LOCATIONS__';
  const PICKER_INTENT = {
    OPEN_EXISTING_LIBRARY: 'open_existing_library',
    CONVERT_TO_LIBRARY: 'convert_to_library',
    CHOOSE_LIBRARY_LOCATION: 'choose_library_location',
    GENERIC_FOLDER_SELECTION: 'generic_folder_selection',
  };
  let currentPath = VIRTUAL_ROOT;
  let selectedPath = VIRTUAL_ROOT; // Explicitly selected folder (via checkbox)
  let currentHasDb = false; // Track if current selected folder has database
  let currentHasOpenableDb = false; // Track if current folder's DB looks openable
  let selectedHasOpenableDb = false; // Track if the resolved picker action should read as "Open"
  let selectedHasDb = false; // Track if selected folder has any database file
  let selectedHasMedia = false; // Track if selected folder has media to convert
  let selectedConvertBlocked = false; // OS primary directory; convert intent only
  let selectionProbePending = false; // Await server probe before lower-priority verdicts
  let pickerIntent = PICKER_INTENT.GENERIC_FOLDER_SELECTION;

  const CONVERT_BLOCKED_HINT =
    'Unable to convert primary OS directories. Pick another folder to continue.';
  const MACOS_USER_PRIMARY_DIR_NAMES = new Set([
    'Desktop',
    'Documents',
    'Downloads',
    'Library',
    'Movies',
    'Music',
    'Pictures',
    'Public',
  ]);
  const SYSTEM_CONVERT_BLOCK_PREFIXES = [
    '/Applications',
    '/System',
    '/Library',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/opt',
  ];
  let topLevelLocations = [];
  let resolveCallback = null; // Store resolve callback for database click handler
  let onSelectCallback = null;
  let onCancelCallback = null;
  let keyboardHandler = null; // Store keyboard event handler for cleanup
  let folderListClickHandler = null; // Store reference to event handler for cleanup
  let folderListRequestId = 0;
  let selectionProbeRequestId = 0;
  let activeItemKey = null; // Keyboard-highlighted row in the visible list
  let folderListLoading = false;
  let lastListSignature = null;
  let embeddedRefreshActive = false;
  let primaryActionLabelOverride = null;
  let activeLastPathStorageKey = 'picker.lastPath';
  const FOLDER_LIST_PLACEHOLDER_COUNT = 6;

  const pickerAutoRefresh = PickerUtils.createPickerAutoRefresh({
    isVisible: () => {
      if (embeddedRefreshActive) {
        return true;
      }
      const overlay = document.getElementById('folderPickerOverlay');
      return !!(overlay && overlay.style.display !== 'none');
    },
    onRefresh: () => updateFolderList({ silent: true }),
  });

  function startPickerAutoRefresh() {
    pickerAutoRefresh.start();
  }

  function stopPickerAutoRefresh() {
    pickerAutoRefresh.stop();
    lastListSignature = null;
  }

  async function syncSelectionAfterListChange() {
    if (
      selectedPath === currentPath &&
      (shouldUseOpenLibraryCta() || shouldUseConvertLibraryCta())
    ) {
      beginSelectionProbeCycle();
      await syncSelectedPathProbe();
    }
    updateButtonText();
  }

  const DEFAULT_ELEMENT_IDS = {
    breadcrumb: 'folderPickerBreadcrumb',
    folderList: 'folderPickerFolderList',
    selectedPath: 'folderPickerSelectedPath',
    chooseBtn: 'folderPickerChooseBtn',
    overlay: 'folderPickerOverlay',
  };
  let activeElementIds = { ...DEFAULT_ELEMENT_IDS };
  let savedElementIds = null;
  let embeddedOnPathChange = null;
  let embeddedKeyboardHandler = null;

  function pickerEl(key) {
    const id = activeElementIds[key];
    if (!id) {
      return null;
    }
    return document.getElementById(id);
  }

  function notifyEmbeddedPathChange() {
    if (!embeddedOnPathChange) {
      return;
    }
    embeddedOnPathChange(selectedPath === VIRTUAL_ROOT ? null : selectedPath);
  }

  const { getLocations, listDirectory, readErrorPayload, buildHttpError } =
    PickerFilesystem;

  // ===========================================================================
  // API Calls
  // ===========================================================================

  async function probeLibraryPath(path, { fast = false } = {}) {
    const response = await fetch('/api/library/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_path: path, fast }),
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
      has_media: data.has_media || false,
      media_count: data.media_count || 0,
      convert_blocked: Boolean(data.convert_blocked),
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

  function shouldUseConvertLibraryCta() {
    return pickerIntent === PICKER_INTENT.CONVERT_TO_LIBRARY;
  }

  function usesStrictFolderValidation() {
    return shouldUseOpenLibraryCta() || shouldUseConvertLibraryCta();
  }

  function getUserHomePath() {
    return topLevelLocations.find(
      (loc) => loc.path.startsWith('/Users/') && loc.path !== '/Users/Shared',
    )?.path;
  }

  function isClientConvertBlockedPath(path) {
    if (!path || path === VIRTUAL_ROOT) {
      return false;
    }

    if (path === '/Users/Shared' || path === '/Volumes') {
      return true;
    }

    const home = getUserHomePath();
    if (home) {
      if (path === home) {
        return true;
      }
      const primaryPaths = [...MACOS_USER_PRIMARY_DIR_NAMES].map((name) =>
        `${home}/${name}`,
      );
      if (primaryPaths.includes(path)) {
        return true;
      }
    }

    return SYSTEM_CONVERT_BLOCK_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  }

  function syncClientConvertBlockedFromPath() {
    if (!shouldUseConvertLibraryCta() || selectedPath === VIRTUAL_ROOT) {
      selectedConvertBlocked = false;
      return;
    }
    selectedConvertBlocked = isClientConvertBlockedPath(selectedPath);
  }

  function resolveConvertVerdict() {
    if (selectedPath === VIRTUAL_ROOT) {
      return { blocked: true, message: '', showMessage: false };
    }

    if (selectedConvertBlocked) {
      return {
        blocked: true,
        message: CONVERT_BLOCKED_HINT,
        showMessage: true,
      };
    }

    if (selectionProbePending) {
      return { blocked: true, message: '', showMessage: false };
    }

    if (selectedHasOpenableDb) {
      return {
        blocked: true,
        message:
          'This folder already contains a library. Use Open library instead.',
        showMessage: true,
      };
    }

    if (!selectedHasMedia) {
      return {
        blocked: true,
        message: 'No media files found in this folder.',
        showMessage: true,
      };
    }

    return { blocked: false, message: '', showMessage: false };
  }

  function isChooseActionBlocked() {
    if (folderListLoading) {
      return true;
    }
    if (selectedPath === VIRTUAL_ROOT) {
      return true;
    }
    if (shouldUseOpenLibraryCta()) {
      return !selectedHasOpenableDb;
    }
    if (shouldUseConvertLibraryCta()) {
      syncClientConvertBlockedFromPath();
      return resolveConvertVerdict().blocked;
    }
    return false;
  }

  function getPrimaryActionLabel() {
    if (primaryActionLabelOverride) {
      return primaryActionLabelOverride;
    }
    if (shouldUseOpenLibraryCta()) {
      return 'Open';
    }
    if (shouldUseConvertLibraryCta()) {
      return 'Convert';
    }

    return 'Continue';
  }

  function rememberPickerPath(path) {
    if (!path || path === VIRTUAL_ROOT) {
      return;
    }
    localStorage.setItem(activeLastPathStorageKey, path);
  }

  function getRememberedPickerPath() {
    return localStorage.getItem(activeLastPathStorageKey);
  }

  // ===========================================================================
  // UI Updates
  // ===========================================================================

  function getFolderListLoadingHtml() {
    const placeholders = Array.from(
      { length: FOLDER_LIST_PLACEHOLDER_COUNT },
      () => '<div class="folder-placeholder"></div>',
    ).join('');
    return `<div class="folder-placeholder-container">${placeholders}</div>`;
  }

  function showFolderListLoading() {
    const folderList = pickerEl('folderList');
    if (!folderList) {
      return;
    }
    folderListLoading = true;
    folderList.innerHTML = getFolderListLoadingHtml();
    updateButtonText();
  }

  function clearFolderListLoading() {
    folderListLoading = false;
  }

  function getProvisionalInitialPath(options = {}) {
    if (options.initialPath) {
      return options.initialPath;
    }
    const savedPath = getRememberedPickerPath();
    if (savedPath) {
      return savedPath;
    }
    return VIRTUAL_ROOT;
  }

  async function ensureFolderPickerOverlay() {
    let overlay = document.getElementById('folderPickerOverlay');
    if (overlay) {
      return overlay;
    }

    const response = await fetch('/fragments/folderPicker.html');
    if (!response.ok) {
      throw buildHttpError(response, 'Failed to load folder picker');
    }
    const html = await response.text();
    document.body.insertAdjacentHTML('beforeend', html);
    return document.getElementById('folderPickerOverlay');
  }

  function updateBreadcrumb() {
    const breadcrumb = pickerEl('breadcrumb');
    if (!breadcrumb) {
      return;
    }

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
    } else {
      const parts = currentPath.split('/').filter(Boolean);
      let buildPath = '';
      parts.forEach((part, index) => {
        buildPath += `/${part}`;
        const isLast = index === parts.length - 1;
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

  function getFolderItemKey(type, path) {
    return `${type}:${path}`;
  }

  function getFolderPickerRows() {
    const folderList = pickerEl('folderList');
    return PickerUtils.getNavigableRows(folderList, '.folder-item[data-item-key]');
  }

  function syncFolderPickerState(options = {}) {
    const rows = getFolderPickerRows();
    let activeRow = null;

    rows.forEach((row) => {
      const isActive = row.dataset.itemKey === activeItemKey;
      row.classList.toggle('picker-keyboard-active', isActive);
      row.setAttribute('aria-selected', isActive ? 'true' : 'false');

      if (isActive) {
        activeRow = row;
      }

      const checkbox = row.querySelector('.folder-checkbox');
      if (!checkbox) {
        return;
      }

      const isSelected = row.dataset.itemPath === selectedPath;
      checkbox.textContent = isSelected ? 'check_box' : 'folder';
      checkbox.classList.toggle('selected', isSelected);
    });

    if (!activeRow) {
      activeItemKey = null;
      return;
    }

    if (options.scroll) {
      PickerUtils.scrollRowIntoView(activeRow);
    }
  }

  async function setActiveFolderItem(itemKey, options = {}) {
    const targetRow = getFolderPickerRows().find(
      (row) => row.dataset.itemKey === itemKey,
    );
    if (!targetRow) {
      return false;
    }

    activeItemKey = itemKey;
    selectedPath = targetRow.dataset.itemPath || VIRTUAL_ROOT;
    beginSelectionProbeCycle();
    updateSelectedPath();
    syncFolderPickerState(options);
    await syncSelectedPathProbe();
    return true;
  }

  async function moveActiveFolderItem(direction) {
    const rows = getFolderPickerRows();
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

    return setActiveFolderItem(rows[nextIndex].dataset.itemKey, { scroll: true });
  }

  function renderVirtualRootList(folderList, { preserveScroll = false } = {}) {
    const scrollTop = preserveScroll ? folderList.scrollTop : 0;

    clearFolderListLoading();
    currentHasDb = false;
    currentHasOpenableDb = false;
    selectedHasOpenableDb = false;
    selectedHasDb = false;
    selectedHasMedia = false;
    selectedConvertBlocked = false;
    selectionProbePending = false;
    updateButtonText();

    folderList.innerHTML = PickerUtils.sortPickerItems(topLevelLocations)
      .map(
        (loc) => `
        <div class="folder-item" data-real-path="${loc.path}" data-item-key="${getFolderItemKey('location', loc.path)}" data-item-path="${loc.path}" aria-selected="false">
          <span class="folder-icon material-symbols-outlined">folder</span>
          <span class="folder-name">${loc.name}</span>
          <span class="folder-arrow">→</span>
        </div>
      `,
      )
      .join('');

    if (folderListClickHandler) {
      folderList.removeEventListener('click', folderListClickHandler);
    }

    folderListClickHandler = (e) => {
      const item = e.target.closest('.folder-item[data-real-path]');
      if (!item) return;
      navigateTo(item.dataset.realPath);
    };

    folderList.addEventListener('click', folderListClickHandler);
    if (preserveScroll) {
      folderList.scrollTop = scrollTop;
    }
    syncFolderPickerState();
  }

  function renderDirectoryList(folderList, folders, { preserveScroll = false } = {}) {
    const scrollTop = preserveScroll ? folderList.scrollTop : 0;

    if (folders.length === 0 && !currentHasDb) {
      activeItemKey = null;
      folderList.innerHTML = getFolderListLoadingHtml();
      return;
    }

    let html = '';

    folders.forEach((folder) => {
      const folderPath = currentPath + '/' + folder;
      const isSelected = selectedPath === folderPath;
      const iconClass = isSelected ? 'check_box' : 'folder';
      const selectedClass = isSelected ? 'selected' : '';

      html += `
          <div class="folder-item" data-folder="${folder}" data-folder-path="${folderPath}" data-item-key="${getFolderItemKey('folder', folderPath)}" data-item-path="${folderPath}" aria-selected="false">
            <span class="folder-checkbox material-symbols-outlined ${selectedClass}" data-path="${folderPath}">${iconClass}</span>
            <span class="folder-name">${folder}</span>
            <span class="folder-arrow">→</span>
          </div>
        `;
    });

    if (currentHasDb) {
      html += `
          <div class="folder-item folder-item-db" data-is-db="true" data-item-key="${getFolderItemKey('db', currentPath)}" data-item-path="${currentPath}" aria-selected="false">
            <span class="folder-icon material-symbols-outlined">description</span>
            <span class="folder-name">photo_library.db</span>
          </div>
        `;
    }

    folderList.innerHTML = html;

    if (folderListClickHandler) {
      folderList.removeEventListener('click', folderListClickHandler);
    }

    folderListClickHandler = async (e) => {
      const item = e.target.closest('.folder-item[data-folder]');
      if (!item) {
        const dbItem = e.target.closest('.folder-item[data-is-db]');
        if (dbItem) {
          if (currentPath !== VIRTUAL_ROOT && resolveCallback) {
            if (shouldUseConvertLibraryCta()) {
              return;
            }
            if (shouldUseOpenLibraryCta() && !currentHasOpenableDb) {
              return;
            }
            activeItemKey = dbItem.dataset.itemKey || null;
            selectedPath = currentPath;
            updateSelectedPath();
            syncFolderPickerState();
            rememberPickerPath(currentPath);

            const overlay = pickerEl('overlay');
            if (overlay) {
              overlay.style.display = 'none';
            }
            stopPickerAutoRefresh();
            resolveCallback(currentPath);
          }
        }
        return;
      }

      const checkbox = item.querySelector('.folder-checkbox');
      const folderPath = checkbox?.dataset.path;

      if (e.target.classList.contains('folder-checkbox')) {
        e.stopPropagation();
        selectFolder(folderPath);
        return;
      }

      const folder = item.dataset.folder;
      const newPath = currentPath + '/' + folder;
      navigateTo(newPath);
    };

    folderList.addEventListener('click', folderListClickHandler);
    if (preserveScroll) {
      folderList.scrollTop = scrollTop;
    }
    syncFolderPickerState();
  }

  async function updateFolderList({ silent = false } = {}) {
    const folderList = pickerEl('folderList');
    if (!folderList) {
      return;
    }
    const requestId = ++folderListRequestId;
    const pathForRequest = currentPath;

    if (currentPath === VIRTUAL_ROOT) {
      if (silent) {
        try {
          const locations = await getLocations();
          if (requestId !== folderListRequestId || pathForRequest !== currentPath) {
            return;
          }
          const signature = PickerUtils.buildLocationsSignature(locations);
          if (signature === lastListSignature) {
            return;
          }
          topLevelLocations = locations;
          lastListSignature = signature;
          renderVirtualRootList(folderList, { preserveScroll: true });
        } catch (error) {
          console.warn('Folder picker silent refresh failed:', error);
        }
        return;
      }

      if (!topLevelLocations.length) {
        showFolderListLoading();
        return;
      }

      lastListSignature = PickerUtils.buildLocationsSignature(topLevelLocations);
      renderVirtualRootList(folderList);
      return;
    }

    if (!silent) {
      showFolderListLoading();
    }

    try {
      const result = await listDirectory(currentPath);
      if (requestId !== folderListRequestId || pathForRequest !== currentPath) {
        return;
      }
      clearFolderListLoading();

      const folders = result.folders;
      const signature = PickerUtils.buildFolderListSignature(currentPath, result);
      if (silent && signature === lastListSignature) {
        return;
      }

      lastListSignature = signature;
      currentHasDb = result.has_db;
      currentHasOpenableDb = result.has_openable_db;
      if (shouldUseOpenLibraryCta() && selectedPath === currentPath) {
        selectedHasOpenableDb = currentHasOpenableDb;
        selectedHasDb = currentHasDb;
      } else if (!usesStrictFolderValidation()) {
        selectedHasOpenableDb = false;
        selectedHasDb = false;
        selectedHasMedia = false;
        selectedConvertBlocked = false;
      }

      renderDirectoryList(folderList, folders, { preserveScroll: silent });
      await syncSelectionAfterListChange();
    } catch (error) {
      if (requestId !== folderListRequestId || pathForRequest !== currentPath) {
        return;
      }
      if (silent) {
        console.warn('Folder picker silent refresh failed:', error);
        return;
      }
      clearFolderListLoading();
      folderList.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
      activeItemKey = null;
      currentHasDb = false;
      currentHasOpenableDb = false;
      if (shouldUseOpenLibraryCta() && selectedPath === currentPath) {
        selectedHasOpenableDb = false;
        selectedHasDb = false;
        selectedHasMedia = false;
        selectedConvertBlocked = false;
      } else if (!usesStrictFolderValidation()) {
        selectedHasOpenableDb = false;
        selectedHasDb = false;
        selectedHasMedia = false;
        selectedConvertBlocked = false;
      }
      updateButtonText();
    }
  }

  function updateSelectedPath() {
    const pathDisplay = pickerEl('selectedPath');
    if (!pathDisplay) {
      return;
    }
    // Show real path (not virtual root)
    if (selectedPath === VIRTUAL_ROOT) {
      pathDisplay.textContent = 'No path selected';
    } else {
      pathDisplay.textContent = selectedPath;
    }
  }

  function updateButtonText() {
    const chooseBtn = pickerEl('chooseBtn');
    if (chooseBtn) {
      chooseBtn.textContent = getPrimaryActionLabel();
      chooseBtn.disabled = isChooseActionBlocked();
    }
    updateSelectionHint();
  }

  function updateSelectionHint() {
    const hintEl = document.getElementById('folderPickerSelectionHint');
    if (!hintEl) {
      return;
    }

    if (
      folderListLoading ||
      !usesStrictFolderValidation() ||
      selectedPath === VIRTUAL_ROOT
    ) {
      hintEl.hidden = true;
      hintEl.textContent = '';
      return;
    }

    if (shouldUseOpenLibraryCta()) {
      if (selectedHasOpenableDb) {
        hintEl.hidden = true;
        hintEl.textContent = '';
        return;
      }

      hintEl.hidden = false;
      hintEl.textContent = selectedHasDb
        ? "Library database found here but it can't be opened."
        : 'No photo library found in this folder.';
      return;
    }

    if (shouldUseConvertLibraryCta()) {
      syncClientConvertBlockedFromPath();
      const verdict = resolveConvertVerdict();
      if (verdict.showMessage) {
        hintEl.hidden = false;
        hintEl.textContent = verdict.message;
        return;
      }

      hintEl.hidden = true;
      hintEl.textContent = '';
    }
  }

  async function syncSelectedPathProbe() {
    const requestId = ++selectionProbeRequestId;

    if (!usesStrictFolderValidation()) {
      selectionProbePending = false;
      selectedHasOpenableDb = false;
      selectedHasDb = false;
      selectedHasMedia = false;
      selectedConvertBlocked = false;
      updateButtonText();
      return;
    }

    if (selectedPath === VIRTUAL_ROOT) {
      selectionProbePending = false;
      selectedHasOpenableDb = false;
      selectedHasDb = false;
      selectedHasMedia = false;
      selectedConvertBlocked = false;
      updateButtonText();
      return;
    }

    if (!selectionProbePending) {
      syncClientConvertBlockedFromPath();
      selectionProbePending = true;
      updateButtonText();
    }

    try {
      if (shouldUseOpenLibraryCta()) {
        selectionProbePending = false;
        if (selectedPath === currentPath) {
          selectedHasOpenableDb = currentHasOpenableDb;
          selectedHasDb = currentHasDb;
        } else {
          const result = await listDirectory(selectedPath);
          if (requestId !== selectionProbeRequestId) {
            return;
          }
          selectedHasOpenableDb = result.has_openable_db;
          selectedHasDb = result.has_db;
        }
        updateButtonText();
        return;
      }

      const result = await probeLibraryPath(selectedPath, { fast: true });
      if (requestId !== selectionProbeRequestId) {
        return;
      }
      selectionProbePending = false;
      selectedHasOpenableDb = result.has_openable_db;
      selectedHasDb = result.has_db;
      selectedHasMedia = result.has_media;
      selectedConvertBlocked =
        result.convert_blocked || isClientConvertBlockedPath(selectedPath);
      updateButtonText();
    } catch (_) {
      if (requestId !== selectionProbeRequestId) {
        return;
      }
      selectionProbePending = false;
      selectedHasOpenableDb = false;
      selectedHasDb = false;
      selectedHasMedia = false;
      syncClientConvertBlockedFromPath();
      updateButtonText();
    }
  }

  function beginSelectionProbeCycle() {
    syncClientConvertBlockedFromPath();
    if (shouldUseConvertLibraryCta() && selectedPath !== VIRTUAL_ROOT) {
      selectionProbePending = true;
    }
  }

  function restoreFolderListScroll(folderList, scrollTop) {
    if (folderList) {
      folderList.scrollTop = scrollTop;
    }
  }

  async function selectFolder(path) {
    const folderList = pickerEl('folderList');
    const scrollTop = folderList?.scrollTop ?? 0;

    // Toggle behavior - clicking same folder deselects it
    if (selectedPath === path) {
      selectedPath = currentPath; // Revert to current location
      activeItemKey = null;
    } else {
      selectedPath = path; // Select (radio button - clears others)
    }

    beginSelectionProbeCycle();
    updateSelectedPath();
    syncFolderPickerState();
    restoreFolderListScroll(folderList, scrollTop);
    await syncSelectedPathProbe();
    restoreFolderListScroll(folderList, scrollTop);
    notifyEmbeddedPathChange();
  }

  async function navigateTo(path) {
    activeItemKey = null;
    currentPath = path || VIRTUAL_ROOT;
    // When navigating, selected path becomes where you are (unless you explicitly checked something)
    selectedPath = currentPath;
    beginSelectionProbeCycle();
    updateBreadcrumb();
    await updateFolderList(); // This now updates currentHasDb and button text
    await syncSelectedPathProbe();
    updateSelectedPath();
    notifyEmbeddedPathChange();
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
      const moved = await moveActiveFolderItem(e.key === 'ArrowUp' ? -1 : 1);
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

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

  function setPickerSubtitle(subtitle) {
    const subtitleEl = document.getElementById('folderPickerSubtitle');
    if (!subtitleEl) {
      return;
    }

    if (shouldUseConvertLibraryCta() && subtitle.includes('\n')) {
      const breakIndex = subtitle.indexOf('\n');
      const intro = subtitle.slice(0, breakIndex);
      const warning = subtitle.slice(breakIndex + 1);

      subtitleEl.replaceChildren();
      subtitleEl.classList.add('picker-subtitle--stacked');

      const introEl = document.createElement('span');
      introEl.textContent = intro;
      const warningEl = document.createElement('span');
      warningEl.className = 'picker-subtitle-warning';
      warningEl.textContent = warning;

      subtitleEl.append(introEl, warningEl);
      return;
    }

    subtitleEl.classList.remove('picker-subtitle--stacked');
    subtitleEl.textContent = subtitle;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  async function getLastUsedLibraryPath() {
    try {
      const response = await fetch('/api/library/last-used');
      if (!response.ok) {
        return null;
      }
      const data = await response.json();
      return data.library_path || null;
    } catch {
      return null;
    }
  }

  async function resolveInitialPath(options = {}) {
    let initialPath = options.initialPath || VIRTUAL_ROOT;

    if (!options.initialPath && currentPath !== VIRTUAL_ROOT) {
      try {
        await listDirectory(currentPath);
        initialPath = currentPath;
      } catch {
        currentPath = VIRTUAL_ROOT;
        initialPath = VIRTUAL_ROOT;
      }
    } else if (initialPath === VIRTUAL_ROOT) {
      if (pickerIntent === PICKER_INTENT.OPEN_EXISTING_LIBRARY) {
        const lastUsedPath = await getLastUsedLibraryPath();
        if (lastUsedPath) {
          try {
            await listDirectory(lastUsedPath);
            initialPath = lastUsedPath;
          } catch {
            // Fall through to localStorage / Desktop default
          }
        }
      }

      const savedPath = getRememberedPickerPath();
      if (savedPath) {
        try {
          await listDirectory(savedPath);
          initialPath = savedPath;
        } catch {
          // Fall through to Desktop default
        }
      }

      if (initialPath === VIRTUAL_ROOT) {
        initialPath = await PickerUtils.getDefaultPath(topLevelLocations, listDirectory);
      }
    }

    if (initialPath !== VIRTUAL_ROOT) {
      try {
        await listDirectory(initialPath);
      } catch {
        currentPath = VIRTUAL_ROOT;
        initialPath = VIRTUAL_ROOT;
        initialPath = await PickerUtils.getDefaultPath(topLevelLocations, listDirectory);
      }
    }

    return initialPath;
  }

  async function initEmbedded(options = {}) {
    if (savedElementIds) {
      unmountEmbedded();
    }

    savedElementIds = { ...activeElementIds };
    activeElementIds = {
      breadcrumb: options.breadcrumbId || 'createLibraryBreadcrumb',
      folderList: options.folderListId || 'createLibraryFolderList',
      selectedPath: options.selectedPathId || 'createLibrarySelectedPath',
      chooseBtn: null,
      overlay: null,
    };

    pickerIntent = options.intent || PICKER_INTENT.CHOOSE_LIBRARY_LOCATION;
    embeddedOnPathChange =
      typeof options.onPathChange === 'function' ? options.onPathChange : null;
    resolveCallback = null;

    topLevelLocations = await getLocations();
    const initialPath = await resolveInitialPath(options);

    currentPath = initialPath;
    selectedPath = initialPath;
    currentHasDb = false;
    currentHasOpenableDb = false;
    selectedHasOpenableDb = false;
    selectedHasDb = false;
    selectedHasMedia = false;
    selectedConvertBlocked = false;
    selectionProbePending = false;
    activeItemKey = null;

    updateBreadcrumb();
    await updateFolderList();
    beginSelectionProbeCycle();
    await syncSelectedPathProbe();
    updateSelectedPath();
    notifyEmbeddedPathChange();

    embeddedRefreshActive = true;
    startPickerAutoRefresh();

    if (options.enableKeyboard) {
      embeddedKeyboardHandler = (e) => {
        void handleKeyboard(e);
      };
      document.addEventListener('keydown', embeddedKeyboardHandler);
    }

    return {
      getSelectedPath: () => (selectedPath === VIRTUAL_ROOT ? null : selectedPath),
    };
  }

  function unmountEmbedded() {
    embeddedRefreshActive = false;
    stopPickerAutoRefresh();

    if (embeddedKeyboardHandler) {
      document.removeEventListener('keydown', embeddedKeyboardHandler);
      embeddedKeyboardHandler = null;
    }
    embeddedOnPathChange = null;

    const folderList = pickerEl('folderList');
    if (folderList && folderListClickHandler) {
      folderList.removeEventListener('click', folderListClickHandler);
      folderListClickHandler = null;
    }

    if (savedElementIds) {
      activeElementIds = { ...savedElementIds };
      savedElementIds = null;
    } else {
      activeElementIds = { ...DEFAULT_ELEMENT_IDS };
    }
  }

  async function populateFolderPickerAfterShow(options = {}) {
    topLevelLocations = await getLocations();

    const initialPath = await resolveInitialPath(options);

    currentPath = initialPath;
    selectedPath = initialPath;
    currentHasDb = false;
    currentHasOpenableDb = false;
    selectedHasOpenableDb = false;
    selectedHasDb = false;
    selectedHasMedia = false;
    selectedConvertBlocked = false;
    selectionProbePending = false;
    activeItemKey = null;

    updateBreadcrumb();
    await updateFolderList();
    beginSelectionProbeCycle();
    await syncSelectedPathProbe();
    updateSelectedPath();
  }

  function wireFolderPickerActions(overlay, options, resolve, wizardActions) {
    const showGoBack = wizardActions && !!options.showGoBack;
    const closeBtn = document.getElementById('folderPickerCloseBtn');
    const cancelBtn = document.getElementById('folderPickerCancelBtn');
    const chooseBtn = document.getElementById('folderPickerChooseBtn');
    const goBackBtn = document.getElementById('folderPickerGoBackBtn');

    const handleCancel = () => {
      stopPickerAutoRefresh();
      overlay.style.display = 'none';
      if (keyboardHandler) {
        document.removeEventListener('keydown', keyboardHandler);
        keyboardHandler = null;
      }
      resolveCallback = null;
      resolve(wizardActions ? { action: 'cancel' } : null);
    };

    const handleGoBack = () => {
      stopPickerAutoRefresh();
      overlay.style.display = 'none';
      if (keyboardHandler) {
        document.removeEventListener('keydown', keyboardHandler);
        keyboardHandler = null;
      }
      resolveCallback = null;
      resolve({ action: 'back' });
    };

    const handleChoose = async () => {
      if (isChooseActionBlocked()) {
        return;
      }

      rememberPickerPath(selectedPath);

      if (typeof options.beforeResolveChoose === 'function') {
        await options.beforeResolveChoose(selectedPath);
      }

      if (keyboardHandler) {
        document.removeEventListener('keydown', keyboardHandler);
        keyboardHandler = null;
      }
      resolveCallback = null;
      if (options.keepVisibleOnChoose) {
        stopPickerAutoRefresh();
        overlay.style.pointerEvents = 'none';
        resolve(selectedPath);
        return;
      }

      stopPickerAutoRefresh();
      overlay.style.display = 'none';
      resolve(selectedPath);
    };

    resolveCallback = resolve;

    closeBtn.onclick = handleCancel;
    cancelBtn.onclick = handleCancel;
    chooseBtn.onclick = handleChoose;
    if (goBackBtn) {
      goBackBtn.onclick = showGoBack ? handleGoBack : null;
    }

    keyboardHandler = (e) => {
      void handleKeyboard(e);
    };
    document.addEventListener('keydown', keyboardHandler);
  }

  function preloadOverlay() {
    void ensureFolderPickerOverlay().catch(() => {});
  }

  async function show(options = {}) {
    return new Promise(async (resolve, reject) => {
      let wizardActions = false;
      try {
        if (savedElementIds) {
          unmountEmbedded();
        }
        stopPickerAutoRefresh();
        activeElementIds = { ...DEFAULT_ELEMENT_IDS };

        wizardActions = !!options.wizardActions;
        pickerIntent = options.intent || PICKER_INTENT.GENERIC_FOLDER_SELECTION;
        primaryActionLabelOverride = options.primaryActionLabel || null;
        activeLastPathStorageKey = options.lastPathStorageKey || 'picker.lastPath';

        const overlay = await ensureFolderPickerOverlay();
        if (!overlay) {
          throw new Error('Folder picker overlay not found');
        }

        const title = options.title || 'Open library';
        const subtitle =
          options.subtitle ||
          (pickerIntent === PICKER_INTENT.OPEN_EXISTING_LIBRARY
            ? 'Select a library folder to open.'
            : pickerIntent === PICKER_INTENT.CONVERT_TO_LIBRARY
              ? 'Select a folder containing media files to convert into a new library.\nWARNING: This process permanently renames and reorganizes media files, and moves incompatible files to a trash folder for review.'
              : 'Select an existing library folder (or choose where to create one).');

        document.getElementById('folderPickerTitle').textContent = title;
        setPickerSubtitle(subtitle);

        const showGoBack = wizardActions && !!options.showGoBack;
        const goBackBtn = document.getElementById('folderPickerGoBackBtn');
        if (goBackBtn) {
          goBackBtn.style.display = showGoBack ? '' : 'none';
        }

        const provisionalPath = getProvisionalInitialPath(options);
        currentPath = provisionalPath;
        selectedPath = provisionalPath;
        currentHasDb = false;
        currentHasOpenableDb = false;
        selectedHasOpenableDb = false;
        selectedHasDb = false;
        selectedHasMedia = false;
        selectedConvertBlocked = false;
        selectionProbePending = false;
        activeItemKey = null;
        topLevelLocations = [];

        updateBreadcrumb();
        showFolderListLoading();
        updateSelectedPath();
        updateButtonText();

        const nameLibraryOverlay = document.getElementById('nameLibraryOverlay');
        if (nameLibraryOverlay) {
          nameLibraryOverlay.style.display = 'none';
        }

        overlay.style.display = 'flex';
        overlay.style.pointerEvents = '';

        wireFolderPickerActions(overlay, options, resolve, wizardActions);

        try {
          await populateFolderPickerAfterShow(options);
          startPickerAutoRefresh();
        } catch (error) {
          console.error('Failed to populate folder picker:', error);
          clearFolderListLoading();
          const folderList = pickerEl('folderList');
          if (folderList) {
            folderList.innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
          }
          updateButtonText();
          if (isFilesystemApiUnavailable(error)) {
            overlay.style.display = 'none';
            if (keyboardHandler) {
              document.removeEventListener('keydown', keyboardHandler);
              keyboardHandler = null;
            }
            resolveCallback = null;
            const nativePath = await showNativeFolderPicker(options);
            if (wizardActions) {
              resolve(nativePath ? nativePath : { action: 'cancel' });
            } else {
              resolve(nativePath);
            }
            return;
          }
        }
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
    stopPickerAutoRefresh();
    embeddedRefreshActive = false;
    primaryActionLabelOverride = null;
    activeLastPathStorageKey = 'picker.lastPath';
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
    preloadOverlay,
    initEmbedded,
    unmountEmbedded,
    getDefaultParentPath: async () => {
      const locations = await getLocations();
      return PickerUtils.getDefaultPath(locations, listDirectory);
    },
  };
})();

// Export for use in main.js
window.FolderPicker = FolderPicker;
