#!/bin/bash
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Applying database migrations..."
if python -m backend.migrate; then
    echo "Database migration phase completed."
else
    echo "ERROR: Database migration failed; refusing to start the backend." >&2
    exit 1
fi

# /home is the App Service's persistent filesystem. Keeping the browser there
# avoids downloading it again on every deployment or container replacement.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/.cache/ms-playwright}"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

# App Service images can be replaced independently of the persistent browser cache.
# Chromium requires this library even when the matching browser is already cached in /home.
if ! ldconfig -p | grep -Fq "libglib-2.0.so.0"; then
    echo "Installing missing Chromium dependency: libglib2.0-0..."
    if ! apt-get update || ! apt-get install -y --no-install-recommends libglib2.0-0; then
        echo "ERROR: Could not install libglib2.0-0; CrowdSignal submission will be unavailable." >&2
    fi
fi

echo "Ensuring Playwright Chromium is installed at $PLAYWRIGHT_BROWSERS_PATH..."
PLAYWRIGHT_INSTALLED=false
if python -m playwright install --with-deps chromium; then
    PLAYWRIGHT_INSTALLED=true
else
    echo "Playwright dependency installation failed; using Debian's direct security archive and retrying once..." >&2
    apt-get clean
    rm -rf /var/lib/apt/lists/*
    if [ -f /etc/apt/sources.list ]; then
        sed -i 's|http://deb.debian.org/debian-security|http://security.debian.org/debian-security|g' /etc/apt/sources.list
    fi
    if apt-get update && python -m playwright install --with-deps chromium; then
        PLAYWRIGHT_INSTALLED=true
    fi
fi

if [ "$PLAYWRIGHT_INSTALLED" = true ]; then
    if timeout 15s python -m backend.verify_playwright; then
        echo "Playwright Chromium is ready."
    else
        # The application serves both tenants and most features do not use a browser.
        # Keep it online if Chromium cannot launch; tenant 1 submission will fail explicitly.
        echo "ERROR: Playwright Chromium launch check failed; CrowdSignal submission is unavailable." >&2
    fi
else
    # The application serves both tenants and most features do not use a browser.
    # Keep it online if an apt/CDN failure is transient; tenant 1 survey submission
    # will return its existing explicit error until Chromium is available.
    echo "ERROR: Playwright Chromium installation failed; starting the backend without it." >&2
fi

# Start the application
exec python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
