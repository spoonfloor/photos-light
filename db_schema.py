"""
Single Source of Truth for Database Schema

This file imports and aliases the current schema version (v3).
All application code should import from this file, not version-specific files.

Version History:
- v1: Original schema (photos, deleted_photos)
- v2: Added hash_cache, operation_state, rating column (overengineered)
- v3: Removed operation_state, kept hash_cache + rating (recommended)

Current: v3
"""

from db_schema_v3 import (
    SCHEMA_VERSION,
    PHOTOS_TABLE_SCHEMA,
    DELETED_PHOTOS_TABLE_SCHEMA,
    HASH_CACHE_TABLE_SCHEMA,
    PHOTOS_INDICES,
    HASH_CACHE_INDICES,
    create_database_schema,
    get_schema_info
)

__all__ = [
    'SCHEMA_VERSION',
    'PHOTOS_TABLE_SCHEMA',
    'DELETED_PHOTOS_TABLE_SCHEMA',
    'HASH_CACHE_TABLE_SCHEMA',
    'PHOTOS_INDICES',
    'HASH_CACHE_INDICES',
    'create_database_schema',
    'get_schema_info'
]
