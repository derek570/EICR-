#!/usr/bin/env python3
"""
EICR Certificate Editor - Streamlit Application
A web-based UI for editing EICR data and generating PDF certificates.
"""

import streamlit as st
import json
import csv
import os
import sys
import argparse
import subprocess
from pathlib import Path
from datetime import datetime
import pandas as pd
from eicr_pdf_generator import generate_eicr_pdf
from eic_pdf_generator import generate_eic_pdf, detect_bathroom_work
from generate_full_pdf import map_circuit_fields

# Authentication imports
import auth
import database as db
from models import User, BugReport
import uuid

# Parse command line arguments for user
def get_user_from_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--user', type=str, default='', help='User name (Derek or Michael)')
    # Parse known args to avoid conflicts with Streamlit's args
    args, _ = parser.parse_known_args()
    return args.user

CURRENT_USER = get_user_from_args()

# Page configuration
st.set_page_config(
    page_title="EICR Certificate Editor",
    page_icon="⚡",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Professional CSS Styling
st.markdown("""
<style>
    /* Color Variables */
    :root {
        --primary: #1E3A5F;
        --primary-light: #2C5282;
        --accent: #3498DB;
        --success: #27AE60;
        --warning: #F39C12;
        --danger: #E74C3C;
        --bg-light: #F8FAFC;
        --card-bg: #FFFFFF;
        --text-primary: #1A202C;
        --text-secondary: #4A5568;
        --border-color: #E2E8F0;
    }

    /* Main app styling */
    .stApp {
        background-color: #F8FAFC;
    }

    /* Header styling */
    .main-header {
        background: linear-gradient(135deg, #1E3A5F 0%, #2C5282 100%);
        padding: 1.5rem 2rem;
        border-radius: 12px;
        margin-bottom: 1.5rem;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }

    .main-header h1 {
        color: white !important;
        margin: 0 !important;
        font-weight: 600 !important;
    }

    /* Section headers */
    .section-header {
        color: #1E3A5F;
        font-weight: 600;
        font-size: 1.1rem;
        padding-bottom: 0.5rem;
        border-bottom: 2px solid #3498DB;
        margin-bottom: 1rem;
    }

    /* Card containers */
    .card {
        background: white;
        border-radius: 12px;
        padding: 1.5rem;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        border: 1px solid #E2E8F0;
        margin-bottom: 1rem;
    }

    /* Sidebar styling */
    [data-testid="stSidebar"] {
        background: linear-gradient(180deg, #1E3A5F 0%, #2C5282 100%);
    }

    [data-testid="stSidebar"] .stMarkdown,
    [data-testid="stSidebar"] .stMarkdown p,
    [data-testid="stSidebar"] .stMarkdown span {
        color: white !important;
    }

    [data-testid="stSidebar"] h1,
    [data-testid="stSidebar"] h2,
    [data-testid="stSidebar"] h3,
    [data-testid="stSidebar"] h4 {
        color: white !important;
    }

    [data-testid="stSidebar"] label,
    [data-testid="stSidebar"] .stSelectbox label,
    [data-testid="stSidebar"] .stRadio label,
    [data-testid="stSidebar"] .stRadio div[role="radiogroup"] label,
    [data-testid="stSidebar"] .stRadio div[role="radiogroup"] label p,
    [data-testid="stSidebar"] .stRadio div[role="radiogroup"] label span,
    [data-testid="stSidebar"] [data-testid="stWidgetLabel"],
    [data-testid="stSidebar"] [data-testid="stWidgetLabel"] p {
        color: white !important;
    }

    [data-testid="stSidebar"] .stAlert {
        background-color: rgba(255, 255, 255, 0.15) !important;
        border: 1px solid rgba(255, 255, 255, 0.3) !important;
    }

    [data-testid="stSidebar"] .stAlert p,
    [data-testid="stSidebar"] .stAlert span,
    [data-testid="stSidebar"] [data-testid="stAlertContentInfo"] p,
    [data-testid="stSidebar"] [data-testid="stAlertContentWarning"] p,
    [data-testid="stSidebar"] [data-testid="stAlertContentSuccess"] p {
        color: white !important;
    }

    [data-testid="stSidebar"] small,
    [data-testid="stSidebar"] .stCaption,
    [data-testid="stSidebar"] [data-testid="stCaptionContainer"] {
        color: rgba(255, 255, 255, 0.85) !important;
    }

    /* Button styling */
    .stButton > button {
        background: linear-gradient(135deg, #3498DB 0%, #2980B9 100%);
        color: white;
        border: none;
        border-radius: 8px;
        padding: 0.5rem 1.5rem;
        font-weight: 500;
        transition: all 0.2s ease;
        box-shadow: 0 2px 4px rgba(52, 152, 219, 0.3);
    }

    .stButton > button:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 8px rgba(52, 152, 219, 0.4);
    }

    .stButton > button[kind="primary"] {
        background: linear-gradient(135deg, #27AE60 0%, #219A52 100%);
        box-shadow: 0 2px 4px rgba(39, 174, 96, 0.3);
    }

    .stButton > button[kind="primary"]:hover {
        box-shadow: 0 4px 8px rgba(39, 174, 96, 0.4);
    }

    /* Tab styling */
    .stTabs [data-baseweb="tab-list"] {
        gap: 8px;
        background-color: #F1F5F9;
        padding: 0.5rem;
        border-radius: 10px;
    }

    .stTabs [data-baseweb="tab"] {
        background-color: transparent;
        border-radius: 8px;
        padding: 0.5rem 1rem;
        font-weight: 500;
        color: #4A5568;
    }

    .stTabs [aria-selected="true"] {
        background-color: white !important;
        color: #1E3A5F !important;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    /* Input fields */
    .stTextInput > div > div > input,
    .stTextArea > div > div > textarea,
    .stSelectbox > div > div {
        border-radius: 8px;
        border: 1px solid #E2E8F0;
        transition: border-color 0.2s ease;
    }

    .stTextInput > div > div > input:focus,
    .stTextArea > div > div > textarea:focus {
        border-color: #3498DB;
        box-shadow: 0 0 0 3px rgba(52, 152, 219, 0.1);
    }

    /* Metric cards */
    [data-testid="stMetric"] {
        background: white;
        border-radius: 10px;
        padding: 1rem;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        border: 1px solid #E2E8F0;
    }

    [data-testid="stMetric"] label {
        color: #4A5568 !important;
        font-weight: 500;
    }

    [data-testid="stMetric"] [data-testid="stMetricValue"] {
        color: #1E3A5F !important;
        font-weight: 700;
    }

    /* Data editor styling */
    .stDataFrame {
        border-radius: 10px;
        overflow: hidden;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    /* Freeze first two columns (Ref and Designation) in circuit editor */
    [data-testid="stDataFrame"] [data-testid="glideDataEditor"] > div:first-child {
        position: sticky !important;
        left: 0 !important;
        z-index: 1 !important;
        background: white !important;
    }

    /* Success/Info/Warning/Error messages */
    .stSuccess {
        background-color: #D4EDDA;
        border-left: 4px solid #27AE60;
        border-radius: 0 8px 8px 0;
    }

    .stInfo {
        background-color: #E8F4FD;
        border-left: 4px solid #3498DB;
        border-radius: 0 8px 8px 0;
    }

    .stWarning {
        background-color: #FFF3CD;
        border-left: 4px solid #F39C12;
        border-radius: 0 8px 8px 0;
    }

    .stError {
        background-color: #F8D7DA;
        border-left: 4px solid #E74C3C;
        border-radius: 0 8px 8px 0;
    }

    /* Observation code badges */
    .code-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        font-weight: 700;
        font-size: 1rem;
        color: white;
    }

    .code-c1 { background: linear-gradient(135deg, #E74C3C 0%, #C0392B 100%); }
    .code-c2 { background: linear-gradient(135deg, #F39C12 0%, #D68910 100%); }
    .code-c3 { background: linear-gradient(135deg, #3498DB 0%, #2980B9 100%); }
    .code-fi { background: linear-gradient(135deg, #9B59B6 0%, #8E44AD 100%); }

    /* Observation cards */
    .observation-card {
        background: white;
        border-radius: 12px;
        padding: 1rem 1.5rem;
        margin-bottom: 1rem;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
        border: 1px solid #E2E8F0;
        transition: all 0.2s ease;
    }

    .observation-card:hover {
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        transform: translateY(-2px);
    }

    /* Expander styling */
    .streamlit-expanderHeader {
        background-color: #F8FAFC;
        border-radius: 8px;
        font-weight: 500;
    }

    /* Sidebar expander text should be white */
    [data-testid="stSidebar"] .streamlit-expanderHeader,
    [data-testid="stSidebar"] .streamlit-expanderHeader p,
    [data-testid="stSidebar"] .streamlit-expanderHeader span,
    [data-testid="stSidebar"] [data-testid="stExpander"] summary,
    [data-testid="stSidebar"] [data-testid="stExpander"] summary span {
        color: white !important;
        background-color: transparent !important;
    }

    /* Dividers */
    hr {
        border: none;
        height: 1px;
        background: linear-gradient(90deg, transparent, #E2E8F0, transparent);
        margin: 1.5rem 0;
    }

    /* Hide Streamlit branding */
    #MainMenu {visibility: hidden;}
    footer {visibility: hidden;}

    /* Assessment badges */
    .assessment-satisfactory {
        background: linear-gradient(135deg, #27AE60 0%, #219A52 100%);
        color: white;
        padding: 0.75rem 2rem;
        border-radius: 50px;
        font-weight: 700;
        font-size: 1.5rem;
        display: inline-block;
        box-shadow: 0 4px 6px rgba(39, 174, 96, 0.3);
    }

    .assessment-unsatisfactory {
        background: linear-gradient(135deg, #E74C3C 0%, #C0392B 100%);
        color: white;
        padding: 0.75rem 2rem;
        border-radius: 50px;
        font-weight: 700;
        font-size: 1.5rem;
        display: inline-block;
        box-shadow: 0 4px 6px rgba(231, 76, 60, 0.3);
    }
</style>
""", unsafe_allow_html=True)


# ============================================================================
# AUTHENTICATION, DPA, AND BUG REPORTING
# ============================================================================

def show_login_page():
    """Display the login page."""
    st.markdown("""
    <div style="text-align: center; padding: 2rem;">
        <h1 style="color: #1E3A5F;">EICR-oMatic 3000</h1>
        <p style="color: #4A5568; font-size: 1.2rem;">Electrical Certificate Automation</p>
    </div>
    """, unsafe_allow_html=True)

    col1, col2, col3 = st.columns([1, 2, 1])
    with col2:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("Login")

        email = st.text_input("Email", key="login_email")
        password = st.text_input("Password", type="password", key="login_password")

        if st.button("Login", type="primary", use_container_width=True):
            if email and password:
                user, error = auth.authenticate(email, password)
                if user:
                    st.session_state.authenticated = True
                    st.session_state.user_id = user.id
                    st.session_state.user_email = user.email
                    st.session_state.user_name = user.name
                    st.session_state.session_created_at = datetime.utcnow().isoformat()
                    st.session_state.dpa_accepted = False
                    st.rerun()
                else:
                    st.error(error)
            else:
                st.warning("Please enter email and password")

        st.markdown('</div>', unsafe_allow_html=True)


def show_dpa_page():
    """Display the DPA acceptance page."""
    st.markdown("""
    <div style="text-align: center; padding: 1rem;">
        <h1 style="color: #1E3A5F;">Data Processing Agreement</h1>
        <p style="color: #4A5568;">Please read and accept the agreement to continue</p>
    </div>
    """, unsafe_allow_html=True)

    # Load DPA text
    dpa_path = Path(__file__).parent.parent / "config" / "dpa_text.md"
    if dpa_path.exists():
        dpa_text = dpa_path.read_text()
    else:
        dpa_text = "Data Processing Agreement text not found. Please contact the administrator."

    # Display DPA in scrollable container
    st.markdown("""
    <style>
        .dpa-container {
            max-height: 500px;
            overflow-y: auto;
            border: 1px solid #E2E8F0;
            border-radius: 8px;
            padding: 1.5rem;
            background: white;
            margin-bottom: 1rem;
        }
    </style>
    """, unsafe_allow_html=True)

    with st.container():
        st.markdown(f'<div class="dpa-container">{dpa_text}</div>', unsafe_allow_html=True)

    # Also render as markdown for proper formatting
    with st.expander("View Full Agreement (Formatted)", expanded=False):
        st.markdown(dpa_text)

    # Acceptance checkbox and button
    col1, col2, col3 = st.columns([1, 2, 1])
    with col2:
        accepted = st.checkbox("I have read and agree to the Data Processing Agreement", key="dpa_checkbox")

        if st.button("Continue", type="primary", use_container_width=True, disabled=not accepted):
            if accepted:
                st.session_state.dpa_accepted = True
                auth.log_dpa_acceptance(st.session_state.user_id)
                st.rerun()

    # Logout option
    st.markdown("---")
    if st.button("Logout"):
        do_logout()


def show_bug_report_form():
    """Show bug report form in sidebar."""
    with st.sidebar.expander("Report a Bug", expanded=False):
        st.markdown("##### Found an issue?")

        title = st.text_input("Title (required)", max_chars=100, key="bug_title")
        description = st.text_area("What were you trying to do? (required)", key="bug_description")
        actual = st.text_area("What happened instead? (required)", key="bug_actual")
        steps = st.text_area("Steps to reproduce (optional)", key="bug_steps")
        severity = st.selectbox("Severity", ["Low", "Medium", "High", "Critical"], key="bug_severity")
        screenshot = st.file_uploader("Screenshot (optional)", type=['png', 'jpg', 'jpeg'], key="bug_screenshot")

        if st.button("Submit Bug Report", key="submit_bug"):
            if not title or not description or not actual:
                st.error("Please fill in all required fields")
            else:
                # Create bug report
                user_id = st.session_state.get('user_id', 'unknown')
                report = BugReport(
                    user_id=user_id,
                    title=title,
                    description=description,
                    actual_behaviour=actual,
                    steps_to_reproduce=steps or "",
                    expected_behaviour="",
                    severity=severity.lower(),
                    page_context=st.session_state.get('current_job_folder', 'unknown')
                )

                # Save screenshot if provided
                if screenshot:
                    user_data_path = auth.get_user_data_path(user_id)
                    bug_dir = user_data_path / "bug_reports"
                    bug_dir.mkdir(parents=True, exist_ok=True)
                    screenshot_path = bug_dir / f"{report.id}.png"
                    screenshot_path.write_bytes(screenshot.read())
                    report.screenshot_path = str(screenshot_path)

                # Save to database
                db.create_bug_report(report)
                db.log_action(user_id, 'bug_report_submitted', {'bug_id': report.id})

                st.success(f"Bug report submitted! Reference: {report.id[:8]}")


def do_logout():
    """Perform logout and clear session."""
    user_id = st.session_state.get('user_id')
    if user_id:
        auth.log_logout(user_id)

    # Clear authentication-related session state
    for key in ['authenticated', 'user_id', 'user_email', 'user_name', 'session_created_at', 'dpa_accepted']:
        if key in st.session_state:
            del st.session_state[key]

    st.rerun()


def check_session_valid():
    """Check if current session is valid."""
    if not st.session_state.get('authenticated'):
        return False

    session_created = st.session_state.get('session_created_at')
    if not session_created or not auth.is_session_valid(session_created):
        do_logout()
        return False

    return True


def get_authenticated_user_path():
    """Get the data path for the authenticated user."""
    user_id = st.session_state.get('user_id')
    if user_id:
        return auth.get_user_data_path(user_id)
    return None


# ============= Secure File Upload Functions =============

# Allowed file extensions
ALLOWED_EXTENSIONS = {'.m4a', '.mp3', '.wav', '.webm', '.jpg', '.jpeg', '.png', '.heic'}

# Maximum file size (200MB)
MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024

# Magic bytes for file type validation
FILE_SIGNATURES = {
    # Audio formats
    b'\x00\x00\x00': 'mp4_container',  # M4A (part of MP4 container, need to check for ftyp)
    b'ID3': 'mp3',  # MP3 with ID3 tag
    b'\xff\xfb': 'mp3',  # MP3 frame sync
    b'\xff\xfa': 'mp3',  # MP3 frame sync
    b'\xff\xf3': 'mp3',  # MP3 frame sync
    b'\xff\xf2': 'mp3',  # MP3 frame sync
    b'RIFF': 'wav',  # WAV
    b'\x1a\x45\xdf\xa3': 'webm',  # WebM/Matroska
    # Image formats
    b'\xff\xd8\xff': 'jpeg',  # JPEG
    b'\x89PNG\r\n\x1a\n': 'png',  # PNG
    b'\x00\x00\x00\x0cjP': 'heic',  # HEIC (part of HEIF)
}


def sanitise_filename(filename: str) -> str:
    """
    Sanitise filename to prevent path traversal and injection attacks.
    Removes path separators, null bytes, and non-safe characters.
    """
    import re
    # Get just the filename without any path components
    filename = os.path.basename(filename)
    # Remove null bytes
    filename = filename.replace('\x00', '')
    # Keep only safe characters: alphanumeric, dots, underscores, hyphens
    filename = re.sub(r'[^a-zA-Z0-9._-]', '_', filename)
    # Prevent hidden files
    filename = filename.lstrip('.')
    # Limit length
    if len(filename) > 200:
        name, ext = os.path.splitext(filename)
        filename = name[:200-len(ext)] + ext
    # Ensure filename is not empty
    if not filename:
        filename = 'unnamed_file'
    return filename


def validate_file_extension(filename: str) -> bool:
    """Check if file extension is in allowed list."""
    ext = os.path.splitext(filename.lower())[1]
    return ext in ALLOWED_EXTENSIONS


def validate_file_content(file_bytes: bytes, filename: str) -> bool:
    """
    Validate file type by checking magic bytes, not just extension.
    Returns True if file content matches expected type.
    """
    if len(file_bytes) < 12:
        return False

    ext = os.path.splitext(filename.lower())[1]
    header = file_bytes[:12]

    # Check for M4A/MP4 container (has 'ftyp' marker at byte 4)
    if ext == '.m4a':
        if len(file_bytes) >= 8 and file_bytes[4:8] == b'ftyp':
            return True
        return False

    # Check for MP3
    if ext == '.mp3':
        if header[:3] == b'ID3':  # ID3 tag
            return True
        if header[:2] in (b'\xff\xfb', b'\xff\xfa', b'\xff\xf3', b'\xff\xf2'):  # Frame sync
            return True
        return False

    # Check for WAV
    if ext == '.wav':
        if header[:4] == b'RIFF' and file_bytes[8:12] == b'WAVE':
            return True
        return False

    # Check for WebM
    if ext == '.webm':
        if header[:4] == b'\x1a\x45\xdf\xa3':  # EBML header
            return True
        return False

    # Check for JPEG
    if ext in ('.jpg', '.jpeg'):
        if header[:3] == b'\xff\xd8\xff':
            return True
        return False

    # Check for PNG
    if ext == '.png':
        if header[:8] == b'\x89PNG\r\n\x1a\n':
            return True
        return False

    # Check for HEIC
    if ext == '.heic':
        # HEIC files have 'ftyp' at byte 4 with heic/heix/hevc brand
        if len(file_bytes) >= 12 and file_bytes[4:8] == b'ftyp':
            brand = file_bytes[8:12]
            if brand in (b'heic', b'heix', b'hevc', b'mif1'):
                return True
        return False

    return False


def validate_file_size(file_size: int) -> bool:
    """Check if file size is within allowed limit."""
    return file_size <= MAX_FILE_SIZE_BYTES


def create_job_folder(user_id: str) -> tuple:
    """
    Create a job folder with timestamp in user's INCOMING directory.
    Returns (folder_path, folder_name) or (None, None) on failure.
    """
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    folder_name = f'job_{timestamp}'
    folder_path = auth.get_user_data_path(user_id) / 'INCOMING' / folder_name

    try:
        folder_path.mkdir(parents=True, exist_ok=True)
        return folder_path, folder_name
    except Exception:
        return None, None


def process_uploaded_job(job_folder_path: Path) -> tuple:
    """
    Process an uploaded job by calling run_job.js.
    Returns (success, stdout, stderr).
    """
    # Get absolute path to run_job.js
    project_root = Path(__file__).parent.parent.resolve()
    run_job_script = project_root / 'run_job.js'

    if not run_job_script.exists():
        return False, '', f'run_job.js not found at {run_job_script}'

    try:
        result = subprocess.run(
            ['node', str(run_job_script), str(job_folder_path.resolve())],
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=600  # 10 minute timeout
        )
        return result.returncode == 0, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return False, '', 'Processing timed out after 10 minutes'
    except FileNotFoundError:
        return False, '', 'Node.js not found. Please install Node.js.'
    except Exception as e:
        return False, '', str(e)


# Initialize session state for authentication
if 'authenticated' not in st.session_state:
    st.session_state.authenticated = False
if 'dpa_accepted' not in st.session_state:
    st.session_state.dpa_accepted = False

# Authentication flow
if not check_session_valid():
    show_login_page()
    st.stop()

if not st.session_state.get('dpa_accepted', False):
    show_dpa_page()
    st.stop()


# Constants for dropdown options
EARTHING_ARRANGEMENTS = ["TN-S", "TN-C-S", "TT", "IT", "TN-C"]
LIVE_CONDUCTORS = ["AC - 1-phase (2 wire)", "AC - 1-phase (3 wire)", "AC - 3-phase (3 wire)", "AC - 3-phase (4 wire)", "DC - 2 pole", "DC - 3 pole"]
VOLTAGES = ["230", "400", "110", "N/A", "Other"]
FREQUENCIES = ["50", "60", "N/A"]
BS_EN_OPTIONS = ["LIM", "UNKNOWN", "88", "88-2", "88-3", "88-5", "1361-I", "1361-II", "3036-S1A", "3036-S2A", "3036-S4A",
                 "60898-B", "60898-C", "60898-D", "61009-B", "61009-C", "61009-D", "60947-2", "62423-F", "62423-B",
                 "4293", "5419", "N/A", "Other"]
OCPD_TYPES = ["B", "C", "D", "gG", "gM", "aM", "N/A"]
RCD_TYPES = ["A", "AC", "F", "B", "N/A"]
CONDUCTOR_MATERIALS = ["Copper", "Aluminium", "N/A"]
OBSERVATION_CODES = ["C1", "C2", "C3", "FI"]

# Inspection schedule items for linking observations
SCHEDULE_ITEMS = {
    "1.1": "Intake equipment - Service cable, Service head, Earthing arrangement",
    "1.2": "Consumer's isolator (where present)",
    "1.3": "Consumer's meter tails",
    "3.1": "Presence and condition of distributor's earthing arrangements",
    "3.2": "Presence and condition of earth electrode connection",
    "3.3": "Provision of earthing/bonding labels at all appropriate locations",
    "3.4": "Confirmation of earthing conductor size",
    "3.5": "Accessibility and condition of earthing conductor at MET",
    "3.6": "Confirmation of main protective bonding conductor sizes",
    "3.7": "Condition and accessibility of main protective bonding connections",
    "3.8": "Accessibility and condition of other protective bonding connections",
    "4.1": "Adequacy of working space/accessibility to consumer unit",
    "4.2": "Security of fixing",
    "4.3": "Condition of enclosure(s) in terms of IP rating",
    "4.4": "Condition of enclosure(s) in terms of fire rating",
    "4.5": "Enclosure not damaged/deteriorated so as to impair safety",
    "4.6": "Presence of main linked switch",
    "4.7": "Operation of main switch (functional check)",
    "4.8": "Manual operation of circuit breakers and RCDs",
    "4.9": "Correct identification of circuit details and protective devices",
    "4.10": "Presence of RCD six-monthly test notice",
    "4.17": "RCD(s) provided for fault protection",
    "4.18": "RCD(s) provided for additional protection",
    "4.20": "Confirmation that ALL conductor connections are secure",
    "5.1": "Identification of conductors",
    "5.2": "Cables correctly supported throughout their run",
    "5.3": "Condition of insulation of live parts",
    "5.4": "Non sheathed cables protected by enclosure",
    "5.5": "Adequacy of cables for current carrying capacity",
    "5.6": "Coordination between conductors and overload protective devices",
    "5.7": "Adequacy of protective devices for fault protection",
    "5.8": "Presence and adequacy of circuit protective conductors",
    "5.10": "Concealed cables installed in prescribed zones",
    "5.12.1": "RCD protection for socket outlets 32A or less",
    "5.12.2": "RCD for mobile equipment outdoors",
    "5.12.3": "RCD for cables concealed in walls < 50mm",
    "5.12.4": "RCD for final circuits supplying luminaires (domestic)",
    "5.18": "Condition of accessories including socket-outlets, switches",
    "5.19": "Suitability of accessories for external influences",
    "6.1": "Additional protection for all low voltage circuits by RCD (bath/shower)",
    "6.4": "Presence of supplementary bonding conductors",
    "6.6": "Suitability of equipment for IP rating (bath/shower)",
}

# EIC Inspection Schedule Items (simplified 14-item version for new installations)
EIC_SCHEDULE_ITEMS = {
    "1.0": "Condition of consumer's intake equipment (Visual inspection only)",
    "2.0": "Parallel or switched alternative sources of supply",
    "3.0": "Protective measure: Automatic disconnection of supply",
    "4.0": "Basic protection",
    "5.0": "Protective measures other than ADS",
    "6.0": "Additional protection",
    "7.0": "Distribution equipment",
    "8.0": "Circuits (Distribution and final)",
    "9.0": "Isolation and switching",
    "10.0": "Current using equipment (permanently connected)",
    "11.0": "Identification and notices",
    "12.0": "Location(s) containing a bath or shower",
    "13.0": "Other special installations or locations",
    "14.0": "Prosumer's low voltage electrical installation(s)",
}

# Installation types for EIC
INSTALLATION_TYPES = ["new_installation", "addition", "alteration"]
INSTALLATION_TYPE_LABELS = {
    "new_installation": "New installation",
    "addition": "An addition to an existing installation",
    "alteration": "An alteration to an existing installation"
}


def sync_inline_observations_to_main():
    """
    Synchronize inline observation data to the main observations list.
    Call this before saving or generating PDFs.
    """
    if 'inline_obs_data' not in st.session_state:
        return
    if 'observations' not in st.session_state:
        st.session_state.observations = []
    if 'inspection_items' not in st.session_state:
        return

    for item_id, obs_data in st.session_state.inline_obs_data.items():
        current_code = st.session_state.inspection_items.get(item_id, "tick")

        # Only sync if code is C1/C2/C3 and has meaningful data (text)
        if current_code in ["C1", "C2", "C3"] and obs_data.get("text"):
            # Check if observation already exists for this schedule item
            existing_idx = None
            for idx, obs in enumerate(st.session_state.observations):
                if obs.get("schedule_item") == item_id:
                    existing_idx = idx
                    break

            # Parse regulations from comma-separated string
            regs_str = obs_data.get("regs", "")
            regs_list = [r.strip() for r in regs_str.split(",") if r.strip()] if regs_str else []

            # Build observation dict
            new_obs = {
                "title": obs_data.get("title", ""),
                "text": obs_data.get("text", ""),
                "regs": regs_list,
                "code": current_code,
                "schedule_item": item_id,
            }
            if obs_data.get("photo"):
                new_obs["photo"] = obs_data["photo"]

            if existing_idx is not None:
                st.session_state.observations[existing_idx] = new_obs
            else:
                st.session_state.observations.append(new_obs)


def infer_cable_sizes(circuits: list) -> list:
    """
    Automatically infer cable sizes based on circuit type and rating.

    Rules:
    - Lighting circuits: 1mm² live, 1mm² CPC
    - Radial 16A or 20A circuits: 2.5mm² live, 1.5mm² CPC
    - Socket ring circuits on 32A breaker: 2.5mm² live, 1.5mm² CPC
    - Cooker circuits: 6mm² live, 2.5mm² CPC
    """
    for circuit in circuits:
        designation = circuit.get('circuit_designation', '').lower()
        rating = circuit.get('ocpd_rating_a', '')

        # Skip if cable sizes already set
        if circuit.get('live_csa') and circuit.get('cpc_csa'):
            continue

        # Lighting circuits - 1mm² live, 1mm² CPC
        if any(term in designation for term in ['light', 'lighting', 'lamp']):
            circuit['live_csa'] = '1.0'
            circuit['cpc_csa'] = '1.0'

        # Cooker circuits - 6mm² live, 2.5mm² CPC
        elif any(term in designation for term in ['cooker', 'oven', 'hob', 'range']):
            circuit['live_csa'] = '6.0'
            circuit['cpc_csa'] = '2.5'

        # Shower circuits - typically 10mm² live, 4mm² CPC
        elif 'shower' in designation:
            circuit['live_csa'] = '10.0'
            circuit['cpc_csa'] = '4.0'

        # Ring circuits on 32A - 2.5mm² live, 1.5mm² CPC
        elif 'ring' in designation and rating == '32':
            circuit['live_csa'] = '2.5'
            circuit['cpc_csa'] = '1.5'

        # Socket/radial circuits on 16A or 20A - 2.5mm² live, 1.5mm² CPC
        elif any(term in designation for term in ['socket', 'radial', 'spur', 'fcu']) and rating in ['16', '20']:
            circuit['live_csa'] = '2.5'
            circuit['cpc_csa'] = '1.5'

        # Default for 32A socket circuits (assume ring) - 2.5mm² live, 1.5mm² CPC
        elif any(term in designation for term in ['socket', 'ring']) and rating == '32':
            circuit['live_csa'] = '2.5'
            circuit['cpc_csa'] = '1.5'

        # Immersion heater - typically 2.5mm², 1.5mm CPC
        elif any(term in designation for term in ['immersion', 'water heater']):
            circuit['live_csa'] = '2.5'
            circuit['cpc_csa'] = '1.5'

    return circuits


def load_json_file(filepath: Path) -> dict:
    """Load a JSON file, return empty dict if not found."""
    if filepath.exists():
        with open(filepath, 'r') as f:
            return json.load(f)
    return {}


def load_csv_file(filepath: Path) -> list:
    """Load a CSV file as list of dicts."""
    if filepath.exists():
        with open(filepath, 'r') as f:
            reader = csv.DictReader(f)
            return list(reader)
    return []


def save_json_file(filepath: Path, data: dict):
    """Save data to JSON file."""
    with open(filepath, 'w') as f:
        json.dump(data, f, indent=2)


def save_csv_file(filepath: Path, data: list, fieldnames: list):
    """Save data to CSV file."""
    with open(filepath, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(data)


def get_output_directories(base_path: Path, user: str = "") -> list:
    """Get list of output directories for a specific user."""
    folder_name = f"data/OUTPUT_{user}" if user else "data/OUTPUT"
    output_dir = base_path / folder_name
    if output_dir.exists():
        return [d.name for d in output_dir.iterdir() if d.is_dir() and not d.name.startswith('.')]
    return []


def get_available_users(base_path: Path) -> list:
    """Get list of available users based on OUTPUT folders."""
    users = []
    data_path = base_path / "data"
    if data_path.exists():
        for folder in data_path.iterdir():
            if folder.is_dir() and folder.name.startswith("OUTPUT_"):
                user = folder.name.replace("OUTPUT_", "")
                users.append(user)
    # Add default (no user) if OUTPUT folder exists
    if (base_path / "data" / "OUTPUT").exists():
        users.insert(0, "")
    return users if users else [""]


def load_inspector_profiles(base_path: Path) -> dict:
    """Load inspector profiles from JSON file."""
    profiles_file = base_path / "config" / "inspector_profiles.json"
    if profiles_file.exists():
        with open(profiles_file, 'r') as f:
            return json.load(f)
    return {"profiles": [], "last_selected": None}


def save_inspector_profiles(base_path: Path, profiles_data: dict):
    """Save inspector profiles to JSON file."""
    profiles_file = base_path / "config" / "inspector_profiles.json"
    with open(profiles_file, 'w') as f:
        json.dump(profiles_data, f, indent=2)


def get_inspector_by_id(profiles_data: dict, inspector_id: str) -> dict:
    """Get an inspector profile by ID."""
    for profile in profiles_data.get("profiles", []):
        if profile.get("id") == inspector_id:
            return profile
    return None


def load_company_settings(base_path: Path, user: str) -> dict:
    """Load company settings for a specific user."""
    if user:
        settings_file = base_path / "config" / f"company_settings_{user}.json"
    else:
        settings_file = base_path / "config" / "company_settings.json"

    if settings_file.exists():
        with open(settings_file, 'r') as f:
            return json.load(f)
    return {
        "company_name": "",
        "company_address": "",
        "company_phone": "",
        "company_email": "",
        "company_website": "",
        "company_registration": "",
        "logo_file": None
    }


def save_company_settings(base_path: Path, user: str, settings: dict):
    """Save company settings for a specific user."""
    if user:
        settings_file = base_path / "config" / f"company_settings_{user}.json"
    else:
        settings_file = base_path / "config" / "company_settings.json"

    with open(settings_file, 'w') as f:
        json.dump(settings, f, indent=2)


# ============================================================================
# USER DEFAULTS FEATURE
# ============================================================================

# Field definitions for the "Set as Defaults" feature
# Maps field categories to their session state keys and config paths
SAVABLE_FIELDS = {
    "Installation Details": {
        "premises_desc": {
            "label": "Description of Premises",
            "session_key": "premises_desc",
            "config_path": ["installation_details", "description_of_premises"]
        },
        "next_inspection": {
            "label": "Next Inspection (years)",
            "session_key": "next_inspection",
            "config_path": ["installation_details", "next_inspection_years"]
        },
        "records_available": {
            "label": "Installation Records Available",
            "session_key": "records_available",
            "config_path": ["installation_details", "installation_records_available"]
        },
        "additions_alterations": {
            "label": "Evidence of Additions/Alterations",
            "session_key": "additions_alterations",
            "config_path": ["installation_details", "evidence_of_additions_alterations"]
        }
    },
    "Extent & Limitations": {
        "extent": {
            "label": "Extent of Installation",
            "session_key": "extent",
            "config_path": ["extent_and_limitations", "extent"]
        },
        "agreed_limitations": {
            "label": "Agreed Limitations",
            "session_key": "agreed_limitations",
            "config_path": ["extent_and_limitations", "agreed_limitations"]
        },
        "agreed_with": {
            "label": "Agreed With",
            "session_key": "agreed_with",
            "config_path": ["extent_and_limitations", "agreed_with"]
        },
        "operational_limitations": {
            "label": "Operational Limitations",
            "session_key": "operational_limitations",
            "config_path": ["extent_and_limitations", "operational_limitations"]
        }
    },
    "Supply Characteristics": {
        "earthing": {
            "label": "Earthing Arrangement",
            "session_key": "earthing",
            "config_path": ["supply_characteristics", "earthing_arrangement"]
        },
        "live_conductors": {
            "label": "Live Conductors",
            "session_key": "live_conductors",
            "config_path": ["supply_characteristics", "live_conductors"]
        },
        "nominal_voltage_u": {
            "label": "Nominal Voltage U",
            "session_key": "nominal_voltage_u",
            "config_path": ["supply_characteristics", "nominal_voltage_u"]
        },
        "nominal_voltage_uo": {
            "label": "Nominal Voltage Uo",
            "session_key": "nominal_voltage_uo",
            "config_path": ["supply_characteristics", "nominal_voltage_uo"]
        },
        "nominal_frequency": {
            "label": "Nominal Frequency",
            "session_key": "nominal_frequency",
            "config_path": ["supply_characteristics", "nominal_frequency"]
        },
        "number_of_supplies": {
            "label": "Number of Supplies",
            "session_key": "number_of_supplies",
            "config_path": ["supply_characteristics", "number_of_supplies"]
        },
        "polarity_confirmed": {
            "label": "Supply Polarity Confirmed",
            "session_key": "polarity_confirmed",
            "config_path": ["supply_characteristics", "supply_polarity_confirmed"]
        }
    },
    "Main Switch": {
        "ms_bs_en": {
            "label": "Type BS(EN)",
            "session_key": "ms_bs_en",
            "config_path": ["particulars_of_installation", "main_switch", "type_bs_en"]
        },
        "ms_poles": {
            "label": "Number of Poles",
            "session_key": "ms_poles",
            "config_path": ["particulars_of_installation", "main_switch", "number_of_poles"]
        },
        "ms_voltage": {
            "label": "Voltage Rating",
            "session_key": "ms_voltage",
            "config_path": ["particulars_of_installation", "main_switch", "voltage_rating"]
        },
        "ms_current": {
            "label": "Rated Current",
            "session_key": "ms_current",
            "config_path": ["particulars_of_installation", "main_switch", "rated_current"]
        }
    },
    "Conductor Details": {
        "tails_material": {
            "label": "Tails Material",
            "session_key": "tails_material",
            "config_path": ["particulars_of_installation", "tails", "material"]
        },
        "tails_csa": {
            "label": "Tails CSA (mm2)",
            "session_key": "tails_csa",
            "config_path": ["particulars_of_installation", "tails", "csa"]
        },
        "ec_material": {
            "label": "Earthing Conductor Material",
            "session_key": "ec_material",
            "config_path": ["particulars_of_installation", "earthing_conductor", "material"]
        },
        "ec_csa": {
            "label": "Earthing Conductor CSA (mm2)",
            "session_key": "ec_csa",
            "config_path": ["particulars_of_installation", "earthing_conductor", "csa"]
        },
        "mpb_material": {
            "label": "Bonding Conductor Material",
            "session_key": "mpb_material",
            "config_path": ["particulars_of_installation", "main_protective_bonding", "material"]
        },
        "mpb_csa": {
            "label": "Bonding Conductor CSA (mm2)",
            "session_key": "mpb_csa",
            "config_path": ["particulars_of_installation", "main_protective_bonding", "csa"]
        }
    },
    "Bonding": {
        "bond_water": {
            "label": "Water Bonding",
            "session_key": "bond_water",
            "config_path": ["particulars_of_installation", "bonding_of_extraneous_parts", "water"]
        },
        "bond_gas": {
            "label": "Gas Bonding",
            "session_key": "bond_gas",
            "config_path": ["particulars_of_installation", "bonding_of_extraneous_parts", "gas"]
        },
        "bond_oil": {
            "label": "Oil Bonding",
            "session_key": "bond_oil",
            "config_path": ["particulars_of_installation", "bonding_of_extraneous_parts", "oil"]
        },
        "bond_steel": {
            "label": "Steel Bonding",
            "session_key": "bond_steel",
            "config_path": ["particulars_of_installation", "bonding_of_extraneous_parts", "steel"]
        },
        "bond_lightning": {
            "label": "Lightning Bonding",
            "session_key": "bond_lightning",
            "config_path": ["particulars_of_installation", "bonding_of_extraneous_parts", "lightning"]
        }
    },
    "SPD Settings": {
        "spd_type_board": {
            "label": "SPD Type",
            "session_key": "spd_type_board",
            "config_path": ["particulars_of_installation", "spd", "type"]
        },
        "spd_status": {
            "label": "SPD Status",
            "session_key": "spd_status",
            "config_path": ["particulars_of_installation", "spd", "status"]
        }
    }
}

# Circuit template fields that can be saved as defaults
CIRCUIT_TEMPLATE_FIELDS = {
    "wiring_type": {"label": "Wiring Type", "type": "select", "options": ["A", "B", "C", "D"]},
    "ref_method": {"label": "Reference Method", "type": "select", "options": ["A", "B", "C", "D"]},
    "live_csa_mm2": {"label": "Live CSA (mm2)", "type": "text"},
    "cpc_csa_mm2": {"label": "CPC CSA (mm2)", "type": "text"},
    "max_disconnect_time_s": {"label": "Max Disconnect Time (s)", "type": "text"},
    "ocpd_bs_en": {"label": "OCPD BS/EN", "type": "text"},
    "ocpd_type": {"label": "OCPD Type", "type": "select", "options": ["B", "C", "D", "gG", "gM"]},
    "ocpd_breaking_capacity_ka": {"label": "Breaking Capacity (kA)", "type": "text"},
    "rcd_bs_en": {"label": "RCD BS/EN", "type": "text"},
    "rcd_type": {"label": "RCD Type", "type": "select", "options": ["", "AC", "A", "F", "B", "S"]},
    "rcd_operating_current_ma": {"label": "RCD Operating Current (mA)", "type": "text"},
    "ir_test_voltage_v": {"label": "IR Test Voltage (V)", "type": "text"},
    "polarity_confirmed": {"label": "Polarity Confirmed", "type": "select", "options": ["", "Y", "N"]}
}


def load_user_defaults(base_path: Path, user: str) -> dict:
    """Load user-specific certificate defaults."""
    if not user:
        return {}
    defaults_file = base_path / "config" / f"user_defaults_{user}.json"
    if defaults_file.exists():
        with open(defaults_file, 'r') as f:
            return json.load(f)
    return {}


def save_user_defaults(base_path: Path, user: str, defaults: dict):
    """Save user-specific certificate defaults."""
    if not user:
        return
    defaults_file = base_path / "config" / f"user_defaults_{user}.json"
    with open(defaults_file, 'w') as f:
        json.dump(defaults, f, indent=2)


def get_nested_value(data: dict, path: list, default=None):
    """Get a value from a nested dictionary using a path list."""
    current = data
    for key in path:
        if isinstance(current, dict) and key in current:
            current = current[key]
        else:
            return default
    return current


def set_nested_value(data: dict, path: list, value):
    """Set a value in a nested dictionary using a path list."""
    current = data
    for key in path[:-1]:
        if key not in current:
            current[key] = {}
        current = current[key]
    current[path[-1]] = value


def build_defaults_selection_data(cert_type: str) -> dict:
    """
    Build a dictionary of current field values from session state for the selection dialog.
    Returns dict mapping field_key -> {"label": str, "value": any, "group": str}
    """
    selection_data = {}

    for group_name, fields in SAVABLE_FIELDS.items():
        for field_key, field_info in fields.items():
            current_value = st.session_state.get(field_info["session_key"], "")
            selection_data[field_key] = {
                "label": field_info["label"],
                "value": current_value,
                "group": group_name,
                "config_path": field_info["config_path"]
            }

    # Add inspection schedule items
    if cert_type == "EIC":
        items = st.session_state.get('eic_inspection_items', {})
    else:
        items = st.session_state.get('inspection_items', {})

    selection_data["inspection_schedule"] = {
        "label": "Inspection Schedule Items",
        "value": items,
        "group": "Inspection Schedule",
        "is_schedule": True
    }

    return selection_data


def apply_user_defaults_to_session(user_defaults: dict, cert_type: str):
    """Apply user defaults to session state for fields not already set."""
    cert_defaults = user_defaults.get(cert_type.lower(), {})
    if not cert_defaults:
        return

    for group_name, fields in SAVABLE_FIELDS.items():
        for field_key, field_info in fields.items():
            session_key = field_info["session_key"]
            # Only apply if not already set
            if session_key not in st.session_state or st.session_state[session_key] in [None, "", []]:
                default_value = get_nested_value(cert_defaults, field_info["config_path"])
                if default_value is not None:
                    st.session_state[session_key] = default_value

    # Apply inspection schedule defaults
    schedule_defaults = cert_defaults.get("inspection_schedule", {}).get("items", {})
    if schedule_defaults:
        if cert_type == "EIC":
            if 'eic_inspection_items' not in st.session_state:
                st.session_state.eic_inspection_items = schedule_defaults
        else:
            if 'inspection_items' not in st.session_state:
                st.session_state.inspection_items = schedule_defaults

    # Apply circuit template defaults to session state
    circuit_template = cert_defaults.get("circuit_template", {})
    if circuit_template:
        st.session_state.circuit_template_defaults = circuit_template


def apply_circuit_template_to_circuits(circuits: list, circuit_template: dict) -> list:
    """Apply circuit template defaults to circuits that are missing those fields.

    This function preserves any values that came from transcript extraction
    while filling in missing fields with user defaults.
    """
    if not circuit_template or not circuits:
        return circuits

    for circuit in circuits:
        for field_key, default_value in circuit_template.items():
            # Only apply if the field is empty/missing in the circuit
            current_value = circuit.get(field_key, "")
            if current_value in [None, "", "N/A"]:
                circuit[field_key] = default_value

    return circuits


def get_index_from_options(options: list, value, default=0) -> int:
    """Get the index of a value in options list, or default if not found."""
    try:
        return options.index(value)
    except (ValueError, TypeError):
        return default


def save_defaults_from_form(base_path: Path, user: str, cert_type: str):
    """Save the defaults form values to the user defaults file."""
    if not user:
        return

    user_defaults = load_user_defaults(base_path, user)
    cert_key = cert_type.lower()

    if cert_key not in user_defaults:
        user_defaults[cert_key] = {}

    user_defaults[cert_key]["last_updated"] = datetime.now().isoformat()

    # Map form keys to config paths
    mappings = [
        ("def_premises_desc", ["installation_details", "description_of_premises"]),
        ("def_next_inspection", ["installation_details", "next_inspection_years"]),
        ("def_records_available", ["installation_details", "installation_records_available"]),
        ("def_additions_alterations", ["installation_details", "evidence_of_additions_alterations"]),
        ("def_extent", ["extent_and_limitations", "extent"]),
        ("def_agreed_limitations", ["extent_and_limitations", "agreed_limitations"]),
        ("def_agreed_with", ["extent_and_limitations", "agreed_with"]),
        ("def_operational_limitations", ["extent_and_limitations", "operational_limitations"]),
        ("def_earthing", ["supply_characteristics", "earthing_arrangement"]),
        ("def_live_conductors", ["supply_characteristics", "live_conductors"]),
        ("def_nominal_voltage_u", ["supply_characteristics", "nominal_voltage_u"]),
        ("def_nominal_voltage_uo", ["supply_characteristics", "nominal_voltage_uo"]),
        ("def_nominal_frequency", ["supply_characteristics", "nominal_frequency"]),
        ("def_number_of_supplies", ["supply_characteristics", "number_of_supplies"]),
        ("def_polarity_confirmed", ["supply_characteristics", "supply_polarity_confirmed"]),
        ("def_ms_bs_en", ["particulars_of_installation", "main_switch", "type_bs_en"]),
        ("def_ms_poles", ["particulars_of_installation", "main_switch", "number_of_poles"]),
        ("def_ms_voltage", ["particulars_of_installation", "main_switch", "voltage_rating"]),
        ("def_ms_current", ["particulars_of_installation", "main_switch", "rated_current"]),
        ("def_tails_material", ["particulars_of_installation", "tails", "material"]),
        ("def_tails_csa", ["particulars_of_installation", "tails", "csa"]),
        ("def_ec_material", ["particulars_of_installation", "earthing_conductor", "material"]),
        ("def_ec_csa", ["particulars_of_installation", "earthing_conductor", "csa"]),
        ("def_mpb_material", ["particulars_of_installation", "main_protective_bonding", "material"]),
        ("def_mpb_csa", ["particulars_of_installation", "main_protective_bonding", "csa"]),
        ("def_bond_water", ["particulars_of_installation", "bonding_of_extraneous_parts", "water"]),
        ("def_bond_gas", ["particulars_of_installation", "bonding_of_extraneous_parts", "gas"]),
        ("def_bond_oil", ["particulars_of_installation", "bonding_of_extraneous_parts", "oil"]),
        ("def_bond_steel", ["particulars_of_installation", "bonding_of_extraneous_parts", "steel"]),
        ("def_bond_lightning", ["particulars_of_installation", "bonding_of_extraneous_parts", "lightning"]),
        ("def_spd_type_board", ["particulars_of_installation", "spd", "type"]),
        ("def_spd_status", ["particulars_of_installation", "spd", "status"]),
    ]

    for session_key, config_path in mappings:
        value = st.session_state.get(session_key)
        if value is not None and value != "":
            set_nested_value(user_defaults[cert_key], config_path, value)

    # Save circuit template
    circuit_template = {}
    circuit_mappings = [
        ("def_circuit_wiring_type", "wiring_type"),
        ("def_circuit_ref_method", "ref_method"),
        ("def_circuit_disconnect_time", "max_disconnect_time_s"),
        ("def_circuit_live_csa", "live_csa_mm2"),
        ("def_circuit_cpc_csa", "cpc_csa_mm2"),
        ("def_circuit_ir_voltage", "ir_test_voltage_v"),
        ("def_circuit_ocpd_bs_en", "ocpd_bs_en"),
        ("def_circuit_ocpd_type", "ocpd_type"),
        ("def_circuit_breaking_capacity", "ocpd_breaking_capacity_ka"),
        ("def_circuit_rcd_bs_en", "rcd_bs_en"),
        ("def_circuit_rcd_type", "rcd_type"),
        ("def_circuit_rcd_ma", "rcd_operating_current_ma"),
    ]

    for session_key, template_key in circuit_mappings:
        value = st.session_state.get(session_key)
        if value is not None and value != "":
            circuit_template[template_key] = value

    if circuit_template:
        user_defaults[cert_key]["circuit_template"] = circuit_template

    save_user_defaults(base_path, user, user_defaults)


def render_defaults_tab(base_path: Path, user: str, job_loaded: bool = True):
    """Render the defaults configuration tab.

    Args:
        base_path: Path to the EICR_App directory
        user: Current user name
        job_loaded: If True, show option to copy from current job values
    """
    cert_type = st.session_state.get('certificate_type', 'EICR')

    st.markdown('<p class="section-header">Certificate Defaults Configuration</p>', unsafe_allow_html=True)

    st.info(f"Configure your default values for {cert_type} certificates. "
            "These values will automatically populate new certificates (unless transcript data is available).")

    # Load existing defaults
    user_defaults = load_user_defaults(base_path, user) if user else {}
    cert_defaults = user_defaults.get(cert_type.lower(), {})

    # Show last updated time if available
    if cert_defaults.get("last_updated"):
        st.caption(f"Last updated: {cert_defaults['last_updated']}")

    # Certificate type selector (when no job loaded)
    if not job_loaded:
        cert_type = st.selectbox(
            "Certificate Type",
            options=["EICR", "EIC"],
            index=0 if cert_type == "EICR" else 1,
            key="defaults_cert_type_selector"
        )
        st.session_state.certificate_type = cert_type
        cert_defaults = user_defaults.get(cert_type.lower(), {})

    # Quick actions row
    col1, col2, col3 = st.columns(3)
    with col1:
        if cert_defaults and st.button("Delete Saved Defaults", type="secondary"):
            if user:
                user_defaults = load_user_defaults(base_path, user)
                if cert_type.lower() in user_defaults:
                    del user_defaults[cert_type.lower()]
                    save_user_defaults(base_path, user, user_defaults)
                    st.success("Defaults deleted!")
                    st.rerun()
    with col2:
        if st.button("Close Defaults Editor", type="secondary"):
            st.session_state.show_defaults_tab = False
            st.rerun()

    st.markdown("---")

    # === Installation Details ===
    with st.expander("Installation Details", expanded=True):
        col1, col2 = st.columns(2)
        with col1:
            premises_options = ["Residential", "Commercial", "Industrial", "Agricultural", "Other"]
            current_premises = get_nested_value(cert_defaults, ["installation_details", "description_of_premises"], "Residential")
            st.selectbox(
                "Description of Premises",
                options=premises_options,
                index=get_index_from_options(premises_options, current_premises, 0),
                key="def_premises_desc"
            )
            st.number_input(
                "Next Inspection (years)",
                min_value=1, max_value=10,
                value=int(get_nested_value(cert_defaults, ["installation_details", "next_inspection_years"], 5)),
                key="def_next_inspection"
            )
        with col2:
            st.checkbox(
                "Installation Records Available",
                value=get_nested_value(cert_defaults, ["installation_details", "installation_records_available"], False),
                key="def_records_available"
            )
            st.checkbox(
                "Evidence of Additions/Alterations",
                value=get_nested_value(cert_defaults, ["installation_details", "evidence_of_additions_alterations"], False),
                key="def_additions_alterations"
            )

    # === Extent & Limitations ===
    with st.expander("Extent & Limitations", expanded=False):
        st.text_area(
            "Extent of Installation",
            value=get_nested_value(cert_defaults, ["extent_and_limitations", "extent"], ""),
            height=100,
            key="def_extent",
            placeholder="e.g., Fixed electrical wiring installation.\n20% of accessories opened"
        )
        st.text_area(
            "Agreed Limitations",
            value=get_nested_value(cert_defaults, ["extent_and_limitations", "agreed_limitations"], ""),
            height=100,
            key="def_agreed_limitations",
            placeholder="e.g., No loft spaces entered. No lifting of floors..."
        )
        st.text_input(
            "Agreed With",
            value=get_nested_value(cert_defaults, ["extent_and_limitations", "agreed_with"], ""),
            key="def_agreed_with",
            placeholder="e.g., Occupier"
        )
        st.text_area(
            "Operational Limitations",
            value=get_nested_value(cert_defaults, ["extent_and_limitations", "operational_limitations"], ""),
            height=80,
            key="def_operational_limitations"
        )

    # === Supply Characteristics ===
    with st.expander("Supply Characteristics", expanded=False):
        col1, col2 = st.columns(2)
        with col1:
            earthing_options = ["TN-C-S", "TN-S", "TT", "TN-C", "IT"]
            current_earthing = get_nested_value(cert_defaults, ["supply_characteristics", "earthing_arrangement"], "TN-C-S")
            st.selectbox(
                "Earthing Arrangement",
                options=earthing_options,
                index=get_index_from_options(earthing_options, current_earthing, 0),
                key="def_earthing"
            )
            live_options = ["AC - 1-phase (2 wire)", "AC - 1-phase (3 wire)", "AC - 3-phase (3 wire)", "AC - 3-phase (4 wire)"]
            current_live = get_nested_value(cert_defaults, ["supply_characteristics", "live_conductors"], "AC - 1-phase (2 wire)")
            st.selectbox(
                "Live Conductors",
                options=live_options,
                index=get_index_from_options(live_options, current_live, 0),
                key="def_live_conductors"
            )
            st.text_input("Nominal Voltage U",
                value=get_nested_value(cert_defaults, ["supply_characteristics", "nominal_voltage_u"], "230"),
                key="def_nominal_voltage_u"
            )
        with col2:
            st.text_input("Nominal Voltage Uo",
                value=get_nested_value(cert_defaults, ["supply_characteristics", "nominal_voltage_uo"], "230"),
                key="def_nominal_voltage_uo"
            )
            st.text_input("Nominal Frequency",
                value=get_nested_value(cert_defaults, ["supply_characteristics", "nominal_frequency"], "50"),
                key="def_nominal_frequency"
            )
            st.text_input("Number of Supplies",
                value=get_nested_value(cert_defaults, ["supply_characteristics", "number_of_supplies"], "1"),
                key="def_number_of_supplies"
            )
            st.checkbox("Supply Polarity Confirmed",
                value=get_nested_value(cert_defaults, ["supply_characteristics", "supply_polarity_confirmed"], True),
                key="def_polarity_confirmed"
            )

    # === Main Switch ===
    with st.expander("Main Switch Defaults", expanded=False):
        col1, col2 = st.columns(2)
        with col1:
            st.text_input("Type BS(EN)",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "main_switch", "type_bs_en"], ""),
                key="def_ms_bs_en"
            )
            st.text_input("Number of Poles",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "main_switch", "number_of_poles"], ""),
                key="def_ms_poles"
            )
        with col2:
            st.text_input("Voltage Rating",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "main_switch", "voltage_rating"], ""),
                key="def_ms_voltage"
            )
            st.text_input("Rated Current",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "main_switch", "rated_current"], ""),
                key="def_ms_current"
            )

    # === Conductor Details ===
    with st.expander("Conductor Details", expanded=False):
        col1, col2 = st.columns(2)
        with col1:
            st.markdown("**Tails**")
            st.text_input("Material",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "tails", "material"], ""),
                key="def_tails_material"
            )
            st.text_input("CSA (mm2)",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "tails", "csa"], ""),
                key="def_tails_csa"
            )
            st.markdown("**Earthing Conductor**")
            st.text_input("Material",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "earthing_conductor", "material"], ""),
                key="def_ec_material"
            )
            st.text_input("CSA (mm2)",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "earthing_conductor", "csa"], ""),
                key="def_ec_csa"
            )
        with col2:
            st.markdown("**Main Protective Bonding**")
            st.text_input("Material",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "main_protective_bonding", "material"], ""),
                key="def_mpb_material"
            )
            st.text_input("CSA (mm2)",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "main_protective_bonding", "csa"], ""),
                key="def_mpb_csa"
            )

    # === Bonding ===
    with st.expander("Bonding of Extraneous Parts", expanded=False):
        col1, col2, col3 = st.columns(3)
        with col1:
            st.checkbox("Water",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "bonding_of_extraneous_parts", "water"], True),
                key="def_bond_water"
            )
            st.checkbox("Gas",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "bonding_of_extraneous_parts", "gas"], True),
                key="def_bond_gas"
            )
        with col2:
            st.checkbox("Oil",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "bonding_of_extraneous_parts", "oil"], False),
                key="def_bond_oil"
            )
            st.checkbox("Steel",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "bonding_of_extraneous_parts", "steel"], False),
                key="def_bond_steel"
            )
        with col3:
            st.checkbox("Lightning",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "bonding_of_extraneous_parts", "lightning"], False),
                key="def_bond_lightning"
            )

    # === SPD Settings ===
    with st.expander("SPD Settings", expanded=False):
        col1, col2 = st.columns(2)
        with col1:
            st.text_input("SPD Type",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "spd", "type"], ""),
                key="def_spd_type_board"
            )
        with col2:
            st.text_input("SPD Status",
                value=get_nested_value(cert_defaults, ["particulars_of_installation", "spd", "status"], ""),
                key="def_spd_status"
            )

    # === Circuit Schedule Template ===
    st.markdown("---")
    with st.expander("Circuit Schedule Template Row", expanded=True):
        st.markdown("""
            Configure default values for new circuit rows. These values will be used as the
            starting point for all circuits in the schedule (test readings excluded - those come from transcripts).
        """)

        circuit_template = cert_defaults.get("circuit_template", {})

        col1, col2, col3 = st.columns(3)

        with col1:
            st.markdown("**Wiring & Reference**")
            wiring_options = ["", "A", "B", "C", "D"]
            current_wiring = circuit_template.get("wiring_type", "")
            st.selectbox("Wiring Type",
                options=wiring_options,
                index=get_index_from_options(wiring_options, current_wiring, 0),
                key="def_circuit_wiring_type"
            )
            ref_options = ["", "A", "B", "C", "D"]
            current_ref = circuit_template.get("ref_method", "")
            st.selectbox("Reference Method",
                options=ref_options,
                index=get_index_from_options(ref_options, current_ref, 0),
                key="def_circuit_ref_method"
            )
            st.text_input("Max Disconnect Time (s)",
                value=circuit_template.get("max_disconnect_time_s", ""),
                key="def_circuit_disconnect_time",
                placeholder="e.g., 0.4"
            )

        with col2:
            st.markdown("**Cable Sizes**")
            st.text_input("Live CSA (mm2)",
                value=circuit_template.get("live_csa_mm2", ""),
                key="def_circuit_live_csa",
                placeholder="e.g., 2.5"
            )
            st.text_input("CPC CSA (mm2)",
                value=circuit_template.get("cpc_csa_mm2", ""),
                key="def_circuit_cpc_csa",
                placeholder="e.g., 1.5"
            )
            st.text_input("IR Test Voltage (V)",
                value=circuit_template.get("ir_test_voltage_v", ""),
                key="def_circuit_ir_voltage",
                placeholder="e.g., 500"
            )

        with col3:
            st.markdown("**Protection Devices**")
            st.text_input("OCPD BS/EN",
                value=circuit_template.get("ocpd_bs_en", ""),
                key="def_circuit_ocpd_bs_en",
                placeholder="e.g., 61009"
            )
            ocpd_options = ["", "B", "C", "D", "gG", "gM"]
            current_ocpd = circuit_template.get("ocpd_type", "")
            st.selectbox("OCPD Type",
                options=ocpd_options,
                index=get_index_from_options(ocpd_options, current_ocpd, 0),
                key="def_circuit_ocpd_type"
            )
            st.text_input("Breaking Capacity (kA)",
                value=circuit_template.get("ocpd_breaking_capacity_ka", ""),
                key="def_circuit_breaking_capacity",
                placeholder="e.g., 6"
            )
            st.text_input("RCD BS/EN",
                value=circuit_template.get("rcd_bs_en", ""),
                key="def_circuit_rcd_bs_en",
                placeholder="e.g., 61009"
            )
            rcd_options = ["", "AC", "A", "F", "B", "S"]
            current_rcd = circuit_template.get("rcd_type", "")
            st.selectbox("RCD Type",
                options=rcd_options,
                index=get_index_from_options(rcd_options, current_rcd, 0),
                key="def_circuit_rcd_type"
            )
            st.text_input("RCD Operating Current (mA)",
                value=circuit_template.get("rcd_operating_current_ma", ""),
                key="def_circuit_rcd_ma",
                placeholder="e.g., 30"
            )

    st.markdown("---")

    # Save button
    if st.button("Save Defaults", type="primary", use_container_width=True):
        save_defaults_from_form(base_path, user, cert_type)
        st.success(f"Defaults saved for {user} ({cert_type})!")
        st.balloons()


