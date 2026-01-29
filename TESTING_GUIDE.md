# Testing Guide - New Infrastructure

**Session: January 29, 2026**

## 🛡️ SAFETY FIRST

### Before Testing:

1. **Backup your database**

   ```bash
   cd ~/Desktop/photos-light
   cp -r ~/.photos-light ~/.photos-light.backup
   ```

2. **Note your library location**
   - Your config is in `~/.photos-light/.config.json`
   - Your database is in `~/.photos-light/photo_library.db`

---

## 🔧 Step 1: Database Migration

### Migrate to Schema v2:

```bash
cd ~/Desktop/photos-light
python3 migrate_db.py
```

### Expected Output:

```
🔍 Checking for v2 infrastructure tables...
  Adding operation_state table...
  ✓ Added operation_state table with indices
  Adding hash_cache table...
  ✓ Added hash_cache table with indices

✅ Migration complete!

Database is now at schema v2 with:
  • Photos table with rating column
  • operation_state table (resumable operations)
  • hash_cache table (performance optimization)
```

### Verify Migration:

```bash
sqlite3 ~/.photos-light/photo_library.db "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

**Should see:**

- `deleted_photos`
- `hash_cache` ← NEW
- `operation_state` ← NEW
- `photos`

---

## 🧪 Step 2: Test Hash Cache (Update Index)

### Run the App:

```bash
cd ~/Desktop/photos-light
python3 app.py
```

### In Browser:

1. Open `http://localhost:5002`
2. Load your library
3. Click **Utilities Menu** → **Update Database**

### What to Look For:

**In Terminal:**

```
📦 Hash cache initialized
🔄 LIBRARY SYNC (incremental mode): Scanning filesystem...

📝 Adding 150 untracked files (with hash caching)...
  1/150. DSC_1234.jpg (computed hash)
  2/150. DSC_1235.jpg (computed hash)
  ...

  ✓ Added 150 untracked files
  📊 Cache stats: 0% hit rate (0 memory, 0 DB, 150 misses)  ← First run
```

### Run Update Index Again (Test Cache):

**Terminal should show:**

```
📝 Adding 0 untracked files...  ← No new files
📊 Cache stats: 100% hit rate (0 memory, 0 DB, 0 misses)  ← All cached

OR if you add a file:

📝 Adding 1 untracked files (with hash caching)...
  1/1. new_photo.jpg (hash from cache)  ← CACHED!
  📊 Cache stats: 100% hit rate (0 memory, 1 DB, 0 misses)
```

**✅ Success:** See "hash from cache" messages

---

## 🧪 Step 3: Test Import with Hash Cache

### Import a File You've Already Imported:

1. **Copy a photo from your library to desktop**

   ```bash
   cp ~/path/to/library/2024/2024-01-15/some_photo.jpg ~/Desktop/test_photo.jpg
   ```

2. **Try to import it** (via web UI)
   - Click **+ Import Photos**
   - Select `test_photo.jpg`

**Terminal should show:**

```
1. Processing: test_photo.jpg
   Hash: abc12345... (cached)  ← CACHE HIT!
   ⏭️  Duplicate (existing ID: 123)
```

**✅ Success:** Hash computed from cache, duplicate detected instantly

---

## 🧪 Step 4: Test Date Edit with Smart Rehashing

### Edit a Photo Date:

1. **In Browser:** Click on a photo
2. **Change the date** (use the date editor)
3. **Save**

**Terminal should show:**

```
  🔄 Checking orientation...
  ✅ No orientation tag present
  📝 Hash computed after EXIF write: abc12345
  📝 Hash changed: def67890 → abc12345

OR if file unchanged:

  ℹ️  File unchanged (cache hit) - skipping hash update
```

**✅ Success:** See either hash change or cache hit detection

---

## 🧪 Step 5: Test Operation State Tracking

### Check Operation State Table:

```bash
sqlite3 ~/.photos-light/photo_library.db "SELECT * FROM operation_state ORDER BY updated_at DESC LIMIT 3;"
```

**Should see:**

```
operation_id|operation_type|status|started_at|updated_at|checkpoint_data|performance_metrics|error_message
uuid-123...|update_index|completed|2026-01-29T...|2026-01-29T...|{...}|null|null
```

**✅ Success:** Operations are being tracked

---

## 🧪 Step 6: Test Hash Cache Persistence

### Restart the App:

