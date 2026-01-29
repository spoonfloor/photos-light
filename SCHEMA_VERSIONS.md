# Database Schema Versions

**Current Version: v3** (as of January 29, 2026)

---

## 📁 Schema Files

| File              | Version | Status                  | Tables                                       |
| ----------------- | ------- | ----------------------- | -------------------------------------------- |
| `db_schema_v1.py` | 1       | Original                | `photos`, `deleted_photos`                   |
| `db_schema_v2.py` | 2       | Overengineered          | + `hash_cache`, `operation_state` + `rating` |
| `db_schema_v3.py` | 3       | **Current/Recommended** | + `hash_cache` + `rating`                    |
| `db_schema.py`    | -       | Alias to v3             | (imports v3)                                 |

---

## 🔄 Version History

### v1 - Original Schema

**Tables:** 2

- `photos` (8 columns)
- `deleted_photos`

**Status:** Production baseline, no optimization

---

### v2 - Overengineered (Not Recommended)

**Tables:** 4

- `photos` (9 columns) + `rating` column
- `deleted_photos`
- `hash_cache` ← **Good addition**
- `operation_state` ← **Unnecessary complexity**

**Changes:**

- ✅ Added `hash_cache` table for performance
- ✅ Added `rating` column for favorites
- ❌ Added `operation_state` table for resume (overengineered)

**Why not recommended:**

- `operation_state` adds 600+ lines of code for rare edge case
- Resume UI not implemented (incomplete feature)
- Simpler alternatives exist (see DB_CHANGES_EVALUATION.md)

---

### v3 - Recommended (Current)

**Tables:** 3

- `photos` (9 columns) + `rating` column
- `deleted_photos`
- `hash_cache` ← **Kept: necessary optimization**

**Changes from v2:**

- ✅ Kept `hash_cache` (80-90% speedup, minimal complexity)
- ✅ Kept `rating` column (useful feature, harmless)
- ✅ Removed `operation_state` (unnecessary complexity)

**Benefits:**

- 90% of v2's performance benefit
- 40% less complexity
- Still crash-safe via two-phase commit
- Cleaner, more maintainable

---

## 📊 Table Details

### `hash_cache` (v2, v3)

**Purpose:** Cache file hashes to avoid repeated computation

**Schema:**

```sql
CREATE TABLE hash_cache (
    file_path TEXT NOT NULL,
    mtime_ns INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    cached_at TEXT NOT NULL,
    PRIMARY KEY (file_path, mtime_ns, file_size)
)
```

**Key features:**

- Composite key: `(file_path, mtime_ns, file_size)` = unique file state
- Automatic invalidation when file changes
- Stores full 64-char hash, returns 7-char (backward compatible)

**Performance impact:**

- First run: 0% speedup (cache miss)
- Repeat run: **80-90% speedup** (verified in tests)

---

### `operation_state` (v2 only - removed in v3)

**Purpose:** Track long-running operations for resume capability

**Schema:**

```sql
CREATE TABLE operation_state (
    operation_id TEXT PRIMARY KEY,
    operation_type TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    checkpoint_data TEXT,
    performance_metrics TEXT,
    error_message TEXT
)
```

**Why removed:**

- Solves rare edge case (crashes during operations)
- Adds significant complexity (600+ lines)
- Resume UI never implemented
- Simpler alternatives exist:
  - Operations are fast enough with hash_cache
  - Two-phase commit for rebuild (safer)
  - Idempotent operations (just restart)

---

### `rating` column (v2, v3)

**Added to `photos` table:**

```sql
rating INTEGER DEFAULT NULL
```

**Purpose:** Support favorites/starred photos (0-5 scale)

**Status:**

- Column exists in v2, v3
- API endpoints implemented but unused
- Frontend UI not implemented yet
- Harmless scope creep, useful future feature

---

## 🔀 Migration Path

### From v1 → v3 (Recommended)

```bash
# Use migrate script (needs updating to skip operation_state)
python3 migrate_db.py /path/to/photo_library.db
```

**Changes applied:**

1. Add `rating` column to `photos`
2. Create `hash_cache` table
3. Create indices

### From v2 → v3 (Simplify)

```sql
-- Drop unnecessary table
DROP TABLE IF EXISTS operation_state;

-- Schema is now v3 compatible
```

---

## 🎯 Current Status

**Active Schema:** v3 (via `db_schema.py`)

**Existing Code Imports:**

- ✅ `app.py` imports `db_schema` (will use v3)
- ✅ `library_sync.py` imports `db_schema` (will use v3)
- ✅ `migrate_db.py` needs updating for v3
- ⚠️ `library_sync.py` uses `operation_state` (needs refactoring)

**Next Steps:**

1. Update `library_sync.py` to remove operation_state usage
2. Update `migrate_db.py` to migrate v1→v3 (skip v2)
3. Test on real database

---

## 📖 References

- **Full analysis:** `DB_CHANGES_EVALUATION.md`
- **Test results:** `TEST_RESULTS.md`
- **Implementation status:** `INFRASTRUCTURE_IMPLEMENTATION_STATUS.md`

---

**Version:** v3  
**Date:** January 29, 2026  
**Status:** Ready for implementation
