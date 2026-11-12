"""Email delivery (email_sender.py). Offline: httpx.MockTransport stands in for Resend."""
import json
import logging
import re

import httpx
import pytest

from auth import AuthService, build_email_sender, load_auth_config
from email_sender import (
    EMAIL_SUBJECT,
    RESEND_API_URL,
    ConsoleEmailSender,
    EmailDeliveryError,
    ResendEmailSender,
    code_email_text,
)
from support import OWNER_EMAIL, FakeClock, RecordingSender, owner_env

API_KEY = "re_test_key_not_real"
FROM = "Combat Copilot <login@example.test>"
CODE = "482915"


def make_sender(handler) -> ResendEmailSender:
    return ResendEmailSender(
        api_key=API_KEY,
        from_address=FROM,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def ok(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"id": "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"})


# ----------------------------------------------------------------------- Resend

def test_resend_receives_one_json_post_with_a_bearer_key():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok(request)

    make_sender(handler).send_code(OWNER_EMAIL, CODE, 10)

    (request,) = seen
    assert request.method == "POST"
    assert str(request.url) == RESEND_API_URL == "https://api.resend.com/emails"
    assert request.headers["authorization"] == f"Bearer {API_KEY}"
    assert request.headers["content-type"] == "application/json"
    body = json.loads(request.content)
    assert body["from"] == FROM
    assert body["to"] == [OWNER_EMAIL]
    assert body["subject"] == EMAIL_SUBJECT
    assert set(body) == {"from", "to", "subject", "text"}  # plain text only


def test_the_email_body_is_the_code_and_its_expiry_and_no_links():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return ok(request)

    make_sender(handler).send_code(OWNER_EMAIL, CODE, 10)

    text = captured["text"]
    assert CODE in text
    assert "10 minutes" in text
    assert not re.search(r"https?://|www\.|\.com|<a |href", text, re.IGNORECASE)


def test_the_api_key_and_the_code_stay_in_their_own_places():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok(request)

    make_sender(handler).send_code(OWNER_EMAIL, CODE, 10)

    request = seen[0]
    assert API_KEY.encode() not in request.content
    assert API_KEY not in str(request.url)
    assert CODE not in str(request.url)
    assert CODE not in "".join(f"{k}={v}" for k, v in request.headers.items())


def test_a_provider_rejection_raises_with_the_provider_message_but_no_secrets():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"name": "validation_error", "message": "The example.test domain is not verified."})

    with pytest.raises(EmailDeliveryError) as excinfo:
        make_sender(handler).send_code(OWNER_EMAIL, CODE, 10)

    message = str(excinfo.value)
    assert "HTTP 403" in message
    assert "domain is not verified" in message
    assert API_KEY not in message
    assert CODE not in message


def test_a_non_json_error_body_is_summarised_not_echoed():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="<html>Bad gateway, request id 12345</html>")

    with pytest.raises(EmailDeliveryError) as excinfo:
        make_sender(handler).send_code(OWNER_EMAIL, CODE, 10)

    assert "HTTP 502" in str(excinfo.value)
    assert "Bad gateway" not in str(excinfo.value)


def test_a_very_long_provider_message_is_capped():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"message": "x" * 5000})

    with pytest.raises(EmailDeliveryError) as excinfo:
        make_sender(handler).send_code(OWNER_EMAIL, CODE, 10)

    assert len(str(excinfo.value)) < 400


@pytest.mark.parametrize("failure", [httpx.ConnectError("no route to host"), httpx.ReadTimeout("slow")])
def test_network_failures_raise_a_delivery_error_without_secrets(failure):
    def handler(_request: httpx.Request) -> httpx.Response:
        raise failure

    with pytest.raises(EmailDeliveryError) as excinfo:
        make_sender(handler).send_code(OWNER_EMAIL, CODE, 10)

    assert API_KEY not in str(excinfo.value)
    assert CODE not in str(excinfo.value)


def test_code_email_text_mentions_the_expiry_and_single_use():
    text = code_email_text("123456", 10)

    assert "123456" in text and "10 minutes" in text and "once" in text


# ---------------------------------------------------------------------- console

def test_the_console_sender_remembers_and_logs_the_code(caplog):
    sender = ConsoleEmailSender()

    with caplog.at_level(logging.WARNING, logger="combat_copilot.email"):
        sender.send_code(OWNER_EMAIL, CODE, 10)

    assert sender.last_codes == {OWNER_EMAIL: CODE}
    assert CODE in caplog.text


# --------------------------------------------------------- selection and delivery

def test_build_email_sender_picks_the_configured_provider():
    resend = build_email_sender(load_auth_config(owner_env(
        ENV="production", EMAIL_PROVIDER="resend", EMAIL_API_KEY=API_KEY, EMAIL_FROM=FROM,
    )))
    console = build_email_sender(load_auth_config(owner_env()))
    disabled = build_email_sender(load_auth_config(owner_env(OWNER_EMAILS=None)))

    assert isinstance(resend, ResendEmailSender)
    assert isinstance(console, ConsoleEmailSender)
    assert disabled is None


def make_service(sender) -> AuthService:
    return AuthService(load_auth_config(owner_env()), sender, FakeClock())


def test_delivery_failures_are_swallowed_and_logged_without_the_code(caplog):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "API key is invalid"})

    service = make_service(make_sender(handler))

    with caplog.at_level(logging.DEBUG):
        service.deliver_code(OWNER_EMAIL, CODE)  # must not raise

    assert "HTTP 401" in caplog.text
    assert CODE not in caplog.text
    assert API_KEY not in caplog.text


def test_an_unexpected_provider_error_logs_only_its_class(caplog):
    class Exploding:
        def send_code(self, to, code, expires_minutes):
            raise KeyError(f"secret {code} {API_KEY}")

    with caplog.at_level(logging.DEBUG):
        make_service(Exploding()).deliver_code(OWNER_EMAIL, CODE)

    assert "KeyError" in caplog.text
    assert CODE not in caplog.text
    assert API_KEY not in caplog.text


def test_with_no_sender_configured_it_logs_and_does_not_raise(caplog):
    with caplog.at_level(logging.ERROR, logger="combat_copilot.auth"):
        make_service(None).deliver_code(OWNER_EMAIL, CODE)

    assert "No email sender" in caplog.text
    assert CODE not in caplog.text


def test_deliver_code_passes_the_ten_minute_expiry_to_the_sender():
    sender = RecordingSender()

    make_service(sender).deliver_code(OWNER_EMAIL, CODE)

    assert sender.sent == [(OWNER_EMAIL, CODE, 10)]


def test_closing_the_service_closes_the_http_client():
    sender = make_sender(ok)
    service = make_service(sender)

    service.close()

    assert sender._client.is_closed
