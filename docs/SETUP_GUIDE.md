# EICR-oMatic 3000 - Setup Guide for New Mac

## Overview
This guide will set up the EICR-oMatic 3000 on a new Mac so it can process EICR jobs.

---

## Step 1: Install Required Software

### 1.1 Install Homebrew (if not already installed)
Open **Terminal** (press Cmd+Space, type "Terminal") and paste:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 1.2 Install Node.js
```bash
brew install node
```

### 1.3 Install Python dependencies
```bash
pip3 install streamlit pandas reportlab Pillow
```

### 1.4 Install Playwright (for PDF generation)
```bash
npx playwright install chromium
```

---

## Step 2: Access the Shared iCloud Folder

1. Derek will share the **EICR_Automation** folder via iCloud
2. Accept the share invitation
3. The folder will appear in **Finder > iCloud Drive > EICR_Automation**

---

## Step 3: Set Up API Keys

The system needs API keys to work. Create a file called `.env` in the EICR_Automation folder.

### 3.1 Open Terminal and run:
```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/EICR_Automation
nano .env
```

### 3.2 Add these lines (Derek will provide the actual keys):
```
GEMINI_API_KEY=your_gemini_key_here
OPENAI_API_KEY=your_openai_key_here
```

### 3.3 Save and exit:
- Press **Ctrl+X**
- Press **Y** to confirm
- Press **Enter**

---

## Step 4: Install Node Dependencies

```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/EICR_Automation
npm install
```

---

## Step 5: Test It Works

```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/EICR_Automation
node run_all.js
```

You should see "No job folders found" if the INCOMING folder is empty.

---

## Daily Usage

### To Process Jobs:
1. Double-click **"Run EICR-oMatic 3000"** app on the Desktop
2. Jobs in INCOMING will be processed
3. Results appear in OUTPUT folder
4. Completed jobs move to DONE folder

### To Edit/Review Certificates:
1. Double-click **"EICR Editor"** app on the Desktop
2. Select a job from the dropdown
3. Review and edit as needed
4. Generate final PDF

---

## Troubleshooting

### "Command not found" errors
Run the install steps again, or check that Terminal can find node:
```bash
which node
```

### API errors
Check the `.env` file has the correct API keys.

### Jobs not processing
Check the INCOMING folder has audio files (.m4a, .mp3) or photos (.jpg, .heic).

---

## Need Help?
Contact Derek.
