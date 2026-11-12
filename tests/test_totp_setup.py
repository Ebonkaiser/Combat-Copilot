"""The owner's enrollment script (scripts/totp_setup.py): what it shows, what it insists on before it prints
the server settings, and that those settings really enable the server. Offline; typing and time are injected."""
import re
import subprocess
import sys
from pathlib import Path

import pytest

import totp
from auth import load_auth_config
from support import OWNER_EMAIL

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import totp_setup  # noqa: E402

NOW = 1_800_000_000.0


class Run:
    """Runs the script's main() with typing, time and output injected."""

    def __init__(self, *argv, answers=(), qr=None, color=False, now=NOW):
        self.lines: list = []
        self.prompts: list = []
        self.uris: list = []
        feed = iter(answers)

        def typed(prompt):
            self.prompts.append(prompt)
            try:
                answer = next(feed)
            except StopIteration:
                raise EOFError from None
            if isinstance(answer, BaseException):
                raise answer
            return answer(self) if callable(answer) else answer

        def qr_stub(uri):
            self.uris.append(uri)
            return qr

        self.code = totp_setup.main(list(argv), input_fn=typed, now=lambda: now, out=self.lines.append, qr=qr_stub, color=color)

    @property
    def text(self) -> str:
        return "\n".join(self.lines)

    def value(self, name: str) -> str:
        match = re.search(rf"^\s*{name}=(\S+)", self.text, re.MULTILINE)
        assert match, f"{name}= not printed"
        return match.group(1)

    @property
    def secret(self) -> str:
        return self.value("OWNER_TOTP_SECRET")


def right_code(run: Run, offset: int = 0) -> str:
    secret = re.search(r"Key:\s+(.+)", run.text).group(1)
    return totp.totp_at(totp.decode_secret(secret), NOW + offset * totp.PERIOD)


def confirm_with_the_right_code(offset: int = 0):
    return lambda run: right_code(run, offset)


# ------------------------------------------------------------------ happy path

def test_a_confirmed_setup_shows_the_key_and_prints_the_server_settings():
    run = Run("--email", "Owner@Example.test", answers=[confirm_with_the_right_code()])

    assert run.code == 0
    assert run.value("OWNER_EMAILS") == "owner@example.test"  # trimmed and lower-cased, as the server stores it
    assert len(totp.decode_secret(run.secret)) == 20
    assert re.search(r"Account:\s+owner@example.test", run.text)
    assert "That code is right." in run.text
    assert len(run.value("SESSION_SECRET")) >= 48
    assert "docker compose up -d" in run.text


def test_the_displayed_key_is_the_key_in_the_env_lines_and_in_the_qr_uri():
    run = Run("--email", OWNER_EMAIL, answers=[confirm_with_the_right_code()])

    shown = re.search(r"Key:\s+(.+)", run.text).group(1)
    assert shown.replace(" ", "") == run.secret
    assert all(len(group) == 4 for group in shown.split())
    assert run.uris == [totp.provisioning_uri(run.secret, OWNER_EMAIL, "Combat Copilot")]


def test_the_printed_settings_actually_enable_the_server():
    run = Run("--email", OWNER_EMAIL, answers=[confirm_with_the_right_code()])
    environment = {
        "ENV": "production",
        "OWNER_EMAILS": run.value("OWNER_EMAILS"),
        "OWNER_TOTP_SECRET": run.secret,
        "SESSION_SECRET": run.value("SESSION_SECRET"),
    }

    config = load_auth_config(environment)

    assert config.owner_login_enabled and config.login_method == "totp"
    assert config.sole_owner == OWNER_EMAIL
    assert config.owner_totp_key == totp.decode_secret(run.secret)


def test_every_run_makes_a_new_secret():
    secrets_seen = {Run("--email", OWNER_EMAIL, "--no-confirm").secret for _ in range(5)}

    assert len(secrets_seen) == 5


# ---------------------------------------------------------------- confirmation

def test_a_code_from_the_neighbouring_thirty_seconds_is_accepted():
    for offset in (-1, 1):
        assert Run("--email", OWNER_EMAIL, answers=[confirm_with_the_right_code(offset)]).code == 0


def test_a_wrong_code_may_be_retried():
    run = Run("--email", OWNER_EMAIL, answers=["000000", confirm_with_the_right_code()])

    assert run.code == 0
    assert "Try again (2 left)" in run.text
    assert len(run.prompts) == 2


def test_three_wrong_codes_end_the_setup_without_printing_any_server_settings():
    run = Run("--email", OWNER_EMAIL, answers=["000000", "111111", "222222"])

    assert run.code == 1
    assert "OWNER_TOTP_SECRET=" not in run.text and "OWNER_EMAILS=" not in run.text and "SESSION_SECRET=" not in run.text
    assert "nothing is ready" in run.text
    assert len(run.prompts) == 3


def test_a_code_that_is_too_old_is_not_accepted():
    run = Run("--email", OWNER_EMAIL, answers=[confirm_with_the_right_code(-5)] * 3)

    assert run.code == 1


