"""The HTTP stack in this Python environment must match the pins in requirements.txt.

FastAPI only requires `starlette>=0.46`, and Starlette's TestClient picks its HTTP client by what is installed:
httpx2 when present, the older httpx otherwise. Unpinned, CI resolved newer packages than a developer machine had,
the two clients ordered cookies differently, and a test passed locally but failed in CI.

The pins make CI and the Docker image deterministic. This test makes a drifting LOCAL environment fail loudly, with
the fix in the message, instead of silently running different code than CI does.
"""
import re
from importlib import metadata
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PINNED = ("starlette", "httpx2")


def pinned_version(package: str) -> str:
    text = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    match = re.search(rf"^{re.escape(package)}==([^\s#]+)", text, re.MULTILINE)
    assert match, f"{package} must be pinned with == in requirements.txt (see the comment there for why)"
    return match.group(1)


@pytest.mark.parametrize("package", PINNED)
def test_the_installed_http_stack_matches_the_pins(package):
    wanted = pinned_version(package)
    try:
        installed = metadata.version(package)
    except metadata.PackageNotFoundError:
        installed = None

    assert installed == wanted, (
        f"{package} is {'not installed' if installed is None else installed} but requirements.txt pins {wanted}. "
        "This environment differs from CI and the Docker image: run `pip install -r requirements-dev.txt`."
    )
