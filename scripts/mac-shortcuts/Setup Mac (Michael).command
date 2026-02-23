#!/bin/bash

# EICR-oMatic 3000 - Setup Script for Michael
# Double-click this file to install all required software

cd "$(dirname "$0")"

clear
echo ""
echo "=============================================="
echo "     EICR-oMatic 3000 - Mac Setup Script"
echo "=============================================="
echo ""
echo "This will install the required software:"
echo "  - Homebrew (Mac package manager)"
echo "  - Python 3"
echo "  - Node.js"
echo "  - Python packages (Streamlit, etc.)"
echo ""
echo "This may take 5-10 minutes."
echo ""
read -p "Press Enter to continue (or Ctrl+C to cancel)..."
echo ""

# Track if anything failed
ERRORS=0

# Step 1: Install Homebrew if not present
echo "----------------------------------------------"
echo "Step 1/4: Checking Homebrew..."
echo "----------------------------------------------"
if command -v brew &> /dev/null; then
    echo "Homebrew is already installed."
else
    echo "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Add Homebrew to PATH for Apple Silicon Macs
    if [[ -f "/opt/homebrew/bin/brew" ]]; then
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi

    if command -v brew &> /dev/null; then
        echo "Homebrew installed successfully."
    else
        echo "ERROR: Homebrew installation failed."
        ERRORS=$((ERRORS + 1))
    fi
fi
echo ""

# Step 2: Install Python 3
echo "----------------------------------------------"
echo "Step 2/4: Checking Python 3..."
echo "----------------------------------------------"
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version)
    echo "Python 3 is installed: $PYTHON_VERSION"
else
    echo "Installing Python 3..."
    brew install python3
    if command -v python3 &> /dev/null; then
        echo "Python 3 installed successfully."
    else
        echo "ERROR: Python 3 installation failed."
        ERRORS=$((ERRORS + 1))
    fi
fi
echo ""

# Step 3: Install Node.js
echo "----------------------------------------------"
echo "Step 3/4: Checking Node.js..."
echo "----------------------------------------------"
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo "Node.js is installed: $NODE_VERSION"
else
    echo "Installing Node.js..."
    brew install node
    if command -v node &> /dev/null; then
        echo "Node.js installed successfully."
    else
        echo "ERROR: Node.js installation failed."
        ERRORS=$((ERRORS + 1))
    fi
fi
echo ""

# Step 4: Install Python packages
echo "----------------------------------------------"
echo "Step 4/4: Installing Python packages..."
echo "----------------------------------------------"
echo "Installing: streamlit, pandas, reportlab, Pillow, python-dotenv"
pip3 install --upgrade streamlit pandas reportlab Pillow python-dotenv
if [ $? -eq 0 ]; then
    echo "Python packages installed successfully."
else
    echo "ERROR: Some Python packages failed to install."
    ERRORS=$((ERRORS + 1))
fi
echo ""

# Summary
echo "=============================================="
echo "                  COMPLETE"
echo "=============================================="
echo ""
if [ $ERRORS -eq 0 ]; then
    echo "All software installed successfully!"
    echo ""
    echo "You can now double-click:"
    echo "  'Open Editor (Michael).command' to edit certificates"
    echo ""
else
    echo "Setup completed with $ERRORS error(s)."
    echo "Please check the messages above and try again,"
    echo "or contact Derek for help."
    echo ""
fi

read -p "Press Enter to close this window..."
