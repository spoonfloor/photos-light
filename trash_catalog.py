"""Grid read helpers for user-deleted photos in deleted_photos + .trash/user_deleted/."""

from __future__ import annotations

import json
import os
import shutil
from collections import defaultdict
from typing import Callable, Literal, Optional, Tuple

RestoreOutcome = Literal['restored', 'merged', 'error']

from library_filesystem import move_file_to_category_trash

USER_DELETED_TRASH_CATEGORY = 'user_deleted'

DELETED_PHOTO_GRID_SELECT = """
    SELECT
        id,
        original_path,
        trash_filename,
        deleted_at,
        photo_data,
        json_extract(photo_data, '$.date_taken') AS date_taken,
        json_extract(photo_data, '$.current_path') AS current_path,
        json_extract(photo_data, '$.file_type') AS file_type,
        json_extract(photo_data, '$.rating') AS rating,
        json_extract(photo_data, '$.width') AS width,
        json_extract(photo_data, '$.height') AS height,
        json_extract(photo_data, '$.content_hash') AS content_hash
    FROM deleted_photos
"""

TRASH_TOTAL_COUNT_CACHE = None
TRASH_TOTAL_COUNT_CACHE_REVISION = None
TRASH_MONTH_INDEX_CACHE = {}
TRASH_MONTH_INDEX_CACHE_REVISION = None


def ensure_user_deleted_trash_dir(trash_dir: str) -> str:
    """Ensure ``.trash/user_deleted`` exists and return its path."""
    user_dir = os.path.join(trash_dir, USER_DELETED_TRASH_CATEGORY)
    os.makedirs(user_dir, exist_ok=True)
    return user_dir


def move_photo_to_user_trash(library_path: str, trash_dir: str, full_path: str) -> str:
    """Move a library file into ``.trash/user_deleted/`` preserving relative path."""
    ensure_user_deleted_trash_dir(trash_dir)
    trash_path = move_file_to_category_trash(
        library_path,
        trash_dir,
        full_path,
        USER_DELETED_TRASH_CATEGORY,
    )
    return os.path.relpath(trash_path, trash_dir)


def user_trash_dir_for_library(library_path: str) -> str:
    """Return ``<library>/.trash``."""
    return os.path.join(library_path, '.trash')


def deleted_row_for_content_hash(cursor, content_hash: str):
    """Find a user-deleted row whose archived photo_data matches ``content_hash``."""
    if not content_hash:
        return None
    return cursor.execute(
        """
        SELECT * FROM deleted_photos
        WHERE json_extract(photo_data, '$.content_hash') = ?
        LIMIT 1
        """,
        (content_hash,),
    ).fetchone()


def restore_or_merge_deleted_photo(
    cursor,
    *,
    photo_id: int,
    trash_dir: str,
    library_path: str,
) -> Tuple[RestoreOutcome, Optional[int], Optional[str]]:
    """
    Restore one deleted photo, or merge with a live library copy when the hash
    already exists in ``photos``.

    Returns ``(outcome, live_photo_id, error_message)``.
    """
    row = cursor.execute(
        "SELECT * FROM deleted_photos WHERE id = ?",
        (photo_id,),
    ).fetchone()
    if not row:
        return 'error', None, f'Photo {photo_id} not found in trash'

    deleted_data = dict(row)
    original_path = deleted_data['original_path']
    trash_filename = deleted_data['trash_filename']
    photo_data = json.loads(deleted_data['photo_data'])
    content_hash = photo_data.get('content_hash')

    trash_path = resolve_user_deleted_trash_path(trash_dir, trash_filename)
    full_path = os.path.join(library_path, original_path)

    if not trash_path or not os.path.exists(trash_path):
        return 'error', None, f'Photo {photo_id} file not found in trash'

    live_row = None
    if content_hash:
        live_row = cursor.execute(
            "SELECT id, current_path FROM photos WHERE content_hash = ?",
            (content_hash,),
        ).fetchone()

    if live_row:
        live_path = os.path.join(library_path, live_row['current_path'])
        if not os.path.exists(live_path):
            os.makedirs(os.path.dirname(live_path), exist_ok=True)
            shutil.move(trash_path, live_path)
        else:
            os.remove(trash_path)
        cursor.execute("DELETE FROM deleted_photos WHERE id = ?", (photo_id,))
        cursor.connection.commit()
        return 'merged', live_row['id'], None

    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    shutil.move(trash_path, full_path)
    if not os.path.exists(full_path):
        return 'error', None, f'Failed to verify restored file for photo {photo_id}'

    columns = list(photo_data.keys())
    placeholders = ', '.join(['?' for _ in columns])
    values = [photo_data[col] for col in columns]
    cursor.execute(
        f"INSERT INTO photos ({', '.join(columns)}) VALUES ({placeholders})",
        values,
    )
    cursor.execute("DELETE FROM deleted_photos WHERE id = ?", (photo_id,))
    cursor.connection.commit()
    return 'restored', photo_id, None


