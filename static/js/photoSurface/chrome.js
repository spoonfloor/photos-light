/**
 * Shared app chrome behavior (utilities menu, filter chips).
 */
const PhotoChrome = (() => {
  function hideUtilitiesMenu(menu) {
    if (menu) {
      menu.style.display = 'none';
    }
  }

  function toggleUtilitiesMenu(utilitiesBtn, menu, { onBeforeShow } = {}) {
    if (!utilitiesBtn || !menu) {
      return;
    }

    const isVisible = menu.style.display === 'block';
    if (isVisible) {
      hideUtilitiesMenu(menu);
      return;
    }

    onBeforeShow?.();

    const btnRect = utilitiesBtn.getBoundingClientRect();
    const insetEnd = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--utilities-menu-viewport-inset-end',
      ),
    );
    const insetExtra = Number.isFinite(insetEnd) ? insetEnd : 0;

    menu.style.top = `${btnRect.bottom + 8}px`;
    menu.style.right = `${window.innerWidth - btnRect.right + insetExtra}px`;
    menu.style.left = '';
    menu.style.display = 'block';
  }

  function ensureSelectedFilterChip(scroll, onToggle) {
    if (!scroll) {
      return null;
    }

    let chip = scroll.querySelector('.filter-chip[data-filter="selected"]');
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'filter-chip';
      chip.dataset.filter = 'selected';
      chip.hidden = true;
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', () => onToggle?.('selected'));
      scroll.appendChild(chip);
    }
    return chip;
  }

  function applyFilterChipAvailability(chip, availability) {
    if (availability === undefined) {
      chip.disabled = false;
      chip.classList.remove('inactive');
      chip.setAttribute('aria-disabled', 'false');
      chip.removeAttribute('aria-busy');
      return;
    }

    const enabled = availability === true;
    chip.disabled = !enabled;
    chip.classList.toggle('inactive', !enabled);
    chip.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    if (availability === null) {
      chip.setAttribute('aria-busy', 'true');
    } else {
      chip.removeAttribute('aria-busy');
    }
  }

  function updateFilterChips({
    scroll,
    activeFilters,
    selectedCount = 0,
    showSelectedChip = true,
    filterAvailability = null,
    onToggle,
  }) {
    if (!scroll) {
      return;
    }

    const chips = scroll.querySelectorAll(
      '.filter-chip[data-filter]:not([data-filter="selected"])',
    );
    chips.forEach((chip) => {
      const filterKey = chip.dataset.filter;
      if (filterKey === 'recentImports') {
        chip.hidden = !ViewCapabilities.get().recentImportsFilter;
      }
      applyFilterChipAvailability(chip, filterAvailability?.[filterKey]);
      const isActive = !!activeFilters?.[filterKey];
      chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      if (!chip.dataset.filterChipWired) {
        chip.addEventListener('click', () => {
          if (chip.disabled) {
            return;
          }
          onToggle?.(filterKey);
        });
        chip.dataset.filterChipWired = 'true';
      }
    });

    const selectedChip = ensureSelectedFilterChip(scroll, onToggle);
    if (selectedChip) {
      const showChip = showSelectedChip && selectedCount > 0;
      selectedChip.hidden = !showChip;
      selectedChip.textContent = `selected (${selectedCount})`;
      selectedChip.setAttribute(
        'aria-pressed',
        activeFilters?.selected ? 'true' : 'false',
      );
    }
  }

  function capEnabled(caps, capName) {
    const value = caps?.[capName];
    if (capName === 'deleteKind') {
      return value != null && value !== false;
    }
    return !!value;
  }

  function applySurfaceChrome(caps = ViewCapabilities.get()) {
    document.querySelectorAll('[data-cap]').forEach((el) => {
      const capName = el.dataset.cap;
      const enabled = capEnabled(caps, capName);
      el.hidden = !enabled;
      if (capName === 'dateJumper') {
        el.setAttribute('aria-hidden', enabled ? 'false' : 'true');
      }
    });
    if (typeof AppBarVisibility !== 'undefined') {
      AppBarVisibility.devDiff(ViewCapabilities.get(), 'chrome.applySurfaceChrome');
    }
    if (typeof AppBarLayout !== 'undefined') {
      AppBarLayout.scheduleLayout();
    }
  }

  function wireUtilitiesDismiss(menu, utilitiesBtn) {
    document.addEventListener('click', (event) => {
      if (
        menu &&
        utilitiesBtn &&
        !menu.contains(event.target) &&
        !utilitiesBtn.contains(event.target)
      ) {
        hideUtilitiesMenu(menu);
      }
    });
  }

  return {
    hideUtilitiesMenu,
    toggleUtilitiesMenu,
    ensureSelectedFilterChip,
    updateFilterChips,
    applySurfaceChrome,
    wireUtilitiesDismiss,
  };
})();