def render_defaults_tab_standalone(base_path: Path, user: str):
    """Render the defaults tab when no job is loaded."""
    st.markdown("""
        <div class="main-header">
            <h1>Configure Certificate Defaults</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 0.25rem 0 0 0; font-size: 0.9rem;">
                Set your personal default values for certificates
            </p>
        </div>
    """, unsafe_allow_html=True)

    render_defaults_tab(base_path, user, job_loaded=False)


# Initialize session state
if 'data_loaded' not in st.session_state:
    st.session_state.data_loaded = False
if 'current_job' not in st.session_state:
    st.session_state.current_job = None
if 'show_defaults_dialog' not in st.session_state:
    st.session_state.show_defaults_dialog = False
if 'show_defaults_tab' not in st.session_state:
    st.session_state.show_defaults_tab = False
if 'circuit_template_defaults' not in st.session_state:
    st.session_state.circuit_template_defaults = {}
if 'defaults_checkboxes' not in st.session_state:
    st.session_state.defaults_checkboxes = {}


# Base path
base_path = Path("/Users/Derek/Library/Mobile Documents/com~apple~CloudDocs/EICR_Automation/EICR_App")

# Set user in session state (from command line or keep existing)
if CURRENT_USER:
    st.session_state.selected_user = CURRENT_USER