def resolve_user_deleted_trash_path(trash_dir: str, trash_filename: str) -> str:
    """Resolve on-disk path for a deleted photo, including legacy flat trash entries."""
    if not trash_filename:
        return ''
    direct = os.path.join(trash_dir, trash_filename)
    if os.path.exists(direct):
        return direct
    basename = os.path.basename(trash_filename)
    legacy = os.path.join(trash_dir, basename)
    if os.path.exists(legacy):
        return legacy
    categorized = os.path.join(trash_dir, USER_DELETED_TRASH_CATEGORY, basename)
    if os.path.exists(categorized):
        return categorized
    return direct


def deleted_row_to_grid_dict(row, *, month_key_for_photo_grid: Callable) -> dict:
    """Serialize a deleted_photos row for the trash grid API."""
    date_str = row['date_taken']
    original_path = row['original_path']
    rating = row['rating']
    if rating is not None:
        try:
            rating = int(rating)
        except (TypeError, ValueError):
            rating = None
    width = row['width']
    height = row['height']
    if width is not None:
        try:
            width = int(width)
        except (TypeError, ValueError):
            width = None
    if height is not None:
        try:
            height = int(height)
        except (TypeError, ValueError):
            height = None
    return {
        'id': row['id'],
        'date': date_str,
        'month': month_key_for_photo_grid(date_str, original_path),
        'file_type': row['file_type'],
        'path': original_path,
        'width': width,
        'height': height,
        'rating': rating,
        'deleted_at': row['deleted_at'],
        'trash_filename': row['trash_filename'],
    }


def parse_deleted_photo_data(row) -> dict:
    """Parse stored photo_data JSON for a deleted row."""
    try:
        return json.loads(row['photo_data'])
    except (TypeError, json.JSONDecodeError):
        return {}


def invalidate_trash_grid_caches():
    global TRASH_TOTAL_COUNT_CACHE, TRASH_TOTAL_COUNT_CACHE_REVISION, TRASH_MONTH_INDEX_CACHE
    TRASH_TOTAL_COUNT_CACHE = None
    TRASH_TOTAL_COUNT_CACHE_REVISION = None
    TRASH_MONTH_INDEX_CACHE = {}


def get_trash_total_count(cursor, *, catalog_revision: int) -> int:
    global TRASH_TOTAL_COUNT_CACHE, TRASH_TOTAL_COUNT_CACHE_REVISION
    if (
        TRASH_TOTAL_COUNT_CACHE is not None
        and TRASH_TOTAL_COUNT_CACHE_REVISION == catalog_revision
    ):
        return TRASH_TOTAL_COUNT_CACHE
    row = cursor.execute('SELECT COUNT(*) AS count FROM deleted_photos').fetchone()
    TRASH_TOTAL_COUNT_CACHE = int(row['count']) if row else 0
    TRASH_TOTAL_COUNT_CACHE_REVISION = catalog_revision
    return TRASH_TOTAL_COUNT_CACHE


def _deleted_filter_clause(starred: bool = False, video: bool = False) -> tuple[str, list]:
    clauses = []
    params: list = []
    if starred:
        clauses.append("CAST(json_extract(photo_data, '$.rating') AS INTEGER) = 5")
    if video:
        clauses.append("json_extract(photo_data, '$.file_type') = ?")
        params.append('video')
    if not clauses:
        return '', params
    return ' WHERE ' + ' AND '.join(clauses), params


