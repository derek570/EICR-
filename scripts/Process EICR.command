#!/bin/bash

# EICR Automation Launcher
# Double-click this file to process all jobs in the INCOMING folder

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Change to the project root directory
cd "$SCRIPT_DIR"

echo ""
echo "Starting EICR Automation..."
echo ""

# Run the processing script
node run_all.js

echo ""
echo "----------------------------------------"
echo "Processing complete. Press any key to close."
read -n 1 -s