# Sidebar - Job Selection
# Load company settings for current user
company_settings = load_company_settings(base_path, CURRENT_USER)

# Display header with company branding
if company_settings.get("logo_file"):
    logo_path = base_path / "assets" / "logos" / company_settings["logo_file"]
    if logo_path.exists():
        st.sidebar.image(str(logo_path), width=150)

header_title = "EICR-oMatic 3000"
# Use authenticated user name if available
auth_user_name = st.session_state.get('user_name') or st.session_state.get('user_email', '').split('@')[0]
if auth_user_name:
    header_subtitle = f"{auth_user_name}'s Editor"
elif CURRENT_USER:
    header_subtitle = f"{CURRENT_USER}'s Editor"
else:
    header_subtitle = "Certificate Management"

if company_settings.get("company_name"):
    header_subtitle = company_settings["company_name"]

st.sidebar.markdown(f"""
    <div style='text-align: center; padding: 1rem 0;'>
        <h1 style='font-size: 1.4rem; margin-bottom: 0.25rem;'>{header_title}</h1>
        <p style='font-size: 0.9rem; opacity: 0.8; margin: 0;'>{header_subtitle}</p>
    </div>
""", unsafe_allow_html=True)
st.sidebar.markdown("---")

# Upload Job Section
if st.session_state.get('authenticated') and st.session_state.get('dpa_accepted'):
    st.sidebar.markdown('<p style="color: white; font-weight: 600; margin-bottom: 0.5rem;">Upload New Job</p>', unsafe_allow_html=True)
    with st.sidebar.expander("Click to upload", expanded=False):
        st.markdown("##### Upload Audio & Photos")

        # File uploader
        uploaded_files = st.file_uploader(
            "Select audio and photos",
            type=['m4a', 'mp3', 'wav', 'webm', 'jpg', 'jpeg', 'png', 'heic'],
            accept_multiple_files=True,
            key="job_upload_files"
        )

        # Optional job reference
        job_reference = st.text_input(
            "Job Reference (optional)",
            placeholder="e.g., 123 High Street or Client Name",
            key="job_upload_reference"
        )

        # Certificate type selection
        upload_cert_type = st.selectbox(
            "Certificate Type",
            options=["EICR", "EIC"],
            key="upload_cert_type"
        )

        # Upload & Process button
        if st.button("Upload & Process", type="primary", use_container_width=True, key="upload_process_btn"):
            user_id = st.session_state.get('user_id')

            if not uploaded_files:
                st.error("Please select at least one file to upload")
            elif not user_id:
                st.error("Authentication error. Please log in again.")
            else:
                # Validate all files before processing
                validation_errors = []
                validated_files = []

                for uploaded_file in uploaded_files:
                    # Check file size
                    file_bytes = uploaded_file.read()
                    uploaded_file.seek(0)  # Reset for later reading

                    if not validate_file_size(len(file_bytes)):
                        validation_errors.append(f"{uploaded_file.name}: File exceeds 200MB limit")
                        continue

                    # Check extension
                    if not validate_file_extension(uploaded_file.name):
                        validation_errors.append(f"{uploaded_file.name}: Invalid file type")
                        continue

                    # Validate content matches extension
                    if not validate_file_content(file_bytes, uploaded_file.name):
                        validation_errors.append(f"{uploaded_file.name}: File content does not match extension")
                        continue

                    validated_files.append((uploaded_file, file_bytes))

                if validation_errors:
                    for error in validation_errors:
                        st.error(error)

                if validated_files:
                    # Create job folder
                    job_folder_path, job_folder_name = create_job_folder(user_id)

                    if not job_folder_path:
                        st.error("Failed to create job folder")
                    else:
                        # Save files
                        saved_files = []
                        save_errors = []

                        for uploaded_file, file_bytes in validated_files:
                            safe_filename = sanitise_filename(uploaded_file.name)
                            file_path = job_folder_path / safe_filename

                            try:
                                with open(file_path, 'wb') as f:
                                    f.write(file_bytes)
                                saved_files.append(safe_filename)
                            except Exception as e:
                                save_errors.append(f"{uploaded_file.name}: {str(e)}")

                        if save_errors:
                            for error in save_errors:
                                st.error(f"Failed to save: {error}")

                        if saved_files:
                            # Log the upload action
                            db.log_action(
                                user_id,
                                'file_upload',
                                {
                                    'job_folder': job_folder_name,
                                    'files': saved_files,
                                    'job_reference': job_reference,
                                    'cert_type': upload_cert_type,
                                    'file_count': len(saved_files)
                                }
                            )

                            st.success(f"Uploaded {len(saved_files)} file(s) to {job_folder_name}")

                            # Process the job
                            with st.spinner('Processing job... This may take a few minutes.'):
                                success, stdout, stderr = process_uploaded_job(job_folder_path)

                            if success:
                                st.success("Job processed successfully!")
                                st.toast("Job ready for editing!", icon="✅")

                                # Log processing success
                                db.log_action(
                                    user_id,
                                    'job_processed',
                                    {
                                        'job_folder': job_folder_name,
                                        'status': 'success',
                                        'cert_type': upload_cert_type
                                    }
                                )

                                # Show option to view in editor
                                st.info(f"Job '{job_folder_name}' is ready. Reload the page to see it in the job list.")
                            else:
                                st.error("Processing failed!")
                                if stderr:
                                    with st.expander("Error Details"):
                                        st.code(stderr[:1000], language=None)

                                # Log processing failure
                                db.log_action(
                                    user_id,
                                    'job_processed',
                                    {
                                        'job_folder': job_folder_name,
                                        'status': 'failed',
                                        'error': stderr[:500] if stderr else 'Unknown error'
                                    }
                                )
                        else:
                            st.error("No files were saved successfully")

        # Show upload limits
        st.caption("Accepted: .m4a, .mp3, .wav, .webm, .jpg, .jpeg, .png, .heic")
        st.caption("Max file size: 200MB per file")

