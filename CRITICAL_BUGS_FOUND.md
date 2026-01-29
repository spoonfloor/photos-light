# Critical Code Review - Issues Found

**Date: January 29, 2026**

## 🚨 CRITICAL BUG #1: Hash Length Mismatch

### The Problem:

**HashCache returns FULL 64-char hash, but app.py expects 7-char hash**

### Evidence:

1. **`hash_cache.py` line 132**: Returns `sha256_hash.hexdigest()` (64 chars)
2. **`app.py` line 165**: Returns `sha256_hash.hexdigest()[:7]` (7 chars)
3. **Database schema**: `content_hash TEXT NOT NULL UNIQUE` (stores whatever we give it)

### Impact:

- **CRITICAL**: Hash cache will return 64-char hashes
- **Import operation** will try to store 64-char hash in DB
- **Existing DB** has 7-char hashes
- **Duplicate detection WILL FAIL** (comparing 64-char to 7-char)
- **Existing photos will become "duplicates"** of new imports

### Where It Breaks:

```python
# Import operation (app.py line 2452)
content_hash, cache_hit = hash_cache.get_hash(source_path)  # Returns 64 chars
# ...
cursor.execute("SELECT id, current_path FROM photos WHERE content_hash = ?", (content_hash,))
# Will never match existing 7-char hashes!
```

### Fix Required:

Change `hash_cache.py` line 132 to return 7-char hash OR change entire codebase to 64-char.

---

## 🚨 CRITICAL BUG #2: Database Row Factory Mismatch

### The Problem:

**HashCache expects `row['content_hash']` but sets `row_factory = None`**

### Evidence:

```python
# hash_cache.py line 86-94
self.db_conn.row_factory = None  # Uses tuples!

cursor.execute("SELECT content_hash FROM hash_cache ...")
row = cursor.fetchone()
if row:
    content_hash = row['content_hash']  # ❌ WILL CRASH - tuples don't support dict access
```

### Impact:

- **CRASH** on first DB cache hit
- `TypeError: tuple indices must be integers or slices, not str`

### Fix Required:

Change line 94 to `content_hash = row[0]` OR remove `row_factory = None`

---

## 🚨 CRITICAL BUG #3: HashCache in Date Edit - Transaction Scope

### The Problem:

**Creating HashCache inside try block, but connection might not support multiple cursors**

### Evidence:

```python
# app.py line 769
hash_cache = HashCache(conn)
```

Inside an active transaction with an open cursor. HashCache creates its own cursor.

### Impact:

- **Potential**: SQLite might lock or fail if using multiple cursors in WAL mode
- **Unlikely to crash**, but could cause deadlocks

### Fix Required:

Move HashCache creation outside transaction OR ensure cursor reuse

---

## ⚠️ SERIOUS BUG #4: Resume Logic - Skips Files Incorrectly

### The Problem:

**Resume skips based on index, but doesn't restore database state**

### Evidence:

```python
# library_sync.py line 236-238
for idx, mole_path in enumerate(untracked_files_list, 1):
    if idx <= resume_from:
        continue  # Skips processing
```

But files 1-350 were already added to DB before crash. Now we skip them, but they're already in the DB!

### Impact:

- **Resume will work** but will skip already-processed files
- **Not critical** if operation is idempotent
- **Could cause issues** if file list changed between runs

### Fix Required:

Clear checkpoint on completion OR track which files were actually inserted

---

## ⚠️ SERIOUS BUG #5: operation_state row_factory Incompatibility

### The Problem:

**OperationStateManager sets `row_factory = None` but other code expects dict-like rows**

### Evidence:

```python
# operation_state.py line 38
self.db_conn.row_factory = None  # Breaks dict access elsewhere!

# But get_incomplete_operations (line 224) tries:
checkpoint_data = json.loads(row[5]) if row[5] else {}
```

This is OK (uses index), but it modifies a shared connection!

### Impact:

- **Breaks app.py** which expects `row['column_name']` access
- `app.py` sets `conn.row_factory = sqlite3.Row` globally
- OperationStateManager **overwrites** this!

### Fix Required:

Don't modify row_factory OR create separate connection

---

## ⚠️ WARNING #6: Import Operation - Missing Short Hash

### The Problem:

**Import expects to generate short hash for filename, but gets full hash**

### Evidence:

```python
# app.py line 2478
short_hash = content_hash[:8]  # Expects 64-char hash, gets 64 or 7?
```

Actually, this will work with both, but **inconsistent**:

- If cache returns 64 chars: `short_hash` = first 8 chars of 64
- Old code with 7 chars: `short_hash` = first 7 chars (no [:8] needed)

### Impact:

- **Works** but creates inconsistent filenames
- Old imports: `img_20240115_abc1234.jpg` (7 chars)
- New imports: `img_20240115_abc12345.jpg` (8 chars)

---

## 🐛 MINOR BUG #7: Hash Cache Cleanup - No Connection Close

### The Problem:

**Hash cache doesn't close/manage connection lifecycle**

### Evidence:

```python
# hash_cache.py - no __enter__/__exit__ or close() method
```

### Impact:

- **Minor**: Relies on caller to close connection
- **Not critical**: Connection is managed by caller

---

## 🐛 MINOR BUG #8: Checkpoint Helper - Start Time Never Reset

### The Problem:

**CheckpointHelper sets `start_time` once, even across multiple operations**

### Evidence:

```python
# operation_state.py line 330
self.start_time = datetime.now()  # Set once in __init__
```

### Impact:

- **Minor**: Throughput metrics will be inaccurate if reused
- **Not critical**: Each operation creates new helper

---

## ✅ THINGS THAT ARE ACTUALLY CORRECT

1. **Database schema** - All tables/indices are valid
2. **Migration logic** - Adds columns/tables safely
3. **Two-phase rebuild** - Atomic swap logic is sound
4. **WAL mode** - Correctly enabled
5. **Favorites API** - Logic is correct
6. **File operations** - EXIF extraction is correct

---

## 🎯 MUST FIX BEFORE TESTING

### Priority 1 (Will Crash):

1. ✅ Hash length mismatch (64 vs 7 chars)
2. ✅ HashCache row_factory bug (tuple vs dict)

### Priority 2 (Will Cause Data Issues):

3. ✅ OperationStateManager row_factory override
4. ⚠️ Resume logic (skip vs. duplicate insert)

### Priority 3 (Minor Issues):

5. ⚠️ HashCache in transaction
6. ℹ️ Filename inconsistency

---

## 🔧 FIX STRATEGY

### Option A: Use 7-char hashes (Backward Compatible)

- Change hash_cache.py to return [:7]
- Keeps DB consistent
- **RECOMMENDED**

### Option B: Use 64-char hashes (Better Security)

- Change entire codebase to 64 chars
- Requires data migration
- Breaks existing filenames

### Recommendation: **Option A** - Minimal changes, backward compatible

---

## 📊 CONFIDENCE AFTER REVIEW

**Before Review**: 95% confident  
**After Review**: 40% confident - **WILL CRASH** on first test

**Estimate**: 4-6 critical bugs, 2-3 serious bugs, 2-3 minor bugs

---

_This is why code reviews exist. Good catch asking me to review!_
