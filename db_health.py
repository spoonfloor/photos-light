"""
Database Health Check System

Provides centralized health checking for photo library databases.
Used by switch library, app startup, and diagnostic tools.
"""

import sqlite3
import os
from enum import Enum
from dataclasses import dataclass
from typing import List, Optional, Set


class DBStatus(Enum):
    """Health status of a database"""
    HEALTHY = "healthy"
    MISSING = "missing"
    CORRUPTED = "corrupted"
    MISSING_COLUMNS = "missing_columns"
    EXTRA_COLUMNS = "extra_columns"
    MIXED_SCHEMA = "mixed_schema"  # Both missing and extra columns


@dataclass
class DBHealthReport:
    """
    Health check results for a database.
    
    Provides status, details, and recommended actions.
    """
    status: DBStatus
    db_path: str
    
    # Schema details
    missing_columns: Optional[List[str]] = None
    extra_columns: Optional[List[str]] = None
    error_message: Optional[str] = None
    
    # Action flags
    can_migrate: bool = False
    can_use_anyway: bool = False
    can_create_new: bool = False
    
    def needs_attention(self) -> bool:
        """Returns True if database requires action before use"""
        return self.status != DBStatus.HEALTHY
    
    def get_user_message(self) -> str:
        """Human-readable description of status"""
        if self.status == DBStatus.HEALTHY:
            return "Database is healthy and up to date"
        
        elif self.status == DBStatus.MISSING:
            return f"No database found at: {self.db_path}"
        
        elif self.status == DBStatus.CORRUPTED:
            return f"Database file is corrupted or invalid: {self.error_message}"
        
        elif self.status == DBStatus.MISSING_COLUMNS:
            cols = ', '.join(self.missing_columns)
            return f"Database schema is outdated. Missing columns: {cols}"
        
        elif self.status == DBStatus.EXTRA_COLUMNS:
            cols = ', '.join(self.extra_columns)
            return f"Database has extra columns (not in current schema): {cols}"
        
        elif self.status == DBStatus.MIXED_SCHEMA:
            missing = ', '.join(self.missing_columns)
            extra = ', '.join(self.extra_columns)
            return f"Database schema mismatch. Missing: {missing}. Extra: {extra}"
        
        return "Unknown database status"
    
    def get_recommended_actions(self) -> List[str]:
        """List of available actions: 'migrate', 'create_new', 'continue', 'abort'"""
        actions = []
        
        if self.can_migrate:
            actions.append('migrate')
        
        if self.can_create_new:
            actions.append('create_new')
        
        if self.can_use_anyway:
            actions.append('continue')
        
        if not actions:
            actions.append('abort')
        
        return actions


def get_table_columns(cursor, table_name: str) -> Set[str]:
    """Get set of column names for a table"""
    cursor.execute(f"PRAGMA table_info({table_name})")
    return {row[1] for row in cursor.fetchall()}


def get_expected_columns() -> Set[str]:
    """Get expected columns from canonical schema"""
    # Import here to avoid circular dependency
    from db_schema import PHOTOS_TABLE_SCHEMA
    
    # Parse CREATE TABLE statement to extract column names
    # Simple parsing - assumes column name is first word after opening paren or comma
    import re
    
    # Extract everything between first ( and )
    match = re.search(r'\((.*)\)', PHOTOS_TABLE_SCHEMA, re.DOTALL)
    if not match:
        return set()
    
    table_def = match.group(1)
    
    # Split by comma, get first word of each line (the column name)
    columns = set()
    for line in table_def.split(','):
        line = line.strip()
        if line:
            # First word is the column name
            col_name = line.split()[0].strip()
            columns.add(col_name)
    
    return columns


def check_database_health(db_path: str) -> DBHealthReport:
    """
    Comprehensive health check of a photo library database.
    
    Checks:
    - File existence
    - SQLite validity
    - Table structure
    - Schema version
    
    Args:
        db_path: Path to the database file
    
    Returns:
        DBHealthReport with status and recommendations
    """
    
    # Check 1: File exists?
    if not os.path.exists(db_path):
        return DBHealthReport(
            status=DBStatus.MISSING,
            db_path=db_path,
            can_create_new=True,
            can_migrate=False,
            can_use_anyway=False
        )
    
    # Check 2: Valid SQLite file?
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = cursor.fetchall()
    except (sqlite3.DatabaseError, sqlite3.OperationalError) as e:
        return DBHealthReport(
            status=DBStatus.CORRUPTED,
            db_path=db_path,
            error_message=str(e),
            can_create_new=True,
            can_migrate=False,
            can_use_anyway=False
        )
    
    # Check 3: Has photos table?
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='photos'")
    if not cursor.fetchone():
        conn.close()
        return DBHealthReport(
            status=DBStatus.CORRUPTED,
            db_path=db_path,
            error_message="No 'photos' table found",
            can_create_new=True,
            can_migrate=False,
            can_use_anyway=False
        )
    
    # Check 4: Schema matches expected?
    try:
        actual_columns = get_table_columns(cursor, 'photos')
        expected_columns = get_expected_columns()
        
        missing = expected_columns - actual_columns
        extra = actual_columns - expected_columns
        
        conn.close()
        
        # Perfect match
        if not missing and not extra:
            return DBHealthReport(
                status=DBStatus.HEALTHY,
                db_path=db_path,
                can_migrate=False,
                can_use_anyway=True
            )
        
        # Missing columns only - can migrate
        if missing and not extra:
            return DBHealthReport(
                status=DBStatus.MISSING_COLUMNS,
                db_path=db_path,
                missing_columns=sorted(list(missing)),
                can_migrate=True,
                can_use_anyway=True,  # Might work with degraded features
                can_create_new=False
            )
        
        # Extra columns only - harmless but inconsistent
        if extra and not missing:
            return DBHealthReport(
                status=DBStatus.EXTRA_COLUMNS,
                db_path=db_path,
                extra_columns=sorted(list(extra)),
                can_migrate=False,  # Don't auto-remove columns
                can_use_anyway=True,
                can_create_new=False
            )
        
        # Both missing and extra - complex schema drift
        return DBHealthReport(
            status=DBStatus.MIXED_SCHEMA,
            db_path=db_path,
            missing_columns=sorted(list(missing)),
            extra_columns=sorted(list(extra)),
            can_migrate=True,  # Can add missing, leave extra
            can_use_anyway=True,
            can_create_new=False
        )
        
    except Exception as e:
        if conn:
            conn.close()
        return DBHealthReport(
            status=DBStatus.CORRUPTED,
            db_path=db_path,
            error_message=f"Schema check failed: {str(e)}",
            can_create_new=True,
            can_migrate=False,
            can_use_anyway=False
        )


def format_health_report(report: DBHealthReport) -> str:
    """
    Format health report as human-readable text.
    
    Useful for CLI tools and logging.
    """
    lines = []
    lines.append("=" * 60)
    lines.append("DATABASE HEALTH CHECK")
    lines.append("=" * 60)
    lines.append(f"Path: {report.db_path}")
    lines.append(f"Status: {report.status.value.upper()}")
    lines.append("")
    lines.append(report.get_user_message())
    
    if report.missing_columns:
        lines.append("")
        lines.append("Missing columns:")
        for col in report.missing_columns:
            lines.append(f"  - {col}")
    
    if report.extra_columns:
        lines.append("")
        lines.append("Extra columns:")
        for col in report.extra_columns:
            lines.append(f"  - {col}")
    
    lines.append("")
    lines.append("Available actions:")
    for action in report.get_recommended_actions():
        lines.append(f"  - {action}")
    
    lines.append("=" * 60)
    
    return "\n".join(lines)