def build_trash_month_index(
    cursor,
    sort_order: str = 'newest',
    *,
    starred: bool = False,
    video: bool = False,
    month_key_for_photo_grid: Callable,
    sort_grid_month_keys: Callable,
):
    where, params = _deleted_filter_clause(starred, video)
    rows = cursor.execute(
        f"""
        SELECT
            json_extract(photo_data, '$.date_taken') AS date_taken,
            original_path
        FROM deleted_photos
        {where}
        """,
        params,
    ).fetchall()
    month_counts = defaultdict(int)
    for row in rows:
        month = month_key_for_photo_grid(row['date_taken'], row['original_path'])
        month_counts[month] += 1
    ordered = sort_grid_month_keys(month_counts, sort_order)
    months = [{'month': month, 'count': month_counts[month]} for month in ordered]
    total = sum(month_counts.values())
    return {
        'months': months,
        'total': total,
        'undated_count': month_counts.get('undated', 0),
        'sort': sort_order,
        'starred': starred,
        'video': video,
        'filtered': bool(starred or video),
    }


def get_cached_trash_month_index(
    cursor,
    sort_order: str = 'newest',
    *,
    starred: bool = False,
    video: bool = False,
    catalog_revision: int,
    month_key_for_photo_grid: Callable,
    sort_grid_month_keys: Callable,
):
    global TRASH_MONTH_INDEX_CACHE, TRASH_MONTH_INDEX_CACHE_REVISION
    if TRASH_MONTH_INDEX_CACHE_REVISION != catalog_revision:
        TRASH_MONTH_INDEX_CACHE = {}
        TRASH_MONTH_INDEX_CACHE_REVISION = catalog_revision
    flags = []
    if starred:
        flags.append('starred')
    if video:
        flags.append('video')
    suffix = ','.join(flags) if flags else 'all'
    cache_key = f'{sort_order}|{suffix}'
    if cache_key not in TRASH_MONTH_INDEX_CACHE:
        TRASH_MONTH_INDEX_CACHE[cache_key] = build_trash_month_index(
            cursor,
            sort_order,
            starred=starred,
            video=video,
            month_key_for_photo_grid=month_key_for_photo_grid,
            sort_grid_month_keys=sort_grid_month_keys,
        )
    return TRASH_MONTH_INDEX_CACHE[cache_key]


def _hydrate_deleted_rows_by_id(cursor, id_rows):
    if not id_rows:
        return []
    ids = [row['id'] if hasattr(row, 'keys') else row[0] for row in id_rows]
    placeholders = ','.join('?' * len(ids))
    rows = cursor.execute(
        f"{DELETED_PHOTO_GRID_SELECT} WHERE id IN ({placeholders})",
        ids,
    ).fetchall()
    by_id = {row['id']: row for row in rows}
    return [by_id[photo_id] for photo_id in ids if photo_id in by_id]


def _fetch_dated_deleted_page(cursor, limit, sort_order, after=None):
    if sort_order == 'newest':
        order_clause = (
            'ORDER BY date_taken DESC, original_path ASC, id ASC'
        )
        if after:
            where = """
                WHERE date_taken IS NOT NULL
                  AND (
                    date_taken < ? OR
                    (date_taken = ? AND original_path > ?) OR
                    (date_taken = ? AND original_path = ? AND id > ?)
                  )
            """
            params = (
                after['date_taken'], after['date_taken'], after['current_path'],
                after['date_taken'], after['current_path'], after['photo_id'],
                limit,
            )
        else:
            where = 'WHERE date_taken IS NOT NULL'
            params = (limit,)
    else:
        order_clause = 'ORDER BY date_taken ASC, original_path ASC, id ASC'
        if after:
            where = """
                WHERE date_taken IS NOT NULL
                  AND (
                    date_taken > ? OR
                    (date_taken = ? AND original_path > ?) OR
                    (date_taken = ? AND original_path = ? AND id > ?)
                  )
            """
            params = (
                after['date_taken'], after['date_taken'], after['current_path'],
                after['date_taken'], after['current_path'], after['photo_id'],
                limit,
            )
        else:
            where = 'WHERE date_taken IS NOT NULL'
            params = (limit,)

    id_rows = cursor.execute(
        f"""
        SELECT id, json_extract(photo_data, '$.date_taken') AS date_taken,
               original_path AS current_path
        FROM deleted_photos
        {where}
        {order_clause}
        LIMIT ?
        """,
        params,
    ).fetchall()
    return _hydrate_deleted_rows_by_id(cursor, id_rows)


