from typing import Dict, Any
from schemas import EncounterState, DamageEvent, Combatant


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
        
        # 1. Boundary Clamping: 0 <= HP <= MaxHP
        target.current_hp = max(0, min(target.max_hp, target.current_hp - event.damage_amount))

        # 2. State Transition: Incapacitated when hitting 0 HP
        if target.current_hp == 0 and "Incapacitated" not in target.conditions:
            target.conditions.append("Incapacitated")
        elif target.current_hp > 0 and "Incapacitated" in target.conditions:
            target.conditions.remove("Incapacitated")

        # 3. Idempotent Condition Application
        for cond in event.applied_conditions:
            if cond not in target.conditions:
                target.conditions.append(cond)

        # 4. Context Payload returned for downstream nodes / logging
        return {
            "target_id": target.id,
            "target_name": target.name,
            "damage_taken": event.damage_amount,
            "damage_type": event.damage_type.value,
            "previous_hp": previous_hp,
            "current_hp": target.current_hp,
            "is_down": target.current_hp == 0,
            "conditions": target.conditions,
            "tactical_tags": target.tactical_tags,
            "faction": target.faction,
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