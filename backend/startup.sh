#!/bin/bash
set -u

# /home is the App Service's persistent filesystem. Keeping the browser there
# avoids downloading it again on every deployment or container replacement.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/.cache/ms-playwright}"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

echo "Ensuring Playwright Chromium is installed at $PLAYWRIGHT_BROWSERS_PATH..."
if python -m playwright install --with-deps chromium; then
    echo "Playwright Chromium is ready."
else
    # The application serves both tenants and most features do not use a browser.
    # Keep it online if an apt/CDN failure is transient; tenant 1 survey submission
    # will return its existing explicit error until Chromium is available.
    echo "ERROR: Playwright Chromium installation failed; starting the backend without it." >&2
fi

# Start the application
exec python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