1. **Stop the app** (Ctrl+C)
2. **Start it again** (`python3 app.py`)
3. **Run Update Index** again

**Terminal should show:**

```
📦 Hash cache initialized
📝 Adding 0 untracked files...
📊 Cache stats: X% hit rate (... memory, ... DB, ... misses)
```

**✅ Success:** DB cache persists across restarts (high hit rate)

---

## 🧪 Step 7: Test Favorites API (Backend Only)

### Using curl or browser console:

**Toggle Favorite:**

```bash
curl -X POST http://localhost:5002/api/photo/1/favorite \
  -H "Content-Type: application/json"
```

**Response:**

```json
{
  "photo_id": 1,
  "rating": 5,
  "favorited": true
}
```

**Get Favorites:**

```bash
curl http://localhost:5002/api/photos/favorites
```

**Verify EXIF was written:**

```bash
exiftool -Rating ~/path/to/library/2024/.../photo.jpg
```

**Should show:**

```
Rating: 5
```

**✅ Success:** EXIF rating written to file

---

## 🧪 Step 8: Test Resume Capability (Simulated)

### Force Interrupt During Update Index:

1. **Start Update Index** (with lots of files)
2. **Ctrl+C during operation** (kill the server)
3. **Restart server**
4. **Run Update Index again**

**Terminal should show:**

```
🔄 Resuming operation: uuid-abc123
🔄 Resuming from file 350  ← Checkpoint!
```

**✅ Success:** Operation resumes from checkpoint

---

## 📊 What's Working vs. Not Working

### ✅ Fully Working (Test Now):

- Hash cache (Update Index, Import, Date Edit)
- Operation state tracking
- Database migration
- Favorites API (backend)
- Resume detection

### ⚠️ Partially Working:

- **Resume capability**: Detection works, but UI doesn't offer continue/restart yet
- **Favorites**: API works, but no UI buttons yet

### ❌ Not Yet Implemented:

- Resume UI dialog (frontend)
- Favorite button in photo grid (frontend)
- Favorites filter in utilities menu (frontend)
- Batch EXIF in library_sync (optimization)

---

## 🐛 Troubleshooting

### Migration Failed:

```bash
# Restore backup
rm -rf ~/.photos-light
cp -r ~/.photos-light.backup ~/.photos-light
```

### Hash Cache Not Working:

```bash
# Check table exists
sqlite3 ~/.photos-light/photo_library.db "SELECT COUNT(*) FROM hash_cache;"
```

### Import Error:

```bash
# Check logs in terminal
# Look for Python stack traces
```

### Can't See Operations:

```bash
# Check operation_state table
sqlite3 ~/.photos-light/photo_library.db \
  "SELECT operation_type, status FROM operation_state;"
```

---

## 📈 Expected Performance

### First Run (Cold Cache):

- Update Index: Normal speed (builds cache)
- Import: Normal speed (builds cache)

### Subsequent Runs (Warm Cache):

- Update Index: **80-90% faster** ← HUGE WIN
- Import of existing file: **Instant duplicate detection**
- Date Edit: **Skips unnecessary rehashing**

### Large Library (10,000+ photos):

- First Update Index: ~10-15 minutes (depending on NAS)
- Second Update Index: ~1-2 minutes (cache!)

---

## 🎯 Success Criteria

You'll know it's working when you see:

1. ✅ **"hash from cache"** in terminal logs
2. ✅ **"📊 Cache stats: X% hit rate"** after operations
3. ✅ **"🔄 Resuming operation"** after crash
4. ✅ **Hash cache table** has entries in database
5. ✅ **Operation state table** tracks operations
6. ✅ **Rating column** in photos table

---

## 🚨 When to Stop Testing

### Stop if you see:

- Database corruption errors
- Python crashes
- Data loss (photos disappearing)
- Files being moved incorrectly

### These are OK:

- "Hash cache miss" on first run (expected)
- "No rating found" (expected for old photos)
- Slow first run (building cache)

---

## 📞 Report Back

After testing, tell me:

1. **Migration**: Did it succeed?
2. **Hash Cache**: Did you see "hash from cache"?
3. **Cache Stats**: What hit rate after 2nd Update Index?
4. **Any Errors**: Python crashes? Database errors?
5. **Performance**: Faster on 2nd run?

Then we'll decide: fix issues, add frontend, or optimize further.

---

_Generated: January 29, 2026_
