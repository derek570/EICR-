"""
Data models for EICR-oMatic 3000 authentication and tracking system.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
import uuid
import json


@dataclass
class User:
    """User account model."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    email: str = ""
    password_hash: str = ""
    name: str = ""
    company_name: str = ""
    phone: str = ""
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    last_login: Optional[str] = None
    is_active: bool = True
    failed_login_attempts: int = 0
    locked_until: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for database storage."""
        return {
            'id': self.id,
            'email': self.email,
            'password_hash': self.password_hash,
            'name': self.name,
            'company_name': self.company_name,
            'phone': self.phone,
            'created_at': self.created_at,
            'last_login': self.last_login,
            'is_active': 1 if self.is_active else 0,
            'failed_login_attempts': self.failed_login_attempts,
            'locked_until': self.locked_until
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'User':
        """Create User from dictionary."""
        return cls(
            id=data.get('id', str(uuid.uuid4())),
            email=data.get('email', ''),
            password_hash=data.get('password_hash', ''),
            name=data.get('name', ''),
            company_name=data.get('company_name', ''),
            phone=data.get('phone', ''),
            created_at=data.get('created_at', datetime.utcnow().isoformat()),
            last_login=data.get('last_login'),
            is_active=bool(data.get('is_active', 1)),
            failed_login_attempts=data.get('failed_login_attempts', 0),
            locked_until=data.get('locked_until')
        )


@dataclass
class Job:
    """Job/certificate record model."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str = ""
    folder_name: str = ""
    certificate_type: str = "EICR"  # EICR or EIC
    status: str = "pending"  # pending, processing, completed, failed
    address: str = ""
    client_name: str = ""
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    completed_at: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for database storage."""
        return {
            'id': self.id,
            'user_id': self.user_id,
            'folder_name': self.folder_name,
            'certificate_type': self.certificate_type,
            'status': self.status,
            'address': self.address,
            'client_name': self.client_name,
            'created_at': self.created_at,
            'completed_at': self.completed_at
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'Job':
        """Create Job from dictionary."""
        return cls(
            id=data.get('id', str(uuid.uuid4())),
            user_id=data.get('user_id', ''),
            folder_name=data.get('folder_name', ''),
            certificate_type=data.get('certificate_type', 'EICR'),
            status=data.get('status', 'pending'),
            address=data.get('address', ''),
            client_name=data.get('client_name', ''),
            created_at=data.get('created_at', datetime.utcnow().isoformat()),
            completed_at=data.get('completed_at')
        )


@dataclass
class AuditLog:
    """Audit log entry model."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str = ""
    action: str = ""  # login_success, login_failed, logout, dpa_accepted, job_access, job_modify, certificate_download, bug_report_submitted
    details: str = ""  # JSON string with additional details
    ip_address: Optional[str] = None
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    def to_dict(self) -> dict:
        """Convert to dictionary for database storage."""
        return {
            'id': self.id,
            'user_id': self.user_id,
            'action': self.action,
            'details': self.details,
            'ip_address': self.ip_address,
            'created_at': self.created_at
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'AuditLog':
        """Create AuditLog from dictionary."""
        return cls(
            id=data.get('id', str(uuid.uuid4())),
            user_id=data.get('user_id', ''),
            action=data.get('action', ''),
            details=data.get('details', ''),
            ip_address=data.get('ip_address'),
            created_at=data.get('created_at', datetime.utcnow().isoformat())
        )

    def get_details_dict(self) -> dict:
        """Parse details JSON string to dictionary."""
        if self.details:
            try:
                return json.loads(self.details)
            except json.JSONDecodeError:
                return {}
        return {}


@dataclass
class BugReport:
    """Bug report model."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str = ""
    title: str = ""
    description: str = ""
    steps_to_reproduce: str = ""
    expected_behaviour: str = ""
    actual_behaviour: str = ""
    severity: str = "medium"  # low, medium, high, critical
    status: str = "new"  # new, in_progress, resolved, closed
    screenshot_path: Optional[str] = None
    page_context: str = ""
    admin_notes: str = ""
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    def to_dict(self) -> dict:
        """Convert to dictionary for database storage."""
        return {
            'id': self.id,
            'user_id': self.user_id,
            'title': self.title,
            'description': self.description,
            'steps_to_reproduce': self.steps_to_reproduce,
            'expected_behaviour': self.expected_behaviour,
            'actual_behaviour': self.actual_behaviour,
            'severity': self.severity,
            'status': self.status,
            'screenshot_path': self.screenshot_path,
            'page_context': self.page_context,
            'admin_notes': self.admin_notes,
            'created_at': self.created_at,
            'updated_at': self.updated_at
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'BugReport':
        """Create BugReport from dictionary."""
        return cls(
            id=data.get('id', str(uuid.uuid4())),
            user_id=data.get('user_id', ''),
            title=data.get('title', ''),
            description=data.get('description', ''),
            steps_to_reproduce=data.get('steps_to_reproduce', ''),
            expected_behaviour=data.get('expected_behaviour', ''),
            actual_behaviour=data.get('actual_behaviour', ''),
            severity=data.get('severity', 'medium'),
            status=data.get('status', 'new'),
            screenshot_path=data.get('screenshot_path'),
            page_context=data.get('page_context', ''),
            admin_notes=data.get('admin_notes', ''),
            created_at=data.get('created_at', datetime.utcnow().isoformat()),
            updated_at=data.get('updated_at', datetime.utcnow().isoformat())
        )
