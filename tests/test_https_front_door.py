"""Guards for the HTTPS front door: Caddy in docker-compose.yml, its Caddyfile and the .env template.

Owner sign-in only works over HTTPS (the session cookie is Secure), and the Droplet's compose file is copied over
by hand instead of being deployed by CI, so a slip here would only show up as "nobody can sign in" on the live
site. Offline and fast; the tests that run `docker compose config` skip themselves when Compose is not installed.
"""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent


def compose_file() -> dict:
    return yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf-8"))


def caddyfile() -> str:
    return (ROOT / "Caddyfile").read_text(encoding="utf-8")


def compose_is_installed() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


needs_compose = pytest.mark.skipif(not compose_is_installed(), reason="Docker Compose is not installed")


# ------------------------------------------------------------------ docker-compose.yml, as written

def test_caddy_is_an_opt_in_profile_and_the_app_always_runs():
    services = compose_file()["services"]

    assert services["caddy"]["profiles"] == ["https"]
    assert "profiles" not in services["app"]
    assert services["caddy"]["depends_on"] == ["app"]


@pytest.mark.parametrize("service", ["app", "caddy"])
def test_both_services_come_back_after_a_reboot(service):
    # Without a restart policy a Droplet reboot leaves the site down until someone runs `docker compose up -d`.
    assert compose_file()["services"][service]["restart"] == "unless-stopped"


def test_caddy_publishes_the_web_ports_and_nothing_else():
    assert set(compose_file()["services"]["caddy"]["ports"]) == {"80:80", "443:443", "443:443/udp"}


def test_caddy_keeps_its_certificates_across_restarts():
    # Without a persistent /data every restart would order a new certificate and soon hit Let's Encrypt's limits.
    compose = compose_file()
    mounts = [volume.split(":")[:2] for volume in compose["services"]["caddy"]["volumes"]]

    assert ["caddy_data", "/data"] in mounts
    assert "caddy_data" in compose["volumes"]


def test_caddy_reads_the_caddyfile_read_only():
    assert "./Caddyfile:/etc/caddy/Caddyfile:ro" in compose_file()["services"]["caddy"]["volumes"]


def test_the_apps_plain_http_port_can_be_closed_with_one_setting():
    assert compose_file()["services"]["app"]["ports"] == ["${APP_BIND_ADDRESS:-0.0.0.0}:8080:8080"]


# ------------------------------------------------------------------ docker-compose.yml, as Compose reads it

def resolved(tmp_path: Path, **dotenv: str) -> dict:
    """What `docker compose config` makes of docker-compose.yml with these .env values (in a scratch folder)."""
    shutil.copy(ROOT / "docker-compose.yml", tmp_path / "docker-compose.yml")
    shutil.copy(ROOT / "Caddyfile", tmp_path / "Caddyfile")
    lines = ["GOOGLE_API_KEY=not-a-real-key", *(f"{name}={value}" for name, value in dotenv.items())]
    (tmp_path / ".env").write_text("\n".join(lines) + "\n", encoding="utf-8")
    # Nothing from the developer's own shell may leak into what is being checked.
    clean = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "SITE_ADDRESS", "APP_BIND", "IMAGE_"))}
    done = subprocess.run(
        ["docker", "compose", "--project-directory", str(tmp_path), "config", "--format", "json"],
        capture_output=True, text=True, env=clean, timeout=120,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


@needs_compose
def test_without_the_https_settings_only_the_app_runs_and_it_is_published_as_before(tmp_path):
    services = resolved(tmp_path)["services"]

    assert set(services) == {"app"}
    # str()/int(): Compose versions differ in whether they print port numbers as text or as numbers.
    assert [(p.get("host_ip"), str(p["published"]), int(p["target"])) for p in services["app"]["ports"]] == [("0.0.0.0", "8080", 8080)]


@needs_compose
def test_the_https_settings_turn_caddy_on_for_the_host_name_and_close_the_app_port(tmp_path):
    services = resolved(
        tmp_path, COMPOSE_PROFILES="https", SITE_ADDRESS="yourname.duckdns.org", APP_BIND_ADDRESS="127.0.0.1"
    )["services"]

    assert set(services) == {"app", "caddy"}
    assert services["caddy"]["environment"]["SITE_ADDRESS"] == "yourname.duckdns.org"
    assert [(p.get("host_ip"), str(p["published"])) for p in services["app"]["ports"]] == [("127.0.0.1", "8080")]


# ------------------------------------------------------------------ the Caddyfile

def test_the_caddyfile_serves_the_configured_host_name_and_proxies_to_the_app():
    text = caddyfile()

    assert re.search(r"^\{\$SITE_ADDRESS(:[^}]*)?\} \{$", text, re.MULTILINE)
    assert "reverse_proxy app:8080" in text


def test_the_caddyfile_does_not_buffer_the_narration_stream():
    assert "flush_interval -1" in caddyfile()


def test_the_caddyfile_neither_switches_certificates_off_nor_fakes_them():
    # A plain-http-only site, "auto_https off" or an internal (self-signed) CA would all leave the Droplet
    # without a certificate a browser accepts, and owner sign-in could not work.
    forbidden = re.search(r"^\s*(auto_https|local_certs|tls\s+internal|http://)", caddyfile(), re.MULTILINE)

    assert forbidden is None, f"the Caddyfile must keep real HTTPS on: {forbidden and forbidden.group(0)!r}"


# ------------------------------------------------------------------ the .env template

@pytest.mark.parametrize("name", ["COMPOSE_PROFILES", "SITE_ADDRESS", "APP_BIND_ADDRESS"])
def test_the_env_template_documents_every_https_setting(name):
    assert name in (ROOT / ".env.example").read_text(encoding="utf-8")
