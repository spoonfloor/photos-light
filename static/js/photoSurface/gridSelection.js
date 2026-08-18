/**
 * Shared photo selection model — shift-range, month select-all, DOM sync.
 */
const GridSelection = (() => {
  /** @type {(raw: string | number) => string | number} */
  let photoIdNormalizer = (id) => id;

  function setPhotoIdNormalizer(normalizer) {
    photoIdNormalizer =
      typeof normalizer === 'function' ? normalizer : (id) => id;
  }

  function normalizePhotoId(raw) {
    if (raw == null || raw === '') {
      return null;
    }
    return photoIdNormalizer(raw);
  }

  function parseCardIndex(card) {
    const index = parseInt(card?.dataset?.index, 10);
    return Number.isFinite(index) ? index : null;
  }

  function parseCardId(card) {
    const raw = card?.dataset?.id;
    return normalizePhotoId(raw);
  }

  function getAllCards(root) {
    return root ? Array.from(root.querySelectorAll('.photo-card')) : [];
  }

  function updateMonthCircleStates(root, selectedIds) {
    if (!root) {
      return;
    }
    root.querySelectorAll('.month-section').forEach((section) => {
      const cards = section.querySelectorAll('.photo-card');
      const ids = Array.from(cards)
        .map((card) => parseCardId(card))
        .filter((id) => id != null);
      const allSelected =
        ids.length > 0 && ids.every((id) => selectedIds.has(id));
      const circle = section.querySelector('.month-select-circle');
      if (circle) {
        circle.classList.toggle('selected', allSelected);
      }
    });
  }

  function applyToDom(root, selectedIds) {
    if (!root) {
      return;
    }
    root.querySelectorAll('.photo-card').forEach((card) => {
      const id = parseCardId(card);
      card.classList.toggle('selected', id != null && selectedIds.has(id));
    });
    updateMonthCircleStates(root, selectedIds);
  }

  function selectRange(root, selectedIds, startIndex, endIndex) {
    const start = Math.min(startIndex, endIndex);
    const end = Math.max(startIndex, endIndex);
    getAllCards(root).forEach((card) => {
      const index = parseCardIndex(card);
      if (index == null || index < start || index > end) {
        return;
      }
      const id = parseCardId(card);
      if (id == null) {
        return;
      }
      selectedIds.add(id);
      card.classList.add('selected');
    });
    updateMonthCircleStates(root, selectedIds);
  }

  function toggleCard(root, selectedIds, card, event, lastClickedIndex) {
    const id = parseCardId(card);
    const index = parseCardIndex(card);
    if (id == null || index == null) {
      return lastClickedIndex;
    }

    if (event.shiftKey && lastClickedIndex != null) {
      selectRange(root, selectedIds, lastClickedIndex, index);
      return index;
    }

    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      card.classList.remove('selected');
    } else {
      selectedIds.add(id);
      card.classList.add('selected');
    }
    updateMonthCircleStates(root, selectedIds);
    return index;
  }

  function toggleMonth(root, selectedIds, monthKey) {
    const section = root.querySelector(`[data-month="${monthKey}"]`);
    if (!section) {
      return;
    }
    const cards = section.querySelectorAll('.photo-card');
    const ids = Array.from(cards)
      .map((card) => parseCardId(card))
      .filter((id) => id != null);
    const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));

    cards.forEach((card) => {
      const id = parseCardId(card);
      if (id == null) {
        return;
      }
      if (allSelected) {
        selectedIds.delete(id);
        card.classList.remove('selected');
      } else {
        selectedIds.add(id);
        card.classList.add('selected');
      }
    });
    updateMonthCircleStates(root, selectedIds);
  }

  function handleMonthCircleClick(root, selectedIds, circle, event, lastClickedIndex) {
    const section = circle.closest('.month-section');
    if (!section) {
      return lastClickedIndex;
    }

    const cards = section.querySelectorAll('.photo-card');
    if (!cards.length) {
      return lastClickedIndex;
    }

    const lastIndex = parseCardIndex(cards[cards.length - 1]);
    if (lastIndex == null) {
      return lastClickedIndex;
    }

    if (event.shiftKey && lastClickedIndex != null) {
      selectRange(root, selectedIds, lastClickedIndex, lastIndex);
      return lastIndex;
    }

    toggleMonth(root, selectedIds, section.dataset.month);
    return lastIndex;
  }

  function clearSelection(root, selectedIds) {
    selectedIds.clear();
    applyToDom(root, selectedIds);
  }

  return {
    setPhotoIdNormalizer,
    normalizePhotoId,
    applyToDom,
    updateMonthCircleStates,
    selectRange,
    toggleCard,
    toggleMonth,
    handleMonthCircleClick,
    clearSelection,
    parseCardId,
    parseCardIndex,
  };
})();
