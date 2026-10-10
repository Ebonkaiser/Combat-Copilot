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
        damage_entries=[{"amount": 8, "damage_type": DamageType.SLASHING}],
    )
    result = CombatStateEngine.apply_damage_event(base_encounter, event)

    assert result["current_hp"] == 12
    assert result["is_down"] is False
    assert base_encounter.combatants[1].current_hp == 12


def test_apply_damage_sums_multiple_damage_types(base_encounter):
    event = DamageEvent(
        target_id="c2",
        damage_entries=[
            {"amount": 6, "damage_type": DamageType.PIERCING},
            {"amount": 5, "damage_type": DamageType.COLD},
        ],
    )
    result = CombatStateEngine.apply_damage_event(base_encounter, event)

    assert result["damage_taken"] == 11
    assert result["current_hp"] == 9
    assert base_encounter.combatants[1].current_hp == 9


def test_damage_clamping_to_zero_and_incapacitation(base_encounter):
    event = DamageEvent(
        target_id="c2",
        damage_entries=[{"amount": 50, "damage_type": DamageType.FIRE}],  # Overkill
    )
    result = CombatStateEngine.apply_damage_event(base_encounter, event)

    assert result["current_hp"] == 0
    assert result["is_down"] is True
    assert "Incapacitated" in base_encounter.combatants[1].conditions


def test_apply_condition_add(base_encounter):
    event = DamageEvent(
        target_id="c2",
        condition_name="Stunned",
        condition_action="add",
    )
    result = CombatStateEngine.apply_damage_event(base_encounter, event)

    assert "Stunned" in result["conditions"]
    assert "Stunned" in base_encounter.combatants[1].conditions


def test_apply_condition_remove(base_encounter):
    base_encounter.combatants[1].conditions.append("Stunned")

    event = DamageEvent(
        target_id="c2",
        condition_name="Stunned",
        condition_action="remove",
    )
    result = CombatStateEngine.apply_damage_event(base_encounter, event)

    assert "Stunned" not in result["conditions"]
    assert "Stunned" not in base_encounter.combatants[1].conditions


def test_update_equipment_sets_weapon(base_encounter):
    result = CombatStateEngine.update_equipment(base_encounter, "c1", "Rapier")

    assert result["combatant_id"] == "c1"
    assert result["weapon_equipped"] == "Rapier"
    assert base_encounter.combatants[0].weapon_equipped == "Rapier"


def test_update_equipment_unknown_combatant_raises(base_encounter):
    with pytest.raises(ValueError):
        CombatStateEngine.update_equipment(base_encounter, "does_not_exist", "Rapier")


def test_advance_turn_cycle(base_encounter):
    assert base_encounter.round == 1
    assert base_encounter.active_turn_index == 0

    CombatStateEngine.advance_turn(base_encounter)
    assert base_encounter.round == 1
    assert base_encounter.active_turn_index == 1

    CombatStateEngine.advance_turn(base_encounter)
    assert base_encounter.round == 2
    assert base_encounter.active_turn_index == 0