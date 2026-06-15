// Picker Filesystem API — shared get-locations / list-directory for FolderPicker and PhotoPicker

const PickerFilesystem = (() => {
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

  /**
   * @returns {Promise<Array>}
   */
  async function getLocations() {
    const response = await fetch('/api/filesystem/get-locations');
    if (!response.ok) {
      const message = await readErrorMessage(response, 'Failed to get locations');
      throw buildHttpError(response, message);
    }
    const data = await response.json();
    return data.locations;
  }

  /**
   * @param {string} path
   * @param {{ includeFiles?: boolean }} options
   * @returns {Promise<{ folders: Array, files: Array, has_db: boolean, has_openable_db: boolean }>}
   */
  async function listDirectory(path, { includeFiles = false } = {}) {
    const body = { path };
    if (includeFiles) {
      body.include_files = true;
    }

    const response = await fetch('/api/filesystem/list-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const { message, code } = await readErrorPayload(response, 'Failed to list directory');
      const err = buildHttpError(response, message);
      if (code) err.code = code;
      throw err;
    }

    const data = await response.json();
    return {
      folders: data.folders || [],
      files: data.files || [],
      has_db: data.has_db || false,
      has_openable_db: data.has_openable_db || false,
    };
  }

  return {
    getLocations,
    listDirectory,
    readErrorPayload,
    buildHttpError,
  };
})();

window.PickerFilesystem = PickerFilesystem;
