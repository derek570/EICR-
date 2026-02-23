#!/bin/bash

# EICR-oMatic 3000 - Derek's Editor
# Double-click to open Derek's certificate editor

cd "$(dirname "$0")"

clear
echo ""
echo "=============================================="
echo "      EICR-oMatic 3000 Editor - Derek"
echo "=============================================="
echo ""
echo "Starting editor..."
echo "A browser window will open automatically."
echo ""
echo "(Keep this window open while using the editor)"
echo ""

python3 -m streamlit run EICR_App/python/eicr_editor.py --server.headless false -- --user Derek
