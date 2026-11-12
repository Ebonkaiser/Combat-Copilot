"""Owner sign-in with an authenticator app (auth.py + totp.py): configuration, the sign-in request,
single use, the clock window, the lockout, the development helper, and secret hygiene.

Offline, and nothing sleeps: a FakeClock moves time, so a 24-hour lockout takes microseconds.
"""
import logging

import pytest

import auth as auth_module
import totp
from auth import (
    COOKIE_NAME,
    SESSION_LIFETIME_SECONDS,
    TOTP_LOCKOUT_MAX_SECONDS,
    TOTP_LOCKOUT_SECONDS,
    TOTP_MAX_FAILURES,
    AuthService,
    RateLimited,
    build_email_sender,
    create_auth_service,
    load_auth_config,
)
from support import (
    OWNER_EMAIL,
    SESSION_SECRET,
    TOTP_SECRET,
    FakeClock,
    owner_env,
    request_code,
    sign_in_totp,
    totp_code,
    totp_env,
    verify,
    verify_totp,
)

HTTPS = "https://testserver"
PROD_TOTP_ENV = dict(ENV="production", OWNER_EMAILS=OWNER_EMAIL, SESSION_SECRET=SESSION_SECRET, OWNER_TOTP_SECRET=TOTP_SECRET)
KEY = totp.decode_secret(TOTP_SECRET)


def make_service(**env):
    """A bare AuthService (no HTTP) on a fake clock, in production-strength mode unless env says otherwise."""
    clock = FakeClock()
    return AuthService(load_auth_config({**PROD_TOTP_ENV, **env}), clock=clock), clock


def code_at(clock, steps_ahead: int = 0) -> str:
    return totp.totp_at(KEY, clock.now + steps_ahead * totp.PERIOD)


def wrong_code(clock) -> str:
    """A well-formed code that is NOT valid at the clock's time (nor one step either side)."""
    valid = {code_at(clock, offset) for offset in (-1, 0, 1)}
    return next(candidate for candidate in ("000000", "111111", "222222", "333333") if candidate not in valid)


def wrong_code_for(api) -> str:
    return wrong_code(api.clock)


def cookie_flags(response) -> dict:
    name_value, *attributes = [part.strip() for part in response.headers["set-cookie"].split(";")]
    flags = {"name": name_value.split("=", 1)[0]}
    for attribute in attributes:
        key, _, value = attribute.partition("=")
        flags[key.lower()] = value or True
    return flags


def me(api) -> dict:
    return api.client.get("/auth/me").json()


# ================================================================== configuration

def test_a_totp_secret_selects_the_authenticator_method_and_needs_no_email_settings():
    config = load_auth_config(PROD_TOTP_ENV)  # production, and no EMAIL_* at all

    assert config.owner_login_enabled
    assert config.login_method == "totp"
    assert config.owner_totp_key == KEY
    assert config.sole_owner == OWNER_EMAIL
    assert build_email_sender(config) is None  # nothing is ever emailed


def test_without_a_totp_secret_the_method_is_email():
    config = load_auth_config(owner_env())

    assert config.login_method == "email"
    assert config.owner_totp_key == b""
    assert config.owner_login_enabled


def test_a_blank_totp_secret_means_email_not_a_broken_authenticator():
    assert load_auth_config(owner_env(OWNER_TOTP_SECRET="   ")).login_method == "email"


def test_the_secret_may_be_written_the_way_people_copy_it():
    spaced = " ".join(TOTP_SECRET[i : i + 4] for i in range(0, 32, 4)).lower()

    config = load_auth_config(owner_env(OWNER_TOTP_SECRET=spaced))

    assert config.owner_login_enabled and config.owner_totp_key == KEY