st.sidebar.markdown("---")

# User selection
available_users = get_available_users(base_path)
if len(available_users) > 1:
    # Initialize selected_user in session state
    if 'selected_user' not in st.session_state:
        st.session_state.selected_user = available_users[0] if available_users else ""

    user_display = {u: u if u else "Default" for u in available_users}
    selected_user = st.sidebar.selectbox(
        "User",
        options=available_users,
        format_func=lambda x: x if x else "Default (OUTPUT)",
        index=available_users.index(st.session_state.selected_user) if st.session_state.selected_user in available_users else 0
    )
    st.session_state.selected_user = selected_user
else:
    selected_user = available_users[0] if available_users else ""
    st.session_state.selected_user = selected_user

# Job selection
output_dirs = get_output_directories(base_path, st.session_state.selected_user)
if output_dirs:
    selected_job = st.sidebar.selectbox(
        "Select Job",
        options=output_dirs,
        index=0 if not st.session_state.current_job else output_dirs.index(st.session_state.current_job) if st.session_state.current_job in output_dirs else 0,
        key="job_selector"
    )

    if st.sidebar.button("Load Job", type="primary"):
        st.toast(f"Loading job: {selected_job}...", icon="📂")
        # Clear form field session state so new job data loads properly
        keys_to_clear = [
            'extent', 'agreed_limitations', 'agreed_with', 'operational_limitations',
            'client_name', 'client_address', 'premises_desc', 'records_available',
            'additions_alterations', 'next_inspection', 'earthing', 'live_conductors',
            'number_of_supplies', 'nominal_voltage_u', 'nominal_voltage_uo',
            'nominal_frequency', 'pfc', 'ze', 'polarity_confirmed', 'spd_bs_en',
            'spd_type_supply', 'spd_capacity', 'spd_current', 'board_name',
            'board_location', 'board_manufacturer', 'board_supplied_from',
            'board_zs', 'board_ipf', 'board_phases', 'board_polarity',
            'ms_bs_en', 'ms_poles', 'ms_voltage', 'ms_current', 'ms_fuse',
            'ms_ipf', 'tails_material', 'tails_csa', 'ec_material', 'ec_csa',
            'ec_continuity', 'mpb_material', 'mpb_csa', 'mpb_continuity',
            'bond_water', 'bond_gas', 'bond_oil', 'bond_steel', 'bond_lightning', 'bond_other',
            'spd_type_board', 'spd_status', 'board_notes', 'observations',
            'edited_circuits', 'inspection_items'
        ]
        for key in keys_to_clear:
            if key in st.session_state:
                del st.session_state[key]
        st.session_state.current_job = selected_job
        st.session_state.data_loaded = True

        # Load job data and explicitly set session state values
        folder_name = f"data/OUTPUT_{st.session_state.selected_user}" if st.session_state.selected_user else "data/OUTPUT"
        job_path = base_path / folder_name / selected_job

        # Auto-detect certificate type from job metadata
        job_meta_path = job_path / "job_meta.json"
        if job_meta_path.exists():
            try:
                with open(job_meta_path, 'r') as f:
                    job_meta = json.load(f)
                    if job_meta.get("certificate_type"):
                        st.session_state.certificate_type = job_meta["certificate_type"]
            except:
                pass

        # Apply user defaults FIRST (before extracted data, so extracted data can override)
        user = st.session_state.get('selected_user', CURRENT_USER)
        if user:
            user_defaults = load_user_defaults(base_path, user)
            cert_type = st.session_state.get('certificate_type', 'EICR')
            apply_user_defaults_to_session(user_defaults, cert_type)

        # Load and set board details to session state (overrides user defaults where present)
        board_path = job_path / "board_details.json"
        if board_path.exists():
            try:
                with open(board_path, 'r') as f:
                    bd = json.load(f)
                    # Explicitly set session state values from loaded data
                    st.session_state.board_name = bd.get("name", "DB-1")
                    st.session_state.board_location = bd.get("location", "")
                    st.session_state.board_manufacturer = bd.get("manufacturer", "")
                    st.session_state.board_supplied_from = bd.get("supplied_from", "")
                    st.session_state.board_zs = bd.get("zs_at_db", "")
                    st.session_state.board_ipf = bd.get("ipf_at_db", "")
                    st.session_state.ms_bs_en = bd.get("main_switch_bs_en", "")
                    st.session_state.ms_poles = bd.get("main_switch_poles", "")
                    st.session_state.ms_voltage = bd.get("voltage_rating", "")
                    st.session_state.ms_current = bd.get("rated_current", "")
                    st.session_state.ms_fuse = bd.get("fuse_type", "")
                    st.session_state.ms_ipf = bd.get("ipf_rating", "")
                    st.session_state.tails_material = bd.get("tails_material", "")
                    st.session_state.tails_csa = bd.get("tails_csa", "")
                    st.session_state.ec_material = bd.get("earthing_conductor_material", "")
                    st.session_state.ec_csa = bd.get("earthing_conductor_csa", "")
                    st.session_state.mpb_material = bd.get("bonding_conductor_material", "")
                    st.session_state.mpb_csa = bd.get("bonding_conductor_csa", "")
                    st.session_state.bond_water = bd.get("bond_water", True)
                    st.session_state.bond_gas = bd.get("bond_gas", True)
                    st.session_state.bond_oil = bd.get("bond_oil", False)
                    st.session_state.bond_steel = bd.get("bond_steel", False)
                    st.session_state.bond_lightning = bd.get("bond_lightning", False)
                    st.session_state.bond_other = bd.get("bond_other", "N/A")
                    st.session_state.spd_type_board = bd.get("spd_type", "")
                    st.session_state.spd_status = bd.get("spd_status", "")
                    st.session_state.board_notes = bd.get("notes", "")
                    st.session_state.agreed_limitations = bd.get("agreed_limitations", "")
                    st.session_state.operational_limitations = bd.get("operational_limitations", "")
                    st.session_state.ze = bd.get("ze", "")
                    st.session_state.earthing = bd.get("earthing_arrangement", "")
            except Exception as e:
                pass

        # Load and set installation details to session state
        install_path = job_path / "installation_details.json"
        if install_path.exists():
            try:
                with open(install_path, 'r') as f:
                    inst = json.load(f)
                    st.session_state.client_address = inst.get("address", "")
                    st.session_state.client_name = inst.get("client_name", "")
            except:
                pass

        st.rerun()
else:
    st.sidebar.warning("No jobs found in OUTPUT directory")
    selected_job = None

st.sidebar.markdown("---")

# "Configure Defaults" button - ALWAYS visible
st.sidebar.markdown("### Settings")
if st.sidebar.button("Configure Defaults", type="secondary", use_container_width=True,
                     help="Configure your personal default values for certificates"):
    if st.session_state.get('data_loaded'):
        # When a job is loaded, show a toast directing user to the Defaults tab
        st.toast("Click the 'Defaults' tab above to configure your default values", icon="⚙️")
    else:
        # When no job is loaded, show standalone defaults editor
        st.session_state.show_defaults_tab = True
        st.rerun()

# Initialize certificate type if not set (will be auto-detected from job metadata)
if 'certificate_type' not in st.session_state:
    st.session_state.certificate_type = "EICR"

# Show current certificate type (read-only, set during processing or from job metadata)
cert_type = st.session_state.certificate_type
st.sidebar.caption(f"Certificate Type: **{cert_type}**")

# Load inspector profiles silently (inspector selection is now in the Inspector Profile tab)
inspector_profiles = load_inspector_profiles(base_path)
if inspector_profiles.get("profiles"):
    # Use last selected or default inspector
    last_selected = inspector_profiles.get("last_selected")
    if last_selected:
        st.session_state.current_inspector = get_inspector_by_id(inspector_profiles, last_selected)
    else:
        # Use first profile as default
        st.session_state.current_inspector = inspector_profiles["profiles"][0] if inspector_profiles["profiles"] else None
else:
    st.session_state.current_inspector = None

st.sidebar.markdown("---")

# Load baseline config based on certificate type
if st.session_state.certificate_type == "EIC":
    baseline_config = load_json_file(base_path / "config" / "eic_baseline_config.json")
    eic_baseline_config = baseline_config
else:
    baseline_config = load_json_file(base_path / "config" / "baseline_config.json")
    eic_baseline_config = load_json_file(base_path / "config" / "eic_baseline_config.json")

# Main content - Professional Header (certificate type aware)
if st.session_state.certificate_type == "EIC":
    st.markdown("""
        <div class="main-header" style="background: linear-gradient(135deg, #1E5F3A 0%, #2C8252 100%);">
            <h1>EIC Certificate Editor</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 0.25rem 0 0 0; font-size: 0.9rem;">
                Electrical Installation Certificate - New Installations
            </p>
        </div>
    """, unsafe_allow_html=True)
else:
    st.markdown("""
        <div class="main-header">
            <h1>EICR Certificate Editor</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 0.25rem 0 0 0; font-size: 0.9rem;">
                Electrical Installation Condition Report Management
            </p>
        </div>
    """, unsafe_allow_html=True)

if not st.session_state.data_loaded:
    # Allow access to Defaults tab even without a job loaded
    if st.session_state.get('show_defaults_tab'):
        render_defaults_tab_standalone(base_path, CURRENT_USER)
        st.stop()
    else:
        st.info("Select a job from the sidebar and click 'Load Job' to begin editing.")
        st.markdown("---")
        st.markdown("**Tip:** You can configure your default values anytime by clicking 'Configure Defaults' in the sidebar.")
        st.stop()

# Load job data
# Determine output folder based on selected user
output_folder = f"data/OUTPUT_{st.session_state.selected_user}" if st.session_state.selected_user else "data/OUTPUT"
job_path = base_path / output_folder / st.session_state.current_job
board_details = load_json_file(job_path / "board_details.json")
installation_details = load_json_file(job_path / "installation_details.json")
inspection_schedule = load_json_file(job_path / "inspection_schedule.json")
observations = load_json_file(job_path / "observations.json")
if not isinstance(observations, list):
    observations = []
test_results = load_csv_file(job_path / "test_results.csv")

# Apply automatic cable size inference based on circuit type
test_results = infer_cable_sizes(test_results)

