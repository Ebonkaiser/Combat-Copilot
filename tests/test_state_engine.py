import pytest
from schemas import EncounterState, Combatant, DamageEvent, EntityType, DamageType
from state_engine import CombatStateEngine


@pytest.fixture
def base_encounter():
    return EncounterState(
        encounter_id="enc_01",
        round=1,
        active_turn_index=0,
        combatants=[
            Combatant(
                id="c1",
                name="Player Hero",
                type=EntityType.PLAYER,
                armor_class=16,
                max_hp=40,
                current_hp=40,
            ),
            Combatant(
                id="c2",
                name="Iron Silk Guard",
                type=EntityType.ENEMY,
                armor_class=13,
                max_hp=20,
                current_hp=20,
                tactical_tags=["Aggressive"],
                faction="Iron Silk",
            ),
        ],
    )


def test_apply_damage_within_bounds(base_encounter):
    event = DamageEvent(
        target_id="c2",
        damage_amount=8,
        damage_type=DamageType.SLASHING,
    )
    result = CombatStateEngine.apply_damage_event(base_encounter, event)

    assert result["current_hp"] == 12
    assert result["is_down"] is False
    assert base_encounter.combatants[1].current_hp == 12


def test_damage_clamping_to_zero_and_incapacitation(base_encounter):
    event = DamageEvent(
        target_id="c2",
        damage_amount=50,  # Overkill
        damage_type=DamageType.FIRE,
    )
    result = CombatStateEngine.apply_damage_event(base_encounter, event)

    assert result["current_hp"] == 0
    assert result["is_down"] is True
    assert "Incapacitated" in base_encounter.combatants[1].conditions


def test_advance_turn_cycle(base_encounter):
    assert base_encounter.round == 1
    assert base_encounter.active_turn_index == 0

    CombatStateEngine.advance_turn(base_encounter)
    assert base_encounter.round == 1
    assert base_encounter.active_turn_index == 1

    CombatStateEngine.advance_turn(base_encounter)
    assert base_encounter.round == 2
    assert base_encounter.active_turn_index == 0