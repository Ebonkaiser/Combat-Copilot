# Feature Plan: Weapon-Equipped Field

**Project:** AI Combat Copilot & GM Assistant
**Touches:** Module 1 (schemas, state engine), Module 3 (prompt context, optionally retrieval), Module 4 (HUD), test suite.

## Task

Add a `weapon_equipped` field to each combatant so the LLM narration layer can reference specific weapons instead of generic damage-type language, without violating the core invariant: the LLM narrates, it never decides or mutates state.

## Where it lives: schema

Add to `Combatant` (Module 1, `schemas.py`):

```
weapon_equipped: str = "Unarmed"
```

**Decision: plain string, not a structured object.** A weapon-properties system (reach, damage die, finesse, etc.) is a materially bigger feature — mechanical, not narrative — and isn't what's being asked for. This field exists to ground narration ("Kaelen's rapier finds the gap in his armor"), the same role `tactical_tags` and `faction` already play. If real weapon mechanics are wanted later, that's a separate, larger effort — not bundled here.

**Decision: default `"Unarmed"`, not `None`.** An explicit default is easier to hand to a prompt than a null field, and it's never ambiguous whether the value is "known to be nothing" versus "not yet set."

## How it changes: a new deterministic mutation, not an LLM decision

Equipping a weapon is a state change like applying damage — manual, deterministic, logged. Add one method to `CombatStateEngine` (Module 1):

```
update_equipment(combatant_id: str, weapon_name: str) -> dict
```

Mirrors `apply_damage_event`'s shape: validates the target exists, mutates the field, returns a context payload. This is a new, small, independent mutation — it does not go through the LangGraph narration pipeline, because equipping a weapon between turns doesn't need retrieval or narration on its own (see Open Items if you want that later).

## How it reaches the LLM

**No new wiring required for the basic case.** `generate_narration_node` already receives the full `combatants` list as dicts in its prompt context. Once `weapon_equipped` exists on the schema, it flows through automatically the next time a damage event fires — this is a direct benefit of the existing architecture already generalizing to new combatant fields.

**One small addition needed:** the system prompt (Module 3) doesn't currently tell the model it *can* reference weapons specifically. Add one line, e.g.:

> "If a combatant has a specific weapon_equipped value, reference it directly in narration rather than describing the attack generically."

Without this, the model may just ignore the new field.

## Definition of done

- [ ] `weapon_equipped: str = "Unarmed"` added to `Combatant`.
- [ ] `CombatStateEngine.update_equipment()` implemented and unit tested (mirrors existing `test_apply_damage_within_bounds` pattern).
- [ ] System prompt updated to instruct the model to use `weapon_equipped` when present.
- [ ] HUD (Angular) gets a weapon input per combatant, parallel to the existing damage-entry field — a text field is sufficient for v1, no need for a dropdown/catalog.
- [ ] Manual verification: equip a weapon, apply damage, confirm the narration references it.

## Open items — decide before implementation

1. **Per-event weapon vs. ambient state.** Current plan treats `weapon_equipped` as always-current combatant state — whatever they're holding when a `DamageEvent` fires is what gets narrated. Alternative: attach a `weapon_used` field directly to `DamageEvent` itself, for cases where an attack might not match what's "equipped" (e.g., improvised weapon, off-hand strike). Recommend starting with ambient state — simpler, matches how `damage_type` already carries the necessary "how" information per-event.
2. **RAG query enrichment (optional, not required for v1).** `retrieve_lore_node`'s query currently uses target name + damage type. Could also fold in the attacker's weapon name, in case the knowledge base has lore tied to a specific named weapon. Low cost to add, but not necessary unless your campaign lore actually has weapon-specific entries worth surfacing.
3. **Should equipping itself trigger narration** (e.g., "Kaelen draws her rapier")? Recommend **no** for v1 — keep this a silent state change, same as how HP edits don't narrate until the *next* damage event. Can revisit as a stretch feature.

## Out of scope

- Weapon mechanical properties (damage dice, reach, finesse, etc.).
- Any validation tying `damage_type` to a specific weapon's expected type.
- A weapon catalog/dropdown in the UI — free-text entry only for v1.