# Apply circuit template defaults from user settings
circuit_template = st.session_state.get('circuit_template_defaults', {})
if circuit_template:
    test_results = apply_circuit_template_to_circuits(test_results, circuit_template)

st.success(f"Loaded job: **{st.session_state.current_job}** ({st.session_state.certificate_type})")

# Create tabs based on certificate type
if st.session_state.certificate_type == "EIC":
    # EIC tabs - no Observations tab, different inspection schedule
    tabs = st.tabs([
        "Installation Details",
        "Extent & Type",
        "Supply Characteristics",
        "Distribution Board",
        "Circuit Schedule",
        "EIC Inspection Schedule",
        "Design & Construction",
        "Defaults",
        "Inspector Profile",
        "Company Settings",
        "Generate PDF"
    ])
    TAB_INSTALLATION = 0
    TAB_EXTENT = 1
    TAB_SUPPLY = 2
    TAB_BOARD = 3
    TAB_CIRCUITS = 4
    TAB_INSPECTION = 5
    TAB_DESIGN = 6
    TAB_DEFAULTS = 7
    TAB_INSPECTOR = 8
    TAB_COMPANY = 9
    TAB_PDF = 10
else:
    # EICR tabs - standard layout with Observations
    tabs = st.tabs([
        "Installation Details",
        "Supply Characteristics",
        "Distribution Board",
        "Circuit Schedule",
        "Observations",
        "Inspection Schedule",
        "Defaults",
        "Inspector Profile",
        "Company Settings",
        "Generate PDF"
    ])
    TAB_INSTALLATION = 0
    TAB_EXTENT = None
    TAB_SUPPLY = 1
    TAB_BOARD = 2
    TAB_CIRCUITS = 3
    TAB_OBSERVATIONS = 4
    TAB_INSPECTION = 5
    TAB_DEFAULTS = 6
    TAB_DESIGN = None
    TAB_INSPECTOR = 7
    TAB_COMPANY = 8
    TAB_PDF = 9

# ============================================================================
# TAB 1: Installation Details
# ============================================================================
with tabs[TAB_INSTALLATION]:
    st.markdown('<p class="section-header">Installation Details</p>', unsafe_allow_html=True)

    col1, col2 = st.columns(2)

    with col1:
        st.markdown("##### Client Information")
        client_name = st.text_input(
            "Client Name",
            value=installation_details.get("client_name", ""),
            key="client_name"
        )
        client_address = st.text_area(
            "Installation Address",
            value=installation_details.get("address", ""),
            height=100,
            key="client_address"
        )

        st.markdown("##### Premises")
        premises_desc = st.selectbox(
            "Description of Premises",
            options=["Residential", "Commercial", "Industrial", "Agricultural", "Other"],
            index=0,
            key="premises_desc"
        )

    with col2:
        st.markdown("##### Records & History")
        records_available = st.checkbox(
            "Installation records/diagrams available",
            value=baseline_config.get("installation_details", {}).get("installation_records_available", False),
            key="records_available"
        )
        additions_alterations = st.checkbox(
            "Evidence of additions/alterations",
            value=baseline_config.get("installation_details", {}).get("evidence_of_additions_alterations", False),
            key="additions_alterations"
        )

        st.markdown("##### Next Inspection")
        next_inspection = st.number_input(
            "Recommended interval (years)",
            min_value=1,
            max_value=10,
            value=baseline_config.get("installation_details", {}).get("next_inspection_years", 5),
            key="next_inspection"
        )

    st.markdown("---")
    st.markdown("##### Extent and Limitations")

    # Load from board_details first, then fall back to baseline_config defaults
    baseline_extent = baseline_config.get("extent_and_limitations", {})

    extent = st.text_area(
        "Extent of Installation Covered",
        value=board_details.get("extent") or baseline_extent.get("extent") or "Fixed electrical wiring installation.\n20% of accessories opened",
        height=100,
        key="extent"
    )

    agreed_limitations = st.text_area(
        "Agreed Limitations (including reasons)",
        value=board_details.get("agreed_limitations") or baseline_extent.get("agreed_limitations") or "No loft spaces entered. No lifting of floors. HVAC control cables not tested. No testing of heating controls. No destructive inspections, readily visible accessories only.",
        height=100,
        key="agreed_limitations"
    )

    agreed_with = st.text_input(
        "Agreed With",
        value=board_details.get("agreed_with") or baseline_extent.get("agreed_with") or "Occupier",
        key="agreed_with"
    )

    operational_limitations = st.text_area(
        "Operational Limitations (including reasons)",
        value=board_details.get("operational_limitations") or baseline_extent.get("operational_limitations") or "",
        height=80,
        key="operational_limitations"
    )

# ============================================================================
# TAB: EIC Extent & Installation Type (EIC only)
# ============================================================================
if st.session_state.certificate_type == "EIC":
    with tabs[TAB_EXTENT]:
        st.markdown('<p class="section-header">Extent of Installation & Installation Type</p>', unsafe_allow_html=True)

        st.markdown("##### Extent of Installation Covered by This Certificate")
        eic_extent = st.text_area(
            "Describe the extent of the electrical installation covered",
            value=board_details.get("extent", ""),
            height=100,
            key="eic_extent"
        )

        st.markdown("---")
        st.markdown("##### Installation Type")

        # Initialize installation_type in session state
        if 'installation_type' not in st.session_state:
            st.session_state.installation_type = "new_installation"

        installation_type = st.radio(
            "This installation is:",
            options=INSTALLATION_TYPES,
            format_func=lambda x: INSTALLATION_TYPE_LABELS.get(x, x),
            index=INSTALLATION_TYPES.index(st.session_state.installation_type) if st.session_state.installation_type in INSTALLATION_TYPES else 0,
            key="installation_type_radio"
        )
        st.session_state.installation_type = installation_type

        if installation_type != "new_installation":
            st.markdown("##### Comments on Existing Installation")
            st.caption("In the case of an addition or alteration, see Regulation 644.1.2")
            comments_on_existing = st.text_area(
                "Comments on existing installation",
                value=board_details.get("comments_on_existing", ""),
                height=80,
                key="comments_on_existing"
            )

        st.markdown("---")
        st.markdown("##### Bathroom Detection")

        # Auto-detect bathroom work from extent text
        extent_text = st.session_state.get('eic_extent', '') or st.session_state.get('extent', '')
        bathroom_detected = detect_bathroom_work(extent_text)

        if bathroom_detected:
            st.success("Bathroom work detected in extent description. Item 12.0 will be marked as applicable.")
        else:
            st.info("No bathroom work detected. Item 12.0 will be set to N/A (you can override in the Inspection Schedule).")

        # Manual override for bathroom
        override_bathroom = st.checkbox(
            "Work involves bathroom/shower location (manual override)",
            value=bathroom_detected,
            key="bathroom_override"
        )

# ============================================================================
# TAB: Supply Characteristics
# ============================================================================
with tabs[TAB_SUPPLY]:
    st.markdown('<p class="section-header">Supply Characteristics</p>', unsafe_allow_html=True)

    supply_config = baseline_config.get("supply_characteristics", {})

    col1, col2, col3 = st.columns(3)

    with col1:
        # Load from board_details first, then fall back to supply_config
        earthing_value = board_details.get("earthing_arrangement") or supply_config.get("earthing_arrangement", "TN-C-S")
        earthing = st.selectbox(
            "Earthing Arrangement",
            options=EARTHING_ARRANGEMENTS,
            index=EARTHING_ARRANGEMENTS.index(earthing_value) if earthing_value in EARTHING_ARRANGEMENTS else 1,
            key="earthing"
        )

        live_conductors_value = board_details.get("live_conductors") or supply_config.get("live_conductors", LIVE_CONDUCTORS[0])
        live_conductors = st.selectbox(
            "Live Conductors (AC/DC, phases)",
            options=LIVE_CONDUCTORS,
            index=LIVE_CONDUCTORS.index(live_conductors_value) if live_conductors_value in LIVE_CONDUCTORS else 0,
            key="live_conductors"
        )

        num_supplies_options = ["1", "2", "3", "4", "5", "N/A"]
        num_supplies_value = board_details.get("number_of_supplies") or supply_config.get("number_of_supplies", "1")
        number_of_supplies = st.selectbox(
            "Number of Supplies",
            options=num_supplies_options,
            index=num_supplies_options.index(num_supplies_value) if num_supplies_value in num_supplies_options else 0,
            key="number_of_supplies"
        )

    with col2:
        voltage_u_value = board_details.get("nominal_voltage_u") or supply_config.get("nominal_voltage_u", "230")
        nominal_voltage_u = st.selectbox(
            "Nominal Voltage U (V)",
            options=VOLTAGES,
            index=VOLTAGES.index(voltage_u_value) if voltage_u_value in VOLTAGES else 0,
            key="nominal_voltage_u"
        )

        voltage_uo_value = board_details.get("nominal_voltage_uo") or supply_config.get("nominal_voltage_uo", "230")
        nominal_voltage_uo = st.selectbox(
            "Nominal Voltage Uo (V)",
            options=VOLTAGES,
            index=VOLTAGES.index(voltage_uo_value) if voltage_uo_value in VOLTAGES else 0,
            key="nominal_voltage_uo"
        )

        frequency_value = board_details.get("nominal_frequency") or supply_config.get("nominal_frequency", "50")
        nominal_frequency = st.selectbox(
            "Nominal Frequency (Hz)",
            options=FREQUENCIES,
            index=FREQUENCIES.index(frequency_value) if frequency_value in FREQUENCIES else 0,
            key="nominal_frequency"
        )

    with col3:
        pfc = st.text_input(
            "Prospective Fault Current (kA)",
            value=board_details.get("ipf_at_db", "") or supply_config.get("prospective_fault_current", ""),
            key="pfc"
        )

        ze = st.text_input(
            "External Earth Loop Impedance Ze (Ω)",
            value=board_details.get("ze", "") or supply_config.get("earth_loop_impedance_ze", ""),
            key="ze"
        )

        polarity_confirmed = st.checkbox(
            "Supply Polarity Confirmed",
            value=supply_config.get("supply_polarity_confirmed", True),
            key="polarity_confirmed"
        )

    st.markdown("---")
    st.markdown("##### Supply Protective Device")
    st.caption("Default: LIM (Limited Information) - typically not accessible for inspection")

    col1, col2, col3, col4 = st.columns(4)

    with col1:
        # Load from board_details with LIM default
        spd_bs_en_value = board_details.get("spd_bs_en", "LIM")
        spd_bs_en = st.selectbox(
            "BS(EN)",
            options=BS_EN_OPTIONS,
            index=BS_EN_OPTIONS.index(spd_bs_en_value) if spd_bs_en_value in BS_EN_OPTIONS else 0,
            key="spd_bs_en"
        )

    with col2:
        spd_type_supply = st.text_input(
            "Type",
            value=board_details.get("spd_type_supply", "LIM"),
            key="spd_type_supply"
        )

    with col3:
        spd_capacity = st.text_input(
            "Short Circuit Capacity (kA)",
            value=board_details.get("spd_short_circuit", "LIM"),
            key="spd_capacity"
        )

    with col4:
        spd_current = st.text_input(
            "Rated Current (A)",
            value=board_details.get("spd_rated_current", "LIM"),
            key="spd_current"
        )

# ============================================================================
# TAB: Distribution Board
# ============================================================================
with tabs[TAB_BOARD]:
    st.markdown('<p class="section-header">Distribution Board Details</p>', unsafe_allow_html=True)

    col1, col2 = st.columns(2)

    with col1:
        st.markdown("##### Board Information")
        board_name = st.text_input(
            "Board Designation",
            value=board_details.get("name", "DB-1"),
            key="board_name"
        )
        board_location = st.text_input(
            "Location",
            value=board_details.get("location", ""),
            key="board_location"
        )
        board_manufacturer = st.text_input(
            "Manufacturer",
            value=board_details.get("manufacturer", ""),
            key="board_manufacturer"
        )
        board_supplied_from = st.text_input(
            "Supplied From",
            value=board_details.get("supplied_from", ""),
            key="board_supplied_from"
        )

    with col2:
        st.markdown("##### Test Results at Board")
        board_zs = st.text_input(
            "Zs at DB (Ω)",
            value=board_details.get("zs_at_db", ""),
            key="board_zs"
        )
        board_ipf = st.text_input(
            "Ipf at DB (kA)",
            value=board_details.get("ipf_at_db", ""),
            key="board_ipf"
        )
        board_phases = st.selectbox(
            "Number of Phases",
            options=["1", "3"],
            index=0 if board_details.get("phases", "1") == "1" else 1,
            key="board_phases"
        )
        board_polarity = st.checkbox(
            "Polarity Confirmed",
            value=True,
            key="board_polarity"
        )

    st.markdown("---")
    st.markdown("##### Main Switch / Switch Fuse / Circuit Breaker")

    col1, col2, col3, col4 = st.columns(4)

    with col1:
        ms_bs_en = st.selectbox(
            "Type BS(EN)",
            options=BS_EN_OPTIONS,
            index=BS_EN_OPTIONS.index(board_details.get("main_switch_bs_en", "60947-3")) if board_details.get("main_switch_bs_en") in BS_EN_OPTIONS else 0,
            key="ms_bs_en"
        )
    with col2:
        ms_poles = st.selectbox(
            "Number of Poles",
            options=["1", "2", "3", "4"],
            index=["1", "2", "3", "4"].index(board_details.get("main_switch_poles", "2")) if board_details.get("main_switch_poles", "2") in ["1", "2", "3", "4"] else 1,
            key="ms_poles"
        )
    with col3:
        ms_voltage = st.text_input(
            "Voltage Rating (V)",
            value=board_details.get("voltage_rating", "230"),
            key="ms_voltage"
        )
    with col4:
        ms_current = st.text_input(
            "Rated Current (A)",
            value=board_details.get("rated_current", "100"),
            key="ms_current"
        )

    col1, col2, col3, col4 = st.columns(4)
    with col1:
        ms_fuse = st.text_input(
            "Fuse Device Setting (A)",
            value=board_details.get("fuse_device_setting", "N/A"),
            key="ms_fuse"
        )
    with col2:
        ms_ipf = st.text_input(
            "Ipf Rating (kA)",
            value=board_details.get("ipf_rating", ""),
            key="ms_ipf"
        )
    with col3:
        tails_material = st.selectbox(
            "Tails Material",
            options=["Cu", "Al"],
            index=0 if board_details.get("tails_material", "Cu") == "Cu" else 1,
            key="tails_material"
        )
    with col4:
        tails_csa = st.text_input(
            "Tails CSA (mm²)",
            value=board_details.get("tails_csa", "25"),
            key="tails_csa"
        )

    st.markdown("---")
    st.markdown("##### Earthing & Bonding Conductors")

    col1, col2 = st.columns(2)

    with col1:
        st.markdown("**Earthing Conductor**")
        ec_col1, ec_col2, ec_col3 = st.columns(3)
        with ec_col1:
            ec_material = st.selectbox(
                "Material",
                options=["Cu", "Al"],
                index=0 if board_details.get("earthing_conductor_material", "Cu") == "Cu" else 1,
                key="ec_material"
            )
        with ec_col2:
            ec_csa = st.text_input(
                "CSA (mm²)",
                value=board_details.get("earthing_conductor_csa", "16"),
                key="ec_csa"
            )
        with ec_col3:
            ec_continuity = st.checkbox(
                "Continuity ✓",
                value=board_details.get("earthing_conductor_continuity", True),
                key="ec_continuity"
            )

    with col2:
        st.markdown("**Main Protective Bonding**")
        mpb_col1, mpb_col2, mpb_col3 = st.columns(3)
        with mpb_col1:
            mpb_material = st.selectbox(
                "Material",
                options=["Cu", "Al"],
                index=0 if board_details.get("bonding_conductor_material", "Cu") == "Cu" else 1,
                key="mpb_material"
            )
        with mpb_col2:
            mpb_csa = st.text_input(
                "CSA (mm²)",
                value=board_details.get("bonding_conductor_csa", "10"),
                key="mpb_csa"
            )
        with mpb_col3:
            mpb_continuity = st.checkbox(
                "Continuity ✓",
                value=board_details.get("bonding_conductor_continuity", True),
                key="mpb_continuity"
            )

    st.markdown("---")
    st.markdown("##### Bonding of Extraneous Conductive Parts")

    bond_col1, bond_col2, bond_col3, bond_col4, bond_col5 = st.columns(5)
    with bond_col1:
        bond_water = st.checkbox(
            "Water",
            value=board_details.get("bond_water", True),
            key="bond_water"
        )
    with bond_col2:
        bond_gas = st.checkbox(
            "Gas",
            value=board_details.get("bond_gas", True),
            key="bond_gas"
        )
    with bond_col3:
        bond_oil = st.checkbox(
            "Oil",
            value=board_details.get("bond_oil", False),
            key="bond_oil"
        )
    with bond_col4:
        bond_steel = st.checkbox(
            "Steel",
            value=board_details.get("bond_steel", False),
            key="bond_steel"
        )
    with bond_col5:
        bond_lightning = st.checkbox(
            "Lightning",
            value=board_details.get("bond_lightning", False),
            key="bond_lightning"
        )

    bond_other = st.text_input(
        "Other",
        value=board_details.get("bond_other", "N/A"),
        key="bond_other"
    )

    st.markdown("---")
    st.markdown("##### Surge Protection Device (SPD)")

    col1, col2 = st.columns(2)
    with col1:
        spd_type_board = st.text_input(
            "SPD Type",
            value=board_details.get("spd_type", ""),
            key="spd_type_board"
        )
    with col2:
        spd_status = st.text_input(
            "SPD Status",
            value=board_details.get("spd_status", ""),
            key="spd_status"
        )

    st.markdown("---")
    board_notes = st.text_area(
        "Board Notes",
        value=board_details.get("notes", ""),
        height=100,
        key="board_notes"
    )

# ============================================================================
# TAB: Circuit Schedule
# ============================================================================
with tabs[TAB_CIRCUITS]:
    st.markdown('<p class="section-header">Circuit Schedule</p>', unsafe_allow_html=True)

    if test_results:
        # Convert to DataFrame for editing
        df = pd.DataFrame(test_results)

        # Ensure wiring_type column exists with default 'A' (installation reference method)
        if 'wiring_type' not in df.columns:
            df['wiring_type'] = 'A'
        else:
            # Convert any T+E or similar values to 'A'
            df['wiring_type'] = df['wiring_type'].apply(
                lambda x: 'A' if x not in ['A', 'B', 'C', 'D'] else x
            )

        # Split into fixed columns (Ref, Designation) and scrollable columns
        fixed_cols = ['circuit_ref', 'circuit_designation']
        scroll_cols = [c for c in df.columns if c not in fixed_cols]

        # Column configuration for fixed columns
        fixed_column_config = {
            "circuit_ref": st.column_config.TextColumn("Ref", width="small"),
            "circuit_designation": st.column_config.TextColumn("Designation", width="medium"),
        }

        # Column configuration for scrollable columns
        scroll_column_config = {
            "wiring_type": st.column_config.SelectboxColumn("Wiring Type", options=["A", "B", "C", "D"], default="A", width="small", help="Installation reference method (A, B, C, D)"),
            "ocpd_type": st.column_config.SelectboxColumn("OCPD Type", options=OCPD_TYPES, width="small"),
            "ocpd_rating_a": st.column_config.TextColumn("Rating (A)", width="small"),
            "rcd_type": st.column_config.SelectboxColumn("RCD Type", options=RCD_TYPES, width="small"),
            "rcd_operating_current_ma": st.column_config.TextColumn("RCD mA", width="small"),
            "measured_zs_ohm": st.column_config.TextColumn("Zs (Ω)", width="small"),
            "ir_live_earth_mohm": st.column_config.TextColumn("IR L-E (MΩ)", width="small"),
            "rcd_time_ms": st.column_config.TextColumn("RCD Time (ms)", width="small"),
        }

        # Create two-column layout: fixed left, scrollable right
        col_fixed, col_scroll = st.columns([1, 3])

        with col_fixed:
            st.markdown("**Circuit Reference**")
            # Fixed columns editor (Ref and Designation)
            df_fixed = df[fixed_cols].copy()
            edited_fixed = st.data_editor(
                df_fixed,
                column_config=fixed_column_config,
                num_rows="dynamic",
                use_container_width=True,
                key="circuit_editor_fixed",
                hide_index=True
            )

        with col_scroll:
            st.markdown("**Circuit Details** *(scroll horizontally)*")
            # Scrollable columns editor
            df_scroll = df[scroll_cols].copy()
            edited_scroll = st.data_editor(
                df_scroll,
                column_config=scroll_column_config,
                num_rows="fixed",
                use_container_width=True,
                key="circuit_editor_scroll",
                hide_index=True
            )

        # Merge the two edited dataframes back together
        # Use the fixed editor as the source of truth for row count (allows add/delete)
        edited_df = pd.concat([edited_fixed.reset_index(drop=True), edited_scroll.reset_index(drop=True)], axis=1)

        # Update test_results in session
        st.session_state.edited_circuits = edited_df.to_dict('records')

    else:
        st.warning("No circuit data found. You can add circuits manually.")

        if st.button("Add Sample Circuit"):
            test_results = [{
                "circuit_ref": "1",
                "circuit_designation": "New Circuit",
                "ocpd_type": "B",
                "ocpd_rating_a": "32",
                "rcd_type": "A",
                "rcd_operating_current_ma": "30",
            }]
            st.rerun()

