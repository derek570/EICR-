#!/bin/bash

# EICR-oMatic 3000 - Create New User
# Double-click to create a new user account

cd "$(dirname "$0")"

clear
echo ""
echo "=============================================="
echo "      EICR-oMatic 3000 - Create User"
echo "=============================================="
echo ""

python3 EICR_App/python/admin.py create

echo ""
echo "=============================================="
echo "Press any key to close this window..."
read -n 1
