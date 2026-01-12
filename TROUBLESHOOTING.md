# Troubleshooting Guide

## Quick Diagnostics

Run this to check your setup:

```bash
# Check database
echo "Database: $PHOTO_DB_PATH"
ls -lh "$PHOTO_DB_PATH"
sqlite3 "$PHOTO_DB_PATH" "SELECT COUNT(*) as photos FROM photos;"

# Check library
echo "Library: $PHOTO_LIBRARY_PATH"
ls -la "$PHOTO_LIBRARY_PATH" | head -10

# Check Python dependencies
python3 -c "import flask, PIL, pillow_heif; print('✅ All dependencies installed')"
```

## Common Problems

### 1. Thumbnails show as broken images (404)

**Symptoms:** Grid loads, but images show broken/gray boxes

**Check browser console (F12):**
```
GET http://localhost:5001/api/photo/66345/thumbnail 404 (NOT FOUND)
```

**Root causes:**

**a) Wrong PHOTO_LIBRARY_PATH**
```bash
# Check what path the app is using
grep PHOTO_LIBRARY_PATH run.sh

# Check if that path exists
ls "$PHOTO_LIBRARY_PATH"
```

**b) Database paths don't match real files**
```bash
# See what paths are in database
sqlite3 "$PHOTO_DB_PATH" "SELECT current_path FROM photos LIMIT 5;"

# Check if those files exist
ls "$PHOTO_LIBRARY_PATH/2025/2025-05-01/"
```

**c) Permissions issue**
```bash
# Check if .thumbnails directory is writable
touch "$PHOTO_LIBRARY_PATH/.thumbnails/test.txt"
rm "$PHOTO_LIBRARY_PATH/.thumbnails/test.txt"
```

**Fix:** Update `PHOTO_LIBRARY_PATH` in `run.sh` to point to correct location

---

### 2. Empty grid, no photos showing

**Symptoms:** App loads but grid is completely empty

**Check how many photos are in database:**
```bash
sqlite3 "$PHOTO_DB_PATH" "SELECT COUNT(*) FROM photos;"
```

**If 0 photos:** Database is empty, import some photos first

**If >0 photos:** Check browser console for errors

**Common error:**
```
Failed to load photos: Database not found
```

**Fix:** Set `PHOTO_DB_PATH` correctly in `run.sh`

---

### 3. App won't start - "Database not found"

**Symptoms:**
```
❌ ERROR: Database not found at: /some/path/photo_library.db
```

**Fix:** Edit `run.sh` and set `PHOTO_DB_PATH` to where your database actually is

**Find your database:**
```bash
find ~/Desktop -name "*.db" -type f 2>/dev/null | grep photo
```

---

### 4. App won't start - "Library not found"

**Symptoms:**
```
❌ ERROR: Library not found at: /Volumes/eric_files/photo_library_test
```

**Causes:**
- External drive not mounted
- Path typed incorrectly
- Using test library path when you meant production

**Fix:**
```bash
# Check what volumes are mounted
ls /Volumes/

# Update run.sh with correct path
nano run.sh  # or vim, code, etc.
```

---

### 5. Import fails / upload doesn't work

**Check logs:**
```bash
tail -f "$PHOTO_LIBRARY_PATH/.logs/import_$(date +%Y%m%d).log"
```

**Common issues:**
- Disk full
- `.import_temp/` not writable
- Corrupted upload

**Fix:**
```bash
# Check disk space
df -h "$PHOTO_LIBRARY_PATH"

# Check permissions
ls -la "$PHOTO_LIBRARY_PATH/.import_temp"
```

---

### 6. Missing Python dependencies

**Symptoms:**
```
ModuleNotFoundError: No module named 'flask'
```

**Fix:**
```bash
pip3 install -r requirements.txt
```

**If that doesn't work:**
```bash
# Use full paths
/usr/local/bin/pip3 install -r requirements.txt
/usr/local/bin/python3 app.py
```

---

### 7. Wrong port / port already in use

**Symptoms:**
```
OSError: [Errno 48] Address already in use
```

**Find what's using port 5000:**
```bash
lsof -i :5000
```

**Fix - kill the process:**
```bash
kill -9 <PID>
```

**Or change port in app.py (last line):**
```python
app.run(debug=True, host='0.0.0.0', port=5001)
```

---

## Debug Checklist for AI Agents

When user says "app isn't working":

1. ✅ Check environment variables are set
   ```bash
   echo $PHOTO_DB_PATH
   echo $PHOTO_LIBRARY_PATH
   ```

2. ✅ Check database file exists
   ```bash
   ls -lh "$PHOTO_DB_PATH"
   ```

3. ✅ Check database has photos
   ```bash
   sqlite3 "$PHOTO_DB_PATH" "SELECT COUNT(*) FROM photos;"
   ```

4. ✅ Check library directory exists
   ```bash
   ls "$PHOTO_LIBRARY_PATH" | head
   ```

5. ✅ Check browser console (ask user to open DevTools)
   - F12 → Console tab
   - Look for red errors

6. ✅ Check Flask logs
   - Terminal output where `python3 app.py` is running
   - Look for Python tracebacks

7. ✅ Check application logs
   ```bash
   tail -50 "$PHOTO_LIBRARY_PATH/.logs/app.log"
   ```

8. ✅ Verify file paths match
   ```bash
   # Get a sample path from DB
   sqlite3 "$PHOTO_DB_PATH" "SELECT current_path FROM photos LIMIT 1;"
   
   # Check if file exists (replace with actual path from above)
   ls "$PHOTO_LIBRARY_PATH/2025/2025-05-01/img_xyz.jpg"
   ```

---

## Still stuck?

1. Check `SETUP.md` for architecture details
2. Read logs in `$PHOTO_LIBRARY_PATH/.logs/`
3. Check browser DevTools console (F12)
4. Verify all paths in `run.sh` are correct