def test_no_code_at_all_stops_cleanly():
    run = Run("--email", OWNER_EMAIL, answers=[EOFError()])

    assert run.code == 1 and "OWNER_TOTP_SECRET=" not in run.text


def test_no_confirm_skips_the_prompt():
    run = Run("--email", OWNER_EMAIL, "--no-confirm")

    assert run.code == 0 and run.prompts == []
    assert run.secret


# ----------------------------------------------------------------- reusing a key

def test_an_existing_secret_can_be_reused_for_another_device():
    spaced = "gezd gnbv gy3t qojq gezd gnbv gy3t qojq"

    run = Run("--email", OWNER_EMAIL, "--secret", spaced, answers=[confirm_with_the_right_code()])

    assert run.code == 0 and run.secret == "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    assert "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ" in run.text


def test_a_bad_secret_is_rejected_without_being_echoed():
    run = Run("--email", OWNER_EMAIL, "--secret", "this-is-not-a-key-!!")

    assert run.code == 2
    assert "--secret was rejected" in run.text
    assert "this-is-not" not in run.text


@pytest.mark.parametrize("bad", ["", "nobody", "nobody@", "@example.test", "a b@example.test", "owner@localhost"])
def test_a_bad_email_is_rejected(bad):
    run = Run("--email", bad, "--no-confirm")

    assert run.code == 2 and "OWNER_TOTP_SECRET=" not in run.text


# ------------------------------------------------------------------------- QR

MATRIX = [
    [True, False, True, True, False, False, True],
    [False, True, True, False, True, False, False],
    [True, True, False, False, False, True, True],
    [False, False, True, False, True, True, False],
    [True, False, False, True, True, False, True],  # five rows: an odd count
]


def parse_rendered(lines):
    """Reads rendered QR lines back into rows of booleans (True = dark)."""
    pattern = re.compile("\x1b\\[38;5;(\\d+)m\x1b\\[48;5;(\\d+)m▀")
    rows = []
    for line in lines:
        cells = pattern.findall(line)
        rows.append([foreground == "16" for foreground, _ in cells])  # upper half: the foreground
        rows.append([background == "16" for _, background in cells])  # lower half: the background
    return rows


def test_the_qr_renders_losslessly_as_black_on_white_half_blocks():
    rendered = totp_setup.render_qr(MATRIX)
    rows = parse_rendered(rendered)

    assert len(rendered) == 3  # five module rows -> three text lines
    assert rows[:5] == MATRIX
    assert rows[5] == [False] * 7  # the missing sixth row is light
    assert all(line.endswith("\x1b[0m") for line in rendered)
    # Colours are explicit, so the polarity does not depend on the terminal theme: only black and white are used.
    assert set(re.findall(r"\x1b\[[34]8;5;(\d+)m", "".join(rendered))) == {"16", "231"}


def test_the_qr_is_shown_when_the_library_and_colour_are_available():
    run = Run("--email", OWNER_EMAIL, "--no-confirm", qr=MATRIX, color=True)

    assert "Scan this QR code" in run.text and "▀" in run.text
    assert "Or enter the setup key by hand:" in run.text


def test_without_colour_only_the_key_is_shown():
    run = Run("--email", OWNER_EMAIL, "--no-confirm", qr=MATRIX, color=False)

    assert "▀" not in run.text and "\x1b" not in run.text
    assert "Enter the setup key by hand:" in run.text


def test_without_the_library_the_script_says_how_to_get_a_qr_code():
    run = Run("--email", OWNER_EMAIL, "--no-confirm", qr=None, color=True)

    assert "pip install qrcode" in run.text and "Key:" in run.text


def test_the_real_qr_matrix_function_degrades_when_the_package_is_missing(monkeypatch):
    monkeypatch.setitem(sys.modules, "qrcode", None)  # makes `import qrcode` raise ImportError

    assert totp_setup.qr_matrix("otpauth://totp/x") is None


# ------------------------------------------------------------------- as a program

def test_the_script_runs_as_a_program_from_any_directory(tmp_path):
    script = SCRIPTS / "totp_setup.py"

    done = subprocess.run(
        [sys.executable, str(script), "--email", OWNER_EMAIL, "--no-confirm"],
        capture_output=True, text=True, cwd=tmp_path, timeout=60,
    )

    assert done.returncode == 0, done.stderr
    assert re.search(r"^\s*OWNER_TOTP_SECRET=[A-Z2-7]{32}\b", done.stdout, re.MULTILINE)
    assert "\x1b" not in done.stdout  # no colour codes when not writing to a terminal


def test_the_script_reports_usage_errors_with_a_nonzero_exit(tmp_path):
    done = subprocess.run(
        [sys.executable, str(SCRIPTS / "totp_setup.py"), "--email", "not-an-address", "--no-confirm"],
        capture_output=True, text=True, cwd=tmp_path, timeout=60,
    )

    assert done.returncode == 2 and "does not look like an email" in done.stdout
