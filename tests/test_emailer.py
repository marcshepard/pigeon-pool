"""Email batching uses a mocked Azure client; no messages are sent."""

from unittest.mock import Mock

import pytest
from azure.core.exceptions import HttpResponseError

from backend.utils import emailer


@pytest.fixture
def email_client(monkeypatch):
    monkeypatch.delenv("EMAIL_DRY_RUN", raising=False)
    client = Mock()
    monkeypatch.setattr(emailer.EmailClient, "from_connection_string", Mock(return_value=client))
    return client


@pytest.mark.parametrize("count, sizes", [(49, [49]), (50, [49, 1]), (99, [49, 49, 1])])
def test_bulk_batches_preserve_recipients_and_content(email_client, count, sizes):
    recipients = [f"person{i}@test.invalid" for i in range(count)]
    assert emailer.send_bulk_email_bcc(
        recipients + ["", "placeholder@example.com"], "Subject", "Plain", "<p>HTML</p>"
    )
    messages = [call.args[0] for call in email_client.begin_send.call_args_list]
    assert [len(msg["recipients"]["bcc"]) for msg in messages] == sizes
    assert [addr["address"] for msg in messages for addr in msg["recipients"]["bcc"]] == recipients
    for msg in messages:
        assert msg["recipients"]["to"] == [{"address": "DoNotReply@pigeonpool.com"}]
        assert msg["content"] == {"subject": "Subject", "plainText": "Plain", "html": "<p>HTML</p>"}
    assert email_client.begin_send.return_value.result.call_count == len(sizes)


@pytest.mark.parametrize("phase", ["begin", "poll"])
def test_bulk_failure_logs_details_and_does_not_retry(email_client, capsys, phase):
    failure = HttpResponseError(message="Invalid recipient request")
    failure.status_code = 400
    successful_poller = Mock()
    failed_poller = Mock()
    failed_poller.result.side_effect = failure
    email_client.begin_send.side_effect = [
        successful_poller, failure if phase == "begin" else failed_poller
    ]
    assert not emailer.send_bulk_email_bcc(
        [f"person{i}@test.invalid" for i in range(99)], "Subject", "Plain", "HTML"
    )
    assert email_client.begin_send.call_count == 2
    output = capsys.readouterr().err
    assert "batch=1 batches=3 recipients=49 message=batch sent" in output
    assert "Error sending bulk email batch=2 batches=3" in output
    assert "err_type=HttpResponseError status_code=400" in output
    assert "Invalid recipient request" in output


def test_single_email_logs_actual_error(email_client, capsys):
    email_client.begin_send.side_effect = ValueError("Invalid request")
    assert not emailer.send_email("person@test.invalid", "Subject", "Plain", "HTML")
    assert "err_type=ValueError status_code=None err=Invalid request" in capsys.readouterr().err


def test_empty_and_dry_run_do_not_send(email_client, monkeypatch):
    assert not emailer.send_bulk_email_bcc(["placeholder@example.com"], "Subject", "Plain", "HTML")
    monkeypatch.setenv("EMAIL_DRY_RUN", "true")
    assert emailer.send_bulk_email_bcc(
        [f"person{i}@test.invalid" for i in range(50)], "Subject", "Plain", "HTML"
    )
    email_client.begin_send.assert_not_called()
