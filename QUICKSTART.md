# Quick Start (30 seconds)

## First Time Setup

```bash
cd ~/Desktop/photos-light
pip3 install -r requirements.txt
./run.sh
```

Open: http://localhost:5001

**That's it!**

---

## If it doesn't work

1. **Check paths in `run.sh`** - Edit lines 4-5 if your files are elsewhere
2. **Check database exists** - Should be at path shown in error message
3. **Check library mounted** - `/Volumes/eric_files/photo_library_test` should exist
4. See [SETUP.md](SETUP.md) for detailed troubleshooting

---

## Current Configuration

- **Database:** `/Users/erichenry/Desktop/photo-migration-and-script/migration/databases/photo_library_test.db`
- **Library:** `/Volumes/eric_files/photo_library_test`
- **Test Library:** 154 photos, IDs 6612-66412
- **Server:** http://localhost:5001
