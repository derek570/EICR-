"""
Database operations for EICR-oMatic 3000.
SQLite database with secure operations for users, jobs, audit logs, and bug reports.
"""

import sqlite3
import json
from pathlib import Path
from datetime import datetime
from typing import Optional, List
from contextlib import contextmanager

from models import User, Job, AuditLog, BugReport


# Database path
DB_DIR = Path(__file__).parent.parent / "data"
DB_PATH = DB_DIR / "eicr_omatic.db"


def get_db_path() -> Path:
    """Get the database path, ensuring directory exists."""
    DB_DIR.mkdir(parents=True, exist_ok=True)
    return DB_PATH


@contextmanager
def get_connection():
    """Context manager for database connections."""
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_database():
    """Initialize database with required tables."""
    with get_connection() as conn:
        cursor = conn.cursor()

        # Users table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                name TEXT,
                company_name TEXT,
                phone TEXT,
                created_at TEXT NOT NULL,
                last_login TEXT,
                is_active INTEGER DEFAULT 1,
                failed_login_attempts INTEGER DEFAULT 0,
                locked_until TEXT
            )
        ''')

        # Jobs table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                folder_name TEXT,
                certificate_type TEXT,
                status TEXT DEFAULT 'pending',
                address TEXT,
                client_name TEXT,
                created_at TEXT NOT NULL,
                completed_at TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        ''')

        # Audit log table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS audit_log (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT,
                ip_address TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        ''')

        # Bug reports table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS bug_reports (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                steps_to_reproduce TEXT,
                expected_behaviour TEXT,
                actual_behaviour TEXT,
                severity TEXT DEFAULT 'medium',
                status TEXT DEFAULT 'new',
                screenshot_path TEXT,
                page_context TEXT,
                admin_notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        ''')

        # Create indexes for performance
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_bug_reports_user_id ON bug_reports(user_id)')


# ============= User Operations =============

def create_user(user: User) -> User:
    """Create a new user."""
    with get_connection() as conn:
        cursor = conn.cursor()
        data = user.to_dict()
        cursor.execute('''
            INSERT INTO users (id, email, password_hash, name, company_name, phone,
                             created_at, last_login, is_active, failed_login_attempts, locked_until)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (data['id'], data['email'], data['password_hash'], data['name'],
              data['company_name'], data['phone'], data['created_at'], data['last_login'],
              data['is_active'], data['failed_login_attempts'], data['locked_until']))
    return user


def get_user_by_email(email: str) -> Optional[User]:
    """Get user by email address."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM users WHERE email = ?', (email.lower(),))
        row = cursor.fetchone()
        if row:
            return User.from_dict(dict(row))
    return None


def get_user_by_id(user_id: str) -> Optional[User]:
    """Get user by ID."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM users WHERE id = ?', (user_id,))
        row = cursor.fetchone()
        if row:
            return User.from_dict(dict(row))
    return None


def get_all_users() -> List[User]:
    """Get all users."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM users ORDER BY created_at DESC')
        rows = cursor.fetchall()
        return [User.from_dict(dict(row)) for row in rows]


def update_user(user: User) -> User:
    """Update user record."""
    with get_connection() as conn:
        cursor = conn.cursor()
        data = user.to_dict()
        cursor.execute('''
            UPDATE users SET
                email = ?, password_hash = ?, name = ?, company_name = ?, phone = ?,
                last_login = ?, is_active = ?, failed_login_attempts = ?, locked_until = ?
            WHERE id = ?
        ''', (data['email'], data['password_hash'], data['name'], data['company_name'],
              data['phone'], data['last_login'], data['is_active'],
              data['failed_login_attempts'], data['locked_until'], data['id']))
    return user


def update_login_attempts(user_id: str, attempts: int, locked_until: Optional[str] = None):
    """Update failed login attempts and lock status."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?
        ''', (attempts, locked_until, user_id))


def update_last_login(user_id: str):
    """Update last login timestamp."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE users SET last_login = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?
        ''', (datetime.utcnow().isoformat(), user_id))


def delete_user(user_id: str):
    """Delete user and all associated data (GDPR compliance)."""
    with get_connection() as conn:
        cursor = conn.cursor()
        # Delete audit logs (note: in some jurisdictions these may need to be retained)
        cursor.execute('DELETE FROM audit_log WHERE user_id = ?', (user_id,))
        # Delete bug reports
        cursor.execute('DELETE FROM bug_reports WHERE user_id = ?', (user_id,))
        # Delete jobs
        cursor.execute('DELETE FROM jobs WHERE user_id = ?', (user_id,))
        # Delete user
        cursor.execute('DELETE FROM users WHERE id = ?', (user_id,))


# ============= Job Operations =============

def create_job(job: Job) -> Job:
    """Create a new job record."""
    with get_connection() as conn:
        cursor = conn.cursor()
        data = job.to_dict()
        cursor.execute('''
            INSERT INTO jobs (id, user_id, folder_name, certificate_type, status,
                            address, client_name, created_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (data['id'], data['user_id'], data['folder_name'], data['certificate_type'],
              data['status'], data['address'], data['client_name'], data['created_at'],
              data['completed_at']))
    return job


def get_jobs_by_user(user_id: str) -> List[Job]:
    """Get all jobs for a specific user."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC', (user_id,))
        rows = cursor.fetchall()
        return [Job.from_dict(dict(row)) for row in rows]