@pytest.mark.parametrize(
    "bad",
    ["definitely not base32 !!", "ABCDEFGH", "A" * 25, "0189" * 8],
    ids=["punctuation", "too-short", "bad-length", "digits-outside-base32"],
)
def test_an_invalid_secret_turns_owner_login_off_and_is_never_echoed(bad):
    config = load_auth_config(owner_env(OWNER_TOTP_SECRET=bad))

    assert not config.owner_login_enabled
    assert "OWNER_TOTP_SECRET" in config.disabled_reason
    assert bad not in config.disabled_reason and bad not in repr(config)


def test_authenticator_sign_in_supports_exactly_one_owner_address():
    config = load_auth_config(owner_env(OWNER_EMAILS="a@example.test, b@example.test", OWNER_TOTP_SECRET=TOTP_SECRET))

    assert not config.owner_login_enabled
    assert "exactly one" in config.disabled_reason
    assert config.sole_owner is None


def test_the_session_secret_is_still_required():
    config = load_auth_config({**PROD_TOTP_ENV, "SESSION_SECRET": "too-short"})

    assert not config.owner_login_enabled and "SESSION_SECRET" in config.disabled_reason


def test_an_owner_address_is_still_required():
    config = load_auth_config({**PROD_TOTP_ENV, "OWNER_EMAILS": ""})

    assert not config.owner_login_enabled and "OWNER_EMAILS" in config.disabled_reason


def test_a_totp_secret_wins_over_email_settings():
    config = load_auth_config(
        {**PROD_TOTP_ENV, "EMAIL_PROVIDER": "resend", "EMAIL_API_KEY": "re_not_real", "EMAIL_FROM": "x@example.test"}
    )

    assert config.login_method == "totp" and config.owner_login_enabled
    assert build_email_sender(config) is None


def test_the_config_repr_never_shows_a_secret():
    config = load_auth_config(
        {**PROD_TOTP_ENV, "EMAIL_PROVIDER": "resend", "EMAIL_API_KEY": "re_super_secret_api_key", "EMAIL_FROM": "x@example.test"}
    )

    text = repr(config)

    for secret in (SESSION_SECRET, TOTP_SECRET, repr(KEY), "re_super_secret_api_key"):
        assert secret not in text


def test_startup_logs_the_method_and_never_the_secret(caplog):
    with caplog.at_level(logging.INFO, logger="combat_copilot.auth"):
        create_auth_service(PROD_TOTP_ENV)
        create_auth_service(owner_env(OWNER_TOTP_SECRET="not base32 at all!"))

    assert "authenticator app" in caplog.text
    assert "OWNER_TOTP_SECRET is not a valid base32 key" in caplog.text
    assert TOTP_SECRET not in caplog.text and "not base32 at all" not in caplog.text


# ===================================================================== signing in

def test_the_current_code_signs_the_owner_in_with_a_hardened_cookie(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)

    response = sign_in_totp(api)

    assert response.json() == {"mode": "owner", "email": OWNER_EMAIL}
    flags = cookie_flags(response)
    assert flags["name"] == COOKIE_NAME
    assert flags["httponly"] is True and flags["secure"] is True
    assert flags["samesite"].lower() == "strict" and flags["path"] == "/"
    assert int(flags["max-age"]) == SESSION_LIFETIME_SECONDS
    assert response.headers["cache-control"] == "no-store"


