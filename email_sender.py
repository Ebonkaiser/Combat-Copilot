"""Delivery of the owner sign-in code.

DigitalOcean blocks outbound SMTP (ports 25/465/587) on Droplets, so real
delivery uses a provider's HTTPS API (Resend). The email carries the code and
its expiry only -- no links, so there is nothing to click, forward or phish.
"""
import logging
from typing import Dict, Optional, Protocol

import httpx

logger = logging.getLogger("combat_copilot.email")

RESEND_API_URL = "https://api.resend.com/emails"
EMAIL_SUBJECT = "Your Combat Copilot sign-in code"


class EmailSender(Protocol):
    def send_code(self, to: str, code: str, expires_minutes: int) -> None:
        """Delivers a sign-in code. Raises on failure."""


def code_email_text(code: str, expires_minutes: int) -> str:
    return (
        f"Your Combat Copilot sign-in code is {code}.\n"
        f"It expires in {expires_minutes} minutes and works once.\n"
        "If you did not ask for it, you can ignore this email."
    )


class ConsoleEmailSender:
    """Development only: writes the code to the server log instead of sending it."""

    def __init__(self) -> None:
        self.last_codes: Dict[str, str] = {}

    def send_code(self, to: str, code: str, expires_minutes: int) -> None:
        self.last_codes[to] = code
        logger.warning("[dev email] sign-in code for %s: %s (expires in %d minutes)", to, code, expires_minutes)


class EmailDeliveryError(Exception):
    """Delivery failed. The message never contains the API key or the code."""


class ResendEmailSender:
    """Sends through Resend's HTTPS API (https://resend.com/docs/api-reference/emails/send-email)."""

    def __init__(
        self,
        api_key: str,
        from_address: str,
        client: Optional[httpx.Client] = None,
        timeout: float = 10.0,
    ) -> None:
        self._api_key = api_key
        self._from = from_address
        self._client = client or httpx.Client(timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def send_code(self, to: str, code: str, expires_minutes: int) -> None:
        payload = {
            "from": self._from,
            "to": [to],
            "subject": EMAIL_SUBJECT,
            "text": code_email_text(code, expires_minutes),
        }
        try:
            response = self._client.post(
                RESEND_API_URL,
                json=payload,
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
        except httpx.HTTPError as exc:
            raise EmailDeliveryError(f"could not reach the email provider ({exc.__class__.__name__})") from None
        if response.status_code >= 400:
            raise EmailDeliveryError(
                f"email provider rejected the request (HTTP {response.status_code}): {_provider_message(response)}"
            )


def _provider_message(response: httpx.Response) -> str:
    """The provider's own error text (e.g. 'domain is not verified'), capped, never the request."""
    try:
        message = response.json().get("message")
    except (ValueError, AttributeError):
        message = None
    return str(message)[:200] if message else "no details"