# ============================================================================
# TAB: Observations (EICR only)
# ============================================================================
if st.session_state.certificate_type == "EICR":
    with tabs[TAB_OBSERVATIONS]:
        st.markdown('<p class="section-header">Observations</p>', unsafe_allow_html=True)

        # Initialize observations in session state
        if 'observations' not in st.session_state:
            st.session_state.observations = observations if observations else []

        # Sync any inline observations from the Inspection Schedule tab
        sync_inline_observations_to_main()

        # Add new observation
        st.info("Link observations to inspection schedule items - the code will appear on the schedule automatically. You can also add observations directly from the Inspection Schedule tab by selecting C1/C2/C3.")

        with st.expander("Add New Observation", expanded=False):
            col1, col2 = st.columns([3, 1])

            with col1:
                new_obs_title = st.text_input("Item/Location", key="new_obs_title")
                new_obs_text = st.text_area("Observation Details", key="new_obs_text", height=100)

                # Schedule item selector
                schedule_options = ["(None - don't link to schedule)"] + [f"{k}: {v}" for k, v in SCHEDULE_ITEMS.items()]
                selected_schedule = st.selectbox(
                    "Link to Inspection Schedule Item",
                    options=schedule_options,
                    key="new_obs_schedule",
                    help="Select the schedule item this observation relates to"
                )

            with col2:
                new_obs_code = st.selectbox("Code", options=OBSERVATION_CODES, key="new_obs_code")

                # Photo options: upload new or select existing
                photo_tab1, photo_tab2 = st.tabs(["Upload", "Existing"])

                with photo_tab1:
                    new_obs_photo = st.file_uploader("Photo", type=['jpg', 'jpeg', 'png'], key="new_obs_photo")

                with photo_tab2:
                    # Find existing photos in job folder
                    existing_photos = []
                    photos_scaled_dir = job_path / "photos_scaled"
                    photos_dir = job_path / "photos"

                    for photo_dir in [photos_scaled_dir, photos_dir]:
                        if photo_dir.exists():
                            for p in photo_dir.glob("*.jpg"):
                                existing_photos.append((p.name, str(p.relative_to(job_path))))
                            for p in photo_dir.glob("*.jpeg"):
                                existing_photos.append((p.name, str(p.relative_to(job_path))))
                            for p in photo_dir.glob("*.png"):
                                existing_photos.append((p.name, str(p.relative_to(job_path))))

                    if existing_photos:
                        photo_options = ["(None)"] + [name for name, _ in existing_photos]
                        selected_existing = st.selectbox("Select photo", options=photo_options, key="existing_photo_select")
                    else:
                        selected_existing = None
                        st.caption("No existing photos found")

            if st.button("Add Observation", type="primary"):
                if new_obs_title and new_obs_text:
                    new_obs = {
                        "title": new_obs_title,
                        "text": new_obs_text,
                        "code": new_obs_code,
                    }
                    # Add schedule item if selected
                    if selected_schedule and not selected_schedule.startswith("(None"):
                        schedule_item = selected_schedule.split(":")[0].strip()
                        new_obs["schedule_item"] = schedule_item

                    # Handle photo - either uploaded or selected existing
                    if new_obs_photo is not None:
                        # Create photos directory if it doesn't exist
                        photos_dir = job_path / "photos"
                        photos_dir.mkdir(exist_ok=True)

                        # Generate unique filename
                        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                        obs_index = len(st.session_state.observations)
                        file_ext = new_obs_photo.name.split('.')[-1].lower()
                        photo_filename = f"obs_{obs_index:03d}_{timestamp}.{file_ext}"
                        photo_path = photos_dir / photo_filename

                        # Save the uploaded file
                        with open(photo_path, 'wb') as f:
                            f.write(new_obs_photo.getbuffer())

                        # Store relative path in observation
                        new_obs["photo"] = f"photos/{photo_filename}"
                    elif selected_existing and selected_existing != "(None)" and existing_photos:
                        # Use selected existing photo
                        for name, rel_path in existing_photos:
                            if name == selected_existing:
                                new_obs["photo"] = rel_path
                                break

                    st.session_state.observations.append(new_obs)
                    st.success("Observation added!")
                    st.rerun()
                else:
                    st.error("Please fill in title and details")

        st.markdown("---")

        # Display existing observations
        if st.session_state.observations:
            for i, obs in enumerate(st.session_state.observations):
                code = obs.get("code", "FI")
                code_class = {"C1": "code-c1", "C2": "code-c2", "C3": "code-c3", "FI": "code-fi"}.get(code, "code-fi")

                st.markdown(f"""
                <div class="observation-card">
                    <div style="display: flex; align-items: flex-start; gap: 1rem;">
                        <div class="code-badge {code_class}">{code}</div>
                        <div style="flex: 1;">
                            <div style="font-weight: 600; font-size: 1rem; color: #1A202C; margin-bottom: 0.25rem;">
                                {obs.get('title', 'No title')}
                            </div>
                            <div style="color: #4A5568; font-size: 0.9rem;">
                                {obs.get('text', '')}
                            </div>
                        </div>
                    </div>
                </div>
                """, unsafe_allow_html=True)

                col1, col2, col3 = st.columns([3, 1, 1])
                with col1:
                    # Show linked schedule item
                    schedule_item = obs.get('schedule_item')
                    if schedule_item:
                        schedule_desc = SCHEDULE_ITEMS.get(schedule_item, '')
                        st.caption(f"Linked to: **{schedule_item}** - {schedule_desc}")
                    # Display photo if present
                    if obs.get('photo'):
                        photo_path = job_path / obs['photo']
                        if photo_path.exists():
                            st.image(str(photo_path), width=300)

                with col2:
                    # Attach photo button (only if no photo attached)
                    if not obs.get('photo'):
                        # Get available photos
                        avail_photos = []
                        for photo_dir in [job_path / "photos_scaled", job_path / "photos"]:
                            if photo_dir.exists():
                                for ext in ["*.jpg", "*.jpeg", "*.png"]:
                                    for p in photo_dir.glob(ext):
                                        avail_photos.append((p.name, str(p.relative_to(job_path))))

                        if avail_photos:
                            with st.popover("Attach Photo"):
                                for name, rel_path in avail_photos:
                                    if st.button(name, key=f"attach_{i}_{name}"):
                                        st.session_state.observations[i]["photo"] = rel_path
                                        st.rerun()
                    else:
                        if st.button("Remove Photo", key=f"remove_photo_{i}"):
                            st.session_state.observations[i]["photo"] = None
                            st.rerun()

                with col3:
                    if st.button("Delete", key=f"del_obs_{i}", type="secondary"):
                        # Delete photo file if it exists
                        if obs.get('photo'):
                            photo_path = job_path / obs['photo']
                            if photo_path.exists():
                                photo_path.unlink()
                        st.session_state.observations.pop(i)
                        st.rerun()
        else:
            st.info("No observations recorded. Add observations using the form above.")

# ============================================================================
# TAB: Inspection Schedule
# ============================================================================
with tabs[TAB_INSPECTION]:
    if st.session_state.certificate_type == "EIC":
        # EIC simplified 14-item inspection schedule
        st.markdown('<p class="section-header">EIC Inspection Schedule</p>', unsafe_allow_html=True)

        st.info("EIC uses a simplified 14-item inspection schedule. Mark each item as Satisfactory (tick) or N/A.")

        # Initialize EIC inspection items in session state
        if 'eic_inspection_items' not in st.session_state:
            st.session_state.eic_inspection_items = {}
            for item_id in EIC_SCHEDULE_ITEMS.keys():
                # Get default from baseline config
                item_config = eic_baseline_config.get("inspection_schedule", {}).get("items", {}).get(item_id, {})
                if isinstance(item_config, dict):
                    st.session_state.eic_inspection_items[item_id] = item_config.get("outcome", "tick")
                else:
                    st.session_state.eic_inspection_items[item_id] = item_config if item_config else "tick"

        # Check for bathroom detection
        extent_text = st.session_state.get('eic_extent', '') or st.session_state.get('extent', '')
        bathroom_override = st.session_state.get('bathroom_override', False)
        bathroom_detected = detect_bathroom_work(extent_text) or bathroom_override

        # Auto-set item 12.0 based on bathroom detection
        if bathroom_detected:
            st.session_state.eic_inspection_items["12.0"] = "tick"
        else:
            # Default to N/A if no bathroom work detected
            if st.session_state.eic_inspection_items.get("12.0", "") not in ["tick", "N/A"]:
                st.session_state.eic_inspection_items["12.0"] = "N/A"

        st.markdown("---")
        st.markdown("##### Inspection Schedule Items")

        # Create table for EIC schedule
        for item_id, description in EIC_SCHEDULE_ITEMS.items():
            col1, col2, col3 = st.columns([1, 5, 2])

            with col1:
                st.markdown(f"**{item_id}**")

            with col2:
                st.write(description)

            with col3:
                current = st.session_state.eic_inspection_items.get(item_id, "tick")

                # Special handling for item 12.0 (bathroom)
                if item_id == "12.0":
                    if bathroom_detected:
                        st.markdown(":green[**✓**] (bathroom detected)")
                    else:
                        # Default to N/A when no bathroom
                        default_idx = 1 if current in ["N/A", ""] else (0 if current == "tick" else 1)
                        outcome = st.selectbox(
                            "Outcome",
                            options=["✓", "N/A"],
                            index=default_idx,
                            key=f"eic_insp_{item_id}",
                            label_visibility="collapsed"
                        )
                        st.session_state.eic_inspection_items[item_id] = "tick" if outcome == "✓" else "N/A"
                # Special handling for item 2.0 and 14.0 (typically N/A)
                elif item_id in ["2.0", "14.0"]:
                    outcome = st.selectbox(
                        "Outcome",
                        options=["N/A", "✓"],
                        index=0 if current == "N/A" else 1,
                        key=f"eic_insp_{item_id}",
                        label_visibility="collapsed"
                    )
                    st.session_state.eic_inspection_items[item_id] = "N/A" if outcome == "N/A" else "tick"
                else:
                    outcome = st.selectbox(
                        "Outcome",
                        options=["✓", "N/A"],
                        index=0 if current == "tick" else 1,
                        key=f"eic_insp_{item_id}",
                        label_visibility="collapsed"
                    )
                    st.session_state.eic_inspection_items[item_id] = "tick" if outcome == "✓" else "N/A"

    else:
        # EICR detailed inspection schedule
        st.markdown('<p class="section-header">Inspection Schedule</p>', unsafe_allow_html=True)

        st.info("Default: All items marked as ✓ (satisfactory). Items linked to observations will show the observation code. Select C1/C2/C3 to add an inline observation.")

        # Helper function to get existing photos from job folder
        def get_existing_photos_list(job_folder: Path) -> list:
            """Get list of existing photos in job folder."""
            existing = []
            for photo_dir in [job_folder / "photos_scaled", job_folder / "photos"]:
                if photo_dir.exists():
                    for ext in ["*.jpg", "*.jpeg", "*.png"]:
                        for p in photo_dir.glob(ext):
                            existing.append((p.name, str(p.relative_to(job_folder))))
            return existing

        # Full inspection schedule organized by section (EICR only)
        ALL_SCHEDULE_ITEMS = {
            "1. External condition of intake equipment": {
                "1.1": "Intake equipment - Service cable, Service head, Earthing arrangement",
                "1.1.1": "Person ordering work / duty holder notified",
                "1.2": "Consumer's isolator (where present)",
                "1.3": "Consumer's meter tails",
            },
            "2. Presence of adequate arrangements for other sources": {
                "2.0": "Presence of adequate arrangements for other sources such as microgenerators",
            },
            "3. Earthing / bonding arrangements": {
                "3.1": "Presence and condition of distributor's earthing arrangements",
                "3.2": "Presence and condition of earth electrode connection",
                "3.3": "Provision of earthing/bonding labels at all appropriate locations",
                "3.4": "Confirmation of earthing conductor size",
                "3.5": "Accessibility and condition of earthing conductor at MET",
                "3.6": "Confirmation of main protective bonding conductor sizes",
                "3.7": "Condition and accessibility of main protective bonding connections",
                "3.8": "Accessibility and condition of other protective bonding connections",
            },
            "4. Consumer unit(s) / distribution board(s)": {
                "4.1": "Adequacy of working space/accessibility to consumer unit",
                "4.2": "Security of fixing",
                "4.3": "Condition of enclosure(s) in terms of IP rating",
                "4.4": "Condition of enclosure(s) in terms of fire rating",
                "4.5": "Enclosure not damaged/deteriorated so as to impair safety",
                "4.6": "Presence of main linked switch",
                "4.7": "Operation of main switch (functional check)",
                "4.8": "Manual operation of circuit breakers and RCDs",
                "4.9": "Correct identification of circuit details and protective devices",
                "4.10": "Presence of RCD six-monthly test notice",
                "4.11": "Presence of alternative supply warning notice",
                "4.12": "Presence of other required labelling",
                "4.13": "Compatibility of protective devices, bases and other components",
                "4.14": "Single-pole switching or protective devices in line conductor only",
                "4.15": "Protection against mechanical damage where cables enter",
                "4.16": "Protection against electromagnetic effects where cables enter",
                "4.17": "RCD(s) provided for fault protection",
                "4.18": "RCD(s) provided for additional protection",
                "4.19": "Confirmation of indication that SPD is functional",
                "4.20": "Confirmation that ALL conductor connections are secure",
                "4.21": "Adequate arrangements where generating set operates as switched alternative",
                "4.22": "Adequate arrangements where generating set operates in parallel",
            },
            "5. Final circuits": {
                "5.1": "Identification of conductors",
                "5.2": "Cables correctly supported throughout their run",
                "5.3": "Condition of insulation of live parts",
                "5.4": "Non sheathed cables protected by enclosure",
                "5.4.1": "Integrity of conduit and trunking systems",
                "5.5": "Adequacy of cables for current carrying capacity",
                "5.6": "Coordination between conductors and overload protective devices",
                "5.7": "Adequacy of protective devices for fault protection",
                "5.8": "Presence and adequacy of circuit protective conductors",
                "5.9": "Wiring system(s) appropriate for the installation",
                "5.10": "Concealed cables installed in prescribed zones",
                "5.11": "Cables concealed under floors/ceilings/walls adequately protected",
                "5.12": "Provision of additional protection by RCD not exceeding 30 mA",
                "5.12.1": "RCD for socket outlets 32A or less",
                "5.12.2": "RCD for mobile equipment outdoors",
                "5.12.3": "RCD for cables concealed in walls < 50mm",
                "5.12.4": "RCD for final circuits supplying luminaires (domestic)",
                "5.13": "Provision of fire barriers, sealing arrangements",
                "5.14": "Band II cables segregated from Band I cables",
                "5.15": "Cables segregated from communications cabling",
                "5.16": "Cables segregated from non-electrical services",
                "5.17": "Termination of cables at enclosures",
                "5.17.1": "Connections soundly made and under no undue strain",
                "5.17.2": "No basic insulation visible outside enclosure",
                "5.17.3": "Connections of live conductors adequately enclosed",
                "5.17.4": "Adequately connected at point of entry to enclosure",
                "5.18": "Condition of accessories including socket-outlets, switches",
                "5.19": "Suitability of accessories for external influences",
                "5.20": "Adequacy of working space/accessibility to equipment",
                "5.21": "Single-pole switching in line conductors only",
            },
            "6. Location(s) containing a bath or shower": {
                "6.1": "Additional protection for all LV circuits by RCD not exceeding 30mA",
                "6.2": "Requirements for SELV or PELV met",
                "6.3": "Shaver sockets comply with BS EN 61558-2-5",
                "6.4": "Presence of supplementary bonding conductors",
                "6.5": "LV socket-outlets sited at least 2.5m from zone",
                "6.6": "Suitability of equipment for IP rating",
                "6.7": "Suitability of accessories for a particular zone",
                "6.8": "Suitability of current using equipment for position",
            },
            "7. Other Part 7 special installations or locations": {
                "7.02": "Swimming pools and other basins",
                "7.03": "Rooms and cabins containing sauna heaters",
                "7.04": "Construction and demolition site installations",
                "7.05": "Agricultural and horticultural premises",
                "7.06": "Conducting locations with restricted movement",
                "7.08": "Electrical installations in caravan/camping parks",
                "7.09": "Marinas and similar locations",
                "7.10": "Medical locations",
                "7.11": "Exhibitions, shows and stands",
                "7.12": "Solar photovoltaic (PV) power supply systems",
                "7.14": "Outdoor lighting installations",
                "7.15": "Extra-low voltage lighting installations",
                "7.17": "Mobile or transportable units",
                "7.21": "Electrical installations in caravans and motor caravans",
                "7.22": "Electric vehicle charging installations",
                "7.29": "Operating and maintenance gangways",
                "7.30": "Onshore units of electrical connections for inland navigation",
                "7.40": "Temporary electrical installations for structures/amusements",
                "7.53": "Heating cables and embedded heating systems",
            },
        }

        # Initialize inspection items in session state
        if 'inspection_items' not in st.session_state:
            st.session_state.inspection_items = inspection_schedule.get("items", {})

        # Build observation map for display
        obs_map = {}
        for obs in st.session_state.get('observations', []):
            if obs.get('schedule_item'):
                obs_map[obs['schedule_item']] = obs.get('code', 'FI')

        # Initialize inline observation data storage
        if 'inline_obs_data' not in st.session_state:
            st.session_state.inline_obs_data = {}
            # Pre-populate from existing observations
            for obs in st.session_state.get('observations', []):
                schedule_item = obs.get('schedule_item')
                if schedule_item and obs.get('code') in ['C1', 'C2', 'C3']:
                    regs_list = obs.get('regs', [])
                    regs_str = ", ".join(regs_list) if isinstance(regs_list, list) else str(regs_list)
                    st.session_state.inline_obs_data[schedule_item] = {
                        "title": obs.get('title', ''),
                        "text": obs.get('text', ''),
                        "regs": regs_str,
                        "photo": obs.get('photo')
                    }
                    # Also set the inspection_items to the code
                    st.session_state.inspection_items[schedule_item] = obs.get('code')

        # Quick settings
        col1, col2 = st.columns(2)
        with col1:
            section_7_na = st.checkbox("Mark ALL Section 7 items as N/A", value=True, key="section_7_na")
        with col2:
            show_all = st.checkbox("Show all items (expandable)", value=False, key="show_all_items")

        st.markdown("---")

        # Display schedule by section
        for section_name, items in ALL_SCHEDULE_ITEMS.items():
            with st.expander(section_name, expanded=show_all):
                for item_id, description in items.items():
                    col1, col2, col3 = st.columns([1, 4, 2])

                    with col1:
                        st.markdown(f"**{item_id}**")

                    with col2:
                        st.write(description)

                    with col3:
                        # Check if linked to observation (from Observations tab)
                        if item_id in obs_map:
                            code = obs_map[item_id]
                            code_color = {"C1": "red", "C2": "orange", "C3": "blue", "FI": "gray"}.get(code, "gray")
                            st.markdown(f":{code_color}[**{code}**] (from obs)")
                        elif section_7_na and item_id.startswith("7."):
                            st.markdown(":gray[**N/A**]")
                        else:
                            # Allow override with dropdown
                            current = st.session_state.inspection_items.get(item_id, "tick")
                            options = ["✓", "N/A", "C1", "C2", "C3", "LIM"]
                            # Map current value to index
                            index_map = {"tick": 0, "N/A": 1, "C1": 2, "C2": 3, "C3": 4, "LIM": 5}
                            current_idx = index_map.get(current, 0)

                            outcome = st.selectbox(
                                "Outcome",
                                options=options,
                                index=current_idx,
                                key=f"insp_{item_id}",
                                label_visibility="collapsed"
                            )
                            # Store the selection
                            st.session_state.inspection_items[item_id] = "tick" if outcome == "✓" else outcome

                    # Show inline observation fields when C1/C2/C3 is selected
                    current_outcome = st.session_state.inspection_items.get(item_id, "tick")
                    if current_outcome in ["C1", "C2", "C3"]:
                        # Initialize data for this item if not exists
                        if item_id not in st.session_state.inline_obs_data:
                            st.session_state.inline_obs_data[item_id] = {
                                "title": description,  # Default to schedule item description
                                "text": "",
                                "regs": "",
                                "photo": None
                            }

                        obs_data = st.session_state.inline_obs_data[item_id]
                        border_color = {"C1": "#E74C3C", "C2": "#F39C12", "C3": "#3498DB"}[current_outcome]

                        # Visual container for inline fields
                        st.markdown(
                            f'<div style="background-color: #FFF8E1; padding: 0.5rem 1rem; '
                            f'border-left: 4px solid {border_color}; margin: 0.5rem 0 1rem 2rem; '
                            f'border-radius: 4px;"><small style="color: #666;">Observation for {item_id} ({current_outcome})</small></div>',
                            unsafe_allow_html=True
                        )

                        # Observation fields in columns
                        field_col1, field_col2 = st.columns([3, 1])

                        with field_col1:
                            # Title field
                            new_title = st.text_input(
                                "Item/Location",
                                value=obs_data.get("title", ""),
                                key=f"inline_obs_title_{item_id}",
                                placeholder="e.g., Consumer unit, Kitchen sockets"
                            )
                            st.session_state.inline_obs_data[item_id]["title"] = new_title

                            # Observation text
                            new_text = st.text_area(
                                "Observation Details",
                                value=obs_data.get("text", ""),
                                key=f"inline_obs_text_{item_id}",
                                height=80,
                                placeholder="Describe the deficiency or observation..."
                            )
                            st.session_state.inline_obs_data[item_id]["text"] = new_text

                            # Regulations field
                            new_regs = st.text_input(
                                "Regulations (comma-separated)",
                                value=obs_data.get("regs", ""),
                                key=f"inline_obs_regs_{item_id}",
                                placeholder="e.g., BS 7671 416.2, BS 7671 526.5"
                            )
                            st.session_state.inline_obs_data[item_id]["regs"] = new_regs

                        with field_col2:
                            # Display auto-set values
                            code_color_md = {"C1": "red", "C2": "orange", "C3": "blue"}[current_outcome]
                            st.markdown(f"**Code:** :{code_color_md}[{current_outcome}]")
                            st.markdown(f"**Schedule:** {item_id}")

                            # Photo handling
                            st.markdown("**Photo:**")
                            current_photo = obs_data.get("photo")

                            if current_photo:
                                photo_path = job_path / current_photo
                                if photo_path.exists():
                                    st.image(str(photo_path), width=120)
                                if st.button("Remove Photo", key=f"inline_remove_photo_{item_id}"):
                                    st.session_state.inline_obs_data[item_id]["photo"] = None
                                    st.rerun()
                            else:
                                # Photo tabs: Upload or Select Existing
                                photo_tab1, photo_tab2 = st.tabs(["Upload", "Existing"])

                                with photo_tab1:
                                    uploaded = st.file_uploader(
                                        "Upload",
                                        type=['jpg', 'jpeg', 'png'],
                                        key=f"inline_photo_upload_{item_id}",
                                        label_visibility="collapsed"
                                    )
                                    if uploaded:
                                        photos_dir = job_path / "photos"
                                        photos_dir.mkdir(exist_ok=True)
                                        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                                        file_ext = uploaded.name.split('.')[-1].lower()
                                        photo_filename = f"obs_{item_id.replace('.', '_')}_{timestamp}.{file_ext}"
                                        photo_full_path = photos_dir / photo_filename
                                        with open(photo_full_path, 'wb') as f:
                                            f.write(uploaded.getbuffer())
                                        st.session_state.inline_obs_data[item_id]["photo"] = f"photos/{photo_filename}"
                                        st.rerun()

                                with photo_tab2:
                                    existing_photos = get_existing_photos_list(job_path)
                                    if existing_photos:
                                        photo_options = ["(None)"] + [name for name, _ in existing_photos]
                                        selected = st.selectbox(
                                            "Select",
                                            options=photo_options,
                                            key=f"inline_existing_photo_{item_id}",
                                            label_visibility="collapsed"
                                        )
                                        if selected and selected != "(None)":
                                            for name, rel_path in existing_photos:
                                                if name == selected:
                                                    st.session_state.inline_obs_data[item_id]["photo"] = rel_path
                                                    break
                                    else:
                                        st.caption("No photos")

                        # Save Observation button
                        save_col1, save_col2 = st.columns([3, 1])
                        with save_col2:
                            if st.button("Save Observation", key=f"inline_save_obs_{item_id}", type="primary"):
                                obs_data = st.session_state.inline_obs_data[item_id]
                                if obs_data.get("text"):
                                    # Parse regulations
                                    regs_str = obs_data.get("regs", "")
                                    regs_list = [r.strip() for r in regs_str.split(",") if r.strip()] if regs_str else []

                                    # Build observation
                                    new_obs = {
                                        "title": obs_data.get("title", ""),
                                        "text": obs_data.get("text", ""),
                                        "regs": regs_list,
                                        "code": current_outcome,
                                        "schedule_item": item_id,
                                    }
                                    if obs_data.get("photo"):
                                        new_obs["photo"] = obs_data["photo"]

                                    # Check if observation already exists for this schedule item
                                    existing_idx = None
                                    for idx, obs in enumerate(st.session_state.observations):
                                        if obs.get("schedule_item") == item_id:
                                            existing_idx = idx
                                            break

                                    if existing_idx is not None:
                                        st.session_state.observations[existing_idx] = new_obs
                                    else:
                                        st.session_state.observations.append(new_obs)

                                    # Clear inline data and reset dropdown
                                    del st.session_state.inline_obs_data[item_id]
                                    st.session_state.inspection_items[item_id] = "tick"
                                    st.success(f"Observation saved for {item_id}")
                                    st.rerun()
                                else:
                                    st.error("Please enter observation details")

                        st.markdown("---")

