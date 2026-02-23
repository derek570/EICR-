#!/bin/bash

# EICR-oMatic 3000 - Job Processor
# Double-click this file to process all jobs in INCOMING folder

# Navigate to the project root (parent of scripts/)
cd "$(dirname "$0")/.."

clear
echo ""
echo "=============================================="
echo "         EICR-oMatic 3000"
echo "=============================================="
echo ""
echo "Processing jobs in INCOMING folder..."
echo ""

# Run the processor
node run_all.js

echo ""
echo "=============================================="
echo "Processing complete!"
echo "=============================================="
echo ""
echo "- Results are in the data/OUTPUT folder"
echo "- Completed jobs moved to data/DONE folder"
echo "- Failed jobs moved to data/FAILED folder"
echo ""
echo "Press Enter to close this window..."
read
