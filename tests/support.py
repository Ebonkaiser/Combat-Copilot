"""Shared helpers for the offline (no API key, no network) tests."""
import gc
import shutil
from pathlib import Path

from chromadb.api.shared_system_client import SharedSystemClient

from fake_ai import HashingEmbedding  # noqa: F401  (re-exported for the tests)

REPO_ROOT = Path(__file__).resolve().parent.parent
RULES_DIR = REPO_ROOT / "data" / "rules"
FIXTURE_CAMPAIGNS_DIR = Path(__file__).resolve().parent / "fixtures" / "campaigns"
FIXTURE_CAMPAIGN_ID = "test-campaign"
FIXTURE_CAMPAIGN_DIR = FIXTURE_CAMPAIGNS_DIR / FIXTURE_CAMPAIGN_ID
FIXTURE_LORE_DIR = FIXTURE_CAMPAIGN_DIR / "lore"

# Unique strings planted in the fixture campaign's lore. If one of these ever
# shows up in text served to an anonymous user, campaign lore has leaked.
SENTINEL = "SENTINEL_LORE_7Q2"            # Iron Silk Bureau faction doc
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
    "ENV", "OWNER_EMAILS", "SESSION_SECRET", "ALLOWED_ORIGINS",
    "EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM", "CAMPAIGNS_DIR", "FAKE_AI",
)