# ============================================================================
# TAB: Defaults Configuration
# ============================================================================
with tabs[TAB_DEFAULTS]:
    render_defaults_tab(base_path, st.session_state.get('selected_user', CURRENT_USER), job_loaded=True)

# ============================================================================
# TAB: Inspector Profile
# ============================================================================
with tabs[TAB_INSPECTOR]:
    st.markdown('<p class="section-header">Inspector Profile Management</p>', unsafe_allow_html=True)

    st.info("Manage inspector profiles here. The selected inspector will be used when generating certificates.")

    # Reload profiles (in case they were updated)
    inspector_profiles = load_inspector_profiles(base_path)

    col1, col2 = st.columns([1, 1])

    with col1:
        st.markdown("##### Add New Inspector")

        with st.form("new_inspector_form"):
            new_name = st.text_input("Full Name *", key="new_inspector_name")
            new_organisation = st.text_input("Organisation", key="new_inspector_org")
            new_enrolment = st.text_input("Enrolment Number", key="new_inspector_enrolment",
                                          help="Your registered competent person scheme enrolment number")
            new_mft_serial = st.text_input("MFT Serial Number", key="new_inspector_mft",
                                           help="Multifunction tester serial number (e.g., Fluke, Megger)")
            new_signature = st.file_uploader("Signature Image",
                                             type=['png', 'jpg', 'jpeg'],
                                             key="new_inspector_sig",
                                             help="Upload a transparent PNG of your signature for best results")
            set_as_default = st.checkbox("Set as default inspector", value=False)

            submitted = st.form_submit_button("Add Inspector", type="primary")

            if submitted:
                if new_name:
                    # Generate ID from name
                    new_id = new_name.lower().replace(" ", "_").replace(".", "")

                    # Check for duplicate
                    existing_ids = [p["id"] for p in inspector_profiles.get("profiles", [])]
                    if new_id in existing_ids:
                        st.error(f"An inspector with a similar name already exists.")
                    else:
                        # Save signature if uploaded
                        signature_filename = None
                        if new_signature:
                            signatures_dir = base_path / "assets" / "signatures"
                            signatures_dir.mkdir(exist_ok=True)

                            file_ext = new_signature.name.split('.')[-1].lower()
                            signature_filename = f"{new_id}_signature.{file_ext}"
                            sig_path = signatures_dir / signature_filename

                            with open(sig_path, 'wb') as f:
                                f.write(new_signature.getbuffer())

                        # Create new profile
                        new_profile = {
                            "id": new_id,
                            "name": new_name,
                            "organisation": new_organisation,
                            "enrolment_number": new_enrolment,
                            "mft_serial_number": new_mft_serial,
                            "signature_file": signature_filename,
                            "is_default": set_as_default
                        }

                        # If setting as default, unset others
                        if set_as_default:
                            for p in inspector_profiles.get("profiles", []):
                                p["is_default"] = False

                        inspector_profiles.setdefault("profiles", []).append(new_profile)
                        inspector_profiles["last_selected"] = new_id
                        save_inspector_profiles(base_path, inspector_profiles)

                        st.success(f"Inspector '{new_name}' added successfully!")
                        st.rerun()
                else:
                    st.error("Please enter the inspector's name.")

    with col2:
        st.markdown("##### Existing Inspectors")

        if inspector_profiles.get("profiles"):
            for i, profile in enumerate(inspector_profiles["profiles"]):
                with st.expander(f"{profile['name']}" + (" (Default)" if profile.get("is_default") else ""), expanded=False):
                    st.write(f"**Name:** {profile['name']}")
                    st.write(f"**Organisation:** {profile.get('organisation', 'Not set')}")
                    st.write(f"**Enrolment Number:** {profile.get('enrolment_number', 'Not set')}")
                    st.write(f"**MFT Serial Number:** {profile.get('mft_serial_number', 'Not set')}")

                    # Show signature if exists
                    if profile.get("signature_file"):
                        sig_path = base_path / "assets" / "signatures" / profile["signature_file"]
                        if sig_path.exists():
                            st.image(str(sig_path), width=150, caption="Signature")
                        else:
                            st.caption("Signature file not found")
                    else:
                        st.caption("No signature uploaded")

                    # Edit fields
                    st.markdown("---")
                    st.markdown("**Edit Profile:**")

                    edit_org = st.text_input("Organisation",
                                             value=profile.get("organisation", ""),
                                             key=f"edit_org_{profile['id']}")
                    edit_enrol = st.text_input("Enrolment Number",
                                               value=profile.get("enrolment_number", ""),
                                               key=f"edit_enrol_{profile['id']}")
                    edit_mft = st.text_input("MFT Serial Number",
                                             value=profile.get("mft_serial_number", ""),
                                             key=f"edit_mft_{profile['id']}")

                    # Upload new signature
                    new_sig = st.file_uploader("Update Signature",
                                               type=['png', 'jpg', 'jpeg'],
                                               key=f"update_sig_{profile['id']}")

                    col_a, col_b, col_c = st.columns(3)

                    with col_a:
                        if st.button("Save Changes", key=f"save_{profile['id']}"):
                            # Update profile
                            profile["organisation"] = edit_org
                            profile["enrolment_number"] = edit_enrol
                            profile["mft_serial_number"] = edit_mft

                            # Save new signature if uploaded
                            if new_sig:
                                signatures_dir = base_path / "assets" / "signatures"
                                signatures_dir.mkdir(exist_ok=True)

                                file_ext = new_sig.name.split('.')[-1].lower()
                                signature_filename = f"{profile['id']}_signature.{file_ext}"
                                sig_path = signatures_dir / signature_filename

                                with open(sig_path, 'wb') as f:
                                    f.write(new_sig.getbuffer())

                                profile["signature_file"] = signature_filename

                            save_inspector_profiles(base_path, inspector_profiles)
                            st.success("Profile updated!")
                            st.rerun()

                    with col_b:
                        if not profile.get("is_default"):
                            if st.button("Set Default", key=f"default_{profile['id']}"):
                                for p in inspector_profiles["profiles"]:
                                    p["is_default"] = (p["id"] == profile["id"])
                                save_inspector_profiles(base_path, inspector_profiles)
                                st.success(f"'{profile['name']}' is now the default inspector.")
                                st.rerun()

                    with col_c:
                        if len(inspector_profiles["profiles"]) > 1:
                            if st.button("Delete", key=f"del_{profile['id']}", type="secondary"):
                                # Remove signature file
                                if profile.get("signature_file"):
                                    sig_path = base_path / "assets" / "signatures" / profile["signature_file"]
                                    if sig_path.exists():
                                        sig_path.unlink()

                                inspector_profiles["profiles"].remove(profile)
                                save_inspector_profiles(base_path, inspector_profiles)
                                st.success(f"Inspector '{profile['name']}' deleted.")
                                st.rerun()
                        else:
                            st.caption("Cannot delete the only inspector")
        else:
            st.warning("No inspectors configured. Add one using the form on the left.")

# ============================================================================
# TAB: Design & Construction (EIC only)
# ============================================================================
if st.session_state.certificate_type == "EIC":
    with tabs[TAB_DESIGN]:
        st.markdown('<p class="section-header">Design, Construction, Inspection & Testing</p>', unsafe_allow_html=True)

        st.info("Complete this section with any departures from BS 7671 or permitted exceptions.")

        st.markdown("##### Departures from BS 7671")
        departures = st.text_area(
            "Details of departures from BS 7671, as amended (Regulations 120.3, 133.5)",
            value=board_details.get("departures_from_bs7671", ""),
            height=100,
            key="departures_from_bs7671",
            help="List any departures from BS 7671. Leave blank if none."
        )

        st.markdown("---")
        st.markdown("##### Permitted Exceptions")

        col1, col2 = st.columns([3, 1])

        with col1:
            exceptions = st.text_area(
                "Details of permitted exceptions (Regulations 411.3.3)",
                value=board_details.get("permitted_exceptions", ""),
                height=100,
                key="permitted_exceptions",
                help="List any permitted exceptions. Leave blank if none."
            )

        with col2:
            risk_assessment = st.checkbox(
                "Risk assessment attached",
                value=board_details.get("risk_assessment_attached", False),
                key="risk_assessment_attached"
            )

        st.markdown("---")
        st.markdown("##### Declaration")
        st.markdown("""
        *I/We, being the person(s) responsible for the design, construction and inspection and testing of the electrical installation
        (as indicated by my/our signatures below), particulars of which are described above, having exercised reasonable skill and care
        when carrying out the design, construction and inspection and testing, hereby CERTIFY that the work for which I have been
        responsible is to the best of my knowledge and belief in accordance with BS7671:2018+A3:2024 (18th Edition) as amended except
        for the departures, if any, detailed above.*
        """)

# ============================================================================
# TAB: Company Settings
# ============================================================================
with tabs[TAB_COMPANY]:
    st.markdown('<p class="section-header">Company Settings</p>', unsafe_allow_html=True)

    if CURRENT_USER:
        st.info(f"These settings apply to **{CURRENT_USER}'s** certificates.")
    else:
        st.info("Configure your company details and logo for certificate branding.")

    # Reload company settings
    company_settings = load_company_settings(base_path, CURRENT_USER)

    col1, col2 = st.columns([1, 1])

    with col1:
        st.markdown("##### Company Details")

        company_name = st.text_input("Company Name",
                                     value=company_settings.get("company_name", ""),
                                     key="company_name_input")
        company_address = st.text_area("Company Address",
                                       value=company_settings.get("company_address", ""),
                                       key="company_address_input",
                                       height=100)
        company_phone = st.text_input("Phone Number",
                                      value=company_settings.get("company_phone", ""),
                                      key="company_phone_input")
        company_email = st.text_input("Email Address",
                                      value=company_settings.get("company_email", ""),
                                      key="company_email_input")
        company_website = st.text_input("Website",
                                        value=company_settings.get("company_website", ""),
                                        key="company_website_input")
        company_registration = st.text_input("Registration / Scheme Number",
                                             value=company_settings.get("company_registration", ""),
                                             key="company_reg_input",
                                             help="e.g., NICEIC, NAPIT, or company registration number")

    with col2:
        st.markdown("##### Company Logo")

        # Show current logo if exists
        if company_settings.get("logo_file"):
            logo_path = base_path / "assets" / "logos" / company_settings["logo_file"]
            if logo_path.exists():
                st.image(str(logo_path), width=200, caption="Current Logo")
            else:
                st.caption("Logo file not found")
        else:
            st.caption("No logo uploaded")

        # Upload new logo
        new_logo = st.file_uploader("Upload Logo",
                                    type=['png', 'jpg', 'jpeg'],
                                    key="company_logo_upload",
                                    help="Upload your company logo (PNG recommended for transparency)")

        if new_logo:
            st.image(new_logo, width=200, caption="New Logo Preview")

    st.markdown("---")

    # Save button
    if st.button("Save Company Settings", type="primary"):
        # Save logo if uploaded
        logo_filename = company_settings.get("logo_file")
        if new_logo:
            logos_dir = base_path / "assets" / "logos"
            logos_dir.mkdir(exist_ok=True)

            file_ext = new_logo.name.split('.')[-1].lower()
            user_suffix = f"_{CURRENT_USER}" if CURRENT_USER else ""
            logo_filename = f"company_logo{user_suffix}.{file_ext}"
            logo_path = logos_dir / logo_filename

            with open(logo_path, 'wb') as f:
                f.write(new_logo.getbuffer())

        # Save settings
        new_settings = {
            "company_name": company_name,
            "company_address": company_address,
            "company_phone": company_phone,
            "company_email": company_email,
            "company_website": company_website,
            "company_registration": company_registration,
            "logo_file": logo_filename
        }
        save_company_settings(base_path, CURRENT_USER, new_settings)
        st.success("Company settings saved!")
        st.rerun()

