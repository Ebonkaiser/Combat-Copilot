---
category: rule
rule_source: SRD 5.1 (CC-BY-4.0)
title: "Conditions"
tags: [conditions, status-effects, core-rule]
---

# Conditions

Conditions alter a creature's capabilities in various ways. A condition lasts either until it is countered, until the effect causing it ends, or for a duration specified by the effect that imposed it. Multiple instances of the same condition don't have a cumulative effect. Instead, the most severe version applies while any of them are in effect (e.g., multiple sources of Restrained). Effects that give a condition can specify that it ends early or worsens.

- **Blinded** — Can't see; automatically fails checks requiring sight. Attack rolls against the creature have advantage; the creature's own attack rolls have disadvantage.
- **Charmed** — Can't attack the charmer or target it with harmful abilities/spells. The charmer has advantage on any ability check to interact socially with the creature.
- **Deafened** — Can't hear; automatically fails checks requiring hearing.
- **Frightened** — Disadvantage on ability checks and attack rolls while the source of fear is within line of sight. Can't willingly move closer to the source.
- **Grappled** — Speed becomes 0 and can't benefit from any bonus to speed. Ends if the grappler is incapacitated, or if an effect removes the target from the grappler's reach.
- **Incapacitated** — Can't take actions or reactions.
- **Invisible** — Impossible to see without special sense; treated as heavily obscured for hiding purposes. Location can be detected by noise or tracks. Attacks against the creature have disadvantage; its own attacks have advantage.
- **Paralyzed** — Incapacitated, can't move or speak. Automatically fails Strength and Dexterity saving throws. Attack rolls against the creature have advantage. Any hit that connects is a critical hit if the attacker is within 5 feet.
- **Petrified** — Transformed, along with any nonmagical object worn/carried, into a solid inanimate substance. Weight increases ×10 and stops aging. Incapacitated, can't move or speak, unaware of surroundings. Attacks against it have advantage. Automatically fails Strength/Dexterity saves. Resistance to all damage. Immune to poison and disease (existing ones are suspended, not cured).
- **Poisoned** — Disadvantage on attack rolls and ability checks.
- **Prone** — Only movement option is to crawl (costs extra movement) unless it stands up (uses half movement). Disadvantage on attack rolls. An attack roll against the creature has advantage if the attacker is within 5 feet; otherwise the attack has disadvantage.
- **Restrained** — Speed becomes 0. Attack rolls against the creature have advantage; its own attack rolls have disadvantage. Disadvantage on Dexterity saving throws.
- **Stunned** — Incapacitated, can't move, can speak only falteringly. Automatically fails Strength and Dexterity saves. Attack rolls against the creature have advantage.
- **Unconscious** — Incapacitated, can't move or speak, unaware of surroundings. Drops whatever it's holding and falls prone. Automatically fails Strength/Dexterity saves. Attacks against it have advantage. Any hit is a critical hit if the attacker is within 5 feet.

## Exhaustion

Exhaustion is tracked in levels, each worse than the last (accumulates rather than replacing):

| Level | Effect |
|---|---|
| 1 | Disadvantage on ability checks |
| 2 | Speed halved |
| 3 | Disadvantage on attack rolls and saving throws |
| 4 | Hit point maximum halved |
| 5 | Speed reduced to 0 |
| 6 | Death |

Finishing a long rest reduces exhaustion by 1 level, provided the creature has also had food and drink.

## Implementation note for the state engine

`state_engine.py` should treat conditions as an idempotent list on each `Combatant` (already implemented) and apply the mechanical effects above at combat-resolution time — e.g., attack rolls made against a Prone/Restrained/Paralyzed/Unconscious target should be flagged for advantage, and the reverse for the condition-holder's own rolls. Since dice are entered manually in this build, the copilot's role is to **narrate** these effects and flag the tactical advantage/disadvantage in its GM tactical note, not to compute the roll itself.
