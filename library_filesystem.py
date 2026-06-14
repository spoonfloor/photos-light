"""
Shared library filesystem walk, classification, and layout cleanup.

Convert (terraform) and Clean (make_library_perfect v2) call these helpers so
both agree on which paths exist, what counts as media, and how non-library
content is removed before final audit.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from typing import Iterator, List, Tuple

from library_cleanliness import (
    ALL_MEDIA_EXTENSIONS,
    IGNORED_LIBRARY_FILES,
    in_infrastructure,
    is_misplaced_infrastructure_rel,
    is_day_folder_name,
    is_year_folder_name,
    path_parts,
)
from library_layout import ROOT_INFRASTRUCTURE_DIRS

MAX_LAYOUT_CLEANUP_PASSES = 3


@dataclass(frozen=True)
class LibraryPartition:
    media_files: List[str]
    non_media_files: List[str]

    @property
    def total_media(self) -> int:
        return len(self.media_files)


def _abs_library_path(library_path: str) -> str:
    return os.path.abspath(library_path)


def _filter_walk_dirs(library_path: str, root: str, dirs: List[str]) -> None:
    dirs[:] = [
        entry
        for entry in dirs
        if not in_infrastructure(os.path.relpath(os.path.join(root, entry), library_path))
    ]


def iter_library_walk(library_path: str) -> Iterator[Tuple[str, List[str], List[str]]]:
    """Yield ``(root, dirs, files)`` like ``os.walk``, skipping infrastructure subtrees."""
    library_path = _abs_library_path(library_path)
    for root, dirs, files in os.walk(library_path, topdown=True):
        rel_root = os.path.relpath(root, library_path)
        if rel_root != "." and in_infrastructure(rel_root):
            dirs[:] = []
            continue
        _filter_walk_dirs(library_path, root, dirs)
        yield root, dirs, files


def partition_library_files(library_path: str) -> LibraryPartition:
    """
    Walk the library and partition supported media from everything else.

    Every file outside library infrastructure is classified — including dot-files
    and paths under hidden folders (except allowed infrastructure like
    ``.library`` and ``.trash``).
    """
    library_path = _abs_library_path(library_path)
    media_files: List[str] = []
    non_media_files: List[str] = []

    for root, _dirs, files in iter_library_walk(library_path):
        for filename in files:
            if filename in IGNORED_LIBRARY_FILES:
                continue

            full_path = os.path.join(root, filename)
            ext = os.path.splitext(filename)[1].lower()
            if ext in ALL_MEDIA_EXTENSIONS:
                media_files.append(full_path)
            else:
                non_media_files.append(full_path)

    return LibraryPartition(media_files=media_files, non_media_files=non_media_files)


def quarantine_root_hidden(library_path: str) -> Tuple[List[str], List[str]]:
    """
    Hidden root entries that must leave the library before final audit.

    Folders like ``.git`` are moved as whole trees so convert/clean do not walk
    thousands of internal files individually.
    """
    library_path = _abs_library_path(library_path)
    infrastructure = set(ROOT_INFRASTRUCTURE_DIRS)
    quarantine_dirs: List[str] = []
    quarantine_files: List[str] = []

    try:
        root_items = os.listdir(library_path)
    except OSError:
        return quarantine_dirs, quarantine_files

    for item in root_items:
        if not item.startswith("."):
            continue
        if item in IGNORED_LIBRARY_FILES:
            continue

        item_path = os.path.join(library_path, item)
        if os.path.isdir(item_path):
            if item not in infrastructure and not directory_tree_has_media(
                item_path,
                library_path=library_path,
            ):
                quarantine_dirs.append(item_path)
        elif os.path.isfile(item_path):
            quarantine_files.append(item_path)

    return quarantine_dirs, quarantine_files


def directory_tree_has_media(dir_path: str, *, library_path: str) -> bool:
    """Return True when any supported media file remains under ``dir_path``."""
    library_path = _abs_library_path(library_path)
    dir_path = os.path.abspath(dir_path)

    for root, dirs, files in os.walk(dir_path, topdown=True):
        rel_root = os.path.relpath(root, library_path)
        if rel_root != "." and in_infrastructure(rel_root):
            dirs[:] = []
            continue
        _filter_walk_dirs(library_path, root, dirs)

        for filename in files:
            if filename in IGNORED_LIBRARY_FILES:
                continue
            ext = os.path.splitext(filename)[1].lower()
            if ext in ALL_MEDIA_EXTENSIONS:
                return True
    return False


def remove_misplaced_infrastructure_trees(library_path: str) -> int:
    """Delete infrastructure folders that were copied inside year/media trees."""
    library_path = _abs_library_path(library_path)
    infrastructure = set(ROOT_INFRASTRUCTURE_DIRS)
    removed_count = 0
    roots_to_remove: List[str] = []

    for root, dirs, _files in os.walk(library_path, topdown=True):
        rel_root = os.path.relpath(root, library_path)
        if rel_root != "." and in_infrastructure(rel_root):
            dirs[:] = []
            continue

        for dirname in list(dirs):
            if dirname not in infrastructure:
                continue
            dir_path = os.path.join(root, dirname)
            dir_rel = os.path.relpath(dir_path, library_path)
            if not is_misplaced_infrastructure_rel(dir_rel):
                continue
            roots_to_remove.append(dir_path)
            dirs.remove(dirname)

    for dir_path in roots_to_remove:
        try:
            shutil.rmtree(dir_path)
            removed_count += 1
        except OSError:
            pass

    return removed_count


def prune_empty_year_subfolders(library_path: str) -> int:
    """Remove empty non-day folders and empty day folders under year directories."""
    library_path = _abs_library_path(library_path)
    removed_count = 0
    ignored_entries = set(IGNORED_LIBRARY_FILES)

    try:
        root_items = os.listdir(library_path)
    except OSError:
        return 0

    for item in root_items:
        if not (len(item) == 4 and item.isdigit()):
            continue

        year_path = os.path.join(library_path, item)
        if not os.path.isdir(year_path):
            continue

        for root, dirs, files in os.walk(year_path, topdown=False):
            rel_root = os.path.relpath(root, library_path)
            if in_infrastructure(rel_root):
                continue

            for filename in files:
                if filename in ignored_entries:
                    file_path = os.path.join(root, filename)
                    if os.path.isfile(file_path):
                        try:
                            os.remove(file_path)
                        except OSError:
                            pass

            try:
                visible_entries = [
                    entry
                    for entry in os.listdir(root)
                    if entry not in ignored_entries
                ]
            except OSError:
                continue

            if visible_entries:
                continue

            parts = path_parts(rel_root)
            if len(parts) == 1 and is_year_folder_name(parts[0]):
                pass
            elif len(parts) == 2 and is_year_folder_name(parts[0]) and is_day_folder_name(parts[0], parts[1]):
                pass
            elif len(parts) < 2:
                continue

            try:
                shutil.rmtree(root)
                removed_count += 1
            except OSError:
                pass

    return removed_count


def remove_noncanonical_trees(library_path: str) -> int:
    """
    Remove non-canonical folder trees that contain no supported media.

    Allowed layout after cleanup:
    - Root infrastructure folders (``.library``, ``.logs``, …)
    - ``YYYY/YYYY-MM-DD/`` canonical media trees
    """
    library_path = _abs_library_path(library_path)
    removed_count = 0
    ignored_entries = set(IGNORED_LIBRARY_FILES)
    infrastructure_folders = set(ROOT_INFRASTRUCTURE_DIRS)

    try:
        root_items = os.listdir(library_path)
    except OSError:
        return 0

    for item in root_items:
        item_path = os.path.join(library_path, item)
        if not os.path.isdir(item_path):
            continue

        if item in infrastructure_folders:
            continue

        if len(item) == 4 and item.isdigit():
            try:
                year_items = os.listdir(item_path)
            except OSError:
                continue

            for year_item in year_items:
                year_item_path = os.path.join(item_path, year_item)
                if not os.path.isdir(year_item_path):
                    continue

                is_valid_date_folder = (
                    len(year_item) == 10
                    and year_item[4] == "-"
                    and year_item[7] == "-"
                    and year_item[:4].isdigit()
                    and year_item[5:7].isdigit()
                    and year_item[8:10].isdigit()
                )
                if is_valid_date_folder:
                    continue

                try:
                    visible_entries = [
                        entry
                        for entry in os.listdir(year_item_path)
                        if entry not in ignored_entries
                    ]
                except OSError:
                    continue

                if visible_entries:
                    continue

                try:
                    for ignored_entry in os.listdir(year_item_path):
                        if ignored_entry in ignored_entries:
                            ignored_path = os.path.join(year_item_path, ignored_entry)
                            if os.path.isfile(ignored_path):
                                os.remove(ignored_path)
                    shutil.rmtree(year_item_path)
                    removed_count += 1
                except OSError:
                    pass
            continue

        if directory_tree_has_media(item_path, library_path=library_path):
            continue

        try:
            shutil.rmtree(item_path)
            removed_count += 1
        except OSError:
            pass

    return removed_count


def finalize_library_layout(library_path: str) -> Tuple[int, List[str]]:
    """
    Remove non-canonical folders and return any remaining non-media paths.

    Callers should trash returned paths, then rerun until the list is empty if
    needed.
    """
    removed_dirs = (
        remove_misplaced_infrastructure_trees(library_path)
        + prune_empty_year_subfolders(library_path)
        + remove_noncanonical_trees(library_path)
    )
    stragglers = partition_library_files(library_path).non_media_files
    return removed_dirs, stragglers


def iter_layout_cleanup_passes(
    library_path: str,
    *,
    max_passes: int = MAX_LAYOUT_CLEANUP_PASSES,
) -> Iterator[Tuple[int, List[str]]]:
    """Yield ``(removed_dirs, non_media_stragglers)`` until clear or ``max_passes``."""
    for _ in range(max(1, max_passes)):
        removed, stragglers = finalize_library_layout(library_path)
        yield removed, stragglers
        if not stragglers:
            break