# ============================================================================
# TAB: Generate PDF
# ============================================================================
with tabs[TAB_PDF]:
    cert_type = st.session_state.certificate_type
    st.markdown(f'<p class="section-header">Generate {cert_type} PDF Certificate</p>', unsafe_allow_html=True)

    st.markdown(f"""
    ### Summary of {cert_type} Certificate Data
    Review the information below before generating the PDF.
    """)

    # Show summary
    col1, col2 = st.columns(2)

    with col1:
        st.markdown("##### Installation")
        st.write(f"**Certificate Type:** {cert_type}")
        st.write(f"**Earthing:** {st.session_state.get('earthing', 'TN-C-S')}")
        st.write(f"**Voltage:** {st.session_state.get('nominal_voltage_u', '230')}V")
        st.write(f"**Frequency:** {st.session_state.get('nominal_frequency', '50')}Hz")

    with col2:
        st.markdown("##### Distribution Board")
        st.write(f"**Name:** {board_details.get('name', 'DB-1')}")
        st.write(f"**Location:** {board_details.get('location', '')}")
        st.write(f"**Circuits:** {len(test_results)}")

    st.markdown("---")

    # EIC-specific: Show installation type
    if cert_type == "EIC":
        st.markdown("##### Installation Type")
        install_type = st.session_state.get('installation_type', 'new_installation')
        st.write(f"**Type:** {INSTALLATION_TYPE_LABELS.get(install_type, install_type)}")

        # Bathroom detection status
        extent_text = st.session_state.get('eic_extent', '') or st.session_state.get('extent', '')
        bathroom_override = st.session_state.get('bathroom_override', False)
        bathroom_detected = detect_bathroom_work(extent_text) or bathroom_override
        if bathroom_detected:
            st.write("**Bathroom Work:** Yes (Item 12.0 will be ticked)")
        else:
            st.write("**Bathroom Work:** No")

        st.markdown("---")

        st.markdown("##### Inspection Schedule Summary")
        eic_items = st.session_state.get('eic_inspection_items', {})
        tick_count = sum(1 for v in eic_items.values() if v == 'tick')
        na_count = sum(1 for v in eic_items.values() if v == 'N/A')
        st.write(f"**Satisfactory (✓):** {tick_count} items")
        st.write(f"**Not Applicable (N/A):** {na_count} items")

    else:
        # EICR-specific: Show observations summary
        st.markdown("##### Observations Summary")
        obs_count = len(st.session_state.get('observations', []))
        c1_count = sum(1 for o in st.session_state.get('observations', []) if o.get('code') == 'C1')
        c2_count = sum(1 for o in st.session_state.get('observations', []) if o.get('code') == 'C2')
        c3_count = sum(1 for o in st.session_state.get('observations', []) if o.get('code') == 'C3')

        col1, col2, col3, col4 = st.columns(4)
        col1.metric("Total", obs_count)
        col2.metric("C1 (Danger)", c1_count)
        col3.metric("C2 (Potentially Dangerous)", c2_count)
        col4.metric("C3 (Improvement)", c3_count)

        st.markdown("---")

        # Determine overall assessment (EICR only)
        if c1_count > 0:
            assessment = "UNSATISFACTORY"
            assessment_color = "red"
        elif c2_count > 0:
            assessment = "UNSATISFACTORY"
            assessment_color = "orange"
        else:
            assessment = "SATISFACTORY"
            assessment_color = "green"

        st.markdown("##### Overall Assessment")
        if assessment == "SATISFACTORY":
            st.markdown(f'<div class="assessment-satisfactory">{assessment}</div>', unsafe_allow_html=True)
        else:
            st.markdown(f'<div class="assessment-unsatisfactory">{assessment}</div>', unsafe_allow_html=True)

    st.markdown("---")

    # Show selected inspector
    st.markdown("##### Inspector / Tested By")
    current_inspector = st.session_state.get('current_inspector')
    if current_inspector:
        col1, col2 = st.columns([2, 1])
        with col1:
            st.write(f"**Name:** {current_inspector.get('name', 'Not set')}")
            st.write(f"**Organisation:** {current_inspector.get('organisation', 'Not set')}")
            st.write(f"**Enrolment Number:** {current_inspector.get('enrolment_number', 'Not set')}")
            st.write(f"**MFT Serial Number:** {current_inspector.get('mft_serial_number', 'Not set')}")
        with col2:
            if current_inspector.get("signature_file"):
                sig_path = base_path / "assets" / "signatures" / current_inspector["signature_file"]
                if sig_path.exists():
                    st.image(str(sig_path), width=120, caption="Signature")
    else:
        st.warning("No inspector selected. Please select an inspector from the sidebar or add one in the Inspector Profile tab.")

    st.markdown("---")

    # Generate PDF button
    col1, col2, col3 = st.columns([1, 2, 1])

    with col2:
        if st.button(f"Generate {cert_type} PDF Certificate", type="primary", use_container_width=True):
            with st.spinner("Generating PDF..."):
                try:
                    # Sync inline observations to main observations list before generating PDF
                    sync_inline_observations_to_main()

                    # Certificate number prefix based on type
                    cert_prefix = "EIC" if cert_type == "EIC" else "EICR"
                    cert_number = f"{cert_prefix}-{datetime.now().strftime('%Y%m%d')}-{st.session_state.current_job[:4].upper()}"

                    # Common PDF data structure
                    pdf_data = {
                        'certificate_number': cert_number,
                        'inspection_date': datetime.now().strftime('%d %b %Y'),
                        'next_inspection_date': (datetime.now().replace(year=datetime.now().year + st.session_state.get('next_inspection', 10 if cert_type == "EIC" else 5))).strftime('%d %b %Y'),
                        'client': {
                            'name': st.session_state.get('client_name', ''),
                            'address': st.session_state.get('client_address', ''),
                        },
                        'installation_details': {
                            'name': st.session_state.get('client_name', ''),
                            'address': st.session_state.get('client_address', ''),
                            'description': st.session_state.get('premises_desc', 'Residential'),
                            'records_available': st.session_state.get('records_available', False),
                            'additions_alterations': st.session_state.get('additions_alterations', False),
                            'installation_type': st.session_state.get('installation_type', 'new_installation'),
                            'next_inspection_years': st.session_state.get('next_inspection', 10 if cert_type == "EIC" else 5),
                        },
                        'extent_and_limitations': {
                            'extent': st.session_state.get('eic_extent', '') or st.session_state.get('extent', baseline_config.get('extent_and_limitations', {}).get('extent', '')),
                            'agreed_limitations': st.session_state.get('agreed_limitations', baseline_config.get('extent_and_limitations', {}).get('agreed_limitations', '')),
                            'operational_limitations': st.session_state.get('operational_limitations', ''),
                            'comments_on_existing': st.session_state.get('comments_on_existing', ''),
                        },
                        'supply_characteristics': {
                            'earthing_arrangement': st.session_state.get('earthing', 'TN-C-S'),
                            'live_conductors': st.session_state.get('live_conductors', 'AC - 1-phase (2 wire)'),
                            'nominal_voltage_u': st.session_state.get('nominal_voltage_u', '230'),
                            'nominal_voltage_uo': st.session_state.get('nominal_voltage_uo', '230'),
                            'nominal_frequency': st.session_state.get('nominal_frequency', '50'),
                            'supply_polarity_confirmed': st.session_state.get('polarity_confirmed', True),
                            'prospective_fault_current': st.session_state.get('pfc', ''),
                            'earth_loop_impedance_ze': st.session_state.get('ze', ''),
                            'number_of_supplies': st.session_state.get('number_of_supplies', '1'),
                            'supply_protective_device': {
                                'bs_en': st.session_state.get('spd_bs_en', 'LIM'),
                                'type': st.session_state.get('spd_type', ''),
                                'short_circuit_capacity': st.session_state.get('spd_capacity', ''),
                                'rated_current': st.session_state.get('spd_current', ''),
                            }
                        },
                        'particulars_of_installation': {
                            **baseline_config.get('particulars_of_installation', {}),
                            'bonding_of_extraneous_parts': {
                                'water': st.session_state.get('bond_water', True),
                                'gas': st.session_state.get('bond_gas', True),
                                'oil': st.session_state.get('bond_oil', False),
                                'steel': st.session_state.get('bond_steel', False),
                                'lightning': st.session_state.get('bond_lightning', False),
                                'other': st.session_state.get('bond_other', 'N/A'),
                            },
                        },
                        'distribution_board': {
                            'board_name': st.session_state.get('board_name', board_details.get('name', 'DB-1')),
                            'name': st.session_state.get('board_name', board_details.get('name', 'DB-1')),
                            'location': st.session_state.get('board_location', board_details.get('location', '')),
                            'manufacturer': st.session_state.get('board_manufacturer', board_details.get('manufacturer', '')),
                            'supplied_from': st.session_state.get('board_supplied_from', board_details.get('supplied_from', '')),
                            'phases': st.session_state.get('board_phases', board_details.get('phases', '1')),
                            'zs_at_db': st.session_state.get('board_zs', board_details.get('zs_at_db', '')),
                            'ipf_at_db': st.session_state.get('board_ipf', board_details.get('ipf_at_db', '')),
                            'polarity_confirmed': st.session_state.get('board_polarity', True),
                        },
                        'observations': st.session_state.get('observations', []),
                        # Apply field mapping to convert CSV field names to PDF generator field names
                        'circuits': [map_circuit_fields(c, float(st.session_state.get('ze', 0) or 0)) for c in st.session_state.get('edited_circuits', test_results)],
                        'inspection_schedule': inspection_schedule,
                        # Job path for resolving photo paths
                        'job_path': str(job_path),
                        # Inspector information
                        'inspector': {
                            'name': current_inspector.get('name', '') if current_inspector else '',
                            'position': current_inspector.get('position', 'Qualified Supervisor') if current_inspector else 'Qualified Supervisor',
                            'organisation': current_inspector.get('organisation', '') if current_inspector else '',
                            'enrolment_number': current_inspector.get('enrolment_number', '') if current_inspector else '',
                            'mft_serial_number': current_inspector.get('mft_serial_number', '') if current_inspector else '',
                            'signature_file': str(base_path / "assets" / "signatures" / current_inspector["signature_file"]) if current_inspector and current_inspector.get("signature_file") else None,
                        },
                    }

                    # EIC-specific data
                    if cert_type == "EIC":
                        pdf_data['design_construction'] = {
                            'departures_from_bs7671': st.session_state.get('departures_from_bs7671', ''),
                            'permitted_exceptions': st.session_state.get('permitted_exceptions', ''),
                            'risk_assessment_attached': st.session_state.get('risk_assessment_attached', False),
                        }
                        # Convert EIC inspection items to the expected format
                        eic_items = st.session_state.get('eic_inspection_items', {})
                        pdf_data['inspection_schedule'] = {'items': eic_items}

                        # Add main_switch data to particulars_of_installation for EIC
                        board_location = st.session_state.get('board_location', board_details.get('location', ''))
                        pdf_data['particulars_of_installation'] = {
                            **baseline_config.get('particulars_of_installation', {}),
                            'main_switch': {
                                'location': board_location,
                                'type_bs_en': st.session_state.get('ms_bs_en', '60947-3'),
                                'number_of_poles': st.session_state.get('ms_poles', '2'),
                                'voltage_rating': st.session_state.get('ms_voltage', '230'),
                                'rated_current': st.session_state.get('ms_current', '100'),
                            },
                            'earthing_conductor': {
                                'conductor_material': st.session_state.get('ec_material', 'Copper'),
                                'conductor_csa': st.session_state.get('ec_csa', ''),
                                'continuity': st.session_state.get('ec_continuity', True),
                            },
                            'main_protective_bonding': {
                                'conductor_material': st.session_state.get('mpb_material', 'Copper'),
                                'conductor_csa': st.session_state.get('mpb_csa', ''),
                                'continuity': st.session_state.get('mpb_continuity', True),
                            },
                            'bonding_of_extraneous_parts': {
                                'water': st.session_state.get('bond_water', True),
                                'gas': st.session_state.get('bond_gas', True),
                                'oil': st.session_state.get('bond_oil', False),
                                'steel': st.session_state.get('bond_steel', False),
                                'lightning': st.session_state.get('bond_lightning', False),
                                'other': st.session_state.get('bond_other', 'N/A'),
                            },
                        }

                        # Add main_switch to distribution_board as well for the board section
                        pdf_data['distribution_board']['main_switch'] = {
                            'bs_en': st.session_state.get('ms_bs_en', '60947-3'),
                            'voltage_rating': st.session_state.get('ms_voltage', '230'),
                            'rated_current': st.session_state.get('ms_current', '100'),
                        }
                        pdf_data['distribution_board']['main_switch_bs_en'] = st.session_state.get('ms_bs_en', '60947-3')
                        pdf_data['distribution_board']['voltage_rating'] = st.session_state.get('ms_voltage', '230')
                        pdf_data['distribution_board']['rated_current'] = st.session_state.get('ms_current', '100')

                    # Generate PDF based on certificate type
                    output_filename = f"{cert_prefix}_{cert_number}.pdf"
                    output_path = str(job_path / output_filename)

                    if cert_type == "EIC":
                        generate_eic_pdf(pdf_data, output_path)
                    else:
                        generate_eicr_pdf(pdf_data, output_path)

                    st.success(f"{cert_type} PDF generated successfully!")

                    # Copy to Completed Certificates folder
                    import shutil
                    user_suffix = f" {CURRENT_USER}" if CURRENT_USER else ""
                    completed_folder = base_path.parent / f"Completed Certificates{user_suffix}"
                    completed_folder.mkdir(exist_ok=True)

                    # Use address as filename, or fall back to certificate number
                    address = st.session_state.get('client_address', '').strip()
                    if address:
                        # Clean address for filename
                        clean_address = address.replace('/', '-').replace('\\', '-')
                        for char in '<>:"|?*':
                            clean_address = clean_address.replace(char, '')
                        completed_filename = f"{clean_address}.pdf"
                    else:
                        completed_filename = output_filename

                    completed_path = completed_folder / completed_filename
                    shutil.copy2(output_path, completed_path)
                    st.success(f"Certificate copied to: Completed Certificates{user_suffix}/{completed_filename}")

                    # Provide download button
                    with open(output_path, 'rb') as f:
                        st.download_button(
                            label=f"Download {cert_type} PDF",
                            data=f.read(),
                            file_name=output_filename,
                            mime="application/pdf",
                            use_container_width=True
                        )

                    st.info(f"PDF also saved to job folder: {output_path}")

                except Exception as e:
                    st.error(f"Error generating PDF: {e}")
                    import traceback
                    st.code(traceback.format_exc())

        st.caption("The PDF will be saved to the job output folder.")

# ============================================================================
# Sidebar - Save Button
# ============================================================================
st.sidebar.markdown("---")
if st.sidebar.button("Save All Changes", type="secondary", use_container_width=True):
    # Save selected inspector preference
    if st.session_state.get('selected_inspector'):
        inspector_profiles = load_inspector_profiles(base_path)
        inspector_profiles["last_selected"] = st.session_state.get('selected_inspector')
        save_inspector_profiles(base_path, inspector_profiles)

    # Sync inline observations to main observations list before saving
    sync_inline_observations_to_main()

    # Save observations
    save_json_file(job_path / "observations.json", st.session_state.get('observations', []))

    # Save circuit data if edited
    if 'edited_circuits' in st.session_state:
        fieldnames = list(st.session_state.edited_circuits[0].keys()) if st.session_state.edited_circuits else []
        save_csv_file(job_path / "test_results.csv", st.session_state.edited_circuits, fieldnames)

    # Save board details with all fields
    updated_board = {
        "name": st.session_state.get("board_name", "DB-1"),
        "location": st.session_state.get("board_location", ""),
        "manufacturer": st.session_state.get("board_manufacturer", ""),
        "supplied_from": st.session_state.get("board_supplied_from", ""),
        "phases": st.session_state.get("board_phases", "1"),
        "earthing_arrangement": st.session_state.get("earthing", "TN-C-S"),
        "ze": st.session_state.get("ze", ""),
        "zs_at_db": st.session_state.get("board_zs", ""),
        "ipf_at_db": st.session_state.get("pfc", ""),
        "main_switch_bs_en": st.session_state.get("ms_bs_en", "60947-3"),
        "main_switch_poles": st.session_state.get("ms_poles", "2"),
        "voltage_rating": st.session_state.get("ms_voltage", "230"),
        "rated_current": st.session_state.get("ms_current", "100"),
        "fuse_device_setting": st.session_state.get("ms_fuse", "N/A"),
        "ipf_rating": st.session_state.get("ms_ipf", ""),
        "tails_material": st.session_state.get("tails_material", "Cu"),
        "tails_csa": st.session_state.get("tails_csa", "25"),
        "earthing_conductor_material": st.session_state.get("ec_material", "Cu"),
        "earthing_conductor_csa": st.session_state.get("ec_csa", "16"),
        "earthing_conductor_continuity": st.session_state.get("ec_continuity", True),
        "bonding_conductor_material": st.session_state.get("mpb_material", "Cu"),
        "bonding_conductor_csa": st.session_state.get("mpb_csa", "10"),
        "bonding_conductor_continuity": st.session_state.get("mpb_continuity", True),
        "bond_water": st.session_state.get("bond_water", True),
        "bond_gas": st.session_state.get("bond_gas", True),
        "bond_oil": st.session_state.get("bond_oil", False),
        "bond_steel": st.session_state.get("bond_steel", False),
        "bond_lightning": st.session_state.get("bond_lightning", False),
        "bond_other": st.session_state.get("bond_other", "N/A"),
        "spd_type": st.session_state.get("spd_type_board", ""),
        "spd_status": st.session_state.get("spd_status", ""),
        "rcd_rating": st.session_state.get("rcd_rating", "N/A"),
        "notes": st.session_state.get("board_notes", ""),
        # Supply characteristics
        "live_conductors": st.session_state.get("live_conductors", "AC - 1-phase (2 wire)"),
        "nominal_voltage_u": st.session_state.get("nominal_voltage_u", "230"),
        "nominal_voltage_uo": st.session_state.get("nominal_voltage_uo", "230"),
        "nominal_frequency": st.session_state.get("nominal_frequency", "50"),
        "number_of_supplies": st.session_state.get("number_of_supplies", "1"),
        # Supply protective device
        "spd_bs_en": st.session_state.get("spd_bs_en", "LIM"),
        "spd_type_supply": st.session_state.get("spd_type_supply", "LIM"),
        "spd_short_circuit": st.session_state.get("spd_capacity", "LIM"),
        "spd_rated_current": st.session_state.get("spd_current", "LIM"),
        # Extent and limitations
        "extent": st.session_state.get("extent", "Fixed electrical wiring installation.\n20% of accessories opened"),
        "agreed_limitations": st.session_state.get("agreed_limitations", ""),
        "agreed_with": st.session_state.get("agreed_with", "Occupier"),
        "operational_limitations": st.session_state.get("operational_limitations", ""),
    }
    save_json_file(job_path / "board_details.json", updated_board)

    # Save installation details (client name and address)
    updated_installation = {
        "client_name": st.session_state.get("client_name", ""),
        "address": st.session_state.get("client_address", ""),
        "postcode": installation_details.get("postcode", ""),  # Preserve existing postcode
    }
    save_json_file(job_path / "installation_details.json", updated_installation)

    st.sidebar.success("Changes saved!")

st.sidebar.markdown("---")

# Bug Report Form
show_bug_report_form()

st.sidebar.markdown("---")

# User info and logout
user_name = st.session_state.get('user_name', st.session_state.get('user_email', 'User'))
st.sidebar.caption(f"Logged in as: **{user_name}**")

if st.sidebar.button("Logout", use_container_width=True):
    do_logout()

st.sidebar.markdown("---")
st.sidebar.caption("EICR Certificate Editor v1.0")
