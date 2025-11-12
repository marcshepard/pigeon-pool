"""
Send email function (with simple dry-run support).
Set EMAIL_DRY_RUN=true to log and skip sending.
"""

from __future__ import annotations
import os

from azure.communication.email import EmailClient
from .settings import get_settings
from .logger import debug, info, warn, error

# pylint: disable=line-too-long, broad-except

_settings = get_settings()

def _is_dry_run() -> bool:
    # Read at call time so CLI/exported env takes effect immediately
    v = os.getenv("EMAIL_DRY_RUN", "")
    return v.strip().lower() in ("1", "true", "yes", "on")

def send_email(
    to: str,
    subject: str,
    plain_text: str,
    html: str
) -> bool:
    """Send an email using Azure Communication Services EmailClient."""
    if _is_dry_run():
        info("component=email", mode="DRY_RUN", to=to, subject=subject)
        return True

    debug(f"Sending email to {to}")
    try:
        connection_string = f"endpoint={_settings.email_endpoint};accesskey={_settings.email_access_key}"
        client = EmailClient.from_connection_string(connection_string)

        message = {
            "senderAddress": "DoNotReply@pigeonpool.com",
            "recipients": {"to": [{"address": to}]},
            "content": {"subject": subject, "plainText": plain_text, "html": html},
        }

        poller = client.begin_send(message)
        result = poller.result()
        debug(f"Email successfully sent. Result: {result}")
        return True
    except Exception:
        error("Error sending email", exc_info=True)
        return False

def filter_valid_recipients(addresses: list[str]) -> list[str]:
    """Remove placeholder/test addresses such as *@example.com."""
    return [a for a in addresses if a and not a.lower().endswith("@example.com")]

def send_bulk_email_bcc(bcc: list[str], subject: str, plain_text: str, html: str) -> bool:
    """Send an email to multiple recipients via BCC."""
    valid_bcc = filter_valid_recipients(bcc)

    if _is_dry_run():
        # Log even if empty, but return True so jobs don't look like failures
        info("component=email", mode="DRY_RUN", recipients=valid_bcc, subject=subject)
        return True

    if not valid_bcc:
        # Keep current behavior in live mode: nothing to send → False
        return False

    try:
        connection_string = f"endpoint={_settings.email_endpoint};accesskey={_settings.email_access_key}"
        client = EmailClient.from_connection_string(connection_string)
        message = {
            "senderAddress": "DoNotReply@pigeonpool.com",
            "recipients": {
                "to": [{"address": "DoNotReply@pigeonpool.com"}],
                "bcc": [{"address": addr} for addr in valid_bcc],
            },
            "content": {"subject": subject, "plainText": plain_text, "html": html},
        }
        poller = client.begin_send(message)
        poller.result()
        return True
    except Exception:
        error("Error sending bulk email", exc_info=True)
        return False

# New helper for admin bulk email to all users (no SQL)
def send_bulk_email_to_all_users(emails: list[str], subject: str, plain_text: str) -> bool:
    """Send a plain text email to all users (admin bulk email)."""
    if not emails:
        warn("No user emails found for bulk email.")
        return False
    # Use BCC for privacy
    return send_bulk_email_bcc(emails, subject, plain_text, None)
