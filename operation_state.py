"""
Operation State Manager - Tracks and resumes long-running operations

Handles:
- Operation lifecycle (pending → running → completed/failed)
- Checkpoint persistence (resume from last known state)
- Performance metrics tracking
- Error recovery

Usage:
    manager = OperationStateManager(db_connection)
    op_id = manager.start_operation('rebuild_database')
    
    for i, file in enumerate(files):
        process_file(file)
        
        # Checkpoint every 100 files
        if i % 100 == 0:
            manager.checkpoint(op_id, {'processed': i, 'total': len(files)})
    
    manager.complete_operation(op_id, {'final_count': len(files)})
"""

import json
import uuid
from datetime import datetime
from enum import Enum


class OperationStatus(Enum):
    """Operation status states"""
    PENDING = 'pending'           # Created but not started
    RUNNING = 'running'           # Currently executing
    PAUSED = 'paused'             # Paused by user
    COMPLETED = 'completed'       # Finished successfully
    FAILED = 'failed'             # Failed with error
    CANCELLED = 'cancelled'       # Cancelled by user


class OperationType(Enum):
    """Supported operation types"""
    IMPORT_PHOTOS = 'import_photos'
    DELETE_PHOTOS = 'delete_photos'
    UPDATE_DATE = 'update_date'
    CLEAN_LIBRARY = 'clean_library'
    REBUILD_DATABASE = 'rebuild_database'
    UPDATE_INDEX = 'update_index'
    TERRAFORM = 'terraform'


class OperationStateManager:
    """
    Manages operation state with checkpoint persistence.
    
    Thread-safe for single operation (not designed for concurrent ops).
    """
    
    def __init__(self, db_connection):
        """
        Initialize operation state manager.
        
        Args:
            db_connection: Active SQLite database connection
        """
        self.db_conn = db_connection
        # Don't modify row_factory - use whatever the connection has
    
    def start_operation(self, operation_type, metadata=None):
        """
        Start a new operation or resume an incomplete one.
        
        Args:
            operation_type: OperationType enum or string
            metadata: Optional dict with operation-specific data
        
        Returns:
            str: operation_id
        """
        if isinstance(operation_type, OperationType):
            operation_type = operation_type.value
        
        # Check for incomplete operations of this type
        cursor = self.db_conn.cursor()
        cursor.execute("""
            SELECT operation_id, checkpoint_data
            FROM operation_state
            WHERE operation_type = ? AND status IN ('pending', 'running', 'paused')
            ORDER BY started_at DESC
            LIMIT 1
        """, (operation_type,))
        
        row = cursor.fetchone()
        
        if row:
            # Resume existing operation (access by index for compatibility)
            operation_id = row[0] if isinstance(row, tuple) else row['operation_id']
            print(f"🔄 Resuming operation: {operation_id}")
            
            # Update to running
            cursor.execute("""
                UPDATE operation_state
                SET status = 'running', updated_at = ?
                WHERE operation_id = ?
            """, (datetime.now().isoformat(), operation_id))
            
            self.db_conn.commit()
            return operation_id
        
        # Create new operation
        operation_id = str(uuid.uuid4())
        now = datetime.now().isoformat()
        
        cursor.execute("""
            INSERT INTO operation_state
            (operation_id, operation_type, status, started_at, updated_at, 
             checkpoint_data, performance_metrics, error_message)
            VALUES (?, ?, 'running', ?, ?, NULL, NULL, NULL)
        """, (operation_id, operation_type, now, now))
        
        self.db_conn.commit()
        
        print(f"▶️  Started operation: {operation_id} ({operation_type})")
        return operation_id
    
    def checkpoint(self, operation_id, checkpoint_data, performance_metrics=None):
        """
        Save checkpoint data (for resume capability).
        
        Args:
            operation_id: Operation ID
            checkpoint_data: Dict with state data (files processed, current index, etc)
            performance_metrics: Optional dict with timing/throughput data
        """
        cursor = self.db_conn.cursor()
        
        checkpoint_json = json.dumps(checkpoint_data)
        metrics_json = json.dumps(performance_metrics) if performance_metrics else None
        
        cursor.execute("""
            UPDATE operation_state
            SET checkpoint_data = ?,
                performance_metrics = ?,
                updated_at = ?
            WHERE operation_id = ?
        """, (checkpoint_json, metrics_json, datetime.now().isoformat(), operation_id))
        
        self.db_conn.commit()
    
    def get_checkpoint(self, operation_id):
        """
        Get checkpoint data for operation (for resume).
        
        Args:
            operation_id: Operation ID
        
        Returns:
            dict: Checkpoint data or None if no checkpoint
        """
        cursor = self.db_conn.cursor()
        cursor.execute("""
            SELECT checkpoint_data
            FROM operation_state
            WHERE operation_id = ?
        """, (operation_id,))
        
        row = cursor.fetchone()
        if row:
            # Access by index for compatibility with both tuple and Row
            checkpoint_json = row[0] if isinstance(row, tuple) else row['checkpoint_data']
            if checkpoint_json:
                return json.loads(checkpoint_json)
        return None
    
    def complete_operation(self, operation_id, final_metrics=None):
        """
        Mark operation as completed successfully and clear checkpoint.
        
        Args:
            operation_id: Operation ID
            final_metrics: Optional dict with final performance data
        """
        cursor = self.db_conn.cursor()
        
        metrics_json = json.dumps(final_metrics) if final_metrics else None
        
        cursor.execute("""
            UPDATE operation_state
            SET status = 'completed',
                checkpoint_data = NULL,
                performance_metrics = ?,
                updated_at = ?
            WHERE operation_id = ?
        """, (metrics_json, datetime.now().isoformat(), operation_id))
        
        self.db_conn.commit()
        
        print(f"✅ Operation completed: {operation_id}")
    
    def fail_operation(self, operation_id, error_message):
        """
        Mark operation as failed with error message.
        
        Args:
            operation_id: Operation ID
            error_message: Error description
        """
        cursor = self.db_conn.cursor()
        
        cursor.execute("""
            UPDATE operation_state
            SET status = 'failed',
                error_message = ?,
                updated_at = ?
            WHERE operation_id = ?
        """, (error_message, datetime.now().isoformat(), operation_id))
        
        self.db_conn.commit()
        
        print(f"❌ Operation failed: {operation_id} - {error_message}")
    
    def cancel_operation(self, operation_id):
        """
        Mark operation as cancelled by user.
        
        Args:
            operation_id: Operation ID
        """
        cursor = self.db_conn.cursor()
        
        cursor.execute("""
            UPDATE operation_state
            SET status = 'cancelled',
                updated_at = ?
            WHERE operation_id = ?
        """, (datetime.now().isoformat(), operation_id))
        
        self.db_conn.commit()
        
        print(f"🚫 Operation cancelled: {operation_id}")
    
    def get_incomplete_operations(self):
        """
        Get all incomplete operations (for resume UI).
        
        Returns:
            list: List of dicts with operation details
        """
        cursor = self.db_conn.cursor()
        cursor.execute("""
            SELECT operation_id, operation_type, status, started_at, updated_at, checkpoint_data
            FROM operation_state
            WHERE status IN ('pending', 'running', 'paused')
            ORDER BY updated_at DESC
        """)
        
        results = []
        for row in cursor.fetchall():
            # Access by index for compatibility
            if isinstance(row, tuple):
                checkpoint_json = row[5]
            else:
                checkpoint_json = row['checkpoint_data']
            
            checkpoint_data = json.loads(checkpoint_json) if checkpoint_json else {}
            
            results.append({
                'operation_id': row[0] if isinstance(row, tuple) else row['operation_id'],
                'operation_type': row[1] if isinstance(row, tuple) else row['operation_type'],
                'status': row[2] if isinstance(row, tuple) else row['status'],
                'started_at': row[3] if isinstance(row, tuple) else row['started_at'],
                'updated_at': row[4] if isinstance(row, tuple) else row['updated_at'],
                'checkpoint_data': checkpoint_data
            })
        
        return results
    
    def cleanup_old_operations(self, days=30):
        """
        Clean up completed/failed operations older than N days.
        
        Args:
            days: Age threshold in days
        
        Returns:
            int: Number of operations deleted
        """
        from datetime import timedelta
        
        cursor = self.db_conn.cursor()
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        
        cursor.execute("""
            DELETE FROM operation_state
            WHERE status IN ('completed', 'failed', 'cancelled')
            AND updated_at < ?
        """, (cutoff,))
        
        deleted = cursor.rowcount
        self.db_conn.commit()
        
        print(f"🧹 Cleaned up {deleted} old operations")
        return deleted


