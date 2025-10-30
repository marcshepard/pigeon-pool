#!/bin/bash

# Install Playwright browsers if not already installed
if [ ! -d "/root/.cache/ms-playwright/chromium-1187" ]; then
    echo "Installing Playwright browsers..."
    python -m playwright install --with-deps chromium
fi

# Start the application
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
