"""Time-based one-time passwords (RFC 6238) for the owner's authenticator app. Standard library only.

The parameters are the ones every mainstream authenticator app (Google Authenticator, Microsoft
Authenticator, Authy, 1Password, Bitwarden, ...) supports: HMAC-SHA1, 6 digits, 30-second steps.
"""
import base64
import binascii
import hashlib
import hmac
import secrets
import struct
from typing import Optional
from urllib.parse import quote

DIGITS = 6
PERIOD = 30  # seconds per step
SECRET_BYTES = 20  # 160 bits: what RFC 4226 recommends and authenticator apps expect
MIN_SECRET_BYTES = 16  # RFC 4226 section 4: the shared secret MUST be at least 128 bits
WINDOW = 1  # steps accepted either side of "now": tolerates a phone clock that is up to ~30 s off


def generate_secret() -> str:
    """A fresh random secret as unpadded base32 text, the form authenticator apps take."""
    return base64.b32encode(secrets.token_bytes(SECRET_BYTES)).decode("ascii").rstrip("=")


def decode_secret(text: str) -> bytes:
    """Parses a base32 secret.

    Tolerates what happens to a key when people copy it around: lower case, spaces, hyphens, missing
    padding. Raises ValueError -- never echoing the text -- if it is not valid base32 or is shorter
    than 128 bits.
    """
    cleaned = "".join(text.split()).replace("-", "").rstrip("=").upper()
    if not cleaned:
        raise ValueError("the secret is empty")
    cleaned += "=" * (-len(cleaned) % 8)
    try:
        key = base64.b32decode(cleaned)
    except (binascii.Error, ValueError):
        raise ValueError("the secret is not valid base32") from None
    if len(key) < MIN_SECRET_BYTES:
        raise ValueError("the secret is shorter than 128 bits")
    return key


def normalize_secret(text: str) -> str:
    """The canonical text form (upper case, no spaces or padding) of a valid secret."""
    return base64.b32encode(decode_secret(text)).decode("ascii").rstrip("=")


def hotp(key: bytes, counter: int) -> str:
    """The RFC 4226 HOTP value for ``counter``, as a zero-padded decimal string."""
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(value % 10**DIGITS).zfill(DIGITS)


def current_step(at: float) -> int:
    """The 30-second step number containing the Unix time ``at``."""
    return int(at // PERIOD)


def totp_at(key: bytes, at: float) -> str:
    """The code an authenticator app shows at Unix time ``at``."""
    return hotp(key, current_step(at))


def match_step(
    key: bytes,
    code: str,
    at: float,
    *,
    window: int = WINDOW,
    after_step: Optional[int] = None,
) -> Optional[int]:
    """The step whose code equals ``code`` at time ``at``, or None.

    Steps within ``window`` of the current one are accepted. A step at or before ``after_step`` is not:
    pass the last step that signed someone in, and a code can be used only once (RFC 6238 section 5.2).
    Every candidate step is computed and compared even after a match, so how long a check takes does
    not reveal which step, if any, matched. A malformed code (not six digits) simply never matches.
    """
    submitted = "".join(code.split())  # authenticator apps display "123 456"
    if len(submitted) != DIGITS or not (submitted.isascii() and submitted.isdigit()):
        return None
    now_step = current_step(at)
    matched: Optional[int] = None
    for step in range(now_step - window, now_step + window + 1):
        if step < 0:
            continue
        equal = hmac.compare_digest(hotp(key, step), submitted)
        if equal and (after_step is None or step > after_step) and (matched is None or step > matched):
            matched = step
    return matched


def provisioning_uri(secret: str, account: str, issuer: str) -> str:
    """The otpauth:// URI an authenticator app reads from a QR code (Google's Key URI format).

    ``secret`` must already be in canonical form (see normalize_secret).
    """
    issuer_part = quote(issuer, safe="")
    label = f"{issuer_part}:{quote(account, safe='@')}"
    return f"otpauth://totp/{label}?secret={secret}&issuer={issuer_part}&algorithm=SHA1&digits={DIGITS}&period={PERIOD}"
