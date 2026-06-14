# Photos Light

> **👋 Welcome! If you're a fresh AI agent with zero context:**  
> 1. This is a photo viewer desktop app (Electron + Flask + vanilla JS)  
> 2. Run the Quick Start commands below to start it
> 3. If it breaks, read [TROUBLESHOOTING.md](archive/TROUBLESHOOTING.md)  
> 4. To understand how it works, read [SETUP.md](archive/SETUP.md)

A fast, minimal photo viewer and manager for large personal photo libraries.

## Features

- 📸 **Grid View** - Browse photos chronologically
- 🔍 **Lightbox** - Full-screen photo viewing
- 📅 **Date Editor** - Fix incorrect photo dates
- 📥 **Import** - Drag-and-drop with duplicate detection
- 🗑️ **Trash** - Safe deletion with recovery
- ⚡ **Fast** - Lazy thumbnail loading, optimized for 60k+ photos

## Quick Start (30 seconds)

```bash
cd ~/Desktop/photos-light
pip3 install -r requirements.txt
cd electron
npm install   # first time only
npm start
```

The Electron shell opens automatically at http://localhost:5001

**That's it!** See [QUICKSTART.md](QUICKSTART.md) if you need help.

## Documentation

**Getting Started:**
- [QUICKSTART.md](QUICKSTART.md) - Get running in 30 seconds
- [SETUP.md](archive/SETUP.md) - Detailed setup and configuration
- [TROUBLESHOOTING.md](archive/TROUBLESHOOTING.md) - Fix common issues

**Technical Docs:**
- [Lazy Thumbnail Architecture](docs/LAZY_THUMBNAIL_ARCHITECTURE.md)
- [Import Optimization](docs/IMPORT_OPTIMIZATION.md)
- [Logging Setup](docs/LOGGING_SETUP.md)

## Tech Stack

- **Backend:** Python Flask
- **Frontend:** Vanilla JavaScript
- **Database:** SQLite
- **Storage:** File system with hash-based deduplication

Built for a 65k photo library, works with any size.

## Configuration

Open or create a library from the welcome screen (**Open library** or **Add photos**). Each library is a folder with a SQLite database and photo files on disk.

See [SETUP.md](archive/SETUP.md) for details.
