"""Health, filter vocabularies and ingest history."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from psycopg import Connection

from ..db import get_conn

router = APIRouter(prefix="/api", tags=["meta"])

Conn = Annotated[Connection, Depends(get_conn)]

# Column -> response key. Only these columns can be enumerated.
VOCABULARIES = {
    "school_year": "school_year",
    "term": "term",
    "college": "college",
    "course": "course",
    "program_group": "program_group",
    "status": "status",
    "year_level": "year_level",
    "sex": "sex",
    "region": "region",
    "nationality": "nationality",
}


@router.get("/health")
def health(conn: Conn) -> dict[str, object]:
    with conn.cursor() as cur:
        cur.execute("SELECT postgis_version() AS postgis")
        postgis = cur.fetchone()["postgis"]
        cur.execute("SELECT COUNT(*) AS n FROM enrollment")
        rows = cur.fetchone()["n"]
        cur.execute("SELECT COUNT(*) AS n FROM boundary")
        boundaries = cur.fetchone()["n"]
    return {"status": "ok", "postgis": postgis, "enrollment_rows": rows, "boundaries": boundaries}


@router.get("/filters")
def filters(conn: Conn) -> dict[str, list]:
    """Distinct values for every filterable column, for the dashboard's controls."""
    out: dict[str, list] = {}
    with conn.cursor() as cur:
        for column, key in VOCABULARIES.items():
            cur.execute(
                f"SELECT DISTINCT {column} AS v FROM enrollment "
                f"WHERE {column} IS NOT NULL ORDER BY 1"
            )
            out[key] = [r["v"] for r in cur.fetchall()]
        # Courses grouped under their college, so the course list can narrow when a
        # college is picked without a second round trip.
        cur.execute(
            "SELECT college, course, COUNT(*) AS n FROM enrollment "
            "WHERE college IS NOT NULL AND course IS NOT NULL "
            "GROUP BY 1, 2 ORDER BY 1, 2"
        )
        out["courses_by_college"] = [
            {"college": r["college"], "course": r["course"], "records": r["n"]}
            for r in cur.fetchall()
        ]
    return out


@router.get("/batches")
def batches(conn: Conn) -> list[dict]:
    """Ingest history — what was loaded, when, and how much of it was refused."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, filename, loaded_at, rows_read, rows_loaded, rows_rejected, note "
            "FROM ingest_batch ORDER BY loaded_at DESC LIMIT 100"
        )
        return cur.fetchall()
