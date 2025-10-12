"""
Send email function
"""

#pylint: disable=line-too-long

from azure.communication.email import EmailClient
from .settings import get_settings
from .logger import debug, error

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

    except Exception: #pylint: disable=broad-except
        error("Error sending email", exc_info=True)