def _fetch_undated_deleted_page(cursor, limit, after=None):
    undated_clause = "json_extract(photo_data, '$.date_taken') IS NULL"
    if after:
        where = f"""
            WHERE {undated_clause}
              AND (
                original_path > ? OR
                (original_path = ? AND id > ?)
              )
        """
        params = (after['current_path'], after['current_path'], after['photo_id'], limit)
    else:
        where = f'WHERE {undated_clause}'
        params = (limit,)

    id_rows = cursor.execute(
        f"""
        SELECT id, original_path AS current_path
        FROM deleted_photos
        {where}
        ORDER BY original_path ASC, id ASC
        LIMIT ?
        """,
        params,
    ).fetchall()
    return _hydrate_deleted_rows_by_id(cursor, id_rows)


def fetch_deleted_photos_page(
    cursor,
    limit,
    sort_order,
    *,
    cursor_str: Optional[str],
    catalog_revision: int,
    month_key_for_photo_grid: Callable,
    decode_photos_cursor: Callable,
    cursor_from_row: Callable,
):
    parsed = decode_photos_cursor(cursor_str)
    photos = []
    section = parsed['section'] if parsed else 'dated'
    after = parsed

    if section == 'dated':
        dated_rows = _fetch_dated_deleted_page(
            cursor, limit, sort_order, after=after if parsed else None,
        )
        photos.extend(dated_rows)
        remaining = limit - len(photos)
        if remaining > 0:
            undated_rows = _fetch_undated_deleted_page(cursor, remaining)
            photos.extend(undated_rows)
            if undated_rows:
                section = 'undated'
                after = {
                    'section': 'undated',
                    'current_path': undated_rows[-1]['original_path'],
                    'photo_id': undated_rows[-1]['id'],
                }
            elif dated_rows:
                section = 'dated'
                after = {
                    'section': 'dated',
                    'date_taken': dated_rows[-1]['date_taken'],
                    'current_path': dated_rows[-1]['original_path'],
                    'photo_id': dated_rows[-1]['id'],
                }
        elif dated_rows:
            section = 'dated'
            after = {
                'section': 'dated',
                'date_taken': dated_rows[-1]['date_taken'],
                'current_path': dated_rows[-1]['original_path'],
                'photo_id': dated_rows[-1]['id'],
            }
    else:
        undated_rows = _fetch_undated_deleted_page(
            cursor, limit, after=after if parsed else None,
        )
        photos.extend(undated_rows)
        if undated_rows:
            section = 'undated'
            after = {
                'section': 'undated',
                'current_path': undated_rows[-1]['original_path'],
                'photo_id': undated_rows[-1]['id'],
            }

    next_cursor = None
    if photos:
        last = photos[-1]
        row_for_cursor = {
            'date_taken': last['date_taken'],
            'current_path': last['original_path'],
            'id': last['id'],
        }
        next_cursor = cursor_from_row(row_for_cursor, section)

    total = get_trash_total_count(cursor, catalog_revision=catalog_revision)
    return {
        'photos': [
            deleted_row_to_grid_dict(row, month_key_for_photo_grid=month_key_for_photo_grid)
            for row in photos
        ],
        'count': len(photos),
        'total': total,
        'limit': limit,
        'next_cursor': next_cursor,
        'has_more': len(photos) == limit,
    }


def fetch_deleted_photos_for_grid_month(
    cursor,
    month_key,
    sort_order,
    *,
    month_key_for_photo_grid: Callable,
    month_bounds_for_sql: Callable,
    photo_grid_select_unused=None,
):
    del photo_grid_select_unused
    rows = cursor.execute(DELETED_PHOTO_GRID_SELECT).fetchall()
    matched = []
    for row in rows:
        if month_key_for_photo_grid(row['date_taken'], row['original_path']) != month_key:
            continue
        matched.append(row)

    dated = [row for row in matched if row['date_taken']]
    undated = [row for row in matched if not row['date_taken']]
    if sort_order == 'newest':
        dated.sort(
            key=lambda row: (row['date_taken'], row['original_path'], row['id']),
            reverse=True,
        )
    else:
        dated.sort(key=lambda row: (row['date_taken'], row['original_path'], row['id']))
    undated.sort(key=lambda row: (row['original_path'], row['id']))
    ordered = dated + undated
    return [
        deleted_row_to_grid_dict(row, month_key_for_photo_grid=month_key_for_photo_grid)
        for row in ordered
    ]


