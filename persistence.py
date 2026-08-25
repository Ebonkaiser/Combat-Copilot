import sqlite3
from pathlib import Path
from typing import Optional

from schemas import EncounterState


class StateStore:
    """SQLite-backed durability for encounter state and one-time ingestion flags."""

    def __init__(self, db_path: str = "./state_db/combat_state.db"):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False: the store is read/written from the main
        # event loop thread (request handlers) and from the asyncio.to_thread
        # worker that runs startup ingestion (see server.py's lifespan) --
        # SQLite's own serialized-mode locking makes a single shared
        # connection safe across threads; this just disables sqlite3's
        # extra same-thread-only guard.
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS encounters (
                encounter_id TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ingestion_state (
                category TEXT PRIMARY KEY,
                ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        self._conn.commit()

    def save_encounter(self, encounter: EncounterState) -> None:
        self._conn.execute(
            """
            INSERT INTO encounters (encounter_id, state_json, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(encounter_id) DO UPDATE SET
                state_json = excluded.state_json,
                updated_at = excluded.updated_at
            """,
            (encounter.encounter_id, encounter.model_dump_json()),
        )
        self._conn.commit()

    def get_encounter(self, encounter_id: str) -> Optional[EncounterState]:
        row = self._conn.execute(
            "SELECT state_json FROM encounters WHERE encounter_id = ?",
            (encounter_id,),
        ).fetchone()
        if row is None:
            return None
        return EncounterState.model_validate_json(row[0])

    def is_category_ingested(self, category: str) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM ingestion_state WHERE category = ?",
            (category,),
        ).fetchone()
        return row is not None

    def mark_category_ingested(self, category: str) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO ingestion_state (category) VALUES (?)",
            (category,),
        )
        self._conn.commit()
