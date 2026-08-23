---
category: rule
rule_source: SRD 5.1 (CC-BY-4.0)
title: "Ability Checks, Saving Throws, and Advantage/Disadvantage"
tags: [ability-checks, saving-throws, advantage, skills, core-rule]
---

# Ability Checks, Saving Throws, and Advantage/Disadvantage

## The Core Mechanic

Roll a d20, add the relevant ability modifier (and proficiency bonus if proficient), and compare the total to a target number (DC for checks/saves, or the target's AC for attack rolls).

## Advantage and Disadvantage

Some situations grant **advantage** (roll two d20s, take the higher) or **disadvantage** (roll two d20s, take the lower) on a roll. If multiple situations grant advantage or multiple grant disadvantage, still only roll the two dice once. If circumstances grant both advantage and disadvantage, they cancel and a single d20 is rolled — regardless of how many sources of each apply.

## Ability Checks

Used to test a character's raw talent/training against a difficulty. Typical DCs:

| Difficulty | DC |
|---|---|
| Very easy | 5 |
| Easy | 10 |
| Medium | 15 |
| Hard | 20 |
| Very hard | 25 |
| Nearly impossible | 30 |

**Contested checks** occur when one creature's efforts are directly opposed by another's (e.g., grappling, hiding vs. searching) — higher roll wins; ties mean the situation stays the same.

**Skills** commonly paired with each ability:
- Strength: Athletics
- Dexterity: Acrobatics, Sleight of Hand, Stealth
- Intelligence: Arcana, History, Investigation, Nature, Religion
- Wisdom: Animal Handling, Insight, Medicine, Perception, Survival
- Charisma: Deception, Intimidation, Performance, Persuasion

A character proficient in a skill adds their proficiency bonus; **Expertise** doubles that bonus for specific skills.

## Saving Throws

A saving throw represents an attempt to resist a spell, trap, poison, disease, or similar threat. Roll d20 + the relevant ability modifier, plus proficiency bonus if proficient in that save. Classes typically grant proficiency in two saving throws (e.g., Paladins: Wisdom & Charisma; Fighters: Strength & Constitution; Monks: Strength & Dexterity; Rogues: Dexterity & Intelligence).

## Combat-Copilot Application

Since this build has the LLM narrate outcomes from **manually entered** results rather than rolling dice itself, the copilot should never invent a roll or DC — it treats all incoming numbers (damage, pass/fail on a check) as ground truth per the system prompt's core rule ("Never recalculate HP or invent rolls").
