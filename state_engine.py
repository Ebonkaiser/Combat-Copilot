from typing import Dict, Any
from schemas import EncounterState, DamageEvent, Combatant, ConditionAction


class CombatStateEngine:
    @staticmethod
    def apply_damage_event(state: EncounterState, event: DamageEvent) -> Dict[str, Any]:
        """
        Applies manual damage deterministically, clamps boundaries,
        and triggers automatic condition lifecycles.
        """
        target: Combatant = next((c for c in state.combatants if c.id == event.target_id), None)
        if not target:
            raise ValueError(f"Target with ID '{event.target_id}' not found in encounter.")

        previous_hp = target.current_hp
        total_damage = sum(entry.amount for entry in event.damage_entries)
        net_change = total_damage - event.healing_amount

        # 1. Boundary Clamping: 0 <= HP <= MaxHP
        target.current_hp = max(0, min(target.max_hp, target.current_hp - net_change))

        # 2. State Transition: Incapacitated when hitting 0 HP
        if target.current_hp == 0 and "Incapacitated" not in target.conditions:
            target.conditions.append("Incapacitated")
        elif target.current_hp > 0 and "Incapacitated" in target.conditions:
            target.conditions.remove("Incapacitated")

        # 3. Manual condition add/remove (idempotent either way)
        if event.condition_name:
            if event.condition_action == ConditionAction.REMOVE:
                if event.condition_name in target.conditions:
                    target.conditions.remove(event.condition_name)
            else:
                if event.condition_name not in target.conditions:
                    target.conditions.append(event.condition_name)

        # 4. Context Payload returned for downstream nodes / logging
        return {
            "target_id": target.id,
            "target_name": target.name,
            "damage_taken": total_damage,
            "damage_entries": [
                {"amount": entry.amount, "damage_type": entry.damage_type.value}
                for entry in event.damage_entries
            ],
            "healing_received": event.healing_amount,
            "previous_hp": previous_hp,
            "current_hp": target.current_hp,
            "is_down": target.current_hp == 0,
            "conditions": target.conditions,
            "tactical_tags": target.tactical_tags,
            "faction": target.faction,
        }

    @staticmethod
    def update_equipment(state: EncounterState, combatant_id: str, weapon_name: str) -> Dict[str, Any]:
        """
        Deterministically sets a combatant's equipped weapon. A silent state
        change (like an HP edit) -- it does not itself trigger narration.
        """
        combatant: Combatant = next((c for c in state.combatants if c.id == combatant_id), None)
        if not combatant:
            raise ValueError(f"Combatant with ID '{combatant_id}' not found in encounter.")

        combatant.weapon_equipped = weapon_name

        return {
            "combatant_id": combatant.id,
            "combatant_name": combatant.name,
            "weapon_equipped": combatant.weapon_equipped,
        }

    @staticmethod
    def advance_turn(state: EncounterState) -> None:
        """
        Advances the initiative pointer and increments the round counter when reaching the end.
        """
        if not state.combatants:
            return

        state.active_turn_index += 1
        if state.active_turn_index >= len(state.combatants):
            state.active_turn_index = 0
            state.round += 1