"""
Hash Cache - Two-Level Caching System for File Hashes

Provides:
- In-memory LRU cache (fast, 1000 entries)
- Database persistent cache (survives restarts)
- Automatic invalidation on file changes (mtime, size)

Usage:
    cache = HashCache(db_connection)
    content_hash, cache_hit = cache.get_hash(file_path)
"""

import os
import hashlib
from datetime import datetime
from collections import OrderedDict


class HashCache:
    """
    Two-level hash cache with LRU memory cache and persistent DB cache.
    
    Cache key: (file_path, mtime_ns, file_size)
    - mtime_ns: Nanosecond-precision modification time
    - file_size: File size in bytes
    - Together they uniquely identify file state
    """
    
    def __init__(self, db_connection, max_memory_size=1000):
        """
        Initialize hash cache.
        
        Args:
            db_connection: Active SQLite database connection
            max_memory_size: Maximum entries in memory cache (default: 1000)
        """
        self.db_conn = db_connection
        self.max_memory_size = max_memory_size
        
        # Memory cache: OrderedDict for LRU behavior
        self.memory_cache = OrderedDict()
        
        # Statistics
        self.stats = {
            'memory_hits': 0,
            'db_hits': 0,
            'misses': 0,
            'total_queries': 0
        }
        
        # IMPORTANT: We return 7-char hashes to match app.py's compute_hash()
        # But store full 64-char hashes in DB for uniqueness
    
    def get_hash(self, file_path):
        """
        Get hash for file (from cache or compute).
        
        Args:
            file_path: Absolute path to file
        
        Returns:
            tuple: (content_hash, cache_hit)
            - content_hash: SHA-256 hash (full 64 chars)
            - cache_hit: True if from cache, False if computed
        
        Returns:
            (None, False) if file doesn't exist or error
        """
        self.stats['total_queries'] += 1
        
        # Get file stats
        try:
            stat = os.stat(file_path)
        except OSError as e:
            print(f"⚠️  Cannot stat file {file_path}: {e}")
            return None, False
        
        cache_key = (file_path, stat.st_mtime_ns, stat.st_size)
        
        # Level 1: Check memory cache
        if cache_key in self.memory_cache:
            # Move to end (mark as recently used)
            self.memory_cache.move_to_end(cache_key)
            self.stats['memory_hits'] += 1
            # Memory cache stores full hash, return truncated
            full_hash = self.memory_cache[cache_key]
            return full_hash[:7], True
        
        # Level 2: Check database cache
        cursor = self.db_conn.cursor()
        cursor.execute("""
            SELECT content_hash FROM hash_cache
            WHERE file_path = ? AND mtime_ns = ? AND file_size = ?
        """, cache_key)
        
        row = cursor.fetchone()
        if row:
            # FIX: row is dict-like (sqlite3.Row), access by key
            content_hash = row['content_hash']
            
            # Populate memory cache
            self._add_to_memory_cache(cache_key, content_hash)
            
            self.stats['db_hits'] += 1
            # Return truncated hash to match app.py's compute_hash() (7 chars)
            return content_hash[:7], True
        
        # Cache miss - compute hash
        content_hash = self._compute_hash(file_path)
        
        if content_hash is None:
            return None, False
        
        # Store FULL hash in both caches (64 chars for uniqueness)
        self._add_to_memory_cache(cache_key, content_hash)
        self._add_to_db_cache(cache_key, content_hash)
        
        self.stats['misses'] += 1
        # Return truncated hash to match app.py's compute_hash() (7 chars)
        return content_hash[:7], False
    
    def _compute_hash(self, file_path):
        """
        Compute SHA-256 hash of file.
        
        Args:
            file_path: Absolute path to file
        
        Returns:
            str: Full SHA-256 hash (64 chars), or None on error
        """
        try:
            sha256_hash = hashlib.sha256()
            with open(file_path, "rb") as f:
                # Read in 1MB chunks (optimal for network storage)
                for byte_block in iter(lambda: f.read(1048576), b""):
                    sha256_hash.update(byte_block)
            
            return sha256_hash.hexdigest()
        
        except Exception as e:
            print(f"❌ Error hashing file {file_path}: {e}")
            return None
    
    def _add_to_memory_cache(self, cache_key, content_hash):
        """
        Add entry to memory cache (with LRU eviction).
        Stores FULL 64-char hash for maximum uniqueness.
        """
        # Add to cache
        self.memory_cache[cache_key] = content_hash
        
        # Evict oldest if over limit
        if len(self.memory_cache) > self.max_memory_size:
            # Remove first item (oldest)
            self.memory_cache.popitem(last=False)
    
    def _add_to_db_cache(self, cache_key, content_hash):
        """
        Add entry to database cache.
        Stores FULL 64-char hash for maximum uniqueness and cache hit accuracy.
        """
        file_path, mtime_ns, file_size = cache_key
        
        cursor = self.db_conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO hash_cache 
            (file_path, mtime_ns, file_size, content_hash, cached_at)
            VALUES (?, ?, ?, ?, ?)
        """, (file_path, mtime_ns, file_size, content_hash, datetime.now().isoformat()))
        
        self.db_conn.commit()
    
    def invalidate_file(self, file_path):
        """
        Invalidate all cache entries for a file.
        
        Use when file is deleted or you want to force recompute.
        
        Args:
            file_path: Path to invalidate
        """
        # Remove from memory cache (all entries for this path)
        keys_to_remove = [key for key in self.memory_cache.keys() if key[0] == file_path]
        for key in keys_to_remove:
            del self.memory_cache[key]
        
        # Remove from DB cache
        cursor = self.db_conn.cursor()
        cursor.execute("DELETE FROM hash_cache WHERE file_path = ?", (file_path,))
        self.db_conn.commit()
    
    def cleanup_stale_entries(self, library_path):
        """
        Remove cache entries for files that no longer exist.
        
        Args:
            library_path: Root library path to check
        
        Returns:
            int: Number of stale entries removed
        """
        cursor = self.db_conn.cursor()
        cursor.execute("SELECT DISTINCT file_path FROM hash_cache")
        all_paths = [row['file_path'] for row in cursor.fetchall()]
        
        removed = 0
        for path in all_paths:
            # Check if file exists
            if not os.path.exists(path):
                cursor.execute("DELETE FROM hash_cache WHERE file_path = ?", (path,))
                removed += 1
        
        self.db_conn.commit()
        
        # Also clear memory cache for non-existent files
        keys_to_remove = [key for key in self.memory_cache.keys() if not os.path.exists(key[0])]
        for key in keys_to_remove:
            del self.memory_cache[key]
        
        return removed
    
    def get_stats(self):
        """
        Get cache statistics.
        
        Returns:
            dict: Statistics including hit rates
        """
        total = self.stats['total_queries']
        if total == 0:
            return {**self.stats, 'hit_rate': 0.0}
        
        total_hits = self.stats['memory_hits'] + self.stats['db_hits']
        hit_rate = (total_hits / total) * 100
        
        return {
            **self.stats,
            'hit_rate': round(hit_rate, 1),
            'memory_size': len(self.memory_cache)
        }
    
    def clear_memory_cache(self):
        """Clear in-memory cache (keeps DB cache)"""
        self.memory_cache.clear()
    
    def clear_all(self):
        """Clear both memory and database caches"""
        self.memory_cache.clear()
        
        cursor = self.db_conn.cursor()
        cursor.execute("DELETE FROM hash_cache")
        self.db_conn.commit()


def compute_hash_cached(file_path, hash_cache):
    """
    Compute hash with caching (convenience function).
    
    Args:
        file_path: Absolute path to file
        hash_cache: HashCache instance
    
    Returns:
        tuple: (content_hash, cache_hit)
    """
    return hash_cache.get_hash(file_path)


def compute_hash_legacy(file_path):
    """
    Compute hash without caching (legacy compatibility).
    
    Use this for backward compatibility or when caching not needed.
    
    Args:
        file_path: Absolute path to file
    
    Returns:
        str: SHA-256 hash (full 64 chars)
    """
    sha256_hash = hashlib.sha256()
    try:
        with open(file_path, "rb") as f:
            for byte_block in iter(lambda: f.read(1048576), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()
    except Exception as e:
        print(f"❌ Error hashing file {file_path}: {e}")
        return None
