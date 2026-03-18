#!/bin/bash

# EICR-oMatic 3000 - Michael's Editor
# Double-click to open Michael's certificate editor

cd "$(dirname "$0")"

clear
echo ""
echo "=============================================="
echo "     EICR-oMatic 3000 Editor - Michael"
echo "=============================================="
echo ""
echo "Starting editor..."
echo "A browser window will open automatically."
echo ""
echo "(Keep this window open while using the editor)"
echo ""

python3 -m streamlit run EICR_App/python/eicr_editor.py --server.headless false -- --user Michael
