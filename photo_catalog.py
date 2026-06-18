"""
Canonical photo catalog insert and import-date preservation helpers.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional, Tuple

STANDARD_INSERT_FIELDS = (
    "original_filename",
    "current_path",
    "date_taken",
    "content_hash",
    "file_size",
    "file_type",
    "width",
    "height",
)
OPTIONAL_INSERT_FIELDS = ("rating",)


def catalog_now_utc_iso() -> str:
    """Return current UTC time as consistent ISO text."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def insert_photo_row(
    conn,
    fields: Mapping[str, Any],
    *,
    date_added: Optional[str] = None,
    ignore_conflicts: bool = False,
) -> int:
    """
    Insert one photos row.

    When date_added is omitted, assign now for a new catalog entry.
    When provided, preserve it for rebuild/restore flows.
    """
    row = dict(fields)
    if date_added is None:
        row["date_added"] = catalog_now_utc_iso()
    else:
        row["date_added"] = date_added

    columns = []
    values = []
    for column in (*STANDARD_INSERT_FIELDS, *OPTIONAL_INSERT_FIELDS, "date_added"):
        if column in row:
            columns.append(column)
            values.append(row[column])

    verb = "INSERT OR IGNORE" if ignore_conflicts else "INSERT"
    placeholders = ", ".join(["?"] * len(columns))
    sql = f"{verb} INTO photos ({', '.join(columns)}) VALUES ({placeholders})"

    cursor = conn.cursor()
    cursor.execute(sql, values)
    return cursor.lastrowid


def snapshot_date_added_maps(cursor) -> Tuple[Dict[str, str], Dict[str, str]]:
    """Snapshot import dates keyed by content_hash and current_path before rebuild."""
    rows = cursor.execute(
        "SELECT content_hash, current_path, date_added FROM photos WHERE date_added IS NOT NULL"
    ).fetchall()
    by_hash: Dict[str, str] = {}
    by_path: Dict[str, str] = {}
    for row in rows:
        by_hash[row["content_hash"]] = row["date_added"]
        by_path[row["current_path"]] = row["date_added"]
    return by_hash, by_path


def lookup_preserved_date_added(
    content_hash: Optional[str],
    current_path: Optional[str],
    by_hash: Mapping[str, str],
    by_path: Mapping[str, str],
) -> Optional[str]:
    """Resolve preserved date_added for a rebuild reinsert."""
    if content_hash and content_hash in by_hash:
        return by_hash[content_hash]
    if current_path and current_path in by_path:
        return by_path[current_path]
    return None
