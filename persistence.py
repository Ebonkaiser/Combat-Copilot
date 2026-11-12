import os
import sqlite3
from pathlib import Path
from typing import Optional

from schemas import EncounterState

# Millisecond-resolution UTC timestamps sort correctly as text and keep the LRU
# order exact for encounters touched within the same second.
_NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')"

DEFAULT_DB_PATH = "./state_db/combat_state.db"

# Anonymous encounters live in a public, unauthenticated store, so they are
# bounded: dropped after this long without a write, and capped in number.
ANONYMOUS_IDLE_HOURS = 2
ANONYMOUS_CAP = 200


class StateStore:
    """SQLite-backed durability for encounter state."""

    def __init__(self, db_path: Optional[str] = None):
        # STATE_DB_PATH lets a test or e2e run keep its encounters out of the real database.
        db_path = db_path or os.environ.get("STATE_DB_PATH") or DEFAULT_DB_PATH
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
        # Databases created before owner mode have no owner_scoped column.
        # Existing rows become anonymous (0), which is what they were.
        columns = {row[1] for row in self._conn.execute("PRAGMA table_info(encounters)")}
        if "owner_scoped" not in columns:
            self._conn.execute("ALTER TABLE encounters ADD COLUMN owner_scoped INTEGER NOT NULL DEFAULT 0")
        # An `ingestion_state` table from earlier versions may still exist in
        # an older database. It is no longer created, read or dropped: the
        # knowledge base now syncs from disk by content hash instead of
        # keeping once-per-category flags, and leaving the old table alone
        # keeps a rollback to the previous image working.
        self._conn.commit()

    def save_encounter(self, encounter: EncounterState) -> None:
        self._conn.execute(
            f"""
            INSERT INTO encounters (encounter_id, state_json, owner_scoped, updated_at)
            VALUES (?, ?, ?, {_NOW})
            ON CONFLICT(encounter_id) DO UPDATE SET
                state_json = excluded.state_json,
                owner_scoped = excluded.owner_scoped,
                updated_at = excluded.updated_at
            """,
            (encounter.encounter_id, encounter.model_dump_json(), 1 if encounter.owner_scoped else 0),
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

    def evict_anonymous(self, idle_hours: float = ANONYMOUS_IDLE_HOURS, cap: int = ANONYMOUS_CAP) -> int:
        """Bounds the anonymous (not owner-scoped) encounters: removes those idle for more than
        ``idle_hours``, then the least recently updated beyond ``cap``. Owner-scoped encounters are
        never touched. Returns how many rows were removed."""
        removed = self._conn.execute(
            "DELETE FROM encounters WHERE owner_scoped = 0 AND updated_at < strftime('%Y-%m-%d %H:%M:%f', 'now', ?)",
            (f"-{idle_hours} hours",),
        ).rowcount
        removed += self._conn.execute(
            """
            DELETE FROM encounters
            WHERE owner_scoped = 0 AND encounter_id NOT IN (
                SELECT encounter_id FROM encounters
                WHERE owner_scoped = 0
                ORDER BY updated_at DESC, rowid DESC
                LIMIT ?
            )
            """,
            (cap,),
        ).rowcount
        self._conn.commit()
        return removed

    def count_anonymous(self) -> int:
        return self._conn.execute("SELECT COUNT(*) FROM encounters WHERE owner_scoped = 0").fetchone()[0]
