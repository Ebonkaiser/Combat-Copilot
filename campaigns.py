"""Campaign registry: private campaign content (lore + starter roster) loaded from disk.

Layout, one folder per campaign under CAMPAIGNS_DIR (default ./data/campaigns):

    <slug>/campaign.yaml    id (must equal the folder name), name, description
    <slug>/roster.yaml      combatants: [...]  (validated against schemas.Combatant)
    <slug>/lore/**/*.md     markdown lore, synced into the knowledge base

This content is private: it is git-ignored and docker-ignored, and on the droplet
it is bind-mounted read-only. A bad campaign folder is logged and skipped -- it
never stops the other campaigns, or the server, from loading.
"""
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator

from schemas import Combatant

logger = logging.getLogger("combat_copilot.campaigns")

# Namespace of the public SRD rules in the knowledge base. A campaign may never
# use it: its lore would then be served to everyone as if it were a rule.
RULES_CAMPAIGN_ID = "srd"

CAMPAIGN_ID_PATTERN = re.compile(r"[a-z0-9-]+")
DEFAULT_CAMPAIGNS_DIR = "./data/campaigns"


def is_valid_campaign_id(value: object) -> bool:
    """True for a usable campaign slug: [a-z0-9-]+ and not the reserved rules namespace."""
    return (
        isinstance(value, str)
        and CAMPAIGN_ID_PATTERN.fullmatch(value) is not None
        and value != RULES_CAMPAIGN_ID
    )


def campaigns_dir_from_env() -> str:
    return os.environ.get("CAMPAIGNS_DIR") or DEFAULT_CAMPAIGNS_DIR


class CampaignError(Exception):
    """A campaign folder that cannot be used (the message says why)."""


class CampaignManifest(BaseModel):
    """campaign.yaml"""

    id: str
    name: str = Field(min_length=1)
    description: str = ""

    @field_validator("id")
    @classmethod
    def _id_must_be_a_slug(cls, value: str) -> str:
        if not is_valid_campaign_id(value):
            raise ValueError(f"must match [a-z0-9-]+ and not be '{RULES_CAMPAIGN_ID}'")
        return value

    @field_validator("name")
    @classmethod
    def _name_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value.strip()


class RosterFile(BaseModel):
    """roster.yaml"""

    combatants: List[Combatant] = Field(default_factory=list)


@dataclass(frozen=True)
class Campaign:
    id: str
    name: str
    description: str
    path: Path
    # Registry-owned starter roster: copy before use, never mutate in place.
    roster: List[Combatant] = field(default_factory=list)

    @property
    def lore_dir(self) -> Path:
        return self.path / "lore"


def _summarize(error: ValidationError) -> str:
    """One line per problem, without echoing the offending values back into logs."""
    parts = []
    for item in error.errors(include_url=False, include_context=False, include_input=False):
        location = ".".join(str(part) for part in item["loc"]) or "(root)"
        parts.append(f"{location}: {item['msg']}")
    return "; ".join(parts)


def _read_yaml(path: Path) -> Any:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8-sig"))
    except yaml.YAMLError as exc:
        raise CampaignError(f"{path.name} is not valid YAML ({exc.__class__.__name__})") from exc
    except (OSError, UnicodeDecodeError) as exc:
        raise CampaignError(f"{path.name} could not be read ({exc.__class__.__name__})") from exc


def _load_campaign(folder: Path) -> Campaign:
    if not is_valid_campaign_id(folder.name):
        raise CampaignError(f"folder name must match [a-z0-9-]+ and not be '{RULES_CAMPAIGN_ID}'")

    manifest_path = folder / "campaign.yaml"
    if not manifest_path.is_file():
        raise CampaignError("campaign.yaml not found")
    raw_manifest = _read_yaml(manifest_path)
    if not isinstance(raw_manifest, dict):
        raise CampaignError("campaign.yaml must be a mapping with id, name and description")
    try:
        manifest = CampaignManifest.model_validate(raw_manifest)
    except ValidationError as exc:
        raise CampaignError(f"campaign.yaml is invalid: {_summarize(exc)}") from exc
    if manifest.id != folder.name:
        raise CampaignError(f"campaign.yaml id {manifest.id!r} does not match the folder name {folder.name!r}")

    roster: List[Combatant] = []
    roster_path = folder / "roster.yaml"
    if roster_path.is_file():
        raw_roster = _read_yaml(roster_path)
        if raw_roster is None:
            raw_roster = {}
        if not isinstance(raw_roster, dict):
            raise CampaignError("roster.yaml must be a mapping with a 'combatants' list")
        try:
            roster = RosterFile.model_validate(raw_roster).combatants
        except ValidationError as exc:
            raise CampaignError(f"roster.yaml is invalid: {_summarize(exc)}") from exc
        ids = [combatant.id for combatant in roster]
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        if duplicates:
            raise CampaignError(f"roster.yaml has duplicate combatant ids: {', '.join(duplicates)}")
    else:
        logger.warning("Campaign %r has no roster.yaml; its starter roster is empty.", folder.name)

    return Campaign(
        id=manifest.id,
        name=manifest.name,
        description=manifest.description,
        path=folder,
        roster=roster,
    )


def load_campaigns(campaigns_dir: Optional[Union[str, Path]] = None) -> Dict[str, Campaign]:
    """Loads every valid campaign under campaigns_dir (default: CAMPAIGNS_DIR / ./data/campaigns).

    A missing directory is not an error (the app then serves the SRD rules only).
    A bad campaign is logged and skipped; the rest still load.
    """
    root = Path(campaigns_dir if campaigns_dir is not None else campaigns_dir_from_env())
    if not root.is_dir():
        logger.info("No campaigns directory at %s; serving the public SRD rules only.", root)
        return {}

    try:
        folders = sorted(path for path in root.iterdir() if path.is_dir())
    except OSError:
        logger.exception("Could not list campaigns directory %s", root)
        return {}

    campaigns: Dict[str, Campaign] = {}
    for folder in folders:
        if folder.name.startswith((".", "_")):
            continue  # VCS metadata, caches, scratch folders
        try:
            campaign = _load_campaign(folder)
        except CampaignError as exc:
            logger.error("Skipping campaign folder %r: %s", folder.name, exc)
            continue
        except Exception:
            logger.exception("Skipping campaign folder %r after an unexpected error", folder.name)
            continue
        campaigns[campaign.id] = campaign
        logger.info("Loaded campaign %r (%d starter combatants).", campaign.id, len(campaign.roster))
    return campaigns
