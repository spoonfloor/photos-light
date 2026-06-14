# Quick Start (30 seconds)

## First Time Setup

```bash
cd ~/Desktop/photos-light
pip3 install -r requirements.txt
cd electron && npm install   # first time only
cd electron && npm start
```

The Electron shell opens automatically at http://localhost:5001.

**That's it!** On first launch, use **Open library** or **Add photos** to pick your library folder.

---

## If it doesn't work

1. **Install dependencies** — Run `pip3 install -r requirements.txt` and `cd electron && npm install`
2. **Port 5001 in use** — Quit any other Photos Light instance and try again
3. **Library folder missing** — Re-open the library folder or pick a valid path from the welcome screen
4. See [SETUP.md](archive/SETUP.md) for detailed troubleshooting

---

## Dev notes

- **Server:** http://localhost:5001 (started by Electron via `launcher.py`)
- **Packaged app:** `./packaging/build.sh` → `dist/mac-arm64/Photos Light.app`
