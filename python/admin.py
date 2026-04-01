#!/usr/bin/env python3
"""
Admin CLI tool for EICR-oMatic 3000 user management.

Usage:
    python admin.py create              - Create a new user
    python admin.py list                - List all users
    python admin.py disable <email>     - Disable a user account
    python admin.py enable <email>      - Enable a user account
    python admin.py reset-password <email> - Reset user password
    python admin.py delete <email>      - Delete user and all data (GDPR)
    python admin.py bugs                - List all bug reports
    python admin.py bug-status <id> <status> - Update bug report status
"""

import sys
import os
import getpass
import shutil
from pathlib import Path
from datetime import datetime

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import database as db
import auth
from models import User


def print_header(text: str):
    """Print a formatted header."""
    print("\n" + "=" * 60)
    print(f"  {text}")
    print("=" * 60)


def print_success(text: str):
    """Print success message."""
    print(f"\n  [OK] {text}")


def print_error(text: str):
    """Print error message."""
    print(f"\n  [ERROR] {text}")


def print_user_table(users: list):
    """Print users in a table format."""
    if not users:
        print("  No users found.")
        return

    # Header
    print(f"\n  {'Email':<30} {'Name':<20} {'Active':<8} {'Jobs':<6} {'Last Login':<20}")
    print("  " + "-" * 90)

    for user in users:
        job_count = db.get_job_count_by_user(user.id)
        last_login = user.last_login[:19] if user.last_login else "Never"
        status = "Yes" if user.is_active else "LOCKED" if user.locked_until else "No"
        print(f"  {user.email:<30} {user.name[:18]:<20} {status:<8} {job_count:<6} {last_login:<20}")


def cmd_create():
    """Create a new user interactively."""
    print_header("Create New User")

    # Get email
    email = input("\n  Email: ").strip()
    if not email:
        print_error("Email is required")
        return

    # Validate email
    valid, error = auth.validate_email(email)
    if not valid:
        print_error(error)
        return

    # Check if exists
    if db.get_user_by_email(email.lower()):
        print_error("A user with this email already exists")
        return

    # Get password (hidden input)
    print("\n  Password requirements:")
    print("    - At least 8 characters")
    print("    - At least one letter")
    print("    - At least one number")

    password = getpass.getpass("\n  Password: ")
    if not password:
        print_error("Password is required")
        return

    password_confirm = getpass.getpass("  Confirm password: ")
    if password != password_confirm:
        print_error("Passwords do not match")
        return

    # Validate password
    valid, error = auth.validate_password(password)
    if not valid:
        print_error(error)
        return

    # Get optional details
    name = input("\n  Full name (optional): ").strip()
    company = input("  Company name (optional): ").strip()
    phone = input("  Phone (optional): ").strip()

    # Create user
    user, error = auth.create_user_account(email, password, name, company, phone)
    if user:
        print_success(f"User created successfully!")
        print(f"\n  User ID: {user.id}")
        print(f"  Email: {user.email}")
        print(f"  Name: {user.name or '(not set)'}")
        print(f"  Data folder: data/users/{user.id}/")
    else:
        print_error(error)


def cmd_list():
    """List all users."""
    print_header("All Users")
    users = db.get_all_users()
    print_user_table(users)
    print(f"\n  Total: {len(users)} users")


def cmd_disable(email: str):
    """Disable a user account."""
    print_header(f"Disable User: {email}")

    user = db.get_user_by_email(email.lower())
    if not user:
        print_error("User not found")
        return

    if not user.is_active:
        print("  User is already disabled")
        return

    confirm = input(f"\n  Disable account for {user.email}? (yes/no): ").strip().lower()
    if confirm != "yes":
        print("  Cancelled")
        return

    auth.disable_account(user.id)
    print_success(f"User {email} has been disabled")


def cmd_enable(email: str):
    """Enable a user account."""
    print_header(f"Enable User: {email}")

    user = db.get_user_by_email(email.lower())
    if not user:
        print_error("User not found")
        return

    if user.is_active and not user.locked_until:
        print("  User is already active")
        return

    auth.enable_account(user.id)
    print_success(f"User {email} has been enabled")


def cmd_reset_password(email: str):
    """Reset a user's password."""
    print_header(f"Reset Password: {email}")

    user = db.get_user_by_email(email.lower())
    if not user:
        print_error("User not found")
        return

    print(f"\n  Resetting password for: {user.email}")
    print("  Name: " + (user.name or "(not set)"))

    print("\n  Password requirements:")
    print("    - At least 8 characters")
    print("    - At least one letter")
    print("    - At least one number")

    password = getpass.getpass("\n  New password: ")
    if not password:
        print_error("Password is required")
        return

    password_confirm = getpass.getpass("  Confirm password: ")
    if password != password_confirm:
        print_error("Passwords do not match")
        return

    success, error = auth.reset_password(user.id, password)
    if success:
        print_success("Password has been reset")
    else:
        print_error(error)


