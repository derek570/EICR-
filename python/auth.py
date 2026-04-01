"""
Authentication module for EICR-oMatic 3000.
Handles login, logout, password hashing, session management, and account lockout.
"""

import re
import bcrypt
from datetime import datetime, timedelta
from typing import Optional, Tuple
from pathlib import Path

import database as db
from models import User, AuditLog


# Constants
MIN_PASSWORD_LENGTH = 8
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_DURATION_MINUTES = 15
SESSION_EXPIRY_HOURS = 24


def hash_password(password: str) -> str:
    """Hash a password using bcrypt with automatic salting."""
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password against its hash."""
    try:
        return bcrypt.checkpw(password.encode('utf-8'), password_hash.encode('utf-8'))
    except Exception:
        return False


def validate_password(password: str) -> Tuple[bool, str]:
    """
    Validate password meets requirements.
    Returns (is_valid, error_message).
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        return False, f"Password must be at least {MIN_PASSWORD_LENGTH} characters long"

    if not re.search(r'[A-Za-z]', password):
        return False, "Password must contain at least one letter"

    if not re.search(r'[0-9]', password):
        return False, "Password must contain at least one number"

    return True, ""


def validate_email(email: str) -> Tuple[bool, str]:
    """Validate email format."""
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    if not re.match(pattern, email):
        return False, "Invalid email format"
    return True, ""


def is_account_locked(user: User) -> bool:
    """Check if account is currently locked."""
    if user.locked_until:
        locked_until = datetime.fromisoformat(user.locked_until)
        if datetime.utcnow() < locked_until:
            return True
        # Lock expired, reset
        db.update_login_attempts(user.id, 0, None)
    return False


def get_lockout_remaining(user: User) -> int:
    """Get remaining lockout time in minutes."""
    if user.locked_until:
        locked_until = datetime.fromisoformat(user.locked_until)
        remaining = locked_until - datetime.utcnow()
        if remaining.total_seconds() > 0:
            return int(remaining.total_seconds() / 60) + 1
    return 0


def authenticate(email: str, password: str, ip_address: Optional[str] = None) -> Tuple[Optional[User], str]:
    """
    Authenticate user with email and password.
    Returns (user, error_message). User is None if authentication fails.
    """
    email = email.lower().strip()

    # Get user by email
    user = db.get_user_by_email(email)

    if not user:
        # Don't reveal if email exists
        return None, "Invalid email or password"

    # Check if account is active
    if not user.is_active:
        db.log_action(user.id, 'login_failed', {'reason': 'account_disabled'}, ip_address)
        return None, "Account has been disabled. Please contact support."

    # Check if account is locked
    if is_account_locked(user):
        remaining = get_lockout_remaining(user)
        db.log_action(user.id, 'login_failed', {'reason': 'account_locked'}, ip_address)
        return None, f"Account is locked. Try again in {remaining} minutes."

    # Verify password
    if not verify_password(password, user.password_hash):
        # Increment failed attempts
        attempts = user.failed_login_attempts + 1
        locked_until = None

        if attempts >= MAX_FAILED_ATTEMPTS:
            locked_until = (datetime.utcnow() + timedelta(minutes=LOCKOUT_DURATION_MINUTES)).isoformat()
            db.log_action(user.id, 'account_locked', {'attempts': attempts}, ip_address)

        db.update_login_attempts(user.id, attempts, locked_until)
        db.log_action(user.id, 'login_failed', {'attempts': attempts}, ip_address)

        remaining_attempts = MAX_FAILED_ATTEMPTS - attempts
        if remaining_attempts > 0:
            return None, f"Invalid email or password. {remaining_attempts} attempts remaining."
        else:
            return None, f"Account locked for {LOCKOUT_DURATION_MINUTES} minutes due to too many failed attempts."

    # Successful login
    db.update_last_login(user.id)
    db.log_action(user.id, 'login_success', {}, ip_address)

    # Refresh user data
    user = db.get_user_by_id(user.id)
    return user, ""


def create_user_account(email: str, password: str, name: str = "",
                        company_name: str = "", phone: str = "") -> Tuple[Optional[User], str]:
    """
    Create a new user account.
    Returns (user, error_message). User is None if creation fails.
    """
    email = email.lower().strip()

    # Validate email
    valid, error = validate_email(email)
    if not valid:
        return None, error

    # Check if email already exists
    if db.get_user_by_email(email):
        return None, "An account with this email already exists"

    # Validate password
    valid, error = validate_password(password)
    if not valid:
        return None, error

    # Create user
    user = User(
        email=email,
        password_hash=hash_password(password),
        name=name.strip(),
        company_name=company_name.strip(),
        phone=phone.strip()
    )

    try:
        db.create_user(user)
        # Create user directories
        create_user_directories(user.id)
        db.log_action(user.id, 'account_created', {'email': email})
        return user, ""
    except Exception as e:
        return None, f"Failed to create account: {str(e)}"