def fetch_deleted_photos_anchored_at_month(
    cursor,
    target_month,
    limit,
    sort_order,
    *,
    catalog_revision: int,
    month_bounds_for_sql: Callable,
    month_key_for_photo_grid: Callable,
    cursor_from_row: Callable,
):
    lower, upper = month_bounds_for_sql(target_month)
    if sort_order == 'newest':
        id_rows = cursor.execute(
            """
            SELECT id
            FROM deleted_photos
            WHERE json_extract(photo_data, '$.date_taken') IS NOT NULL
              AND json_extract(photo_data, '$.date_taken') < ?
            ORDER BY json_extract(photo_data, '$.date_taken') DESC,
                     original_path ASC,
                     id ASC
            LIMIT ?
            """,
            (upper, limit),
        ).fetchall()
    else:
        id_rows = cursor.execute(
            """
            SELECT id
            FROM deleted_photos
            WHERE json_extract(photo_data, '$.date_taken') IS NOT NULL
              AND json_extract(photo_data, '$.date_taken') >= ?
            ORDER BY json_extract(photo_data, '$.date_taken') ASC,
                     original_path ASC,
                     id ASC
            LIMIT ?
            """,
            (lower, limit),
        ).fetchall()
    rows = _hydrate_deleted_rows_by_id(cursor, id_rows)
    section = 'dated' if rows else None
    next_cursor = None
    if rows:
        last = rows[-1]
        next_cursor = cursor_from_row(
            {
                'date_taken': last['date_taken'],
                'current_path': last['original_path'],
                'id': last['id'],
            },
            section,
        )
    total = get_trash_total_count(cursor, catalog_revision=catalog_revision)
    return {
        'photos': [
            deleted_row_to_grid_dict(row, month_key_for_photo_grid=month_key_for_photo_grid)
            for row in rows
        ],
        'count': len(rows),
        'total': total,
        'limit': limit,
        'next_cursor': next_cursor,
        'has_more': len(rows) == limit,
        'anchor_month': target_month,
    }


def fetch_trash_years(cursor):
    rows = cursor.execute(
        """
        SELECT DISTINCT substr(json_extract(photo_data, '$.date_taken'), 1, 4) AS year
        FROM deleted_photos
        WHERE json_extract(photo_data, '$.date_taken') IS NOT NULL
        ORDER BY year ASC
        """
    ).fetchall()
    years = []
    for row in rows:
        year = row['year']
        if year and str(year).isdigit():
            years.append(int(year))
    return years


def fetch_trash_nearest_month(cursor, target_month, sort_order):
    rows = cursor.execute(
        """
        SELECT DISTINCT substr(json_extract(photo_data, '$.date_taken'), 1, 7) AS month
        FROM deleted_photos
        WHERE json_extract(photo_data, '$.date_taken') IS NOT NULL
        ORDER BY month
        """
    ).fetchall()
    all_months = []
    for row in rows:
        month = row['month']
        if not month:
            continue
        normalized = str(month).replace(':', '-')
        if len(normalized) >= 7:
            all_months.append(normalized[:7])
    if not all_months:
        return None

    target_year = target_month[:4]
    target_month_num = int(target_month[5:7])
    year_months = [m for m in all_months if m[:4] == target_year]
    if year_months:
        if sort_order == 'newest':
            candidates = [m for m in year_months if int(m[5:7]) <= target_month_num]
            if candidates:
                return max(candidates)
            return min(year_months)
        candidates = [m for m in year_months if int(m[5:7]) >= target_month_num]
        if candidates:
            return min(candidates)
        return max(year_months)

    if sort_order == 'newest':
        earlier = [m for m in all_months if m < target_month]
        return max(earlier) if earlier else min(all_months)
    later = [m for m in all_months if m > target_month]
    return min(later) if later else max(all_months)