def cmd_delete(email: str):
    """Delete a user and all their data (GDPR compliance)."""
    print_header(f"DELETE User: {email}")

    user = db.get_user_by_email(email.lower())
    if not user:
        print_error("User not found")
        return

    job_count = db.get_job_count_by_user(user.id)
    user_dir = auth.get_user_data_path(user.id)

    print(f"\n  WARNING: This will permanently delete:")
    print(f"    - User account: {user.email}")
    print(f"    - {job_count} job records")
    print(f"    - All audit logs for this user")
    print(f"    - All bug reports from this user")
    print(f"    - User data directory: {user_dir}")

    print("\n  This action CANNOT be undone!")

    confirm = input(f"\n  Type '{user.email}' to confirm deletion: ").strip()
    if confirm != user.email:
        print("  Cancelled")
        return

    # Delete user data directory
    if user_dir.exists():
        shutil.rmtree(user_dir)
        print(f"  Deleted directory: {user_dir}")

    # Delete from database
    db.delete_user(user.id)

    print_success(f"User {email} and all associated data have been permanently deleted")


def cmd_bugs():
    """List all bug reports."""
    print_header("Bug Reports")

    reports = db.get_all_bug_reports()
    if not reports:
        print("  No bug reports found.")
        return

    print(f"\n  {'ID':<10} {'Severity':<10} {'Status':<12} {'Title':<35} {'Created':<20}")
    print("  " + "-" * 95)

    for report in reports:
        short_id = report.id[:8]
        title = report.title[:33] + ".." if len(report.title) > 35 else report.title
        created = report.created_at[:19]

        # Color coding for severity
        severity = report.severity.upper()
        print(f"  {short_id:<10} {severity:<10} {report.status:<12} {title:<35} {created:<20}")

    print(f"\n  Total: {len(reports)} bug reports")


def cmd_bug_status(report_id: str, new_status: str):
    """Update a bug report status."""
    valid_statuses = ['new', 'in_progress', 'resolved', 'closed']

    if new_status.lower() not in valid_statuses:
        print_error(f"Invalid status. Valid options: {', '.join(valid_statuses)}")
        return

    # Find report by partial ID
    all_reports = db.get_all_bug_reports()
    matching = [r for r in all_reports if r.id.startswith(report_id)]

    if not matching:
        print_error(f"No bug report found with ID starting with '{report_id}'")
        return

    if len(matching) > 1:
        print_error(f"Multiple reports match '{report_id}'. Please be more specific.")
        for r in matching:
            print(f"    {r.id[:12]}... - {r.title[:40]}")
        return

    report = matching[0]

    print_header("Update Bug Report")
    print(f"\n  Report: {report.id[:12]}...")
    print(f"  Title: {report.title}")
    print(f"  Current status: {report.status}")
    print(f"  New status: {new_status}")

    notes = input("\n  Admin notes (optional): ").strip()

    db.update_bug_report_status(report.id, new_status.lower(), notes)
    print_success("Bug report status updated")


def print_help():
    """Print usage help."""
    print(__doc__)


def main():
    """Main entry point."""
    if len(sys.argv) < 2:
        print_help()
        return

    command = sys.argv[1].lower()

    if command == "create":
        cmd_create()
    elif command == "list":
        cmd_list()
    elif command == "disable":
        if len(sys.argv) < 3:
            print_error("Email required. Usage: python admin.py disable <email>")
        else:
            cmd_disable(sys.argv[2])
    elif command == "enable":
        if len(sys.argv) < 3:
            print_error("Email required. Usage: python admin.py enable <email>")
        else:
            cmd_enable(sys.argv[2])
    elif command == "reset-password":
        if len(sys.argv) < 3:
            print_error("Email required. Usage: python admin.py reset-password <email>")
        else:
            cmd_reset_password(sys.argv[2])
    elif command == "delete":
        if len(sys.argv) < 3:
            print_error("Email required. Usage: python admin.py delete <email>")
        else:
            cmd_delete(sys.argv[2])
    elif command == "bugs":
        cmd_bugs()
    elif command == "bug-status":
        if len(sys.argv) < 4:
            print_error("Usage: python admin.py bug-status <id> <status>")
            print("       Valid statuses: new, in_progress, resolved, closed")
        else:
            cmd_bug_status(sys.argv[2], sys.argv[3])
    elif command in ["help", "-h", "--help"]:
        print_help()
    else:
        print_error(f"Unknown command: {command}")
        print_help()


if __name__ == "__main__":
    main()
