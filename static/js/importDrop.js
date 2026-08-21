/**
 * Drag-and-drop import acquisition for Chrome (stage-upload) and Electron (native paths).
 */
const ImportDrop = (() => {
  function canResolveNativePaths() {
    return (
      typeof window.photosLight !== 'undefined' &&
      typeof window.photosLight.resolveDropFiles === 'function'
    );
  }

  function isTypingTarget(target) {
    if (!target) {
      return false;
    }
    const tag = target.tagName?.toLowerCase();
    return tag === 'input' || tag === 'textarea' || target.isContentEditable;
  }

  function shouldIgnoreDrop() {
    if (!getViewCapabilities().import) {
      return true;
    }
    if (importState.dropImportInProgress) {
      return true;
    }
    if (
      importState.isImporting ||
      importState.overlayPhase === 'preflight' ||
      importState.overlayPhase === 'scanning' ||
      importState.overlayPhase === 'inflight' ||
      importState.overlayPhase === 'complete'
    ) {
      return true;
    }
    const picker = document.getElementById('photoPickerOverlay');
    if (picker && picker.style.display !== 'none') {
      return true;
    }
    const nameLibraryOverlay = document.getElementById('nameLibraryOverlay');
    if (nameLibraryOverlay && nameLibraryOverlay.style.display !== 'none') {
      return true;
    }
    if (
      typeof FlowController !== 'undefined' &&
      FlowController.getActiveFlowKey() &&
      FlowController.getActiveFlowKey() !== 'add'
    ) {
      return true;
    }
    return false;
  }

  /**
   * Capture drop payload synchronously — DataTransfer is cleared after the handler exits.
   * @returns {{ nativePaths: string[], files: File[], entries: FileSystemEntry[] }}
   */
  function captureDropSnapshot(dataTransfer) {
    const nativePaths = canResolveNativePaths()
      ? resolveNativePaths(dataTransfer)
      : [];

    const files = dataTransfer?.files?.length
      ? Array.from(dataTransfer.files)
      : [];

    const entries = [];
    const items = dataTransfer?.items ? Array.from(dataTransfer.items) : [];
    for (const item of items) {
      if (item.kind !== 'file') {
        continue;
      }
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        entries.push(entry);
      }
    }

    return { nativePaths, files, entries };
  }

  function readDirectoryEntries(directoryEntry) {
    return new Promise((resolve, reject) => {
      const reader = directoryEntry.createReader();
      const entries = [];

      function readBatch() {
        reader.readEntries(
          (batch) => {
            if (!batch.length) {
              resolve(entries);
              return;
            }
            entries.push(...batch);
            readBatch();
          },
          (error) => reject(error),
        );
      }

      readBatch();
    });
  }

  async function walkEntry(entry, relativePrefix, collected) {
    if (!entry) {
      return;
    }

    if (entry.isFile) {
      await new Promise((resolve, reject) => {
        entry.file(
          (file) => {
            const relativePath = relativePrefix
              ? `${relativePrefix}/${file.name}`
              : file.name;
            collected.push({ file, relativePath });
            resolve();
          },
          (error) => reject(error),
        );
      });
      return;
    }

    if (!entry.isDirectory) {
      return;
    }

    const childPrefix = relativePrefix
      ? `${relativePrefix}/${entry.name}`
      : entry.name;
    const children = await readDirectoryEntries(entry);
    for (const child of children) {
      await walkEntry(child, childPrefix, collected);
    }
  }

  async function collectDropUploads(snapshot) {
    const collected = [];

    const hasDirectory = snapshot.entries.some((entry) => entry.isDirectory);
    if (!hasDirectory && snapshot.files.length > 0) {
      for (const file of snapshot.files) {
        collected.push({ file, relativePath: file.name });
      }
      return collected;
    }

    for (const entry of snapshot.entries) {
      await walkEntry(entry, '', collected);
    }

    if (collected.length === 0 && snapshot.files.length > 0) {
      for (const file of snapshot.files) {
        collected.push({ file, relativePath: file.name });
      }
    }

    return collected;
  }

  async function stageDropUploads(uploads) {
    if (!uploads.length) {
      return null;
    }

    const formData = new FormData();
    const relativePaths = [];
    uploads.forEach(({ file, relativePath }) => {
      formData.append('files', file, file.name);
      relativePaths.push(relativePath);
    });
    formData.append('relative_paths', JSON.stringify(relativePaths));

    const response = await fetch('/api/import/stage-drop', {
      method: 'POST',
      body: formData,
    });
    const raw = await response.text();
    let result = {};
    try {
      result = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error('Failed to stage dropped files');
    }
    if (!response.ok) {
      throw new Error(result.error || 'Failed to stage dropped files');
    }
    return result;
  }

  function resolveNativePaths(dataTransfer) {
    if (!canResolveNativePaths() || !dataTransfer?.files?.length) {
      return [];
    }
    return window.photosLight.resolveDropFiles(dataTransfer.files);
  }

  async function acquireFromDrop(snapshot) {
    if (snapshot.nativePaths.length > 0) {
      return {
        mode: 'native',
        paths: snapshot.nativePaths,
      };
    }

    const uploads = await collectDropUploads(snapshot);
    const staged = await stageDropUploads(uploads);
    if (!staged) {
      return null;
    }

    return {
      mode: 'staged',
      scanResult: staged,
      dropBatchId: staged.batch_id,
      paths: staged.files || [],
    };
  }

  function preventDefaults(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function wireWindowImportDrop(handlers) {
    const onDrop = handlers?.onDrop;
    if (typeof onDrop !== 'function') {
      return;
    }

    window.addEventListener(
      'dragenter',
      (event) => {
        if (shouldIgnoreDrop() || isTypingTarget(event.target)) {
          return;
        }
        preventDefaults(event);
      },
      false,
    );

    window.addEventListener(
      'dragover',
      (event) => {
        if (shouldIgnoreDrop() || isTypingTarget(event.target)) {
          return;
        }
        preventDefaults(event);
      },
      false,
    );

    window.addEventListener(
      'drop',
      (event) => {
        if (shouldIgnoreDrop() || isTypingTarget(event.target)) {
          return;
        }
        preventDefaults(event);
        const snapshot = captureDropSnapshot(event.dataTransfer);
        void onDrop(snapshot);
      },
      false,
    );
  }

  return {
    acquireFromDrop,
    canResolveNativePaths,
    captureDropSnapshot,
    wireWindowImportDrop,
  };
})();

window.ImportDrop = ImportDrop;
