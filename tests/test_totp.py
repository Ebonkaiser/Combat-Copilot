"""RFC 6238 time-based one-time passwords (totp.py): the published test vectors, the acceptance
window, single use, and secret handling. Offline, and no clock: every time is passed in."""
import base64
from urllib.parse import parse_qs, urlsplit

import pytest

import totp

RFC_KEY = b"12345678901234567890"  # the key behind the RFC 4226 / RFC 6238 test vectors
RFC_KEY_TEXT = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # the same key as an authenticator app takes it

# RFC 4226 appendix D: HOTP for counters 0..9.
HOTP_VECTORS = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]

# RFC 6238 appendix B (SHA-1): Unix time -> TOTP. The RFC prints 8 digits; the 6-digit code is the last six.
TOTP_VECTORS = [
    (59, "94287082"),
    (1111111109, "07081804"),
    (1111111111, "14050471"),
    (1234567890, "89005924"),
    (2000000000, "69279037"),
    (20000000000, "65353130"),
]

AT = 1_800_000_000.0  # exactly on a step boundary
STEP = totp.current_step(AT)


def code_for(step: int) -> str:
    return totp.hotp(RFC_KEY, step)


# ------------------------------------------------------------------ the standard

@pytest.mark.parametrize("counter, expected", list(enumerate(HOTP_VECTORS)))
def test_hotp_matches_the_rfc_4226_vectors(counter, expected):
    assert totp.hotp(RFC_KEY, counter) == expected


@pytest.mark.parametrize("at, eight_digits", TOTP_VECTORS)
def test_totp_matches_the_rfc_6238_vectors(at, eight_digits):
    assert totp.totp_at(RFC_KEY, at) == eight_digits[-6:]


def test_codes_keep_their_leading_zeros():
    assert totp.totp_at(RFC_KEY, 1111111109) == "081804"
    assert totp.totp_at(RFC_KEY, 1234567890) == "005924"
    assert all(len(totp.hotp(RFC_KEY, counter)) == 6 for counter in range(200))


def test_a_step_is_thirty_seconds_counted_from_the_unix_epoch():
    assert [totp.current_step(at) for at in (0, 29.999, 30, 59.9, 60)] == [0, 0, 1, 1, 2]


def test_the_code_changes_only_at_a_step_boundary():
    assert totp.totp_at(RFC_KEY, AT) == totp.totp_at(RFC_KEY, AT + 29.9)
    assert totp.totp_at(RFC_KEY, AT) != totp.totp_at(RFC_KEY, AT + 30)


# ------------------------------------------------------------- acceptance window

def test_the_current_code_matches_its_own_step():
    assert totp.match_step(RFC_KEY, code_for(STEP), AT) == STEP


@pytest.mark.parametrize("offset", [-1, 1])
def test_one_step_either_side_is_accepted(offset):
    assert totp.match_step(RFC_KEY, code_for(STEP + offset), AT) == STEP + offset


@pytest.mark.parametrize("offset", [-2, 2, -10, 10])
def test_two_or_more_steps_away_is_refused(offset):
    assert totp.match_step(RFC_KEY, code_for(STEP + offset), AT) is None


def test_a_wrong_code_does_not_match():
    wrong = next(c for c in ("000000", "111111", "222222") if c not in {code_for(STEP + o) for o in (-1, 0, 1)})

    assert totp.match_step(RFC_KEY, wrong, AT) is None


def test_the_window_can_be_narrowed_or_widened():
    assert totp.match_step(RFC_KEY, code_for(STEP + 1), AT, window=0) is None
    assert totp.match_step(RFC_KEY, code_for(STEP), AT, window=0) == STEP
    assert totp.match_step(RFC_KEY, code_for(STEP + 2), AT, window=2) == STEP + 2


def test_the_window_edges_move_with_the_clock():
    # A step's code is current for 30 seconds, still accepted for the next 30 (one step old), then refused.
    assert totp.match_step(RFC_KEY, code_for(STEP), AT + 29) == STEP
    assert totp.match_step(RFC_KEY, code_for(STEP), AT + 30) == STEP
    assert totp.match_step(RFC_KEY, code_for(STEP), AT + 59) == STEP
    assert totp.match_step(RFC_KEY, code_for(STEP), AT + 60) is None


# ------------------------------------------------------------------- single use

def test_a_code_cannot_be_used_twice():
    first = totp.match_step(RFC_KEY, code_for(STEP), AT)

    assert first == STEP
    assert totp.match_step(RFC_KEY, code_for(STEP), AT, after_step=first) is None


def test_an_older_code_is_refused_once_a_newer_one_has_been_used():
    assert totp.match_step(RFC_KEY, code_for(STEP - 1), AT, after_step=STEP) is None


def test_a_newer_code_is_still_accepted_after_an_older_one_was_used():
    assert totp.match_step(RFC_KEY, code_for(STEP + 1), AT, after_step=STEP) == STEP + 1


def test_after_step_is_exclusive_and_none_means_nothing_was_used():
    assert totp.match_step(RFC_KEY, code_for(STEP), AT, after_step=STEP - 1) == STEP
    assert totp.match_step(RFC_KEY, code_for(STEP), AT, after_step=None) == STEP


