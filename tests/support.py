"""Shared helpers for the offline (no API key, no network) tests."""
import gc
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from chromadb.api.shared_system_client import SharedSystemClient

import totp
from fake_ai import HashingEmbedding  # noqa: F401  (re-exported for the tests)

REPO_ROOT = Path(__file__).resolve().parent.parent
RULES_DIR = REPO_ROOT / "data" / "rules"
FIXTURE_CAMPAIGNS_DIR = Path(__file__).resolve().parent / "fixtures" / "campaigns"
FIXTURE_CAMPAIGN_ID = "test-campaign"
FIXTURE_CAMPAIGN_DIR = FIXTURE_CAMPAIGNS_DIR / FIXTURE_CAMPAIGN_ID
FIXTURE_LORE_DIR = FIXTURE_CAMPAIGN_DIR / "lore"

# Unique strings planted in the fixture campaign's lore. If one of these ever
# shows up in text served to an anonymous user, campaign lore has leaked.
SENTINEL = "SENTINEL_LORE_7Q2"            # Amber Quill Chancery faction doc
SENTINEL_OTHER_FACTION = "SENTINEL_LORE_OTHER_FACTION"  # a different faction's doc
SENTINEL_NO_FACTION = "SENTINEL_LORE_NO_FACTION"        # a doc with no faction at all
ALL_SENTINELS = (SENTINEL, SENTINEL_OTHER_FACTION, SENTINEL_NO_FACTION)


def copy_fixture_lore(destination: Path) -> Path:
    """Copies the fixture campaign's lore folder so a test can edit it freely."""
    shutil.copytree(FIXTURE_LORE_DIR, destination)
    return destination


def release_kb(kb) -> None:
    """Drops Chroma/SQLite handles so Windows can clean the temp directory."""
    for attribute in ("index", "storage_context", "vector_store", "chroma_collection", "chroma_client"):
        if hasattr(kb, attribute):
            delattr(kb, attribute)
    gc.collect()


def simulate_process_restart(kb) -> None:
    """Releases ``kb`` and forgets Chroma's in-process cache, so the next
    CombatKnowledgeBase over the same directory re-reads what is on disk --
    as a freshly started server would."""
    release_kb(kb)
    SharedSystemClient.clear_system_cache()


# ------------------------------------------------------------------ API tests

# Everything the server reads from the environment for auth/campaigns. Cleared
# before each API test so a developer's real shell or .env never leaks in.
SERVER_ENV_VARS = (
    "ENV", "OWNER_EMAILS", "SESSION_SECRET", "ALLOWED_ORIGINS", "OWNER_TOTP_SECRET",
    "EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM", "CAMPAIGNS_DIR", "FAKE_AI",
)

OWNER_EMAIL = "owner@example.test"
SESSION_SECRET = "test-session-secret-0123456789-abcdefghij"  # >= 32 characters
START_TIME = 1_800_000_000.0


class FakeClock:
    """Movable time for the auth service (code/session expiry, rate-limit windows)."""

    def __init__(self, start: float = START_TIME):
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class RecordingSender:
    """Stands in for the email provider: remembers what would have been sent."""

    def __init__(self, fail: bool = False):
        self.sent = []  # (to, code, expires_minutes)
        self.fail = fail

    def send_code(self, to: str, code: str, expires_minutes: int) -> None:
        if self.fail:
            raise RuntimeError("provider exploded")
        self.sent.append((to, code, expires_minutes))

    @property
    def last_code(self) -> str:
        return self.sent[-1][1]


@dataclass
class Api:
    client: Any  # fastapi.testclient.TestClient
    auth: Any  # auth.AuthService
    sender: Any
    clock: FakeClock


def owner_env(**overrides) -> dict:
    """A working owner-login configuration for ENV=development (console email provider).
    Pass a key as None to leave it unset."""
    env = {"ENV": "development", "OWNER_EMAILS": OWNER_EMAIL, "SESSION_SECRET": SESSION_SECRET}
    env.update(overrides)
    return {key: value for key, value in env.items() if value is not None}


def request_code(api, email=OWNER_EMAIL, **kwargs):
    return api.client.post("/auth/request-code", json={"email": email}, **kwargs)


def verify(api, code, email=OWNER_EMAIL, **kwargs):
    return api.client.post("/auth/verify", json={"email": email, "code": code}, **kwargs)


def sign_in(api, email=OWNER_EMAIL):
    """Runs the real request-code -> verify flow; the client's cookie jar then holds the session."""
    assert request_code(api, email).status_code == 202
    response = verify(api, api.sender.last_code, email)
    assert response.status_code == 200, response.text
    return response


# ------------------------------------------------------------- authenticator app

TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # base32 of "12345678901234567890", RFC 6238's test key


def totp_env(**overrides) -> dict:
    """owner_env() with the authenticator-app sign-in selected (no email settings needed)."""
    return owner_env(OWNER_TOTP_SECRET=TOTP_SECRET, **overrides)


def totp_code(api, steps_ahead: int = 0) -> str:
    """The code an authenticator app shows at the API's (fake) clock -- or ``steps_ahead`` 30-second
    steps later (negative: earlier)."""
    return totp.totp_at(totp.decode_secret(TOTP_SECRET), api.clock.now + steps_ahead * totp.PERIOD)


def verify_totp(api, code, **kwargs):
    """The authenticator-app sign-in request: just the code, no email."""
    return api.client.post("/auth/verify", json={"code": code}, **kwargs)


def sign_in_totp(api, steps_ahead: int = 0):
    response = verify_totp(api, totp_code(api, steps_ahead))
    assert response.status_code == 200, response.text
    return response