def test_me_reports_the_owner_and_the_method_after_signing_in(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    assert me(api)["mode"] == "anonymous"

    sign_in_totp(api)

    assert me(api) == {
        "mode": "owner",
        "email": OWNER_EMAIL,
        "owner_login_enabled": True,
        "login_method": "totp",
        "dev": False,
    }


def test_a_stranger_learns_the_method_but_never_the_owner_address(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)

    response = api.client.get("/auth/me")

    assert response.json() == {"mode": "anonymous", "owner_login_enabled": True, "login_method": "totp", "dev": False}
    assert OWNER_EMAIL not in response.text


def test_a_wrong_code_gets_one_generic_401_and_no_cookie(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)

    response = verify_totp(api, wrong_code_for(api))

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or expired code"}
    assert "set-cookie" not in response.headers
    assert me(api)["mode"] == "anonymous"


@pytest.mark.parametrize("kind", ["wrong", "empty", "short", "letters", "full-width digits", "spent"])
def test_every_failure_looks_the_same(open_api, kind):
    # One fresh server per kind: six failures in a row would (rightly) trip the lockout.
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    submitted = {"wrong": wrong_code_for(api), "empty": "", "short": "12345", "letters": "abcdef", "full-width digits": "１２３４５６"}.get(kind)
    if kind == "spent":
        sign_in_totp(api)
        submitted = totp_code(api)  # a perfectly good code, but already used
        api.client.cookies.clear()

    response = verify_totp(api, submitted)

    assert (response.status_code, response.text) == (401, '{"detail":"Invalid or expired code"}')
    assert "set-cookie" not in response.headers


def test_a_code_works_only_once(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    code = totp_code(api)
    assert verify_totp(api, code).status_code == 200
    api.client.post("/auth/logout")

    assert verify_totp(api, code).status_code == 401
    assert me(api)["mode"] == "anonymous"


def test_the_next_step_still_works_after_a_code_was_used(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    sign_in_totp(api, steps_ahead=0)
    api.client.post("/auth/logout")

    assert verify_totp(api, totp_code(api, 1)).status_code == 200


@pytest.mark.parametrize("older", [0, -1])
def test_an_older_code_is_refused_once_a_newer_one_signed_in(open_api, older):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    sign_in_totp(api, steps_ahead=1)
    api.client.post("/auth/logout")

    assert verify_totp(api, totp_code(api, older)).status_code == 401


@pytest.mark.parametrize("offset, expected", [(-1, 200), (0, 200), (1, 200), (-2, 401), (2, 401), (5, 401)])
def test_one_step_either_side_of_now_is_accepted_and_no_more(open_api, offset, expected):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)

    assert verify_totp(api, totp_code(api, offset)).status_code == expected


def test_a_code_stops_working_as_the_clock_moves_on(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    code = totp_code(api)

    api.clock.advance(3 * totp.PERIOD)

    assert verify_totp(api, code).status_code == 401
    assert verify_totp(api, totp_code(api)).status_code == 200


def test_spaces_in_the_code_are_ignored(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    code = totp_code(api)

    assert verify_totp(api, f" {code[:3]} {code[3:]} ").status_code == 200


def test_the_email_field_is_ignored_in_authenticator_mode(open_api):
    # The owner is the one address in OWNER_EMAILS: an older form that still sends an email works the same.
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)

    response = api.client.post("/auth/verify", json={"email": "stranger@example.test", "code": totp_code(api)})

    assert response.status_code == 200
    assert response.json() == {"mode": "owner", "email": OWNER_EMAIL}
    assert me(api)["email"] == OWNER_EMAIL


def test_requesting_a_code_does_nothing_in_authenticator_mode(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)

    allowed = request_code(api, OWNER_EMAIL)
    stranger = request_code(api, "stranger@example.test")

    assert allowed.status_code == stranger.status_code == 202
    assert allowed.json() == stranger.json()
    assert api.sender.sent == []
    assert "set-cookie" not in allowed.headers


def test_a_request_code_flood_is_harmless_in_authenticator_mode(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)

    assert {request_code(api).status_code for _ in range(30)} == {202}
    assert api.sender.sent == []


def test_logout_ends_the_session(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    sign_in_totp(api)

    api.client.post("/auth/logout")

    assert me(api)["mode"] == "anonymous"


def test_the_session_expires_like_any_other(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    sign_in_totp(api)

    api.clock.advance(SESSION_LIFETIME_SECONDS + 1)

    assert me(api)["mode"] == "anonymous"


def test_a_misconfigured_server_answers_401_to_everything_and_locks_nothing(open_api):
    api = open_api(base_url=HTTPS, **{**PROD_TOTP_ENV, "OWNER_TOTP_SECRET": "garbage!"})
    # The code an EMPTY key would produce: what an attacker would try if a broken secret fell back to no key at all.
    empty_key_code = totp.totp_at(b"", api.clock.now)

    statuses = {verify_totp(api, code).status_code for code in ["123456", empty_key_code] * 4}

    assert statuses == {401}
    assert api.auth._totp_locked_until == 0.0
    assert me(api)["owner_login_enabled"] is False


def test_an_email_mode_server_still_requires_the_email_field(open_api):
    api = open_api(**owner_env())

    assert api.client.post("/auth/verify", json={"code": "123456"}).status_code == 422
    assert verify(api, "123456").status_code == 401


def test_no_response_ever_contains_the_secret(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    bodies = [
        api.client.get("/auth/me").text,
        verify_totp(api, wrong_code_for(api)).text,
        request_code(api).text,
        sign_in_totp(api).text,
        api.client.get("/auth/me").text,
    ]

    assert not any(TOTP_SECRET in body or TOTP_SECRET.lower() in body.lower() for body in bodies)


# ======================================================================== lockout

def test_five_wrong_codes_in_a_row_lock_sign_in_even_for_the_right_code(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    for _ in range(TOTP_MAX_FAILURES):
        assert verify_totp(api, wrong_code_for(api)).status_code == 401

    response = verify_totp(api, totp_code(api))

    assert response.status_code == 429
    assert response.headers["retry-after"] == str(TOTP_LOCKOUT_SECONDS) == "900"
    assert "set-cookie" not in response.headers
    assert me(api)["mode"] == "anonymous"


def test_four_wrong_codes_do_not_lock(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    for _ in range(TOTP_MAX_FAILURES - 1):
        verify_totp(api, wrong_code_for(api))

    assert verify_totp(api, totp_code(api)).status_code == 200


def test_the_lockout_counts_down_and_then_ends(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    for _ in range(TOTP_MAX_FAILURES):
        verify_totp(api, wrong_code_for(api))

    api.clock.advance(TOTP_LOCKOUT_SECONDS - 1)
    still = verify_totp(api, totp_code(api))
    api.clock.advance(1)
    after = verify_totp(api, totp_code(api))

    assert (still.status_code, still.headers["retry-after"]) == (429, "1")
    assert after.status_code == 200


def test_a_locked_out_attempt_is_not_checked_so_the_right_code_is_not_spent():
    service, clock = make_service()
    for _ in range(TOTP_MAX_FAILURES):
        service.verify_totp(wrong_code(clock), "203.0.113.1")
    right = code_at(clock)

    with pytest.raises(RateLimited):
        service.verify_totp(right, "203.0.113.1")

    assert service._totp_last_step == -1  # nothing was consumed
    clock.advance(TOTP_LOCKOUT_SECONDS)
    assert service.verify_totp(code_at(clock), "203.0.113.1") is not None


def test_the_lockout_doubles_every_time_up_to_a_day():
    service, clock = make_service()
    expected = [900, 1800, 3600, 7200, 14400, 28800, 57600, 86400, 86400, 86400]

    seen = []
    for _ in expected:
        for _ in range(TOTP_MAX_FAILURES):
            service.verify_totp(wrong_code(clock), "203.0.113.1")
        with pytest.raises(RateLimited) as locked:
            service.verify_totp(wrong_code(clock), "203.0.113.1")
        seen.append(locked.value.retry_after)
        clock.advance(locked.value.retry_after)

    assert seen == expected
    assert expected[-1] == TOTP_LOCKOUT_MAX_SECONDS == 24 * 3600


def test_a_correct_code_resets_the_failure_count():
    service, clock = make_service()
    for round_number in range(4):
        address = f"203.0.113.{round_number}"  # a new address each round: this is about the count, not the per-address budget
        for _ in range(TOTP_MAX_FAILURES - 1):
            assert service.verify_totp(wrong_code(clock), address) is None
        assert service.verify_totp(code_at(clock), address) is not None  # never reaches five in a row
        clock.advance(totp.PERIOD)  # the next sign-in needs a new step


def test_a_correct_code_resets_the_lockout_level():
    service, clock = make_service()
    for _ in range(TOTP_MAX_FAILURES):
        service.verify_totp(wrong_code(clock), "203.0.113.1")
    clock.advance(TOTP_LOCKOUT_SECONDS)
    assert service.verify_totp(code_at(clock), "203.0.113.1") is not None  # signs in: back to level zero
    clock.advance(totp.PERIOD)

    for _ in range(TOTP_MAX_FAILURES):
        service.verify_totp(wrong_code(clock), "203.0.113.1")
    with pytest.raises(RateLimited) as locked:
        service.verify_totp(code_at(clock), "203.0.113.1")

    assert locked.value.retry_after == TOTP_LOCKOUT_SECONDS  # 15 minutes again, not 30


def test_the_lockout_is_per_server_not_per_client_address():
    service, clock = make_service()
    for number in range(TOTP_MAX_FAILURES):
        service.verify_totp(wrong_code(clock), f"203.0.113.{number}")  # five DIFFERENT addresses

    with pytest.raises(RateLimited):
        service.verify_totp(code_at(clock), "198.51.100.200")  # and a sixth one is locked out too


def test_a_request_already_in_flight_when_the_lock_engages_does_not_get_a_guess(monkeypatch):
    # Parallel requests all pass the "is sign-in locked?" check before the first wrong codes lock it. The check
    # is repeated under the same lock that evaluates a code, so a straggler never gets to try one -- not even
    # the right one -- and a burst of requests cannot buy more guesses than a lockout allows.
    service, clock = make_service()
    for number in range(TOTP_MAX_FAILURES - 1):
        service.verify_totp(wrong_code(clock), f"203.0.113.{number}")  # four wrong codes: one short of a lockout
    real_limit = service._limit
    fired = []

    def limit_then_let_another_request_lock_it(key, rule):
        real_limit(key, rule)
        if not fired:  # while THIS request sits between its lock check and its guess, another gets in first
            fired.append(True)
            service.verify_totp(wrong_code(clock), "203.0.113.99")  # the fifth wrong code: locks sign-in

    monkeypatch.setattr(service, "_limit", limit_then_let_another_request_lock_it)

    with pytest.raises(RateLimited):
        service.verify_totp(code_at(clock), "198.51.100.1")  # the RIGHT code, but too late

    assert service._totp_last_step == -1  # it was never evaluated, let alone accepted


def test_the_per_address_attempt_budget_still_applies():
    service, clock = make_service()
    attempts = 0
    for _ in range(2):  # 4 wrong + 1 right, twice: ten attempts, never five wrong in a row
        for _ in range(TOTP_MAX_FAILURES - 1):
            service.verify_totp(wrong_code(clock), "203.0.113.50")
            attempts += 1
        assert service.verify_totp(code_at(clock), "203.0.113.50") is not None
        attempts += 1
        clock.advance(totp.PERIOD)

    assert attempts == 10
    with pytest.raises(RateLimited):
        service.verify_totp(code_at(clock), "203.0.113.50")
    assert service.verify_totp(code_at(clock), "203.0.113.51") is not None  # another address is unaffected


def test_development_relaxes_the_lockout_so_click_testing_is_not_blocked(open_api):
    api = open_api(**totp_env())
    for _ in range(TOTP_MAX_FAILURES * 10 - 1):
        assert verify_totp(api, wrong_code_for(api)).status_code == 401

    assert verify_totp(api, totp_code(api)).status_code == 200  # the 50th attempt is the right one: no lockout yet


def test_development_still_locks_eventually(open_api):
    api = open_api(**totp_env())
    for _ in range(TOTP_MAX_FAILURES * 10):
        verify_totp(api, wrong_code_for(api))

    assert verify_totp(api, totp_code(api)).status_code == 429


def test_a_lockout_is_logged_without_any_code_or_secret(caplog):
    service, clock = make_service()
    submitted = wrong_code(clock)

    with caplog.at_level(logging.WARNING, logger="combat_copilot.auth"):
        for _ in range(TOTP_MAX_FAILURES):
            service.verify_totp(submitted, "203.0.113.1")

    assert "locked for 15 minutes" in caplog.text
    assert TOTP_SECRET not in caplog.text and submitted not in caplog.text.replace("15", "")


# ============================================================ development helper

def test_the_dev_helper_offers_the_current_code_and_it_signs_in(open_api):
    api = open_api(**totp_env())
    assert me(api)["dev"] is True

    helper = api.client.get("/auth/dev/last-code")  # no email: the authenticator form does not ask for one

    assert helper.status_code == 200
    assert helper.json() == {"code": totp_code(api)}
    assert verify_totp(api, helper.json()["code"]).status_code == 200


def test_the_dev_helper_moves_to_the_next_step_after_a_code_was_used(open_api):
    api = open_api(**totp_env())
    first = api.client.get("/auth/dev/last-code").json()["code"]
    assert verify_totp(api, first).status_code == 200
    api.client.post("/auth/logout")

    second = api.client.get("/auth/dev/last-code")
    assert second.json() == {"code": totp_code(api, 1)}
    assert verify_totp(api, second.json()["code"]).status_code == 200
    api.client.post("/auth/logout")

    exhausted = api.client.get("/auth/dev/last-code")  # both valid steps are spent
    assert exhausted.status_code == 409
    api.clock.advance(totp.PERIOD)
    assert verify_totp(api, api.client.get("/auth/dev/last-code").json()["code"]).status_code == 200


def test_the_dev_helper_is_unreachable_outside_development(open_api):
    api = open_api(base_url=HTTPS, **PROD_TOTP_ENV)
    unknown = api.client.get("/definitely/not/a/route")

    helper = api.client.get("/auth/dev/last-code")

    assert (helper.status_code, helper.json()) == (404, unknown.json()) == (404, {"detail": "Not Found"})
    assert me(api)["dev"] is False


def test_the_dev_helper_is_unreachable_in_test_env(open_api):
    api = open_api(**totp_env(ENV="test"))

    assert api.client.get("/auth/dev/last-code").status_code == 404
    assert me(api)["dev"] is False


def test_the_dev_helper_refuses_non_loopback_clients_even_in_development(open_api):
    api = open_api(client_address=("203.0.113.9", 5555), **totp_env())

    assert api.client.get("/auth/dev/last-code").status_code == 404


def test_the_dev_helper_is_not_offered_when_login_is_not_configured(open_api):
    api = open_api(**owner_env(OWNER_TOTP_SECRET="garbage!"))

    assert api.client.get("/auth/dev/last-code").status_code == 404
    assert me(api)["dev"] is False


def test_the_email_dev_helper_is_unchanged_by_the_authenticator_option(open_api):
    api = open_api(sender=None, **owner_env())  # email mode, console sender
    request_code(api)

    helper = api.client.get("/auth/dev/last-code", params={"email": OWNER_EMAIL})

    assert helper.status_code == 200 and len(helper.json()["code"]) == 6
    assert api.client.get("/auth/dev/last-code").status_code == 404  # email mode still needs the address


def test_the_module_exposes_the_documented_lockout_constants():
    assert (auth_module.TOTP_MAX_FAILURES, auth_module.TOTP_LOCKOUT_SECONDS, auth_module.TOTP_LOCKOUT_MAX_SECONDS) == (5, 900, 86400)
