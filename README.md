# Photos Light

A fast, minimal photo viewer and manager for large personal photo libraries.

## Features

- 📸 **Grid View** - Browse photos chronologically
- 🔍 **Lightbox** - Full-screen photo viewing
- 📅 **Date Editor** - Fix incorrect photo dates
- 📥 **Import** - Drag-and-drop with duplicate detection
- 🗑️ **Trash** - Safe deletion with recovery
- ⚡ **Fast** - Lazy thumbnail loading, optimized for 60k+ photos

## Quick Start

1. **Install dependencies:**
   ```bash
   pip3 install -r requirements.txt
   ```

2. **Set database path:**
   ```bash
   export PHOTO_DB_PATH=/path/to/your/photo_library.db
   ```

3. **Run the app:**
   ```bash
   python3 app.py
   ```

4. Open http://localhost:5000

## Documentation

- [Lazy Thumbnail Architecture](docs/LAZY_THUMBNAIL_ARCHITECTURE.md)
- [Import Optimization](docs/IMPORT_OPTIMIZATION.md)
- [Logging Setup](docs/LOGGING_SETUP.md)

## Tech Stack

- **Backend:** Python Flask
- **Frontend:** Vanilla JavaScript
- **Database:** SQLite
- **Storage:** File system with hash-based deduplication

Built for a 65k photo library, works with any size.
