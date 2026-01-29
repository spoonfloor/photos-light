"""
Two-Phase Database Rebuild - Safe, atomic database reconstruction

Prevents data loss during rebuild by:
1. Building new database in temp location
2. Only swapping on complete success
3. Keeping backup of original database

Usage:
    from db_rebuild import rebuild_database_two_phase
    
    for event in rebuild_database_two_phase(library_path, db_path):
        # Stream progress to frontend
        yield event
"""

import os
import shutil
import sqlite3
from datetime import datetime
from db_schema import create_database_schema
from library_sync import synchronize_library_generator
from operation_state import OperationStateManager, OperationType


def rebuild_database_two_phase(library_path, db_path, extract_exif_func, get_dimensions_func):
    """
    Rebuild database using two-phase commit for safety.
    
    Phase 1: Build complete database in temp location
    Phase 2: Atomic swap (temp → production)
    
    If Phase 1 fails, original database is untouched.
    
    Args:
        library_path: Path to photo library
        db_path: Path to production database
        extract_exif_func: Function to extract EXIF dates
        get_dimensions_func: Function to get dimensions
    
    Yields:
        SSE event strings for progress
    """
    import json
    
    # Setup paths
    db_dir = os.path.dirname(db_path)
    db_name = os.path.basename(db_path)
    temp_db_path = os.path.join(db_dir, f".{db_name}.rebuilding")
    backup_db_path = os.path.join(db_dir, f"{db_name}.backup")
    
    print(f"\n{'='*60}")
    print(f"🔨 TWO-PHASE DATABASE REBUILD")
    print(f"Production DB: {db_path}")
    print(f"Temp DB: {temp_db_path}")
    print(f"{'='*60}\n")
    
    # Track operation state
    conn = sqlite3.connect(db_path)
    op_manager = OperationStateManager(conn)
    operation_id = op_manager.start_operation(OperationType.REBUILD_DATABASE)
    conn.close()
    
    try:
        # PHASE 1: Build new database in temp location
        yield f"event: phase\ndata: {json.dumps({'phase': 'building', 'message': 'Building new database...'})}\n\n"
        
        print("📦 Phase 1: Building new database...")
        
        # Remove any existing temp database
        if os.path.exists(temp_db_path):
            os.remove(temp_db_path)
            print(f"  🗑️  Removed stale temp database")
        
        # Create new database with schema
        temp_conn = sqlite3.connect(temp_db_path)
        temp_conn.row_factory = sqlite3.Row
        temp_conn.execute("PRAGMA journal_mode=WAL")
        temp_conn.execute("PRAGMA foreign_keys=ON")
        
        temp_cursor = temp_conn.cursor()
        create_database_schema(temp_cursor)
        temp_conn.commit()
        
        print(f"  ✓ Created new database schema")
        
        # Sync library into temp database
        print(f"  🔄 Scanning and indexing library...")
        
        for event in synchronize_library_generator(
            library_path,
            temp_conn,
            extract_exif_func,
            get_dimensions_func,
            mode='full'
        ):
            # Forward progress events
            yield event
        
        # Close temp database
        temp_conn.close()
        
        print(f"  ✓ Phase 1 complete - new database ready")
        
        # PHASE 2: Atomic swap
        yield f"event: phase\ndata: {json.dumps({'phase': 'swapping', 'message': 'Activating new database...'})}\n\n"
        
        print("\n🔄 Phase 2: Atomic swap...")
        
        # Backup original database
        if os.path.exists(db_path):
            if os.path.exists(backup_db_path):
                os.remove(backup_db_path)
            shutil.copy2(db_path, backup_db_path)
            print(f"  💾 Backed up original database")
        
        # Atomic swap: temp → production
        # Also move WAL and SHM files if they exist
        if os.path.exists(db_path):
            os.remove(db_path)
        
        shutil.move(temp_db_path, db_path)
        
        # Move WAL files
        temp_wal = f"{temp_db_path}-wal"
        prod_wal = f"{db_path}-wal"
        if os.path.exists(temp_wal):
            if os.path.exists(prod_wal):
                os.remove(prod_wal)
            shutil.move(temp_wal, prod_wal)
        
        # Move SHM files
        temp_shm = f"{temp_db_path}-shm"
        prod_shm = f"{db_path}-shm"
        if os.path.exists(temp_shm):
            if os.path.exists(prod_shm):
                os.remove(prod_shm)
            shutil.move(temp_shm, prod_shm)
        
        print(f"  ✅ Swap complete - new database active")
        
        # Mark operation as completed
        conn = sqlite3.connect(db_path)
        op_manager = OperationStateManager(conn)
        op_manager.complete_operation(operation_id, {'rebuild_time': datetime.now().isoformat()})
        conn.close()
        
        print(f"\n{'='*60}")
        print(f"✅ REBUILD COMPLETE")
        print(f"Original backed up to: {backup_db_path}")
        print(f"{'='*60}\n")
        
        yield f"event: complete\ndata: {json.dumps({{'success': True, 'backup_path': backup_db_path}})}\n\n"
    
    except Exception as e:
        print(f"\n❌ Rebuild failed: {e}")
        
        # Clean up temp database
        if os.path.exists(temp_db_path):
            os.remove(temp_db_path)
            print(f"  🗑️  Cleaned up temp database")
        
        # Mark operation as failed
        try:
            conn = sqlite3.connect(db_path)
            op_manager = OperationStateManager(conn)
            op_manager.fail_operation(operation_id, str(e))
            conn.close()
        except:
            pass  # Original DB might be corrupt
        
        yield f"event: error\ndata: {json.dumps({{'error': str(e)}})}\n\n"
        raise


def recover_from_failed_rebuild(db_path):
    """
    Recover from a failed rebuild by restoring backup.
    
    Args:
        db_path: Path to production database
    
    Returns:
        bool: True if recovery successful
    """
    db_dir = os.path.dirname(db_path)
    db_name = os.path.basename(db_path)
    temp_db_path = os.path.join(db_dir, f".{db_name}.rebuilding")
    backup_db_path = os.path.join(db_dir, f"{db_name}.backup")
    
    print(f"\n🔧 RECOVERY MODE")
    
    # Clean up temp database
    if os.path.exists(temp_db_path):
        os.remove(temp_db_path)
        print(f"  ✓ Removed temp database")
    
    # Restore from backup if exists
    if os.path.exists(backup_db_path):
        if os.path.exists(db_path):
            os.remove(db_path)
        shutil.copy2(backup_db_path, db_path)
        print(f"  ✓ Restored from backup")
        return True
    else:
        print(f"  ⚠️  No backup found - cannot recover")
        return False
