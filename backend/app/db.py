"""Schema bootstrap for the loader and the tests.

The schema lives in supabase/migrations/ — one copy, applied by `supabase db push` in
production and by this function everywhere else. Every migration is idempotent, so
applying them on each load is safe.
"""

from __future__ import annotations

from pathlib import Path

from psycopg import Connection

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "supabase" / "migrations"


def migration_files() -> list[Path]:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        raise FileNotFoundError(f"no migrations found in {MIGRATIONS_DIR}")
    return files


def apply_schema(conn: Connection) -> None:
    """Run every migration in order. Safe to call on every load."""
    with conn.cursor() as cur:
        for path in migration_files():
            cur.execute(path.read_text(encoding="utf-8"))
    conn.commit()
