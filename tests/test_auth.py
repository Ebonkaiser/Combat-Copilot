"""Owner authentication (auth.py): email codes, sessions, rate limits, CSRF Origin check.

Offline: a RecordingSender stands in for the email provider and a FakeClock moves
time, so expiry and rate-limit windows are tested without sleeping.
"""
import hmac
import logging
import re

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from itsdangerous import URLSafeSerializer
from starlette.middleware.cors import CORSMiddleware

import auth as auth_module
import server
from auth import (
    CODE_LIFETIME_SECONDS,
    COOKIE_NAME,
    SESSION_LIFETIME_SECONDS,
    SESSION_SALT,
    AuthService,
    SlidingWindowLimiter,
    cors_origins_from_env,
    get_mode,
    load_auth_config,
    origin_allowed,
    require_owner,
)
from support import (
    OWNER_EMAIL,
    SESSION_SECRET,
    FakeClock,
    RecordingSender,
    owner_env,
    request_code,
    sign_in,
    verify,
)

PROD_ENV = dict(
    ENV="production",
    OWNER_EMAILS=OWNER_EMAIL,
    SESSION_SECRET=SESSION_SECRET,
    EMAIL_PROVIDER="resend",
    EMAIL_API_KEY="re_test_key_not_real",
    EMAIL_FROM="Combat Copilot <login@example.test>",
)
HTTPS = "https://testserver"
EVIL = "https://evil.example"


def cookie_attributes(response) -> dict:
    """Parses the (single) Set-Cookie header into {lowercased attribute: value or True}."""
    header = response.headers["set-cookie"]
    name_value, *attributes = [part.strip() for part in header.split(";")]
    parsed: dict = {"name": name_value.split("=", 1)[0], "value": name_value.split("=", 1)[1]}
    for attribute in attributes:
        key, _, value = attribute.partition("=")
        parsed[key.lower()] = value or True
    return parsed


def me(api) -> dict:
    return api.client.get("/auth/me").json()


# ================================================================== configuration

def test_defaults_are_production_with_owner_login_off():
    config = load_auth_config({})

    assert config.env == "production"
    assert not config.owner_login_enabled
    assert config.cookie_secure
    assert config.allowed_origins == ()
    assert config.rate_limit_scale == 1


@pytest.mark.parametrize("value", ["staging", "dev", "Production ", "", "  "])
def test_an_unknown_env_is_treated_as_production(value):
    config = load_auth_config({"ENV": value})

    assert config.env == "production"
    assert config.cookie_secure


def test_only_development_drops_the_secure_cookie_flag_and_relaxes_limits():
    assert not load_auth_config({"ENV": "development"}).cookie_secure
    assert load_auth_config({"ENV": "development"}).rate_limit_scale > 1
    for env in ("test", "production"):
        config = load_auth_config({"ENV": env})
        assert config.cookie_secure
        assert config.rate_limit_scale == 1


def test_owner_emails_are_trimmed_lowercased_and_deduplicated():
    config = load_auth_config(owner_env(OWNER_EMAILS="  Owner@Example.TEST , second@example.test,, OWNER@example.test "))

    assert config.owner_emails == {"owner@example.test", "second@example.test"}


def test_a_complete_development_setup_enables_owner_login_with_the_console_provider():
    config = load_auth_config(owner_env())

    assert config.owner_login_enabled
    assert config.email_provider == "console"


@pytest.mark.parametrize(
    "overrides, reason_fragment",
    [
        (dict(OWNER_EMAILS=None), "OWNER_EMAILS"),
        (dict(OWNER_EMAILS="  ,  "), "OWNER_EMAILS"),
        (dict(SESSION_SECRET=None), "SESSION_SECRET"),
        (dict(SESSION_SECRET="x" * 31), "SESSION_SECRET"),
        (dict(EMAIL_PROVIDER="carrier-pigeon"), "EMAIL_PROVIDER"),
        (dict(ENV="production", EMAIL_PROVIDER="console"), "console"),
        (dict(ENV="production", EMAIL_PROVIDER=None), "EMAIL_PROVIDER"),
        (dict(ENV="production", EMAIL_PROVIDER="resend"), "EMAIL_API_KEY"),
        (dict(ENV="production", EMAIL_PROVIDER="resend", EMAIL_API_KEY="k"), "EMAIL_FROM"),
    ],
)
def test_incomplete_configuration_disables_owner_login_with_a_reason(overrides, reason_fragment):
    config = load_auth_config(owner_env(**overrides))

    assert not config.owner_login_enabled
    assert reason_fragment in config.disabled_reason


