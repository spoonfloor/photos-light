#!/bin/bash
# Photos Light - Quick Start Script

# Set paths (EDIT THESE if your setup is different)
export PHOTO_DB_PATH="/Users/erichenry/Desktop/photo-migration-and-script/migration/databases/photo_library_test.db"
export PHOTO_LIBRARY_PATH="/Volumes/eric_files/photo_library_test"

# Check if database exists
if [ ! -f "$PHOTO_DB_PATH" ]; then
    echo "❌ ERROR: Database not found at: $PHOTO_DB_PATH"
    echo ""
    echo "Edit run.sh and set PHOTO_DB_PATH to your database location"
    exit 1
fi

# Check if library path exists
if [ ! -d "$PHOTO_LIBRARY_PATH" ]; then
    echo "❌ ERROR: Library not found at: $PHOTO_LIBRARY_PATH"
    echo ""
    echo "Edit run.sh and set PHOTO_LIBRARY_PATH to your photo library"
    exit 1
fi

echo "✅ Database: $PHOTO_DB_PATH"
echo "✅ Library: $PHOTO_LIBRARY_PATH"
echo ""
echo "🚀 Starting Photos Light on http://localhost:5001"
echo ""

python3 app.py