def create_user_directories(user_id: str):
    """Create user-specific directories."""
    base_dir = Path(__file__).parent.parent / "data" / "users" / user_id

    directories = [
        base_dir / "INCOMING",
        base_dir / "OUTPUT",
        base_dir / "DONE",
        base_dir / "FAILED",
        base_dir / "bug_reports"
    ]

    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)

    # Create config.json placeholder
    config_path = base_dir / "config.json"
    if not config_path.exists():
        import json
        config_path.write_text(json.dumps({
            "user_id": user_id,
            "created_at": datetime.utcnow().isoformat()
        }, indent=2))


def get_user_data_path(user_id: str) -> Path:
    """Get the base data path for a user."""
    return Path(__file__).parent.parent / "data" / "users" / user_id


def change_password(user_id: str, old_password: str, new_password: str) -> Tuple[bool, str]:
    """
    Change user password.
    Returns (success, error_message).
    """
    user = db.get_user_by_id(user_id)
    if not user:
        return False, "User not found"

    # Verify old password
    if not verify_password(old_password, user.password_hash):
        return False, "Current password is incorrect"

    # Validate new password
    valid, error = validate_password(new_password)
    if not valid:
        return False, error

    # Update password
    user.password_hash = hash_password(new_password)
    db.update_user(user)
    db.log_action(user_id, 'password_changed', {})

    return True, ""


def reset_password(user_id: str, new_password: str) -> Tuple[bool, str]:
    """
    Admin reset of user password.
    Returns (success, error_message).
    """
    user = db.get_user_by_id(user_id)
    if not user:
        return False, "User not found"

    # Validate new password
    valid, error = validate_password(new_password)
    if not valid:
        return False, error

    # Update password and clear lockout
    user.password_hash = hash_password(new_password)
    user.failed_login_attempts = 0
    user.locked_until = None
    db.update_user(user)
    db.log_action(user_id, 'password_reset', {'by': 'admin'})

    return True, ""


def disable_account(user_id: str) -> bool:
    """Disable a user account."""
    user = db.get_user_by_id(user_id)
    if not user:
        return False

    user.is_active = False
    db.update_user(user)
    db.log_action(user_id, 'account_disabled', {})
    return True


def enable_account(user_id: str) -> bool:
    """Enable a user account."""
    user = db.get_user_by_id(user_id)
    if not user:
        return False

    user.is_active = True
    user.failed_login_attempts = 0
    user.locked_until = None
    db.update_user(user)
    db.log_action(user_id, 'account_enabled', {})
    return True


def is_session_valid(session_created_at: str) -> bool:
    """Check if a session is still valid (not expired)."""
    if not session_created_at:
        return False

    try:
        created = datetime.fromisoformat(session_created_at)
        expiry = created + timedelta(hours=SESSION_EXPIRY_HOURS)
        return datetime.utcnow() < expiry
    except Exception:
        return False


def get_session_remaining_hours(session_created_at: str) -> float:
    """Get remaining hours until session expires."""
    if not session_created_at:
        return 0

    try:
        created = datetime.fromisoformat(session_created_at)
        expiry = created + timedelta(hours=SESSION_EXPIRY_HOURS)
        remaining = expiry - datetime.utcnow()
        return max(0, remaining.total_seconds() / 3600)
    except Exception:
        return 0


def log_logout(user_id: str, ip_address: Optional[str] = None):
    """Log user logout."""
    db.log_action(user_id, 'logout', {}, ip_address)


def log_dpa_acceptance(user_id: str, ip_address: Optional[str] = None):
    """Log DPA acceptance."""
    db.log_action(user_id, 'dpa_accepted', {'timestamp': datetime.utcnow().isoformat()}, ip_address)


def log_job_access(user_id: str, job_folder: str, action: str = "view", ip_address: Optional[str] = None):
    """Log job access."""
    db.log_action(user_id, 'job_access', {'folder': job_folder, 'action': action}, ip_address)


def log_certificate_download(user_id: str, job_folder: str, cert_type: str, ip_address: Optional[str] = None):
    """Log certificate download."""
    db.log_action(user_id, 'certificate_download', {'folder': job_folder, 'type': cert_type}, ip_address)