# --------------------------------------------------------------- what people type

def test_spaces_in_the_code_are_ignored():
    code = code_for(STEP)

    assert totp.match_step(RFC_KEY, f"{code[:3]} {code[3:]}", AT) == STEP
    assert totp.match_step(RFC_KEY, f"  {code}\n", AT) == STEP


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "12345",
        "1234567",
        "abcdef",
        "12345a",
        "12-3456",
        "+12345",
        "123456\x00",
        "１２３４５６",  # full-width digits
        "١٢٣٤٥٦",  # Arabic-Indic digits
        "123456; DROP TABLE",
    ],
)
def test_a_malformed_code_never_matches_and_never_raises(bad):
    assert totp.match_step(RFC_KEY, bad, AT) is None


def test_the_clock_near_the_epoch_never_asks_for_a_negative_step():
    assert totp.match_step(RFC_KEY, code_for(0), 10.0) == 0
    assert totp.match_step(RFC_KEY, code_for(1), 10.0) == 1


def test_every_candidate_step_is_compared_whatever_the_outcome(monkeypatch):
    # No early exit and a constant-time comparison: how long a check takes must not reveal which step matched.
    calls = []
    real = totp.hmac.compare_digest
    monkeypatch.setattr(totp.hmac, "compare_digest", lambda a, b: calls.append((a, b)) or real(a, b))

    for submitted in (code_for(STEP - 1), code_for(STEP), code_for(STEP + 1), "000000"):
        calls.clear()
        totp.match_step(RFC_KEY, submitted, AT)

        assert len(calls) == 3, f"{submitted}: expected all three steps to be compared"


# ----------------------------------------------------------------------- secrets

def test_a_generated_secret_is_160_bits_of_unpadded_base32():
    secret = totp.generate_secret()

    assert len(secret) == 32
    assert set(secret) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    assert len(totp.decode_secret(secret)) == totp.SECRET_BYTES == 20


def test_generated_secrets_are_not_repeated():
    assert len({totp.generate_secret() for _ in range(50)}) == 50


def test_a_secret_survives_the_ways_people_copy_keys():
    expected = RFC_KEY
    spaced = " ".join(RFC_KEY_TEXT[i : i + 4] for i in range(0, 32, 4))

    assert totp.decode_secret(RFC_KEY_TEXT) == expected
    assert totp.decode_secret(RFC_KEY_TEXT.lower()) == expected
    assert totp.decode_secret(spaced) == expected
    assert totp.decode_secret(spaced.replace(" ", "-")) == expected
    assert totp.decode_secret(f"  {RFC_KEY_TEXT}\n") == expected


def test_padding_is_optional():
    key = b"0123456789abcdef"  # 16 bytes: the shortest allowed, and one that needs padding
    padded = base64.b32encode(key).decode()

    assert padded.endswith("=")
    assert totp.decode_secret(padded) == totp.decode_secret(padded.rstrip("=")) == key


@pytest.mark.parametrize(
    "bad",
    ["", "   ", "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!", "0189" * 8, "A" * 7, "MFRGG", base64.b32encode(b"x" * 15).decode()],
    ids=["empty", "blank", "punctuation", "digits-outside-base32", "bad-length", "tiny", "15-bytes"],
)
def test_an_invalid_or_short_secret_is_rejected(bad):
    with pytest.raises(ValueError):
        totp.decode_secret(bad)


def test_a_sixteen_byte_secret_is_the_minimum():
    assert len(totp.decode_secret(base64.b32encode(b"x" * 16).decode())) == 16


def test_the_error_never_contains_the_secret():
    with pytest.raises(ValueError) as caught:
        totp.decode_secret("super-secret-key-material-!!!")

    assert "super" not in str(caught.value) and "secret-key" not in str(caught.value)


def test_normalize_secret_gives_the_canonical_form():
    assert totp.normalize_secret(" gezd gnbv gy3t qojq-gezd gnbv gy3t qojq ") == RFC_KEY_TEXT


# ---------------------------------------------------------------- enrollment URI

def test_the_provisioning_uri_is_the_key_uri_authenticator_apps_read():
    uri = totp.provisioning_uri(RFC_KEY_TEXT, "owner@example.test", "Combat Copilot")

    assert uri == (
        "otpauth://totp/Combat%20Copilot:owner@example.test"
        f"?secret={RFC_KEY_TEXT}&issuer=Combat%20Copilot&algorithm=SHA1&digits=6&period=30"
    )


def test_the_provisioning_uri_round_trips_through_a_parser():
    parts = urlsplit(totp.provisioning_uri(RFC_KEY_TEXT, "a+b c@example.test", "Combat & Copilot"))
    query = parse_qs(parts.query)

    assert (parts.scheme, parts.netloc) == ("otpauth", "totp")
    assert parts.path == "/Combat%20%26%20Copilot:a%2Bb%20c@example.test"
    assert query == {
        "secret": [RFC_KEY_TEXT],
        "issuer": ["Combat & Copilot"],
        "algorithm": ["SHA1"],
        "digits": ["6"],
        "period": ["30"],
    }
