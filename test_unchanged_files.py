#!/usr/bin/env python3
"""
Bulletproof test: Verify files in 'unchanged' directory remain unchanged after bake_orientation().
Uses SHA256 hashing to cryptographically prove no changes.
"""
import sys
import os
import hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import bake_orientation

def compute_hash(file_path):
    """Compute SHA256 hash of file."""
    sha256 = hashlib.sha256()
    with open(file_path, 'rb') as f:
        while chunk := f.read(8192):
            sha256.update(chunk)
    return sha256.hexdigest()

def test_unchanged_files():
    """Test all files in unchanged directory remain unchanged."""
    unchanged_dir = "/Users/erichenry/Desktop/baking-files/unchanged"
    
    print("=" * 80)
    print("🧪 BULLETPROOF TEST: Verify files remain unchanged")
    print("=" * 80)
    print()
    
    if not os.path.exists(unchanged_dir):
        print(f"❌ Directory not found: {unchanged_dir}")
        return False
    
    files = sorted([f for f in os.listdir(unchanged_dir) if not f.startswith('.')])
    
    if not files:
        print(f"❌ No files found in: {unchanged_dir}")
        return False
    
    print(f"📂 Testing {len(files)} files from: {unchanged_dir}")
    print()
    
    all_passed = True
    results = []
    
    for filename in files:
        file_path = os.path.join(unchanged_dir, filename)
        
        if not os.path.isfile(file_path):
            continue
        
        print(f"📄 {filename}")
        
        # Compute hash BEFORE
        hash_before = compute_hash(file_path)
        print(f"   🔑 Hash before:  {hash_before[:16]}...")
        
        # Get file size and mtime BEFORE
        stat_before = os.stat(file_path)
        size_before = stat_before.st_size
        mtime_before = stat_before.st_mtime
        
        # Run bake_orientation
        success, message, orient = bake_orientation(file_path)
        print(f"   🎯 bake_orientation: success={success}, orient={orient}")
        print(f"      Message: {message}")
        
        # Compute hash AFTER
        hash_after = compute_hash(file_path)
        print(f"   🔑 Hash after:   {hash_after[:16]}...")
        
        # Get file size and mtime AFTER
        stat_after = os.stat(file_path)
        size_after = stat_after.st_size
        mtime_after = stat_after.st_mtime
        
        # Verify unchanged
        if hash_before == hash_after:
            print(f"   ✅ PASS - File cryptographically proven unchanged")
            results.append((filename, True, message))
        else:
            print(f"   ❌ FAIL - File was modified!")
            print(f"      Hash mismatch: {hash_before} != {hash_after}")
            results.append((filename, False, message))
            all_passed = False
        
        # Additional checks
        if size_before != size_after:
            print(f"   ⚠️  Size changed: {size_before} → {size_after}")
        if mtime_before != mtime_after:
            print(f"   ⚠️  Modification time changed")
        
        print()
    
    # Summary
    print("=" * 80)
    print("📊 SUMMARY")
    print("=" * 80)
    
    passed = sum(1 for _, success, _ in results if success)
    failed = len(results) - passed
    
    for filename, success, message in results:
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status} - {filename}")
        print(f"        {message}")
    
    print()
    print(f"Results: {passed}/{len(results)} passed, {failed} failed")
    print()
    
    if all_passed:
        print("🎉 ALL TESTS PASSED - All files cryptographically proven unchanged!")
        return True
    else:
        print("❌ TESTS FAILED - Some files were modified!")
        return False

if __name__ == "__main__":
    success = test_unchanged_files()
    sys.exit(0 if success else 1)
