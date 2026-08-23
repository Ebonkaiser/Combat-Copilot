# AI Combat Copilot & GM Assistant

An interactive, deterministic combat copilot and narrative assistant for tabletop RPGs. The system decouples state management (HP, turns, conditions) from generative LLM text, using **LangGraph** for deterministic workflow state orchestration and **LlamaIndex** for metadata-filtered RAG over campaign lore and rules.

---

## 🏛️ System Architecture

* **Frontend:** Fast-action Combat HUD (**Angular / TypeScript / Tailwind CSS**) with real-time SSE streaming.
* **Orchestration & State Engine (LangGraph):** Manages deterministic HP mutations, turn cycles, condition lifecycles, and narrative chaining without probabilistic math errors.
* **Knowledge & Retrieval Layer (LlamaIndex):** Ingests campaign lore and rules markdown into ChromaDB with structured metadata filtering (`faction`, `rule_type`).
* **Inference Layer:** LCEL streaming pipeline for real-time narrative delivery and GM tactical advisories via Gemini.

---

## 📁 Repository Layout

```text
combat-copilot/
├── schemas.py           # TypedDict definitions (CombatGraphState) & Pydantic contracts
├── state_engine.py      # Module 1: Deterministic state engine & mutation logic
├── knowledge_engine.py  # Module 2: LlamaIndex retrieval engine & ChromaDB integration
├── combat_graph.py      # Module 3: LangGraph node functions, assembly, and compilation
├── server.py            # FastAPI backend & Server-Sent Events (SSE) streaming routes
├── data/
│   ├── rules/           # System Reference Document (SRD) markdown files
│   └── lore/            # Campaign world, clan, and NPC lore markdown files
├── Dockerfile           # Multi-stage container build
├── docker-compose.yml   # Multi-container orchestration (API + DB + UI)
└── README.md