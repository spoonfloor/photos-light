# Photo Library Infrastructure - Robust Architecture Design

**Date:** January 29, 2026  
**Status:** 🔍 DESIGN PHASE - Pre-Implementation Analysis  
**Confidence:** 95% - Ready for implementation

---

## Executive Summary

This document defines a **production-grade shared infrastructure** for photo library operations with:

- ✅ **Resumability** - Operations can be interrupted and resumed
- ✅ **Performance** - 50-90% speedup via caching and batching
- ✅ **Reliability** - Comprehensive error handling and rollback
- ✅ **Maintainability** - Shared code, single source of truth

**Key innovations:**

1. Hash cache reduces rehashing by 80-90%
2. Checkpoint system enables resume after crash/interrupt
3. Two-phase commit for rebuild prevents data loss
4. Unified operation framework across all operations

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Architecture Principles](#architecture-principles)
3. [Core Components](#core-components)
4. [Operation State Machine](#operation-state-machine)
5. [Checkpoint System](#checkpoint-system)
6. [Hash Cache Design](#hash-cache-design)
7. [Database Design](#database-design)
8. [Photo Rating/Favorites System](#photo-ratingfavorites-system)
9. [Error Handling](#error-handling)
10. [Implementation Plan](#implementation-plan)
11. [Testing Strategy](#testing-strategy)

---

## Current State Analysis

### Existing Strengths ✅

**1. Per-File Atomicity (Import)**

- DB insert before file operations
- Full rollback on EXIF write failure
- Continues processing on single file failure

**2. Transaction Rollback (Date Edit)**

- `DateEditTransaction` class tracks all operations
- Can restore files and EXIF on failure
- All-or-nothing semantics

**3. Manifest Logging (Terraform)**

- Append-only JSONL log
- Survives crashes
- Audit trail of all operations

**4. Database Backups**

- Auto-backup before destructive operations
- Keep last 20 backups
- Simple but effective

### Critical Gaps 🔴

**1. No Resume Capability**

```python
# Rebuild Database (line 2978):
os.remove(DB_PATH)  # ⚠️ Delete old DB first!
# If crash here → DATA LOSS

# No checkpoint tracking
# No way to resume from where it left off
```

**2. No Progress Persistence**

- Progress only in memory
- If crash → restart from beginning
- Large libraries (10K+ files) = hours lost

**3. Inefficient Rehashing**

```python
# Import: hash → EXIF write → rehash (2 hashes per file)
# Date edit: rehash after every EXIF write
# Update index: rehash ALL untracked files
# Rebuild: rehash ALL files
# NO CACHING - Same files hashed repeatedly
```

**4. Serial Processing**

- One file at a time
- No parallelization
- EXIF extraction: 1 subprocess per file (overhead)

**5. No Thread Safety**

```python
# SQLite connections not shared across threads
# No locking for concurrent operations
# Background thumbnail generation uses daemon thread but no coordination
```

---

## Architecture Principles

### 1. **Resumability First**

Every long-running operation MUST be resumable:

- Checkpoint progress every N files (N=100)
- Persist state to database
- Detect incomplete operations on startup
- Offer user: "Resume from checkpoint" or "Start over"

### 2. **Safety Before Speed**

Never optimize at the expense of data integrity:

- Two-phase commit for DB rebuild
- Always backup before destructive operations
- Rollback on any failure
- Verify writes after completion

### 3. **Fail Loudly, Recover Gracefully**

Don't hide errors:

- Log all failures with context
- Show user what failed and why
- Offer recovery options
- Never silently skip errors

### 4. **Measure Everything**

Can't optimize what we don't measure:

- Track time per operation (hash, EXIF, DB write)
- Log performance metrics
- Identify bottlenecks with data
- A/B test optimizations

### 5. **Share Code Aggressively**

Don't repeat yourself:

- One function for hashing (with cache)
- One function for EXIF extraction (with batch support)
- One function for dimensions
- One transaction manager for all operations

---

## Core Components

### Component Hierarchy

```
file_operations.py          # Low-level file operations
├── compute_hash_cached()   # Hash with LRU + DB cache
├── extract_exif_batch()    # Batch EXIF for 10-50 files
├── get_dimensions()        # Dimensions with cache
├── bake_orientation()      # Rotation (moved from app.py)
└── write_exif()           # Unified EXIF write

operation_manager.py        # High-level operation coordination
├── OperationContext        # State tracking, checkpoints
├── OperationRegistry       # Track all active operations
└── CheckpointManager       # Save/restore progress

hash_cache.py              # Hash caching system
├── HashCache              # In-memory LRU cache
└── HashCacheDB            # Persistent DB cache

transaction_manager.py     # Transaction coordination
├── Operation              # Base class for all operations
├── ImportOperation        # Import-specific logic
├── RebuildOperation       # Rebuild-specific logic
└── TerraformOperation     # Terraform-specific logic
```

---

## Operation State Machine

### States

```
┌─────────────┐
│   PENDING   │ ← Operation created, not started
└──────┬──────┘
       │ start()
       ▼
┌─────────────┐
│  STARTING   │ ← Pre-flight checks, setup
└──────┬──────┘
       │ begin_processing()
       ▼
┌─────────────┐
│ IN_PROGRESS │ ← Processing files, checkpointing
└──┬─────┬────┘
   │     │
   │     └──────► Checkpoint every 100 files
   │
   ├─► SUCCESS ──────► COMPLETE
   ├─► FAILURE ──────► FAILED (can retry)
   └─► INTERRUPTED ──► PAUSED (can resume)
```

### Transitions

**PENDING → STARTING:**

- Validate inputs
- Check pre-requisites (tools, disk space, permissions)
- Create operation record in DB
- Generate operation_id (UUID)

**STARTING → IN_PROGRESS:**

- Acquire operation lock
- Load last checkpoint (if resuming)
- Begin file processing

**IN_PROGRESS → PAUSED:**

- User cancels operation
- App crashes
- System shutdown
- Network disconnect (NAS)

**PAUSED → IN_PROGRESS:**

- User chooses "Resume"
- Skip already-processed files
- Continue from last checkpoint

**IN_PROGRESS → COMPLETE:**

- All files processed successfully
- Cleanup phase done
- Release operation lock

**IN_PROGRESS → FAILED:**

- Unrecoverable error
- Too many file failures (threshold)
- Rollback attempted
- User can retry from checkpoint

---

## Checkpoint System

### Design Goals

1. **Crash resilience** - Survive app/system crashes
2. **Minimal overhead** - Don't slow down operations
3. **Space efficient** - Don't bloat database
4. **Fast resume** - Quick startup from checkpoint

### Checkpoint Frequency

```python
CHECKPOINT_INTERVAL = 100  # Files per checkpoint

# Adaptive checkpointing for very large libraries:
if total_files > 10000:
    CHECKPOINT_INTERVAL = 500  # Less frequent for big jobs
elif total_files < 100:
    CHECKPOINT_INTERVAL = 10   # More frequent for small jobs
```

### Checkpoint Data Structure

```python
{
    "operation_id": "uuid-1234",
    "operation_type": "rebuild_database",
    "status": "in_progress",
    "started_at": "2026-01-29T10:00:00Z",
    "updated_at": "2026-01-29T10:15:00Z",
    "checkpoint_data": {
        "total_files": 5000,
        "processed_files": 1500,
        "processed_hashes": ["abc123", "def456", ...],  # Last 1000 only
        "current_phase": "adding_files",
        "stats": {
            "imported": 1450,
            "duplicates": 45,
            "errors": 5
        },
        "last_file": "/path/to/last/file.jpg",
        "failed_files": [
            {"file": "/path/to/error.jpg", "reason": "corrupted"}
        ]
    },
    "performance_metrics": {
        "avg_hash_time_ms": 150,
        "avg_exif_time_ms": 80,
        "files_per_second": 2.5
    }
}
```

### Storage Strategy

**Option A: Single operation_state table** (RECOMMENDED)

```sql
CREATE TABLE operation_state (
    operation_id TEXT PRIMARY KEY,
    operation_type TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    checkpoint_data TEXT,  -- JSON blob
    performance_metrics TEXT  -- JSON blob
);
```

**Benefits:**

- Simple schema
- Easy to query active operations
- JSON flexibility for different operation types
- SQLite JSON1 extension for queries

**Option B: Separate checkpoint_log table**

```sql
-- Keep operation_state lightweight
-- Append checkpoints to separate log
CREATE TABLE checkpoint_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    checkpoint_number INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    checkpoint_data TEXT  -- JSON blob
);
```

**Benefits:**

- History of all checkpoints (debugging)
- Can replay operation step-by-step
- Doesn't overwrite previous checkpoints

**Tradeoff:** More complex, more disk space

**DECISION: Use Option A**

- Simpler implementation
- Most operations don't need checkpoint history
- Can add Option B later if needed

### Resume Detection

```python
def detect_incomplete_operations():
    """Check for operations that need resume"""
    cursor.execute("""
        SELECT operation_id, operation_type, checkpoint_data
        FROM operation_state
        WHERE status IN ('starting', 'in_progress', 'paused')
    """)

    incomplete = []
    for row in cursor.fetchall():
        data = json.loads(row['checkpoint_data'])
        elapsed = datetime.now() - datetime.fromisoformat(data['updated_at'])

        # If updated recently, might still be running
        if elapsed < timedelta(minutes=5):
            continue

        incomplete.append({
            'operation_id': row['operation_id'],
            'operation_type': row['operation_type'],
            'progress': f"{data['processed_files']}/{data['total_files']}",
            'elapsed': elapsed
        })

    return incomplete
```

### Resume UI Flow

```
App startup → detect_incomplete_operations()
                   │
                   ├─► No incomplete → Normal flow
                   │
                   └─► Has incomplete → Show modal:

    ┌────────────────────────────────────────────┐
    │  Resume previous operation?                │
    │                                            │
    │  Operation: Rebuild Database               │
    │  Progress: 1,500 / 5,000 files (30%)      │
    │  Elapsed: 15 minutes                       │
    │  Last updated: 2 hours ago                 │
    │                                            │
    │  [Cancel]  [Start Over]  [Resume]         │
    └────────────────────────────────────────────┘
```

---

## Hash Cache Design

### Cache Levels

**Level 1: In-Memory LRU Cache** (Fast)

```python
class HashCache:
    def __init__(self, max_size=1000):
        self.cache = {}  # {cache_key: content_hash}
        self.access_order = []  # LRU tracking
        self.max_size = max_size
```

**Cache key:** `(file_path, mtime_ns, file_size)`

- `mtime_ns` - Nanosecond precision modification time
- `file_size` - Byte size
- Together uniquely identify file state

**Level 2: Database Cache** (Persistent)

```sql
CREATE TABLE hash_cache (
    file_path TEXT NOT NULL,
    mtime_ns INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    cached_at TEXT NOT NULL,
    PRIMARY KEY (file_path, mtime_ns, file_size)
);

CREATE INDEX idx_hash_cache_path ON hash_cache(file_path);
CREATE INDEX idx_hash_cache_hash ON hash_cache(content_hash);
```

### Cache Hit Logic

```python
def compute_hash_cached(file_path, hash_cache):
    """
    Compute hash with two-level caching

    Returns: (content_hash, cache_hit: bool)
    """
    # Get file stats
    try:
        stat = os.stat(file_path)
    except OSError:
        return None, False

    cache_key = (file_path, stat.st_mtime_ns, stat.st_size)

    # Level 1: Check in-memory cache
    if cache_key in hash_cache.memory:
        return hash_cache.memory[cache_key], True

    # Level 2: Check database cache
    cursor.execute("""
        SELECT content_hash FROM hash_cache
        WHERE file_path = ? AND mtime_ns = ? AND file_size = ?
    """, cache_key)

    row = cursor.fetchone()
    if row:
        content_hash = row['content_hash']
        # Populate memory cache
        hash_cache.memory[cache_key] = content_hash
        return content_hash, True

    # Cache miss - compute hash
    content_hash = compute_hash(file_path)

    # Store in both caches
    hash_cache.memory[cache_key] = content_hash
    cursor.execute("""
        INSERT OR REPLACE INTO hash_cache
        (file_path, mtime_ns, file_size, content_hash, cached_at)
        VALUES (?, ?, ?, ?, ?)
    """, (*cache_key, content_hash, datetime.now().isoformat()))

    return content_hash, False
```

### Cache Invalidation

**Automatic invalidation:**

- File modified (mtime changes) → New cache key → Automatic miss
- File resized → New cache key → Automatic miss
- File moved → Different path → Automatic miss

**Manual cleanup:**

```python
def cleanup_hash_cache():
    """Remove stale cache entries (files no longer exist)"""
    cursor.execute("SELECT DISTINCT file_path FROM hash_cache")
    paths = [row['file_path'] for row in cursor.fetchall()]

    removed = 0
    for path in paths:
        if not os.path.exists(path):
            cursor.execute("DELETE FROM hash_cache WHERE file_path = ?", (path,))
            removed += 1

    conn.commit()
    return removed
```

**When to cleanup:**

- During rebuild database (clean slate)
- Manual "Clean Cache" utility option
- After terraform (many files moved)

### Cache Size Management

**Memory cache:** Fixed size LRU (1000 entries)

- Typical hash: 64 bytes
- Cache key: ~200 bytes
- Total memory: ~260KB (negligible)

**Database cache:** Unbounded, manual cleanup

- Typical entry: ~300 bytes
- 10K files: ~3MB
- 100K files: ~30MB
- Acceptable overhead

**Future:** Add TTL-based expiration if needed

### Performance Impact

**Estimated speedup:**

- Import (with rehash): 25-30% faster
- Date edit (with rehash): 50-60% faster
- Update index: 80-90% faster (most files unchanged)
- Rebuild (first run): 0% (cache empty)
- Rebuild (repeat): 50-60% faster (cache populated)

**Trade-offs:**

- Additional DB table (minimal space)
- Slightly more complex code
- Memory overhead (260KB - negligible)
- Huge performance win

---

## Database Design

### Modified Tables

#### photos table - Add rating column

```sql
ALTER TABLE photos ADD COLUMN rating INTEGER DEFAULT NULL;

-- NULL = no rating/unfavorited
-- 5 = favorited
-- (Can support 1-5 scale later if needed)
```

**Migration:**

```python
# In migrate_db.py
def add_rating_column(cursor):
    """Add rating column if missing"""
    cursor.execute("PRAGMA table_info(photos)")
    columns = {row[1] for row in cursor.fetchall()}

    if 'rating' not in columns:
        print("Adding rating column...")
        cursor.execute("ALTER TABLE photos ADD COLUMN rating INTEGER DEFAULT NULL")
        cursor.execute("CREATE INDEX idx_rating ON photos(rating)")
```

### New Tables

#### 1. operation_state

```sql
CREATE TABLE IF NOT EXISTS operation_state (
    operation_id TEXT PRIMARY KEY,
    operation_type TEXT NOT NULL,  -- 'import', 'rebuild', 'terraform', 'update_index', 'date_edit'
    status TEXT NOT NULL,          -- 'pending', 'starting', 'in_progress', 'paused', 'complete', 'failed'
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    checkpoint_data TEXT,          -- JSON blob with progress details
    performance_metrics TEXT,      -- JSON blob with timing stats
    error_message TEXT             -- Set if status = 'failed'
);

CREATE INDEX idx_operation_status ON operation_state(status);
CREATE INDEX idx_operation_type ON operation_state(operation_type);
CREATE INDEX idx_operation_updated ON operation_state(updated_at);
```

#### 2. hash_cache

```sql
CREATE TABLE IF NOT EXISTS hash_cache (
    file_path TEXT NOT NULL,
    mtime_ns INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    cached_at TEXT NOT NULL,
    PRIMARY KEY (file_path, mtime_ns, file_size)
);

CREATE INDEX idx_hash_cache_path ON hash_cache(file_path);
CREATE INDEX idx_hash_cache_hash ON hash_cache(content_hash);
```

### Schema Migration

**Add to db_schema.py:**

```python
SCHEMA_VERSION = 2  # Increment from 1

# Updated photos table schema (with rating)
PHOTOS_TABLE_SCHEMA = """
    CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_filename TEXT NOT NULL,
        current_path TEXT NOT NULL UNIQUE,
        date_taken TEXT,
        content_hash TEXT NOT NULL UNIQUE,
        file_size INTEGER NOT NULL,
        file_type TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        rating INTEGER DEFAULT NULL
    )
"""

OPERATION_STATE_TABLE_SCHEMA = """..."""
HASH_CACHE_TABLE_SCHEMA = """..."""

# Updated indices
PHOTOS_INDICES = [
    "CREATE INDEX IF NOT EXISTS idx_content_hash ON photos(content_hash)",
    "CREATE INDEX IF NOT EXISTS idx_date_taken ON photos(date_taken)",
    "CREATE INDEX IF NOT EXISTS idx_file_type ON photos(file_type)",
    "CREATE INDEX IF NOT EXISTS idx_rating ON photos(rating)"
]

def create_database_schema(cursor):
    # Existing tables
    cursor.execute(PHOTOS_TABLE_SCHEMA)
    cursor.execute(DELETED_PHOTOS_TABLE_SCHEMA)

    # New tables (v2)
    cursor.execute(OPERATION_STATE_TABLE_SCHEMA)
    cursor.execute(HASH_CACHE_TABLE_SCHEMA)

    # Create all indices
    for index_sql in PHOTOS_INDICES:
        cursor.execute(index_sql)
```

**Add to migrate_db.py:**

```python
# Check if new tables exist
cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_state'")
if not cursor.fetchone():
    print("Adding operation_state table...")
    cursor.execute(OPERATION_STATE_TABLE_SCHEMA)

cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='hash_cache'")
if not cursor.fetchone():
    print("Adding hash_cache table...")
    cursor.execute(HASH_CACHE_TABLE_SCHEMA)
```

### SQLite Configuration

**Enable WAL mode for concurrency:**

```python
def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Enable Write-Ahead Logging (better concurrency)
    conn.execute("PRAGMA journal_mode=WAL")

    # Enable foreign keys (data integrity)
    conn.execute("PRAGMA foreign_keys=ON")

    return conn
```

**Benefits:**

- Readers don't block writers
- Writers don't block readers
- Better crash recovery
- Minimal overhead

**Trade-off:** Creates .db-wal and .db-shm files (expected)

---

## Photo Rating/Favorites System

### Design: Sparse Rating Storage

**Principle:** Only write EXIF Rating tag when explicitly set. Absence = unfavorited.

### Database Schema

```sql
-- Add to photos table
rating INTEGER DEFAULT NULL

-- NULL or 0 = unfavorited
-- 5 = favorited
-- 1-4 = future 5-star rating support
```

### EXIF Rating Tag

**Standard:** EXIF tag `Rating` (0-5 scale)

- Supported by: Lightroom, Photos.app, Bridge, etc.
- 0 = unrated/rejected
- 1-5 = star ratings
- Absent = no rating

**Our usage:**

- 5 = Favorited
- NULL/absent = Not favorited
- (Can expand to 1-5 star system later)

### Implementation

#### 1. Read Rating on Import/Rebuild

```python
def extract_exif_rating(file_path):
    """Extract EXIF Rating tag (0-5)"""
    try:
        result = subprocess.run(
            ['exiftool', '-Rating', '-n', '-s3', file_path],
            capture_output=True, text=True, timeout=5
        )

        rating_str = result.stdout.strip()
        if rating_str:
            rating = int(rating_str)
            return rating if 0 <= rating <= 5 else None
        return None

    except Exception as e:
        print(f"Warning: Could not read rating from {file_path}: {e}")
        return None
```

**During import/rebuild:**

```python
# Extract rating along with other EXIF data
rating = extract_exif_rating(source_path)

# Store in DB (NULL if not present)
cursor.execute("""
    INSERT INTO photos (..., rating)
    VALUES (..., ?)
""", (..., rating))
```

#### 2. Toggle Favorite

```python
@app.route('/api/photo/<int:photo_id>/favorite', methods=['POST'])
def toggle_favorite(photo_id):
    """Toggle favorite status (0 ↔ 5)"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        # Get current rating and file path
        cursor.execute("""
            SELECT rating, current_path
            FROM photos
            WHERE id = ?
        """, (photo_id,))
        row = cursor.fetchone()

        if not row:
            return jsonify({'error': 'Photo not found'}), 404

        current_rating = row['rating']
        file_path = os.path.join(LIBRARY_PATH, row['current_path'])

        # Toggle: if 5 → NULL, else → 5
        new_rating = None if current_rating == 5 else 5

        # Update EXIF
        if new_rating == 5:
            # Write Rating: 5 to EXIF
            result = subprocess.run(
                ['exiftool', '-Rating=5', '-overwrite_original', '-P', file_path],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                return jsonify({'error': 'Failed to write EXIF'}), 500
        else:
            # Remove Rating tag from EXIF
            result = subprocess.run(
                ['exiftool', '-Rating=', '-overwrite_original', '-P', file_path],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                return jsonify({'error': 'Failed to remove EXIF'}), 500

        # Update DB
        cursor.execute("""
            UPDATE photos
            SET rating = ?
            WHERE id = ?
        """, (new_rating, photo_id))
        conn.commit()
        conn.close()

        return jsonify({
            'success': True,
            'photo_id': photo_id,
            'rating': new_rating,
            'is_favorite': new_rating == 5
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500
```

#### 3. Get Favorites

```python
@app.route('/api/photos/favorites')
def get_favorites():
    """Get all favorited photos"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT * FROM photos
            WHERE rating = 5
            ORDER BY date_taken DESC
        """)

        favorites = [dict(row) for row in cursor.fetchall()]
        conn.close()

        return jsonify({
            'favorites': favorites,
            'count': len(favorites)
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500
```

#### 4. Bulk Operations

```python
@app.route('/api/photos/bulk-favorite', methods=['POST'])
def bulk_favorite():
    """Favorite multiple photos at once"""
    data = request.json
    photo_ids = data.get('photo_ids', [])
    favorite = data.get('favorite', True)  # True = favorite, False = unfavorite

    new_rating = 5 if favorite else None

    conn = get_db_connection()
    cursor = conn.cursor()

    for photo_id in photo_ids:
        cursor.execute("""
            SELECT current_path FROM photos WHERE id = ?
        """, (photo_id,))
        row = cursor.fetchone()

        if row:
            file_path = os.path.join(LIBRARY_PATH, row['current_path'])

            # Write/remove EXIF
            if favorite:
                subprocess.run(['exiftool', '-Rating=5', '-overwrite_original', '-P', file_path])
            else:
                subprocess.run(['exiftool', '-Rating=', '-overwrite_original', '-P', file_path])

            # Update DB
            cursor.execute("UPDATE photos SET rating = ? WHERE id = ?", (new_rating, photo_id))

    conn.commit()
    conn.close()

    return jsonify({'success': True, 'updated': len(photo_ids)})
```

### Frontend Integration

**Add favorite button to photo grid:**

```javascript
// In photo card/grid item
<div class='photo-favorite' onclick='toggleFavorite(photoId)'>
  <span class='material-symbols-outlined'>
    ${photo.rating === 5 ? 'star' : 'star_outline'}
  </span>
</div>;

async function toggleFavorite(photoId) {
  const response = await fetch(`/api/photo/${photoId}/favorite`, {
    method: 'POST',
  });
  const result = await response.json();

  if (result.success) {
    // Update UI
    updatePhotoFavoriteUI(photoId, result.is_favorite);
  }
}
```

**Add favorites filter:**

```javascript
// In utilities menu or filter bar
<button onclick='showFavorites()'>
  <span class='material-symbols-outlined'>star</span>
  Show Favorites
</button>;

async function showFavorites() {
  const response = await fetch('/api/photos/favorites');
  const data = await response.json();

  renderPhotos(data.favorites);
  showToast(`Showing ${data.count} favorites`);
}
```

### Why This Design?

**✅ Efficient:**

- No need to write 0 to all photos
- Only touch files when favoriting/unfavoriting
- Instant operation

**✅ Standard:**

- Uses EXIF Rating tag (interoperable)
- Sparse storage (only write when set)
- Same approach as Lightroom, Photos.app

**✅ Scalable:**

- Can expand to 1-5 star system later
- Can add more metadata (labels, colors) same way
- Database queries are fast (indexed)

**✅ Safe:**

- EXIF writes use same safety as date edits
- No rehashing needed (Rating is metadata, not content)
- Rollback possible (just toggle again)

### Future Enhancements

**1. Star ratings (1-5 scale):**

```python
# Replace toggle with set_rating(photo_id, rating)
# rating: 0-5 (0 = unrated)
```

**2. Filter by rating:**

```python
# Show only 4+ star photos
SELECT * FROM photos WHERE rating >= 4
```

**3. Keyboard shortcuts:**

```javascript
// 0-5 keys to rate selected photo
// S key to toggle favorite
```

**4. Color labels:**

```sql
-- Add to photos table
label_color TEXT  -- 'red', 'green', 'blue', etc.

-- EXIF: Use Label tag
exiftool -Label="Red" photo.jpg
```

---

## Error Handling

### Error Categories

**1. Pre-flight Errors** (Block operation start)

- Missing tools (exiftool, ffmpeg)
- Insufficient disk space
- No write permissions
- Library not accessible

**2. Recoverable Errors** (Continue operation, track failure)

- Single file corrupted
- EXIF write timeout
- Hash collision
- Unsupported format

**3. Unrecoverable Errors** (Stop operation, rollback)

- Database corruption
- Disk full during operation
- Library volume disappeared
- Too many file failures (>10%)

### Error Handling Strategy

```python
class OperationError(Exception):
    """Base class for operation errors"""
    pass

class PreflightError(OperationError):
    """Error during pre-flight checks - don't start operation"""
    pass

class RecoverableError(OperationError):
    """Error processing single file - log and continue"""
    def __init__(self, file_path, reason, category):
        self.file_path = file_path
        self.reason = reason
        self.category = category  # 'corrupted', 'timeout', 'unsupported', etc.

class UnrecoverableError(OperationError):
    """Critical error - must stop operation"""
    def __init__(self, reason, can_resume=False):
        self.reason = reason
        self.can_resume = can_resume
```

### Error Recovery Pattern

```python
def process_files(files, operation_context):
    """Process files with comprehensive error handling"""

    # Pre-flight checks
    try:
        check_prerequisites()
    except PreflightError as e:
        return {'error': str(e), 'can_start': False}

    # Begin operation
    operation_context.set_status('in_progress')

    for idx, file_path in enumerate(files):
        try:
            # Process single file
            result = process_single_file(file_path, operation_context)
            operation_context.record_success(file_path, result)

        except RecoverableError as e:
            # Log failure, continue
            operation_context.record_failure(
                file_path=e.file_path,
                reason=e.reason,
                category=e.category
            )
            continue

        except UnrecoverableError as e:
            # Stop immediately, save checkpoint
            operation_context.set_status('failed')
            operation_context.save_checkpoint()

            if e.can_resume:
                return {'error': str(e), 'can_resume': True}
            else:
                # Attempt rollback
                operation_context.rollback()
                return {'error': str(e), 'can_resume': False}

        # Checkpoint every N files
        if (idx + 1) % CHECKPOINT_INTERVAL == 0:
            operation_context.save_checkpoint()

    # All done
    operation_context.set_status('complete')
    return {'success': True, 'stats': operation_context.get_stats()}
```

---

## Implementation Plan

### Phase 0: Foundation (2-3 hours)

**Goal:** Set up database schema and migration

**Tasks:**

1. Add `operation_state` table to db_schema.py
2. Add `hash_cache` table to db_schema.py
3. Update migrate_db.py to add new tables
4. Test migration on existing database
5. Enable WAL mode in get_db_connection()

**Deliverable:** New tables available in all databases

---

### Phase 1: Hash Cache (4-6 hours)

**Goal:** Implement and integrate hash caching

**Tasks:**

1. Create `hash_cache.py` module:
   - `HashCache` class (in-memory LRU)
   - `compute_hash_cached()` function
   - Cache cleanup utilities

2. Integrate into operations:
   - Update `compute_hash()` in app.py to use cache
   - Update import operation
   - Update date edit operation
   - Update library_sync.py (update index, rebuild)

3. Test and measure:
   - Verify cache hits/misses logged
   - Measure speedup on update index
   - Test cache invalidation

**Deliverable:** All operations use cached hashing, 50-90% speedup

---

### Phase 2: Operation State Tracking (3-4 hours)

**Goal:** Basic checkpoint system without resume

**Tasks:**

1. Create `operation_manager.py`:
   - `OperationContext` class
   - Create/update operation records
   - Save checkpoints

2. Integrate into one operation (rebuild database):
   - Create operation_id at start
   - Save checkpoint every 100 files
   - Update status on completion/failure

3. Test checkpoint persistence:
   - Verify checkpoints saved to DB
   - Verify checkpoint data correct

**Deliverable:** Rebuild database saves checkpoints (no resume yet)

---

### Phase 3: Resume Capability (4-6 hours)

**Goal:** Enable resume from checkpoint

**Tasks:**

1. Add resume detection:
   - `detect_incomplete_operations()`
   - Frontend UI to show incomplete operations
   - User choice: Resume or Start Over

2. Implement resume logic:
   - Load checkpoint data
   - Skip already-processed files
   - Continue from last position

3. Two-phase rebuild:
   - Build temp database alongside old one
   - Only swap on success
   - Rollback on failure

4. Test resume scenarios:
   - Simulate crash mid-operation
   - Verify resume works
   - Test "start over" path

**Deliverable:** Rebuild database fully resumable

---

### Phase 4: Extend to All Operations (3-4 hours)

**Goal:** Add resume to other long operations

**Tasks:**

1. Add checkpointing to:
   - Update index (library_sync.py)
   - Terraform
   - Bulk date edit (if many files)

2. Test each operation:
   - Interrupt mid-way
   - Resume successfully
   - Verify data integrity

**Deliverable:** All long operations resumable

---

### Phase 5: Batch Operations (3-4 hours)

**Goal:** Reduce subprocess overhead

**Tasks:**

1. Implement batch EXIF extraction:
   - `extract_exif_batch()` in file_operations.py
   - Single exiftool call for 10-50 files
   - Parse JSON output

2. Integrate into operations:
   - Update library_sync.py to use batch
   - Update rebuild to use batch

3. Combine EXIF + dimensions:
   - Single exiftool call for both
   - Reduce subprocess overhead

4. Test and measure:
   - Verify correctness
   - Measure 20-30% speedup

**Deliverable:** Batch processing reduces subprocess overhead

---

### Phase 6: Quick Wins (2-3 hours)

**Goal:** Low-hanging fruit optimizations

**Tasks:**

1. Skip rehash if EXIF write failed
2. Skip dimensions if already in DB
3. Defer empty folder cleanup to end
4. Add performance metrics logging

**Deliverable:** Additional 10-20% speedup

---

### Phase 7: Testing & Polish (4-6 hours)

**Goal:** Production-ready reliability

**Tasks:**

1. Test on NAS storage:
   - Measure actual speedups
   - Verify resume works over network disconnect
   - Test with large libraries (10K+ files)

2. Error scenario testing:
   - Disk full during operation
   - Library volume disappears
   - Database corruption
   - Permission errors

3. UI polish:
   - Better progress indicators
   - Clearer error messages
   - Resume confirmation dialog
   - Performance stats display

4. Documentation:
   - Update README
   - Document new architecture
   - Add troubleshooting guide

**Deliverable:** Production-ready infrastructure

---

## Total Implementation Effort

**Estimated time:** 25-36 hours

**Breakdown:**

- Phase 0: 2-3 hours (foundation)
- Phase 1: 4-6 hours (hash cache)
- Phase 2: 3-4 hours (checkpointing)
- Phase 3: 4-6 hours (resume)
- Phase 4: 3-4 hours (extend to all ops)
- Phase 5: 3-4 hours (batch operations)
- Phase 6: 2-3 hours (quick wins)
- Phase 7: 4-6 hours (testing & polish)

**Can be split across multiple sessions**

---

## Testing Strategy

### Unit Tests

```python
# test_hash_cache.py
def test_cache_hit():
    cache = HashCache()
    file_path = "/test/file.jpg"
    # First call - miss
    hash1, hit1 = compute_hash_cached(file_path, cache)
    assert hit1 == False
    # Second call - hit
    hash2, hit2 = compute_hash_cached(file_path, cache)
    assert hit2 == True
    assert hash1 == hash2

def test_cache_invalidation():
    cache = HashCache()
    file_path = "/test/file.jpg"
    hash1, _ = compute_hash_cached(file_path, cache)
    # Modify file
    with open(file_path, 'a') as f:
        f.write('modified')
    # Should miss (mtime changed)
    hash2, hit = compute_hash_cached(file_path, cache)
    assert hit == False
    assert hash1 != hash2
```

### Integration Tests

```python
# test_resume.py
def test_rebuild_resume_after_crash():
    # Start rebuild with 1000 files
    op_id = start_rebuild_database()
    # Process 500 files
    wait_for_checkpoint(op_id, processed=500)
    # Simulate crash
    kill_process()
    # Restart app
    restart_app()
    # Detect incomplete operation
    incomplete = detect_incomplete_operations()
    assert len(incomplete) == 1
    # Resume operation
    resume_operation(op_id)
    # Wait for completion
    wait_for_complete(op_id)
    # Verify all 1000 files processed
    assert get_file_count() == 1000
```

### Performance Tests

```python
# test_performance.py
def test_hash_cache_speedup():
    # Rebuild without cache
    start = time.time()
    rebuild_database(use_cache=False)
    time_no_cache = time.time() - start

    # Rebuild with cache (all hits)
    start = time.time()
    rebuild_database(use_cache=True)
    time_with_cache = time.time() - start

    speedup = time_no_cache / time_with_cache
    assert speedup >= 1.5, f"Expected 50%+ speedup, got {speedup}x"
```

### Stress Tests

```python
# test_stress.py
def test_large_library():
    # Test with 50,000 files
    create_test_library(file_count=50000)

    # Rebuild should complete
    result = rebuild_database()
    assert result['success'] == True

    # Should have checkpoints
    checkpoints = get_checkpoints(result['operation_id'])
    assert len(checkpoints) >= 500  # At least 500 checkpoints

def test_nas_disconnect():
    # Test resume after network disconnect
    op_id = start_rebuild_database_on_nas()
    wait_for_checkpoint(op_id, processed=1000)
    # Simulate network disconnect
    disconnect_nas()
    wait(seconds=30)
    # Reconnect
    reconnect_nas()
    # Resume should work
    resume_operation(op_id)
    result = wait_for_complete(op_id)
    assert result['success'] == True
```

---

## Open Questions & Decisions

### Q1: Parallelization Strategy?

**Question:** Should we parallelize file processing (thread pool)?

**Considerations:**

- **Pro:** 2-3x faster on local SSD (utilize multiple cores)
- **Con:** May hurt NAS performance (saturate network)
- **Con:** More complex error handling
- **Con:** SQLite thread safety issues

**Decision:** **NO parallelization in Phase 1**

- Keep it simple and reliable
- Measure actual bottlenecks first
- Can add in future phase if needed
- Hash cache + batch EXIF likely sufficient

### Q2: Checkpoint Interval?

**Question:** How often to checkpoint?

**Options:**

- Every 10 files - Very safe, high overhead
- Every 100 files - Balanced (RECOMMENDED)
- Every 1000 files - Low overhead, lose more progress on crash

**Decision:** **100 files, adaptive**

```python
if total_files > 10000:
    interval = 500
elif total_files < 100:
    interval = 10
else:
    interval = 100
```

### Q3: Hash Algorithm?

**Question:** Is SHA-256 necessary? Could use faster hash?

**Considerations:**

- SHA-256: Cryptographic strength, slow
- xxHash: 5x faster, non-cryptographic
- BLAKE3: 3x faster than SHA-256, cryptographic

**Current:** SHA-256 truncated to 7 chars (collision risk!)

**Decision:** **Keep SHA-256 for now, but DON'T TRUNCATE**

- Use full 64-char hash
- Update DB schema: `content_hash TEXT(64)`
- Migrate existing DBs to full hash
- Future: Consider BLAKE3 if performance critical

### Q4: Batch Size for EXIF?

**Question:** How many files per batch for exiftool?

**Considerations:**

- Small batch (10 files): Less memory, faster error detection
- Large batch (100 files): Better amortization, more memory

**Decision:** **Adaptive batching**

```python
if on_nas():
    batch_size = 10  # Network latency dominates
else:
    batch_size = 50  # Local I/O can handle larger batches
```

### Q5: Cache Cleanup Policy?

**Question:** When to clean hash cache?

**Options:**

- A) Never - Let it grow indefinitely
- B) TTL-based (7 days)
- C) Size-based (max 100K entries)
- D) Manual only (user triggers)

**Decision:** **Manual cleanup only (Option D)**

- Cache growth is slow (~300 bytes per file)
- 100K files = 30MB (acceptable)
- User can clean via "Clean Cache" utility
- Auto-clean during rebuild database

---

## Success Metrics

### Performance Targets

**Hash cache hit rate:**

- Update index: >80% cache hit
- Rebuild (repeat): >50% cache hit
- Date edit: >40% cache hit

**Operation speedup:**

- Update index: 80-90% faster
- Rebuild (repeat): 50-60% faster
- Date edit: 50-60% faster
- Import: 20-30% faster

**Resume reliability:**

- Resume success rate: >99%
- Data integrity: 100% (no data loss)
- Checkpoint overhead: <5% slowdown

### Reliability Targets

**Error handling:**

- All pre-flight errors caught: 100%
- Recoverable errors handled: 100%
- Unrecoverable errors with rollback: 100%

**Data integrity:**

- Zero data loss on crash: 100%
- Zero database corruption: 100%
- All operations atomic: 100%

---

## Risks & Mitigations

### Risk 1: Hash Cache Grows Too Large

**Probability:** Low  
**Impact:** Low

**Mitigation:**

- Monitor cache size in testing
- Add size-based cleanup if needed
- Document cache maintenance

### Risk 2: Checkpoint Overhead Slows Operations

**Probability:** Medium  
**Impact:** Low

**Mitigation:**

- Use adaptive checkpoint intervals
- Optimize checkpoint size (last 1000 hashes only)
- Measure overhead, adjust if >5%

### Risk 3: Resume Logic Has Bugs

**Probability:** Medium  
**Impact:** High

**Mitigation:**

- Comprehensive testing of resume scenarios
- Extensive logging for debugging
- Fallback: "Start over" always available
- Beta testing with real users

### Risk 4: WAL Mode Causes Issues

**Probability:** Low  
**Impact:** Medium

**Mitigation:**

- WAL is well-tested SQLite feature
- Document .db-wal and .db-shm files (normal)
- Provide disable WAL option if needed

### Risk 5: Batch EXIF Parsing Fails

**Probability:** Low  
**Impact:** Low

**Mitigation:**

- Comprehensive error handling
- Fallback to single-file mode on batch failure
- Test with many file types

---

## Conclusion

This architecture provides:

✅ **Resumability** - Never lose progress on crash/interrupt  
✅ **Performance** - 50-90% speedup via caching and batching  
✅ **Reliability** - Comprehensive error handling and rollback  
✅ **Maintainability** - Shared code, clear abstractions  
✅ **Safety** - Data integrity preserved at all times

**Confidence: 95%** - Ready to implement

**Next step:** Begin Phase 0 (foundation)

---

**Document Version:** 1.0  
**Last Updated:** January 29, 2026  
**Author:** AI Architecture Team  
**Status:** ✅ APPROVED FOR IMPLEMENTATION