def test_a_secret_of_exactly_32_bytes_is_accepted_and_never_appears_in_a_reason():
    assert load_auth_config(owner_env(SESSION_SECRET="s" * 32)).owner_login_enabled
    short = load_auth_config(owner_env(SESSION_SECRET="hunter2-too-short"))
    assert "hunter2" not in short.disabled_reason


def test_a_complete_production_setup_with_resend_is_enabled():
    config = load_auth_config(PROD_ENV)

    assert config.owner_login_enabled
    assert config.email_provider == "resend"
    assert config.cookie_secure


@pytest.mark.parametrize(
    "environ, expected",
    [
        ({}, []),
        ({"ENV": "development"}, ["http://localhost:4200"]),
        ({"ENV": "production", "ALLOWED_ORIGINS": "https://App.Example.test/"}, ["https://app.example.test"]),
        ({"ALLOWED_ORIGINS": "https://a.test, https://b.test:8443/ ,,"}, ["https://a.test", "https://b.test:8443"]),
        ({"ALLOWED_ORIGINS": "*"}, []),  # a wildcard with cookies is never honoured
        ({"ALLOWED_ORIGINS": "https://a.test,*"}, ["https://a.test"]),
        ({"ENV": "development", "ALLOWED_ORIGINS": "https://a.test"}, ["https://a.test"]),
    ],
)
def test_allowed_origins_parsing(environ, expected):
    assert cors_origins_from_env(environ) == expected
    assert list(load_auth_config(environ).allowed_origins) == expected


def test_the_app_no_longer_uses_a_wildcard_cors_origin():
    cors = next(m for m in server.app.user_middleware if m.cls is CORSMiddleware)

    assert "*" not in cors.kwargs["allow_origins"]
    assert cors.kwargs["allow_credentials"] is True


# ================================================================== request-code

def test_an_allowlisted_email_is_sent_a_six_digit_code(open_api):
    api = open_api(**owner_env())

    response = request_code(api)

    assert response.status_code == 202
    assert response.json() == {"status": "sent_if_allowed"}
    assert len(api.sender.sent) == 1
    to, code, expires_minutes = api.sender.sent[0]
    assert (to, expires_minutes) == (OWNER_EMAIL, 10)
    assert re.fullmatch(r"\d{6}", code)


def test_a_non_allowlisted_email_gets_an_identical_response_and_nothing_is_sent(open_api):
    api = open_api(**owner_env())

    allowed = request_code(api, OWNER_EMAIL)
    stranger = request_code(api, "stranger@example.test")

    assert stranger.status_code == allowed.status_code == 202
    assert stranger.json() == allowed.json()
    assert dict(stranger.headers) == dict(allowed.headers)
    assert [to for to, _, _ in api.sender.sent] == [OWNER_EMAIL]  # no send for the stranger


def test_the_email_is_sent_after_the_response_not_before_it(open_api, monkeypatch):
    # What keeps the response time independent of the allowlist: for an allowlisted address the
    # slow part (the provider's HTTPS call) runs only once the answer is already on its way.
    import asyncio

    api = open_api(**owner_env())
    events = []
    real_deliver = api.auth.deliver_code
    monkeypatch.setattr(api.auth, "deliver_code", lambda *args: (events.append("email sent"), real_deliver(*args)))

    async def call_the_app():
        body = b'{"email": "owner@example.test"}'
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
            "scheme": "http", "path": "/auth/request-code", "raw_path": b"/auth/request-code",
            "query_string": b"", "client": ("127.0.0.1", 50000), "server": ("testserver", 80),
            "headers": [(b"host", b"testserver"), (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode())],
        }
        delivered = False

        async def receive():
            nonlocal delivered
            if delivered:
                await asyncio.sleep(3600)
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        async def send(message):
            events.append(message["type"])

        await server.app(scope, receive, send)

    asyncio.run(call_the_app())

    assert events.index("http.response.start") < events.index("email sent")
    assert events.index("http.response.body") < events.index("email sent")


def test_the_response_does_not_depend_on_the_provider_failing(open_api, caplog):
    api = open_api(**owner_env())
    api.auth.sender = RecordingSender(fail=True)

    with caplog.at_level(logging.ERROR, logger="combat_copilot.auth"):
        response = request_code(api)

    assert response.status_code == 202
    assert response.json() == {"status": "sent_if_allowed"}
    assert "not delivered" in caplog.text


