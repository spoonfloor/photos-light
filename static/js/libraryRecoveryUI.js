(function () {
  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
      return value;
    }

    Object.getOwnPropertyNames(value).forEach((key) => {
      deepFreeze(value[key]);
    });

    return Object.freeze(value);
  }

  const LibraryRecoveryUI = deepFreeze({
    dialogs: {
      recoverDatabase: {
        title: 'Add new database',
        body: "The selected folder doesn't have a usable library database. Add a new database to continue.",
        actions: [
          { text: 'Cancel', value: 'cancel', primary: false },
          { text: 'Add database', value: 'continue', primary: true },
        ],
      },
      generalPurposeFolderWarning: {
        title: 'Use this folder for your library?',
        body: 'This folder has many non-media files. You can continue, or create a subfolder instead.',
        actions: [
          { text: 'Cancel', value: 'cancel', primary: false },
          {
            text: 'Create subfolder',
            value: 'create_subfolder',
            primary: true,
          },
          { text: 'Continue', value: 'continue', primary: false },
        ],
      },
      recoverMedia: {
        title: 'Recover media',
        buildBody({ countLabel, etaLabel }) {
          return `This folder has ${countLabel} untracked media files. It should take ${etaLabel} to process them. Add them to your library?`;
        },
        actions: [
          { text: 'Cancel', value: 'cancel', primary: false },
          { text: 'See my library', value: 'see_library', primary: false },
          { text: 'Add media', value: 'add_media', primary: true },
        ],
      },
    },
    dock: {
      scanLibrary: {
        title: 'Scanning library',
        body: 'Reviewing the database and searching for available media.',
        statusText: 'Preparing your library',
        statusSpinner: true,
        showCloseButton: true,
      },
      scanComplete: {
        title: 'Scan complete',
        buildBody({ mediaCountLabel, mediaFileLabel, etaLabel, addClosingPhrase }) {
          return `This folder has ${mediaCountLabel} ${mediaFileLabel} that could be added to your library. It should take ${etaLabel}. ${addClosingPhrase} or go directly to your library.`;
        },
        stats: [
          { label: 'Media files', key: 'media_files' },
          { label: 'Duplicates', key: 'duplicate_count' },
          { label: 'Unsupported', key: 'incompatible_count' },
        ],
        actions: [
          { text: 'Cancel', value: 'cancel', primary: false },
          { text: 'See my library', value: 'see_library', primary: false },
          { text: 'Add media', value: 'add_media', primary: true },
        ],
      },
      rebuildingLibrary: {
        title: 'Rebuilding library',
        buildBody({ mediaCountLabel, mediaFileLabel }) {
          return `Repairing your library and adding ${mediaCountLabel} ${mediaFileLabel} to your database. Stay on this screen until it finishes.`;
        },
        stats: [
          { label: 'Added', key: 'added' },
          { label: 'Total', key: 'total' },
        ],
        actionsJustify: 'flex-end',
        actions: [
          { text: 'Cancel', value: 'cancel', primary: false },
        ],
        showCloseButton: true,
      },
      openingLibrary: {
        title: 'Opening library',
        body: 'Loading your photos into the app.',
        statusText: 'Almost done',
        statusSpinner: true,
        showCloseButton: false,
        actions: [],
      },
      failures: {
        recover_database: {
          title: "Couldn't recover library",
          body: "We couldn't add a new database for this folder.",
          errorText:
            'Nothing was changed. Please try again or pick a different folder.',
        },
        add_media: {
          title: "Couldn't finish rebuilding library",
          body: "Your library is open, but we couldn't finish adding media.",
          errorText: 'You can keep using your library and try again later.',
        },
        switched: {
          title: "Couldn't finish opening library",
          body: "Your library is open, but we couldn't finish checking it for media to add.",
          errorText: 'You can keep using your library and try again later.',
        },
        default: {
          title: "Couldn't open library",
          body: "We couldn't finish opening this folder as a library.",
          errorText: 'Please try again or pick a different folder.',
        },
      },
    },
  });

  window.LibraryRecoveryUI = LibraryRecoveryUI;
})();
