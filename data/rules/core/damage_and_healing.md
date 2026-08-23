---
category: rule
rule_source: SRD 5.1 (CC-BY-4.0)
title: "Damage, Healing, and Death"
tags: [damage, healing, death-saves, hit-points, core-rule]
---

# Damage, Healing, and Death

## Damage Types

Acid, Bludgeoning, Cold, Fire, Force, Lightning, Necrotic, Piercing, Poison, Psychic, Radiant, Slashing, Thunder.

## Resistance, Vulnerability, Immunity

- **Resistance:** damage of that type is halved.
- **Vulnerability:** damage of that type is doubled.
- **Immunity:** the creature doesn't take that damage type at all.
Resistance and vulnerability are each applied only once regardless of how many sources grant them. Apply resistance/vulnerability after all other modifiers to damage.

## Hit Points and Damage

When a creature takes damage, subtract it from current hit points. Hit point loss has no effect on capabilities until it drops to 0. Damage that reduces a creature to 0 hit points and doesn't kill it outright (see Instant Death) knocks it Unconscious.

**Instant Death:** If damage reduces you to 0 HP and there is damage remaining, you die if the remaining damage equals or exceeds your hit point maximum.

## Temporary Hit Points

A buffer of hit points that protect against damage first; lost before real hit points and can't be restored by healing. Don't stack — a creature with temporary HP that receives more temp HP decides whether to keep the current amount or switch. They aren't reduced by resistance/vulnerability the way normal HP is.

## Healing

Unless it results in death, damage isn't permanent. Magical healing restores hit points. A creature can never regain hit points in excess of its hit point maximum.

## Dropping to 0 Hit Points

- If damage reduces you to 0 and doesn't kill you outright, you fall Unconscious.
- **Death Saving Throws:** at the start of each turn at 0 HP, roll a d20 (no modifiers).
  - 10 or higher: success.
  - Below 10: failure.
  - **3 successes:** stabilize (unconscious, but no longer dying).
  - **3 failures:** die.
  - Rolling a **natural 20**: regain 1 hit point and become conscious.
  - Rolling a **natural 1**: counts as two failures.
  - Taking damage while at 0 HP causes one automatic death-save failure (two if the damage is a critical hit); if the damage equals/exceeds your hit point maximum, you die outright (massive damage).
- A **stable** creature doesn't make death saves but remains unconscious until it regains at least 1 HP or is stabilized and then tended.
- The **Spare the Dying** effect / a successful DC 10 Wisdom (Medicine) check on a dying creature stabilizes it without restoring hit points.

## Combat-Copilot Application

The state engine (`state_engine.py`) already clamps HP to `0 <= current_hp <= max_hp` and auto-applies "Incapacitated" at 0 HP. For a fuller implementation matching these rules, consider adding a `dying` sub-state distinct from `dead`/`stable`, since 0 HP does not necessarily mean defeated for a PC — only monsters and NPCs typically die outright at 0 HP in this campaign's manual-damage model unless the GM narrates otherwise.