def test_delivery_failures_are_logged_without_secrets(open_api, caplog):
    api = open_api(**owner_env())

    class LeakyProvider:
        def send_code(self, to, code, expires_minutes):
            raise RuntimeError(f"boom while sending {code} with key re_secret_key")

    api.auth.sender = LeakyProvider()
    with caplog.at_level(logging.DEBUG):
        request_code(api)

    assert "re_secret_key" not in caplog.text
    assert not re.search(r"\b\d{6}\b", caplog.text)


def test_the_email_is_trimmed_and_lowercased(open_api):
    api = open_api(**owner_env())

    request_code(api, "  Owner@Example.TEST  ")

    assert api.sender.sent[0][0] == OWNER_EMAIL


def test_the_code_is_zero_padded_to_six_digits(open_api, monkeypatch):
    api = open_api(**owner_env())
    monkeypatch.setattr(auth_module.secrets, "randbelow", lambda n: 42)

    request_code(api)

    assert api.sender.last_code == "000042"


def test_only_a_keyed_hash_of_the_code_is_kept_in_memory(open_api):
    api = open_api(**owner_env())
    request_code(api)
    code = api.sender.last_code

    pending = api.auth._pending[OWNER_EMAIL]

    assert isinstance(pending.digest, bytes) and len(pending.digest) == 32
    assert code.encode() not in pending.digest
    assert code not in repr(api.auth._pending)


def test_the_stored_hash_is_keyed_by_the_secret_and_bound_to_the_email():
    one = AuthService(load_auth_config(owner_env()), RecordingSender(), FakeClock())
    other_secret = AuthService(load_auth_config(owner_env(SESSION_SECRET="another-secret-" + "x" * 30)), RecordingSender(), FakeClock())

    assert one._digest(OWNER_EMAIL, "123456") == one._digest(OWNER_EMAIL, "123456")
    assert one._digest(OWNER_EMAIL, "123456") != other_secret._digest(OWNER_EMAIL, "123456")
    assert one._digest(OWNER_EMAIL, "123456") != one._digest("someone@example.test", "123456")
    assert one._digest(OWNER_EMAIL, "123456") != one._digest(OWNER_EMAIL, "123457")


def test_a_new_request_invalidates_the_previous_code(open_api):
    api = open_api(**owner_env())
    request_code(api)
    first = api.sender.last_code
    request_code(api)
    second = api.sender.last_code

    assert verify(api, first).status_code == 401  # superseded (costs one attempt)
    assert verify(api, second).status_code == 200


def test_requesting_a_code_sets_no_cookie_and_grants_nothing(open_api):
    api = open_api(**owner_env())

    response = request_code(api)

    assert "set-cookie" not in response.headers
    assert me(api)["mode"] == "anonymous"


def test_request_code_validates_the_body(open_api):
    api = open_api(**owner_env())

    assert api.client.post("/auth/request-code", json={}).status_code == 422
    assert api.client.post("/auth/request-code", json={"email": "a" * 300}).status_code == 422
    assert api.client.post("/auth/request-code", content="not json").status_code == 422


def test_when_owner_login_is_off_requests_still_answer_202_and_send_nothing(open_api):
    api = open_api(ENV="production")  # nothing configured

    response = request_code(api)

    assert response.status_code == 202
    assert response.json() == {"status": "sent_if_allowed"}
    assert api.sender is None or api.sender.sent == []
    assert api.client.get("/auth/me").json()["owner_login_enabled"] is False


# ====================================================================== verify

def test_a_valid_code_signs_the_owner_in_with_a_hardened_cookie(open_api):
    api = open_api(base_url=HTTPS, **PROD_ENV)

    response = sign_in(api)

    assert response.json() == {"mode": "owner", "email": OWNER_EMAIL}
    cookie = cookie_attributes(response)
    assert cookie["name"] == COOKIE_NAME
    assert cookie["httponly"] is True
    assert cookie["secure"] is True
    assert cookie["samesite"].lower() == "strict"
    assert cookie["path"] == "/"
    assert int(cookie["max-age"]) == SESSION_LIFETIME_SECONDS == 7 * 24 * 3600
    assert response.headers["cache-control"] == "no-store"


def test_the_secure_flag_is_dropped_only_in_development(open_api):
    api = open_api(**owner_env())  # ENV=development, plain http

    cookie = cookie_attributes(sign_in(api))

    assert "secure" not in cookie
    assert cookie["httponly"] is True
    assert cookie["samesite"].lower() == "strict"


