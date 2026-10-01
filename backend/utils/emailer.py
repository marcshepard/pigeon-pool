"""
Send email function (with simple dry-run support).
Set EMAIL_DRY_RUN=true to log and skip sending.
"""

from __future__ import annotations

import os

from azure.communication.email import EmailClient

from .logger import debug, error, info, warn
from .settings import get_settings

# pylint: disable=line-too-long, broad-except

_settings = get_settings()
# Azure's 50-recipient limit includes the fixed To address.
_BCC_BATCH_SIZE = 49

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
    except Exception as exc:  # noqa: BLE001 - external SDK failures are logged and reported as False
        error("Error sending email", err_type=type(exc).__name__,
              status_code=getattr(exc, "status_code", None), err=str(exc))
        return False

def filter_valid_recipients(addresses: list[str]) -> list[str]:
    """Remove placeholder/test addresses such as *@example.com."""
    return [a for a in addresses if a and not a.lower().endswith("@example.com")]

def send_bulk_email_bcc(bcc: list[str], subject: str, plain_text: str, html: str) -> bool:
    """Send BCC batches; stop on failure without retrying completed batches."""
    valid_bcc = filter_valid_recipients(bcc)

    if _is_dry_run():
        # Log even if empty, but return True so jobs don't look like failures
        info("component=email", mode="DRY_RUN", recipients=valid_bcc, subject=subject)
        return True

    if not valid_bcc:
        # Keep current behavior in live mode: nothing to send → False
        return False

    batch_number = 0
    batch_count = (len(valid_bcc) + _BCC_BATCH_SIZE - 1) // _BCC_BATCH_SIZE
    try:
        connection_string = f"endpoint={_settings.email_endpoint};accesskey={_settings.email_access_key}"
        client = EmailClient.from_connection_string(connection_string)
        for offset in range(0, len(valid_bcc), _BCC_BATCH_SIZE):
            batch_number += 1
            batch = valid_bcc[offset:offset + _BCC_BATCH_SIZE]
            message = {
                "senderAddress": "DoNotReply@pigeonpool.com",
                "recipients": {
                    "to": [{"address": "DoNotReply@pigeonpool.com"}],
                    "bcc": [{"address": addr} for addr in batch],
                },
                "content": {"subject": subject, "plainText": plain_text, "html": html},
            }
            poller = client.begin_send(message)
            poller.result()
            info("component=email", batch=batch_number, batches=batch_count,
                 recipients=len(batch), message="batch sent")
        return True
    except Exception as exc:  # noqa: BLE001 - external SDK failures are logged and reported as False
        error("Error sending bulk email", batch=batch_number, batches=batch_count,
              err_type=type(exc).__name__, status_code=getattr(exc, "status_code", None),
              err=str(exc))
        return False

# New helper for admin bulk email to all users (no SQL)
def send_bulk_email_to_all_users(emails: list[str], subject: str, plain_text: str) -> bool:
    """Send a plain text email to all users (admin bulk email)."""
    if not emails:
        warn("No user emails found for bulk email.")
        return False
    # Use BCC for privacy
    return send_bulk_email_bcc(emails, subject, plain_text, "")
