"""
Send email function
"""

from azure.communication.email import EmailClient
from .settings import get_settings
from .logger import debug, error

#pylint: disable=line-too-long, broad-except

_settings = get_settings()

def send_email(
    to: str,
    subject: str,
    plain_text: str,
    html: str
) -> None:
    """ Send an email using Azure Communication Services EmailClient """
    debug(f"Sending email to {to}")
    try:
        connection_string = f"endpoint={_settings.email_endpoint};accesskey={_settings.email_access_key}"
        client = EmailClient.from_connection_string(connection_string)

        message = {
            "senderAddress": "DoNotReply@pigeonpool.com",
            "recipients": {
                "to": [{"address": to}]
            },
            "content": {
                "subject": subject,
                "plainText": plain_text,
                "html": html
            },
        }

        poller = client.begin_send(message)
        result = poller.result()
        debug(f"Email succesfully sent. Result: {result}")

    except Exception:
        error("Error sending email", exc_info=True)

def filter_valid_recipients(addresses: list[str]) -> list[str]:
    """Remove placeholder/test addresses such as *@example.com."""
    return [a for a in addresses if not a.lower().endswith("@example.com")]

def send_bulk_email_bcc(bcc: list[str], subject: str, plain_text: str, html: str) -> bool:
    """Send an email to multiple recipients via BCC."""
    valid_bcc = filter_valid_recipients(bcc)
    if not valid_bcc:
        return False
    try:
        connection_string = f"endpoint={_settings.email_endpoint};accesskey={_settings.email_access_key}"
        client = EmailClient.from_connection_string(connection_string)
        message = {
            "senderAddress": "DoNotReply@pigeonpool.com",
            "recipients": {"to": [{"address": "DoNotReply@pigeonpool.com"}],
                           "bcc": [{"address": addr} for addr in valid_bcc]},
            "content": {"subject": subject, "plainText": plain_text, "html": html},
        }
        poller = client.begin_send(message)
        poller.result()
        return True
    except Exception:
        error("Error sending bulk email", exc_info=True)
        return False