def test_me_reports_the_owner_after_signing_in(open_api):
    api = open_api(base_url=HTTPS, **PROD_ENV)
    assert me(api)["mode"] == "anonymous"

    sign_in(api)

    assert me(api) == {"mode": "owner", "email": OWNER_EMAIL, "owner_login_enabled": True, "dev": False}


def test_every_failure_looks_the_same(open_api):
    api = open_api(**owner_env())
    request_code(api)
    code = api.sender.last_code
    wrong = "000000" if code != "000000" else "000001"

    failures = {
        "wrong code": verify(api, wrong),
        "malformed code": verify(api, "abc"),
        "unknown email": verify(api, code, "stranger@example.test"),
        "empty code": verify(api, ""),
    }
    request_code(api, "stranger@example.test")  # never issued a code
    failures["no pending code"] = verify(api, code, "stranger@example.test")

    assert {(r.status_code, r.text) for r in failures.values()} == {(401, '{"detail":"Invalid or expired code"}')}
    assert all("set-cookie" not in r.headers for r in failures.values())
    assert me(api)["mode"] == "anonymous"


def test_a_code_expires_after_ten_minutes(open_api):
    api = open_api(**owner_env())
    request_code(api)
    api.clock.advance(CODE_LIFETIME_SECONDS)  # exactly at the expiry instant

    assert verify(api, api.sender.last_code).status_code == 401


def test_a_code_still_works_just_before_it_expires(open_api):
    api = open_api(**owner_env())
    request_code(api)
    api.clock.advance(CODE_LIFETIME_SECONDS - 1)

    assert verify(api, api.sender.last_code).status_code == 200


def test_a_code_works_only_once(open_api):
    api = open_api(**owner_env())
    request_code(api)
    code = api.sender.last_code

    assert verify(api, code).status_code == 200
    api.client.cookies.clear()
    assert verify(api, code).status_code == 401
    assert me(api)["mode"] == "anonymous"


def test_the_sixth_attempt_is_rejected_even_with_the_correct_code(open_api):
    api = open_api(**owner_env())
    request_code(api)
    code = api.sender.last_code
    wrong = "000000" if code != "000000" else "000001"

    for _ in range(5):
        assert verify(api, wrong).status_code == 401

    assert verify(api, code).status_code == 401
    assert me(api)["mode"] == "anonymous"


def test_the_correct_code_on_the_fifth_attempt_still_works(open_api):
    api = open_api(**owner_env())
    request_code(api)
    code = api.sender.last_code
    wrong = "000000" if code != "000000" else "000001"

    for _ in range(4):
        assert verify(api, wrong).status_code == 401

    assert verify(api, code).status_code == 200


def test_failed_attempts_are_counted_per_issued_code(open_api):
    api = open_api(**owner_env())
    request_code(api)
    old = api.sender.last_code
    wrong = "000000" if old != "000000" else "000001"
    for _ in range(4):
        verify(api, wrong)

    request_code(api)  # a fresh code starts with a clean slate

    for _ in range(4):
        assert verify(api, wrong if wrong != api.sender.last_code else "999999").status_code == 401
    assert verify(api, api.sender.last_code).status_code == 200


def test_surrounding_whitespace_in_the_code_is_ignored(open_api):
    api = open_api(**owner_env())
    request_code(api)

    assert verify(api, f"  {api.sender.last_code}\n").status_code == 200


def test_a_code_cannot_be_used_for_a_different_email(open_api):
    api = open_api(**owner_env(OWNER_EMAILS=f"{OWNER_EMAIL},second@example.test"))
    request_code(api, OWNER_EMAIL)

    assert verify(api, api.sender.last_code, "second@example.test").status_code == 401
    assert verify(api, api.sender.last_code, OWNER_EMAIL).status_code == 200


def test_codes_are_compared_in_constant_time(open_api, monkeypatch):
    api = open_api(**owner_env())
    request_code(api)
    calls = []
    real = hmac.compare_digest
    monkeypatch.setattr(auth_module.hmac, "compare_digest", lambda a, b: calls.append(1) or real(a, b))

    verify(api, "000000")
    verify(api, "000000", "stranger@example.test")  # no pending code: still does the comparison work

    assert len(calls) == 2


# ===================================================================== sessions

