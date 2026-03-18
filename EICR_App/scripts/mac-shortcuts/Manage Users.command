#!/bin/bash

# EICR-oMatic 3000 - User Management
# Double-click to manage user accounts

cd "$(dirname "$0")"

while true; do
    clear
    echo ""
    echo "=============================================="
    echo "      EICR-oMatic 3000 - User Management"
    echo "=============================================="
    echo ""
    echo "  1) Create new user"
    echo "  2) List all users"
    echo "  3) Reset password"
    echo "  4) Disable user"
    echo "  5) Enable user"
    echo "  6) Delete user (permanent)"
    echo "  7) View bug reports"
    echo ""
    echo "  0) Exit"
    echo ""
    echo "=============================================="
    echo ""
    read -p "  Select option: " choice

    case $choice in
        1)
            echo ""
            python3 EICR_App/python/admin.py create
            echo ""
            read -p "Press Enter to continue..."
            ;;
        2)
            echo ""
            python3 EICR_App/python/admin.py list
            echo ""
            read -p "Press Enter to continue..."
            ;;
        3)
            echo ""
            read -p "  Enter user email: " email
            python3 EICR_App/python/admin.py reset-password "$email"
            echo ""
            read -p "Press Enter to continue..."
            ;;
        4)
            echo ""
            read -p "  Enter user email: " email
            python3 EICR_App/python/admin.py disable "$email"
            echo ""
            read -p "Press Enter to continue..."
            ;;
        5)
            echo ""
            read -p "  Enter user email: " email
            python3 EICR_App/python/admin.py enable "$email"
            echo ""
            read -p "Press Enter to continue..."
            ;;
        6)
            echo ""
            echo "  WARNING: This permanently deletes the user and all their data!"
            read -p "  Enter user email: " email
            python3 EICR_App/python/admin.py delete "$email"
            echo ""
            read -p "Press Enter to continue..."
            ;;
        7)
            echo ""
            python3 EICR_App/python/admin.py bugs
            echo ""
            read -p "Press Enter to continue..."
            ;;
        0)
            echo ""
            echo "  Goodbye!"
            echo ""
            exit 0
            ;;
        *)
            echo ""
            echo "  Invalid option. Please try again."
            sleep 1
            ;;
    esac
done
