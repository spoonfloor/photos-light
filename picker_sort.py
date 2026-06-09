"""Shared sort helpers for picker data (folder, photo, and date pickers)."""

from enum import Enum
from typing import Callable, List, Sequence, TypeVar

T = TypeVar('T')


class PickerSortMode(str, Enum):
    NAME_ASC = 'name_asc'
    NAME_DESC = 'name_desc'


DEFAULT_PICKER_SORT = PickerSortMode.NAME_ASC


def _name_key(value: str) -> str:
    return value.casefold()


def sort_picker_items(
    items: Sequence[T],
    *,
    key: Callable[[T], str],
    mode: PickerSortMode = DEFAULT_PICKER_SORT,
) -> List[T]:
    reverse = mode == PickerSortMode.NAME_DESC
    return sorted(items, key=lambda item: _name_key(key(item)), reverse=reverse)