def test_a_tampered_session_cookie_is_anonymous(open_api):
    api = open_api(**owner_env())
    token = cookie_attributes(sign_in(api))["value"]
    middle = len(token) // 2
    tampered = token[:middle] + ("A" if token[middle] != "A" else "B") + token[middle + 1:]

    api.client.cookies.clear()
    api.client.cookies.set(COOKIE_NAME, tampered)

    assert me(api)["mode"] == "anonymous"


@pytest.mark.parametrize("garbage", ["", "not-a-token", "a.b.c", "x" * 200])
def test_a_garbage_session_cookie_is_anonymous(open_api, garbage):
    api = open_api(**owner_env())
    api.client.cookies.set(COOKIE_NAME, garbage)

    assert me(api)["mode"] == "anonymous"


def test_an_expired_session_is_anonymous(open_api):
    api = open_api(**owner_env())
    sign_in(api)
    assert me(api)["mode"] == "owner"

    api.clock.advance(SESSION_LIFETIME_SECONDS + 1)

    assert me(api)["mode"] == "anonymous"


def test_a_session_is_still_valid_just_before_it_expires(open_api):
    api = open_api(**owner_env())
    sign_in(api)

    api.clock.advance(SESSION_LIFETIME_SECONDS - 5)

    assert me(api)["mode"] == "owner"


def test_a_token_signed_with_another_secret_is_anonymous(open_api):
    api = open_api(**owner_env())
    forged = URLSafeSerializer("a-completely-different-secret-value-xyz", salt=SESSION_SALT).dumps(
        {"sub": OWNER_EMAIL, "iat": int(api.clock()), "exp": int(api.clock()) + 1000}
    )
    api.client.cookies.set(COOKIE_NAME, forged)

    assert me(api)["mode"] == "anonymous"


@pytest.mark.parametrize(
    "payload",
    [
        {"sub": OWNER_EMAIL},  # no expiry
        {"sub": OWNER_EMAIL, "exp": True},
        {"sub": OWNER_EMAIL, "exp": "tomorrow"},
        {"exp": 9_999_999_999},  # no subject
        {"sub": 7, "exp": 9_999_999_999},
        ["sub", OWNER_EMAIL],
        "owner",
    ],
)
def test_a_correctly_signed_token_with_a_malformed_payload_is_anonymous(open_api, payload):
    api = open_api(**owner_env())
    token = URLSafeSerializer(SESSION_SECRET, salt=SESSION_SALT).dumps(payload)
    api.client.cookies.set(COOKIE_NAME, token)

    assert me(api)["mode"] == "anonymous"


def test_a_token_signed_with_the_right_secret_but_another_salt_is_anonymous(open_api):
    api = open_api(**owner_env())
    token = URLSafeSerializer(SESSION_SECRET, salt="some-other-purpose").dumps(
        {"sub": OWNER_EMAIL, "exp": int(api.clock()) + 1000}
    )
    api.client.cookies.set(COOKIE_NAME, token)

    assert me(api)["mode"] == "anonymous"


def test_a_session_for_an_address_removed_from_the_allowlist_is_anonymous():
    clock = FakeClock()
    before = AuthService(load_auth_config(owner_env(OWNER_EMAILS=OWNER_EMAIL)), RecordingSender(), clock)
    token = before.create_session(OWNER_EMAIL)
    assert before.verify_session(token) == OWNER_EMAIL

    after = AuthService(load_auth_config(owner_env(OWNER_EMAILS="someone-else@example.test")), RecordingSender(), clock)

    assert after.verify_session(token) is None


def test_changing_the_session_secret_signs_everyone_out():
    clock = FakeClock()
    old = AuthService(load_auth_config(owner_env()), RecordingSender(), clock)
    new = AuthService(load_auth_config(owner_env(SESSION_SECRET="rotated-secret-" + "y" * 30)), RecordingSender(), clock)

    assert new.verify_session(old.create_session(OWNER_EMAIL)) is None


def test_logout_clears_the_cookie(open_api):
    api = open_api(**owner_env())
    sign_in(api)
    assert me(api)["mode"] == "owner"

    response = api.client.post("/auth/logout")

    assert response.status_code == 200
    assert response.json() == {"mode": "anonymous"}
    cleared = cookie_attributes(response)
    assert cleared["name"] == COOKIE_NAME
    assert cleared["value"] in ("", '""')
    assert cleared["max-age"] == "0"
    assert me(api)["mode"] == "anonymous"


