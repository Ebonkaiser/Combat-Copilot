"""Guards for the two ways private campaign content (or the app itself) can be broken by packaging.

1. The Dockerfile copies backend modules by an explicit list. A new module that
   server.py imports but the list forgets would crash the image on startup --
   something no other test can catch.
2. Campaign lore must stay out of git and out of the image (this repo and its
   GHCR image are public). The synthetic test fixture is the one exception.

Offline and fast; the git checks skip themselves when git or a checkout is absent.
"""
import ast
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# Imported by server.py only when a dev/test switch is on; deliberately NOT
# shipped in the image, so production cannot load them.
DEV_ONLY_MODULES = {"fake_ai", "eval_harness"}


def local_imports(module_name: str) -> set[str]:
    tree = ast.parse((ROOT / f"{module_name}.py").read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return {name for name in names if (ROOT / f"{name}.py").is_file()}


def modules_needed_by_server() -> set[str]:
    seen: set[str] = set()
    todo = ["server"]
    while todo:
        module = todo.pop()
        if module not in seen:
            seen.add(module)
            todo.extend(local_imports(module))
    return seen


def dockerfile_lines() -> list[str]:
    return (ROOT / "Dockerfile").read_text(encoding="utf-8").splitlines()


def dockerfile_backend_modules() -> set[str]:
    for line in dockerfile_lines():
        parts = line.split()
        if parts[:1] == ["COPY"] and any(part.endswith(".py") for part in parts):
            return {Path(part).stem for part in parts[1:-1]}
    raise AssertionError("no 'COPY <modules>.py ./' line found in the Dockerfile")


def ignore_lines(filename: str) -> set[str]:
    lines = (ROOT / filename).read_text(encoding="utf-8").splitlines()
    return {line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")}


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)


needs_git_checkout = pytest.mark.skipif(
    shutil.which("git") is None or not (ROOT / ".git").exists(),
    reason="needs git and a git checkout",
)


# ------------------------------------------------------------------ the image

def test_the_image_ships_every_module_the_server_imports():
    needed = modules_needed_by_server() - DEV_ONLY_MODULES

    missing = needed - dockerfile_backend_modules()

    assert not missing, f"server.py needs {sorted(missing)} but the Dockerfile COPY list omits them"


def test_dev_only_modules_are_not_shipped_in_the_image():
    assert not (DEV_ONLY_MODULES & dockerfile_backend_modules())


def test_the_image_does_not_copy_campaign_lore():
    copy_lines = [line for line in dockerfile_lines() if line.split()[:1] == ["COPY"]]
    # Source operands only (not the destination, and not a module that happens
    # to be called campaigns.py).
    sources = [token for line in copy_lines for token in line.split()[1:-1] if not token.startswith("--")]

    assert not [s for s in sources if s.startswith(("data/lore", "data/campaigns", "campaigns/"))]
    assert "data/rules/" in sources  # the public SRD rules still ship


@pytest.mark.parametrize("pattern", ["data/campaigns/", "campaigns/"])
def test_dockerignore_keeps_campaign_content_out_of_the_build_context(pattern):
    assert pattern in ignore_lines(".dockerignore")


# -------------------------------------------------------------------------- git

@pytest.mark.parametrize("pattern", ["data/campaigns/", "/campaigns/"])
def test_gitignore_lists_the_private_campaign_locations(pattern):
    assert pattern in ignore_lines(".gitignore")


@needs_git_checkout
@pytest.mark.parametrize(
    "path",
    [
        "data/campaigns/light-and-magic/lore/factions/iron_silk_bureau.md",
        "data/campaigns/anything/roster.yaml",
        "campaigns/light-and-magic/campaign.yaml",
    ],
)
def test_git_ignores_private_campaign_paths(path):
    assert git("check-ignore", "-q", path).returncode == 0, f"{path} would be committed"


@needs_git_checkout
def test_git_does_not_ignore_the_synthetic_test_fixture():
    result = git("check-ignore", "-q", "tests/fixtures/campaigns/test-campaign/campaign.yaml")

    assert result.returncode == 1


@needs_git_checkout
def test_no_private_campaign_file_is_tracked_by_git():
    tracked = git("ls-files", "--", "data/campaigns", "campaigns").stdout.split()

    assert tracked == []


# ------------------------------------------------------- nginx <-> backend coupling

def nginx_api_location() -> str:
    """The body of the `location /api/ { ... }` block."""
    text = (ROOT / "nginx.conf").read_text(encoding="utf-8")
    start = text.index("location /api/")
    return text[text.index("{", start) + 1 : text.index("}", start)]


def test_nginx_forwards_the_original_host_so_the_origin_check_can_pass():
    # The backend refuses a browser POST whose Origin host is not the host the request was addressed
    # to. Behind nginx that only works if nginx passes the client's Host (with its port) upstream:
    # by default it sends 127.0.0.1:8000 and EVERY browser POST would be answered 403.
    block = nginx_api_location()

    assert "proxy_set_header Host $http_host;" in block


def test_nginx_sets_rather_than_appends_the_client_address():
    # The sign-in rate limits are per client address. $proxy_add_x_forwarded_for would keep whatever
    # a client put in the header, letting it pick its own address.
    block = nginx_api_location()

    assert "proxy_set_header X-Forwarded-For $remote_addr;" in block
    assert "$proxy_add_x_forwarded_for" not in block


def test_nginx_keeps_buffering_off_for_the_damage_stream():
    assert "proxy_buffering off;" in nginx_api_location()