class CheckpointHelper:
    """
    Helper for managing checkpoints in long-running operations.
    
    Usage:
        helper = CheckpointHelper(op_manager, operation_id, checkpoint_interval=100)
        
        for i, file in enumerate(files):
            process_file(file)
            helper.maybe_checkpoint(i, {'current': i, 'total': len(files)})
    """
    
    def __init__(self, operation_manager, operation_id, checkpoint_interval=100):
        """
        Initialize checkpoint helper.
        
        Args:
            operation_manager: OperationStateManager instance
            operation_id: Operation ID
            checkpoint_interval: Checkpoint every N items
        """
        self.op_manager = operation_manager
        self.operation_id = operation_id
        self.checkpoint_interval = checkpoint_interval
        self.last_checkpoint = 0
        self.start_time = datetime.now()
    
    def maybe_checkpoint(self, current_index, checkpoint_data=None):
        """
        Checkpoint if interval reached.
        
        Args:
            current_index: Current item index
            checkpoint_data: Optional dict with state data
        
        Returns:
            bool: True if checkpoint was saved
        """
        if current_index - self.last_checkpoint >= self.checkpoint_interval:
            # Add timing metrics
            elapsed = (datetime.now() - self.start_time).total_seconds()
            throughput = current_index / elapsed if elapsed > 0 else 0
            
            metrics = {
                'elapsed_seconds': round(elapsed, 2),
                'items_per_second': round(throughput, 2)
            }
            
            self.op_manager.checkpoint(self.operation_id, checkpoint_data or {}, metrics)
            self.last_checkpoint = current_index
            
            print(f"💾 Checkpoint: {current_index} items ({throughput:.1f}/sec)")
            return True
        
        return False
    
    def force_checkpoint(self, checkpoint_data=None):
        """Force a checkpoint regardless of interval."""
        elapsed = (datetime.now() - self.start_time).total_seconds()
        metrics = {'elapsed_seconds': round(elapsed, 2)}
        
        self.op_manager.checkpoint(self.operation_id, checkpoint_data or {}, metrics)