def test_me_is_anonymous_by_default_and_is_never_cached(open_api):
    api = open_api(sender=None, **owner_env())  # keep the real console sender: that is what "dev" reports

    response = api.client.get("/auth/me")

    assert response.json() == {"mode": "anonymous", "owner_login_enabled": True, "dev": True}
    assert response.headers["cache-control"] == "no-store"


def test_the_mode_and_owner_dependencies_follow_the_session():
    clock = FakeClock()
    service = AuthService(load_auth_config(owner_env()), RecordingSender(), clock)
    mini = FastAPI()
    mini.state.auth = service

    @mini.get("/mode")
    def mode(value=Depends(get_mode)):
        return {"mode": value}

    @mini.get("/owner-only")
    def owner_only(email=Depends(require_owner)):
        return {"email": email}

    client = TestClient(mini)
    assert client.get("/mode").json() == {"mode": "anonymous"}
    response = client.get("/owner-only")
    assert (response.status_code, response.json()) == (401, {"detail": "Owner sign-in required"})

    client.cookies.set(COOKIE_NAME, service.create_session(OWNER_EMAIL))
    assert client.get("/mode").json() == {"mode": "owner"}
    assert client.get("/owner-only").json() == {"email": OWNER_EMAIL}

    client.cookies.set(COOKIE_NAME, "tampered")
    assert client.get("/mode").json() == {"mode": "anonymous"}
    assert client.get("/owner-only").status_code == 401


# ==================================================================== rate limits

def test_the_fourth_code_request_for_an_email_in_fifteen_minutes_is_limited(open_api):
    api = open_api(ENV="test", OWNER_EMAILS=OWNER_EMAIL, SESSION_SECRET=SESSION_SECRET, EMAIL_PROVIDER="console")

    assert [request_code(api).status_code for _ in range(3)] == [202, 202, 202]
    limited = request_code(api)

    assert limited.status_code == 429
    assert 1 <= int(limited.headers["retry-after"]) <= 15 * 60
    assert len(api.sender.sent) == 3  # the limited request sent nothing


def test_the_per_email_limit_applies_identically_to_unknown_addresses(open_api):
    # If only allowlisted addresses were limited, the 429 itself would reveal the owner address.
    api = open_api(ENV="test", OWNER_EMAILS=OWNER_EMAIL, SESSION_SECRET=SESSION_SECRET, EMAIL_PROVIDER="console")

    statuses = {
        email: [request_code(api, email).status_code for _ in range(4)]
        for email in (OWNER_EMAIL, "stranger@example.test")
    }

    assert statuses[OWNER_EMAIL] == statuses["stranger@example.test"] == [202, 202, 202, 429]


def test_the_email_limit_window_slides(open_api):
    api = open_api(ENV="test", OWNER_EMAILS=OWNER_EMAIL, SESSION_SECRET=SESSION_SECRET, EMAIL_PROVIDER="console")
    for _ in range(3):
        request_code(api)
    assert request_code(api).status_code == 429

    api.clock.advance(15 * 60 + 1)

    assert request_code(api).status_code == 202


def test_the_eleventh_code_request_from_one_ip_in_an_hour_is_limited(open_api):
    api = open_api(ENV="test", OWNER_EMAILS=OWNER_EMAIL, SESSION_SECRET=SESSION_SECRET, EMAIL_PROVIDER="console")

    statuses = [request_code(api, f"user{i}@example.test").status_code for i in range(11)]

    assert statuses == [202] * 10 + [429]
    api.clock.advance(60 * 60 + 1)
    assert request_code(api, "fresh@example.test").status_code == 202


def test_the_ip_limit_is_per_client_address(open_api):
    api = open_api(
        client_address=("198.51.100.7", 4000),
        ENV="test", OWNER_EMAILS=OWNER_EMAIL, SESSION_SECRET=SESSION_SECRET, EMAIL_PROVIDER="console",
    )
    for i in range(10):
        request_code(api, f"user{i}@example.test")
    assert request_code(api, "another@example.test").status_code == 429

    # The same app, as seen from a different address, still has its full allowance.
    for _ in range(3):
        api.auth._limiter.hit("noise", 1, 1)  # unrelated key: must not matter
    other = TestClient(server.app, client=("198.51.100.8", 4000))
    assert other.post("/auth/request-code", json={"email": "another@example.test"}).status_code == 202