def get_job_by_id(job_id: str, user_id: str) -> Optional[Job]:
    """Get job by ID, ensuring it belongs to the user."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM jobs WHERE id = ? AND user_id = ?', (job_id, user_id))
        row = cursor.fetchone()
        if row:
            return Job.from_dict(dict(row))
    return None


def update_job(job: Job) -> Job:
    """Update job record."""
    with get_connection() as conn:
        cursor = conn.cursor()
        data = job.to_dict()
        cursor.execute('''
            UPDATE jobs SET
                folder_name = ?, certificate_type = ?, status = ?, address = ?,
                client_name = ?, completed_at = ?
            WHERE id = ? AND user_id = ?
        ''', (data['folder_name'], data['certificate_type'], data['status'],
              data['address'], data['client_name'], data['completed_at'],
              data['id'], data['user_id']))
    return job


def get_job_count_by_user(user_id: str) -> int:
    """Get count of jobs for a user."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT COUNT(*) as count FROM jobs WHERE user_id = ?', (user_id,))
        row = cursor.fetchone()
        return row['count'] if row else 0


# ============= Audit Log Operations =============

def create_audit_log(log: AuditLog) -> AuditLog:
    """Create a new audit log entry."""
    with get_connection() as conn:
        cursor = conn.cursor()
        data = log.to_dict()
        cursor.execute('''
            INSERT INTO audit_log (id, user_id, action, details, ip_address, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (data['id'], data['user_id'], data['action'], data['details'],
              data['ip_address'], data['created_at']))
    return log


def log_action(user_id: str, action: str, details: Optional[dict] = None, ip_address: Optional[str] = None) -> AuditLog:
    """Helper function to quickly log an action."""
    log = AuditLog(
        user_id=user_id,
        action=action,
        details=json.dumps(details) if details else "",
        ip_address=ip_address
    )
    return create_audit_log(log)


def get_audit_logs_by_user(user_id: str, limit: int = 100) -> List[AuditLog]:
    """Get audit logs for a specific user."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT * FROM audit_log WHERE user_id = ?
            ORDER BY created_at DESC LIMIT ?
        ''', (user_id, limit))
        rows = cursor.fetchall()
        return [AuditLog.from_dict(dict(row)) for row in rows]


def get_all_audit_logs(limit: int = 1000) -> List[AuditLog]:
    """Get all audit logs (for admin)."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?
        ''', (limit,))
        rows = cursor.fetchall()
        return [AuditLog.from_dict(dict(row)) for row in rows]


# ============= Bug Report Operations =============

def create_bug_report(report: BugReport) -> BugReport:
    """Create a new bug report."""
    with get_connection() as conn:
        cursor = conn.cursor()
        data = report.to_dict()
        cursor.execute('''
            INSERT INTO bug_reports (id, user_id, title, description, steps_to_reproduce,
                                    expected_behaviour, actual_behaviour, severity, status,
                                    screenshot_path, page_context, admin_notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (data['id'], data['user_id'], data['title'], data['description'],
              data['steps_to_reproduce'], data['expected_behaviour'], data['actual_behaviour'],
              data['severity'], data['status'], data['screenshot_path'], data['page_context'],
              data['admin_notes'], data['created_at'], data['updated_at']))
    return report


def get_bug_reports_by_user(user_id: str) -> List[BugReport]:
    """Get bug reports for a specific user."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT * FROM bug_reports WHERE user_id = ?
            ORDER BY created_at DESC
        ''', (user_id,))
        rows = cursor.fetchall()
        return [BugReport.from_dict(dict(row)) for row in rows]


def get_all_bug_reports() -> List[BugReport]:
    """Get all bug reports (for admin)."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM bug_reports ORDER BY created_at DESC')
        rows = cursor.fetchall()
        return [BugReport.from_dict(dict(row)) for row in rows]


def get_bug_report_by_id(report_id: str) -> Optional[BugReport]:
    """Get bug report by ID."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM bug_reports WHERE id = ?', (report_id,))
        row = cursor.fetchone()
        if row:
            return BugReport.from_dict(dict(row))
    return None


def update_bug_report_status(report_id: str, status: str, admin_notes: str = "") -> Optional[BugReport]:
    """Update bug report status."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE bug_reports SET status = ?, admin_notes = ?, updated_at = ?
            WHERE id = ?
        ''', (status, admin_notes, datetime.utcnow().isoformat(), report_id))
    return get_bug_report_by_id(report_id)


# Initialize database on module import
init_database()
