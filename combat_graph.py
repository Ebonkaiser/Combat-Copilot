from typing import Dict, Any
from langgraph.graph import StateGraph, END
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_google_genai import ChatGoogleGenerativeAI

from schemas import CombatGraphState
from state_engine import CombatStateEngine
from knowledge_engine import CombatKnowledgeBase
from resilience import with_llm_fallback


# --- 1. Graph Nodes ---

def mutate_state_node(state: CombatGraphState) -> Dict[str, Any]:
    """Applies deterministic HP mutations and condition triggers."""
    event = state["last_event"]
    target_id = event["target_id"]
    damage = event["damage_amount"]
    applied_conditions = event.get("applied_conditions", [])

    combatants = [dict(c) for c in state["combatants"]]
    target = next((c for c in combatants if c["id"] == target_id), None)
    
    if not target:
        raise ValueError(f"Target {target_id} not found in state.")

    # Apply deterministic clamping
    previous_hp = target["current_hp"]
    target["current_hp"] = max(0, min(target["max_hp"], target["current_hp"] - damage))

    # Auto-conditions
    if target["current_hp"] == 0 and "Incapacitated" not in target["conditions"]:
        target["conditions"].append("Incapacitated")
    elif target["current_hp"] > 0 and "Incapacitated" in target["conditions"]:
        target["conditions"].remove("Incapacitated")

    for cond in applied_conditions:
        if cond not in target["conditions"]:
            target["conditions"].append(cond)

    return {"combatants": combatants}


def retrieve_lore_node(state: CombatGraphState, kb: CombatKnowledgeBase) -> Dict[str, Any]:
    """Queries LlamaIndex for lore and rules matching the target and attack type."""
    event = state["last_event"]
    target = next((c for c in state["combatants"] if c["id"] == event["target_id"]), {})
    
    faction = target.get("faction")
    
    # 1. Retrieve Lore
    lore_filters = {}
    if faction:
        lore_filters["faction"] = faction
        
    lore_query = f"{target.get('name', '')} vulnerabilities tactics {event.get('damage_type', '')}"
    lore_context = kb.retrieve_context(query=lore_query, metadata_filters=lore_filters, top_k=2)
    
    # 2. Retrieve Rules
    rule_filters = {"category": "rule"}
    conditions = " ".join(event.get("applied_conditions", []))
    rule_query = f"{event.get('damage_type', '')} damage rules conditions {conditions}"
    rule_context = kb.retrieve_context(query=rule_query, metadata_filters=rule_filters, top_k=2)
    
    combined_context = f"--- LORE ---\n{lore_context}\n\n--- RULES ---\n{rule_context}"
    
    return {"retrieved_lore": combined_context}


def generate_narration_node(state: CombatGraphState, llm: ChatGoogleGenerativeAI) -> Dict[str, Any]:
    """Executes the LCEL chain to stream narrative description and tactical brief."""
    prompt = ChatPromptTemplate.from_messages([
        (
            "system",
            "You are an AI Combat Copilot for a tabletop RPG. You receive verified game state changes and reference lore.\n"
            "1. Narrate the blow: 2-3 visceral, fast-paced sentences describing the impact based on damage type and target state.\n"
            "2. If target reaches 0 HP, narrate a decisive defeat.\n"
            "3. Provide a short GM Tactical Note suggesting what the enemy might do next.\n\n"
            "If a combatant has a specific weapon_equipped value (other than 'Unarmed'), reference it "
            "directly in narration rather than describing the attack generically.\n\n"
            "CRITICAL: Never recalculate HP or invent numbers. Rely strictly on the provided delta and lore."
        ),
        (
            "human",
            "Event Delta: {last_event}\n"
            "Target Current State: {combatants}\n"
            "Lore Context: {retrieved_lore}"
        )
    ])
    
    chain = prompt | llm | StrOutputParser()
    result = chain.invoke({
        "last_event": state["last_event"],
        "combatants": state["combatants"],
        "retrieved_lore": state["retrieved_lore"]
    })
    return {"streamed_narration": result}


# --- 2. Graph Assembly & Compilation ---

def create_combat_engine(kb: CombatKnowledgeBase, llm: ChatGoogleGenerativeAI, checkpointer=None):
    """Assembles the DAG and returns the compiled LangGraph runnable."""
    workflow = StateGraph(CombatGraphState)

    # Register nodes
    workflow.add_node("mutate_state", mutate_state_node)
    workflow.add_node("retrieve_lore", lambda state: retrieve_lore_node(state, kb))
    workflow.add_node("generate_narration", with_llm_fallback(lambda state: generate_narration_node(state, llm)))

    # Connect linear pipeline
    workflow.set_entry_point("mutate_state")
    workflow.add_edge("mutate_state", "retrieve_lore")
    workflow.add_edge("retrieve_lore", "generate_narration")
    workflow.add_edge("generate_narration", END)

    return workflow.compile(checkpointer=checkpointer)