def test_the_eleventh_verify_attempt_from_one_ip_in_fifteen_minutes_is_limited(open_api):
    api = open_api(ENV="test", OWNER_EMAILS=OWNER_EMAIL, SESSION_SECRET=SESSION_SECRET, EMAIL_PROVIDER="console")
    request_code(api)
    code = api.sender.last_code
    wrong = "000000" if code != "000000" else "000001"

    statuses = [verify(api, wrong, f"user{i}@example.test").status_code for i in range(11)]

    assert statuses == [401] * 10 + [429]
    assert verify(api, code).status_code == 429  # even the right code is refused while limited
    api.clock.advance(15 * 60 + 1)  # the limit window has passed (the old code has expired too)
    request_code(api)
    assert verify(api, api.sender.last_code).status_code == 200


def test_development_relaxes_the_request_limit_so_click_testing_is_not_blocked(open_api):
    api = open_api(**owner_env())

    statuses = [request_code(api).status_code for _ in range(30)]

    assert set(statuses) == {202}
    assert request_code(api).status_code == 429  # relaxed, not removed


def test_the_sliding_window_limiter_expires_old_hits():
    clock = FakeClock()
    limiter = SlidingWindowLimiter(clock)

    assert [limiter.hit("k", 2, 60) for _ in range(2)] == [None, None]
    assert limiter.hit("k", 2, 60) == 60  # retry-after: exactly the remaining wait
    clock.advance(30)
    assert limiter.hit("k", 2, 60) == 30
    clock.advance(30)  # the two counted hits are now exactly one window old: they no longer count
    assert limiter.hit("k", 2, 60) is None


def test_the_limiter_does_not_count_refused_attempts_against_the_window():
    clock = FakeClock()
    limiter = SlidingWindowLimiter(clock)
    limiter.hit("k", 1, 60)

    for _ in range(50):
        clock.advance(1)
        assert limiter.hit("k", 1, 60) is not None

    clock.advance(11)  # 61s after the one counted hit
    assert limiter.hit("k", 1, 60) is None


def test_the_limiter_state_is_bounded():
    clock = FakeClock()
    limiter = SlidingWindowLimiter(clock, max_keys=100)

    for i in range(1000):
        limiter.hit(f"spray-{i}", 5, 3600)

    assert len(limiter._entries) <= 100


# ====================================================================== CSRF origin

@pytest.mark.parametrize(
    "origin, host, allowed, expected",
    [
        ("http://localhost:4200", "localhost:4200", (), True),
        ("https://site.test", "site.test", (), True),
        ("https://SITE.test/", "site.test", (), True),
        ("http://203.0.113.5:8080", "203.0.113.5:8080", (), True),
        (EVIL, "site.test", (), False),
        ("null", "site.test", (), False),
        ("null", "null", (), False),
        ("http://site.test", "site.test:8080", (), False),  # port differs
        ("http://site.test:8080", "site.test", (), False),
        ("http://site.test@evil.example", "site.test", (), False),
        ("http://site.test.evil.example", "site.test", (), False),
        ("ftp://site.test", "site.test", (), False),
        ("javascript:alert(1)", "site.test", (), False),
        ("", "site.test", (), False),
        (EVIL, None, (), False),
        ("https://app.example.test", "other.test", ("https://app.example.test",), True),
        ("https://app.example.test/", "other.test", ("https://app.example.test",), True),
        ("https://other-app.example.test", "other.test", ("https://app.example.test",), False),
    ],
)
def test_origin_allowed(origin, host, allowed, expected):
    assert origin_allowed(origin, host, allowed) is expected


def test_a_cross_origin_post_is_rejected(open_api):
    api = open_api(**owner_env())

    response = request_code(api, headers={"Origin": EVIL})

    assert response.status_code == 403
    assert response.json() == {"detail": "Cross-origin request rejected"}
    assert api.sender.sent == []  # it never reached the handler


def test_origin_null_is_rejected(open_api):
    api = open_api(**owner_env())

    assert request_code(api, headers={"Origin": "null"}).status_code == 403


def test_a_same_origin_post_is_allowed(open_api):
    api = open_api(**owner_env())

    assert request_code(api, headers={"Origin": "http://testserver"}).status_code == 202


def test_a_post_without_an_origin_header_is_allowed(open_api):
    # Not a browser (curl, server-to-server): CSRF does not apply to it.
    api = open_api(**owner_env())

    assert request_code(api).status_code == 202


def test_an_explicitly_listed_origin_is_allowed_from_any_host(open_api):
    api = open_api(**owner_env(ALLOWED_ORIGINS="https://app.example.test"))

    assert request_code(api, headers={"Origin": "https://app.example.test"}).status_code == 202
    assert request_code(api, headers={"Origin": "https://other.example.test"}).status_code == 403


