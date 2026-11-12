#!/usr/bin/env python3
"""Set up authenticator-app sign-in for the owner. Run this on YOUR computer, not on the server:

    python scripts/totp_setup.py --email you@example.com

It makes a new secret, shows it (as a QR code if the optional `qrcode` package is installed -- `pip install
qrcode` -- and always as a setup key you can type in), waits for you to enter the code your authenticator app
now shows, and only then prints the lines to add to the server's .env. Nothing is sent anywhere.

Use any authenticator app: Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden...
Keep a copy of the setup key in your password manager: it is the only way to add the account to a new phone
without touching the server. The secret is shown on this screen only; clear the terminal afterwards.
"""
import argparse
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Callable, List, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # the repo root, where totp.py lives
import totp  # noqa: E402

ISSUER = "Combat Copilot"
CONFIRM_ATTEMPTS = 3
QUIET_ZONE = 4  # modules of light border the QR specification asks for


def grouped(secret: str) -> str:
    """The secret in groups of four, the way authenticator apps show a setup key."""
    return " ".join(secret[i : i + 4] for i in range(0, len(secret), 4))


def qr_matrix(uri: str) -> Optional[List[List[bool]]]:
    """The QR code for ``uri`` as rows of booleans (True = dark module, quiet zone included), or None
    when the optional `qrcode` package is not installed."""
    try:
        import qrcode  # type: ignore[import-not-found]
    except ImportError:
        return None
    code = qrcode.QRCode(border=QUIET_ZONE)
    code.add_data(uri)
    code.make(fit=True)
    return [[bool(cell) for cell in row] for row in code.get_matrix()]


def render_qr(matrix: Sequence[Sequence[bool]]) -> List[str]:
    """Terminal lines for the matrix: two module rows per text line (half blocks), with the colours set
    explicitly -- black modules on white -- so the polarity is right in a dark or a light terminal."""
    dark, light = "\x1b[38;5;16m", "\x1b[38;5;231m"  # foreground: black / white
    dark_bg, light_bg = "\x1b[48;5;16m", "\x1b[48;5;231m"
    reset = "\x1b[0m"
    lines = []
    for top_row, bottom_row in zip(matrix[::2], list(matrix[1::2]) + [[False] * len(matrix[0])]):
        cells = []
        for top, bottom in zip(top_row, bottom_row):
            cells.append(f"{dark if top else light}{dark_bg if bottom else light_bg}▀")  # upper half block
        lines.append("".join(cells) + reset)
    return lines


def valid_email(text: str) -> bool:
    local, _, domain = text.partition("@")
    return bool(local) and "." in domain and not any(character.isspace() for character in text)


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    input_fn: Callable[[str], str] = input,
    now: Callable[[], float] = time.time,
    out: Callable[[str], None] = print,
    qr: Callable[[str], Optional[List[List[bool]]]] = qr_matrix,
    color: Optional[bool] = None,
) -> int:
    parser = argparse.ArgumentParser(description="Set up authenticator-app sign-in for the owner.")
    parser.add_argument("--email", required=True, help="the owner's address (the one address in OWNER_EMAILS)")
    parser.add_argument("--secret", help="reuse an existing secret (to add the account to another device) instead of making a new one")
    parser.add_argument("--no-confirm", action="store_true", help="skip typing a code to prove the app works (not recommended)")
    args = parser.parse_args(argv)

    email = args.email.strip().lower()
    if not valid_email(email):
        out(f"'{args.email}' does not look like an email address.")
        return 2
    try:
        secret = totp.normalize_secret(args.secret) if args.secret else totp.generate_secret()
    except ValueError as problem:
        out(f"--secret was rejected: {problem}.")  # never echoes the secret itself
        return 2
    key = totp.decode_secret(secret)
    uri = totp.provisioning_uri(secret, email, ISSUER)

    out("")
    out("Add this account to your authenticator app.")
    out("")
    matrix = qr(uri)
    use_color = (sys.stdout.isatty() and "NO_COLOR" not in os.environ) if color is None else color
    if matrix is not None and use_color:
        if os.name == "nt" and sys.stdout.isatty():
            os.system("")  # makes a Windows console understand the colour escape codes below
        out("Scan this QR code (it must be shown in a terminal with colour support):")
        out("")
        for line in render_qr(matrix):
            out("    " + line)
        out("")
        out("Or enter the setup key by hand:")
    elif matrix is None:
        out("Enter the setup key by hand (for a QR code to scan instead, run `pip install qrcode` and this again):")
    else:
        out("Enter the setup key by hand:")
    out("")
    out(f"    Account:  {email}")
    out(f"    Key:      {grouped(secret)}")
    out("    Type:     time-based (TOTP), 6 digits, 30 seconds")
    out("")

    if not args.no_confirm:
        out("Now prove it works before anything is changed on the server.")
        for attempt in range(1, CONFIRM_ATTEMPTS + 1):
            try:
                answer = input_fn("Enter the 6-digit code your app shows now: ")
            except EOFError:
                out("No code entered; stopping.")
                return 1
            if totp.match_step(key, answer, now()) is not None:
                out("That code is right.")
                break
            left = CONFIRM_ATTEMPTS - attempt
            out("That is not the code for this key." + (f" Try again ({left} left): wait for a fresh code and check the key was entered exactly." if left else ""))
        else:
            out("")
            out("The code never matched, so nothing is ready. Check the key you entered, and that this computer's")
            out("clock and your phone's clock are both set automatically. Then run this again.")
            return 1

    out("")
    out("Add these lines to the .env file on your server (the one next to docker-compose.yml):")
    out("")
    out(f"    OWNER_EMAILS={email}")
    out(f"    OWNER_TOTP_SECRET={secret}")
    out(f"    SESSION_SECRET={secrets.token_urlsafe(48)}")
    out("")
    out("(Add the SESSION_SECRET line only if .env does not already have one. Keep each setting on a line of its own,")
    out("with no comment after the value: older Docker Compose versions would read it as part of the value.)")
    out("")
    out("Then apply it with `docker compose up -d` in that folder (a plain restart does not re-read .env).")
    out("")
    out("Reminders:")
    out("  * Save the setup key in your password manager. If you lose your phone, that (or re-running this")
    out("    script and replacing OWNER_TOTP_SECRET on the server) is how you get back in.")
    out("  * Sign-in only works over HTTPS: the session cookie is marked Secure.")
    out("  * Never commit .env, and never paste the key into chat or a ticket.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
