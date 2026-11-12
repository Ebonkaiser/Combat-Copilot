import sqlite3
from pathlib import Path
from typing import Optional

from schemas import EncounterState


class StateStore:
    """SQLite-backed durability for encounter state."""

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
        # An `ingestion_state` table from earlier versions may still exist in
        # an older database. It is no longer created, read or dropped: the
        # knowledge base now syncs from disk by content hash instead of
        # keeping once-per-category flags, and leaving the old table alone
        # keeps a rollback to the previous image working.
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