@pytest.mark.parametrize("method, path", [("post", "/encounters"), ("put", "/encounters/enc_1"), ("delete", "/encounters/enc_1")])
def test_every_state_changing_method_is_checked(open_api, method, path):
    api = open_api(**owner_env())

    response = getattr(api.client, method)(path, headers={"Origin": EVIL})

    assert response.status_code == 403


def test_logout_and_verify_are_checked_too(open_api):
    api = open_api(**owner_env())

    assert api.client.post("/auth/logout", headers={"Origin": EVIL}).status_code == 403
    assert verify(api, "123456", headers={"Origin": EVIL}).status_code == 403


def test_safe_methods_are_not_blocked_but_get_no_cors_grant(open_api):
    api = open_api(**owner_env())

    response = api.client.get("/auth/me", headers={"Origin": EVIL})

    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers


def test_a_foreign_origin_is_never_reflected_even_with_credentials(open_api):
    api = open_api(**owner_env())
    api.client.cookies.set(COOKIE_NAME, "whatever")

    response = api.client.get("/health", headers={"Origin": EVIL})

    # Without Access-Control-Allow-Origin a browser will not let the foreign page read the
    # response. (Starlette adds Access-Control-Allow-Credentials to every Origin-bearing
    # response; on its own it grants nothing.)
    assert "access-control-allow-origin" not in response.headers


def test_a_cross_site_preflight_is_not_granted(open_api):
    api = open_api(**owner_env())

    response = api.client.options(
        "/auth/verify",
        headers={"Origin": EVIL, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"},
    )

    assert "access-control-allow-origin" not in response.headers


# ================================================================ dev sign-in helper

def test_the_dev_helper_returns_the_console_code_and_it_signs_in(open_api):
    api = open_api(sender=None, **owner_env())
    assert api.client.get("/auth/me").json()["dev"] is True
    request_code(api)

    helper = api.client.get("/auth/dev/last-code", params={"email": OWNER_EMAIL})

    assert helper.status_code == 200
    assert re.fullmatch(r"\d{6}", helper.json()["code"])
    assert verify(api, helper.json()["code"]).status_code == 200


def test_the_dev_helper_logs_the_code_like_an_email(open_api, caplog):
    api = open_api(sender=None, **owner_env())

    with caplog.at_level(logging.WARNING, logger="combat_copilot.email"):
        request_code(api)

    assert "sign-in code for owner@example.test" in caplog.text


def test_the_dev_helper_is_unreachable_outside_development(open_api):
    api = open_api(base_url=HTTPS, sender=None, **PROD_ENV)
    unknown_route = api.client.get("/definitely/not/a/route")

    helper = api.client.get("/auth/dev/last-code", params={"email": OWNER_EMAIL})

    assert (helper.status_code, helper.json()) == (404, unknown_route.json()) == (404, {"detail": "Not Found"})
    assert api.client.get("/auth/me").json()["dev"] is False


def test_the_dev_helper_is_unreachable_with_the_console_provider_in_test_env(open_api):
    api = open_api(sender=None, ENV="test", OWNER_EMAILS=OWNER_EMAIL, SESSION_SECRET=SESSION_SECRET, EMAIL_PROVIDER="console")
    request_code(api)

    assert api.client.get("/auth/dev/last-code", params={"email": OWNER_EMAIL}).status_code == 404
    assert api.client.get("/auth/me").json()["dev"] is False


def test_the_dev_helper_refuses_non_loopback_clients_even_in_development(open_api):
    # An ENV=development left on a public host must still not hand out sign-in codes.
    api = open_api(client_address=("203.0.113.9", 5555), sender=None, **owner_env())
    request_code(api)

    assert api.client.get("/auth/dev/last-code", params={"email": OWNER_EMAIL}).status_code == 404


def test_the_dev_helper_404s_for_an_email_without_a_code(open_api):
    api = open_api(sender=None, **owner_env())

    response = api.client.get("/auth/dev/last-code", params={"email": "nobody@example.test"})

    assert (response.status_code, response.json()) == (404, {"detail": "Not Found"})


def test_the_dev_helper_is_not_offered_when_the_provider_is_not_console(open_api):
    api = open_api(sender=None, base_url=HTTPS, **{**PROD_ENV, "ENV": "development"})

    assert api.client.get("/auth/me").json()["dev"] is False
    assert api.client.get("/auth/dev/last-code", params={"email": OWNER_EMAIL}).status_code == 404
