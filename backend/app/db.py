"""Connection pool and schema bootstrap."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import get_settings

SQL_DIR = Path(__file__).parent / "sql"

_pool: ConnectionPool | None = None


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            get_settings().database_url,
            min_size=1,
            max_size=10,
            kwargs={"row_factory": dict_row},
            open=True,
        )
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def get_conn() -> Iterator[Connection]:
    """FastAPI dependency. One connection per request, returned to the pool after."""
    with get_pool().connection() as conn:
        yield conn


def apply_schema(conn: Connection) -> None:
    """Run the idempotent schema script. Safe to call on every start."""
    sql = (SQL_DIR / "001_schema.sql").read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()
