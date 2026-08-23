---
category: rule
rule_source: SRD 5.1 (CC-BY-4.0)
title: "Resting"
tags: [short-rest, long-rest, exhaustion, downtime, core-rule]
---

# Resting

## Short Rest

A period of downtime, at least 1 hour long, during which a character does nothing more strenuous than eating, drinking, reading, or tending to wounds. A character can spend one or more Hit Dice at the end of a short rest, up to the character's maximum number of Hit Dice, rolling each die and adding the character's Constitution modifier, regaining that many hit points. The character can choose to spend an additional Hit Die after each roll. Some class features (e.g., Warlock spell slots, Fighter's Second Wind/Action Surge) recharge on a short rest.

## Long Rest

A period of extended downtime, at least 8 hours, during which a character sleeps or performs light activity for no more than 2 hours. If interrupted by at least 1 hour of walking, fighting, casting spells, or similar strenuous activity, the rest fails.

At the end of a long rest, a character regains all lost hit points and spent Hit Dice (up to half of the character's total number of Hit Dice, minimum 1). The character also regains spent spell slots. A character can't benefit from more than one long rest in a 24-hour period, and must have at least 1 hit point at the start of the rest.

Finishing a long rest reduces one level of exhaustion, provided the character has also had food and drink.

## Combat-Copilot Application

Rest mechanics sit outside the combat state machine (they occur between encounters) but should be represented in `EncounterState`/session bookkeeping as a trigger that: restores HP/spell slots per the above, ticks down exhaustion by 1, and clears any encounter-scoped temporary conditions. In this campaign, Adovarius (as handler) has narratively granted the party full rests and level-ups at key story beats (e.g., after the Sanctuary of Starlight) — these should be modeled as scripted "rest events" rather than literal 8-hour game-time simulation.
