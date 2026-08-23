"""
Module 5: Offline Resilience

Wraps LLM-dependent LangGraph nodes (narration generation, lore retrieval) so
that a model timeout, network failure, or malformed response degrades
gracefully instead of taking the combat state engine down with it.

Core invariant (from the project README): "If LLM inference is disabled,
slow, or offline, the state engine and combat tracker remain fully
operational." mutate_state_node in combat_graph.py already satisfies this by
construction -- it's a pure function with no LLM call. This module makes the
same guarantee explicit for generate_narration_node, which does call out to
Gemini.
"""

from __future__ import annotations

import functools
import logging
from typing import Any, Callable

logger = logging.getLogger("combat_copilot.resilience")


def fallback_narration(state: dict[str, Any]) -> str:
    """
    Deterministic, LLM-free narration used when the model call fails. Built
    entirely from fields already present on state["last_event"] and the
    matching combatant in state["combatants"] -- no invented numbers, so it
    trivially satisfies the same fact-checking bar the eval harness enforces
    on the LLM path.
    """
    event = state.get("last_event", {}) or {}
    combatants = state.get("combatants", []) or []
    target_id = event.get("target_id")
    target = next((c for c in combatants if c.get("id") == target_id), None)

    name = (target or {}).get("name") or target_id or "The target"
    dmg = event.get("damage_amount")
    dmg_type = event.get("damage_type", "")
    current_hp = (target or {}).get("current_hp")
    max_hp = (target or {}).get("max_hp")
    conditions = (target or {}).get("conditions") or event.get("applied_conditions") or []

    parts = ["[Narration unavailable -- combat log]"]
    if dmg is not None:
        dmg_line = f"{name} takes {dmg} {dmg_type} damage.".replace("  ", " ").strip()
        parts.append(dmg_line)
    if current_hp is not None and max_hp is not None:
        parts.append(f"HP: {current_hp}/{max_hp}.")
        if current_hp == 0:
            parts.append(f"{name} is down.")
    if conditions:
        parts.append(f"Conditions: {', '.join(conditions)}.")
    return " ".join(parts)


def with_llm_fallback(
    node_fn: Callable[[dict], dict],
    *,
    output_key: str = "streamed_narration",
) -> Callable[[dict], dict]:
    """
    Wraps a LangGraph node function that calls an LLM. On any exception from
    the wrapped call -- network failure, timeout, malformed response, rate
    limit -- logs a warning and returns a state-engine-only fallback
    narration instead of propagating the failure up through the graph. A
    Gemini outage should degrade the copilot's prose, not the player's
    ability to keep tracking the fight.

    Usage in combat_graph.py:

        workflow.add_node(
            "generate_narration",
            with_llm_fallback(lambda state: generate_narration_node(state, llm)),
        )

    The wrapped function receives and must accept the *full* graph state
    (same signature as the unwrapped node), since the fallback needs
    state["last_event"] and state["combatants"] to build its message.
    """
    @functools.wraps(node_fn)
    def wrapped(state: dict[str, Any]) -> dict[str, Any]:
        try:
            return node_fn(state)
        except Exception as exc:  # noqa: BLE001 -- intentionally broad:
            # any LLM/network/parsing failure should degrade, not crash
            # the graph or the player's session.
            logger.warning("LLM narration call failed, using fallback: %s", exc)
            return {output_key: fallback_narration(state)}

    return wrapped
