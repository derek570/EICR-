#!/bin/bash

# EICR-oMatic 3000 - Certificate Editor
# Double-click this file to open the editor

# Navigate to the project root (parent of scripts/)
cd "$(dirname "$0")/.."

clear
echo ""
echo "=============================================="
echo "         EICR-oMatic 3000 Editor"
echo "=============================================="
echo ""
echo "Starting editor..."
echo "A browser window will open automatically."
echo ""
echo "(Keep this window open while using the editor)"
echo ""

# Run the Streamlit editor
python3 -m streamlit run python/eicr_editor.py --server.headless false
