from enum import Enum
from typing import Dict, List, Optional, TypedDict, Any
from pydantic import BaseModel, Field


class EntityType(str, Enum):
    PLAYER = "player"
    ENEMY = "enemy"
    NPC = "npc"


class DamageType(str, Enum):
    SLASHING = "Slashing"
    PIERCING = "Piercing"
    BLUDGEONING = "Bludgeoning"
    FIRE = "Fire"
    COLD = "Cold"
    LIGHTNING = "Lightning"
    ACID = "Acid"
    POISON = "Poison"
    PSYCHIC = "Psychic"
    RADIANT = "Radiant"
    NECROTIC = "Necrotic"
    FORCE = "Force"


class Combatant(BaseModel):
    id: str
    name: str
    type: EntityType
    armor_class: int
    max_hp: int
    current_hp: int
    conditions: List[str] = Field(default_factory=list)
    tactical_tags: List[str] = Field(default_factory=list)
    resources: Dict[str, int] = Field(default_factory=dict)
    faction: Optional[str] = None
    initiative: int = 0
    weapon_equipped: str = "Unarmed"


class ConditionAction(str, Enum):
    ADD = "add"
    REMOVE = "remove"


class DamageEntry(BaseModel):
    amount: int
    damage_type: DamageType


class DamageEvent(BaseModel):
    attacker_id: Optional[str] = None
    target_id: str
    damage_entries: List[DamageEntry] = Field(default_factory=list)
    healing_amount: int = 0
    condition_name: Optional[str] = None
    condition_action: Optional[ConditionAction] = None


class EquipWeaponRequest(BaseModel):
    weapon_name: str


class EncounterState(BaseModel):
    encounter_id: str
    round: int = 1
    active_turn_index: int = 0
    combatants: List[Combatant] = Field(default_factory=list)
    gm_notes: str = ""


# LangGraph State Schema
class CombatGraphState(TypedDict):
    encounter_id: str
    round: int
    active_turn_index: int
    combatants: List[Dict[str, Any]]
    last_event: Dict[str, Any]
    gm_notes: str
    retrieved_lore: str
    streamed_narration: str