"""Aggregates behind the dashboard's number tiles and charts."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from psycopg import Connection

from ..db import get_conn
from ..filters import Filters

router = APIRouter(prefix="/api", tags=["summary"])

Conn = Annotated[Connection, Depends(get_conn)]

# Breakdown name -> column. Whitelisted; the request never names a column directly.
BREAKDOWNS = {
    "college": "college",
    "course": "course",
    "status": "status",
    "sex": "sex",
    "year_level": "year_level",
    "program_group": "program_group",
    "school_year": "school_year",
    "term": "term",
    "nationality": "nationality",
    "region": "region",
    "province": "province",
}


@router.get("/summary")
def summary(conn: Conn, filters: Filters) -> dict[str, object]:
    """Headline figures plus the standard breakdowns, under the current filters."""
    where, params = filters.where("e")
    measure = filters.measure("e")

    with conn.cursor() as cur:
        cur.execute(
            f"SELECT COUNT(DISTINCT e.student_ref) AS headcount, "
            f"       COUNT(e.id) AS records, "
            f"       COUNT(DISTINCT e.course) AS programs, "
            f"       COUNT(DISTINCT e.municipality_id) AS municipalities, "
            f"       COUNT(DISTINCT e.province_id) AS provinces, "
            f"       COUNT(DISTINCT e.country_id) AS countries "
            f"FROM enrollment e{where}",
            params,
        )
        totals = cur.fetchone()

        cur.execute(
            f"SELECT e.school_year AS year, "
            f"       COUNT(DISTINCT e.student_ref) AS headcount, COUNT(e.id) AS records "
            f"FROM enrollment e{where} GROUP BY 1 ORDER BY 1",
            params,
        )
        trend = cur.fetchall()

        breakdowns: dict[str, list] = {}
        for name in ("college", "status", "sex", "year_level", "program_group"):
            column = BREAKDOWNS[name]
            cur.execute(
                f"SELECT e.{column} AS key, {measure} AS value FROM enrollment e{where} "
                f"GROUP BY 1 HAVING e.{column} IS NOT NULL ORDER BY 2 DESC",
                params,
            )
            breakdowns[name] = cur.fetchall()

        cur.execute(
            f"SELECT e.course AS key, {measure} AS value FROM enrollment e{where} "
            f"GROUP BY 1 HAVING e.course IS NOT NULL ORDER BY 2 DESC LIMIT 15",
            params,
        )
        breakdowns["top_courses"] = cur.fetchall()

        cur.execute(
            f"SELECT e.province AS key, {measure} AS value FROM enrollment e{where} "
            f"GROUP BY 1 HAVING e.province IS NOT NULL ORDER BY 2 DESC LIMIT 15",
            params,
        )
        breakdowns["top_provinces"] = cur.fetchall()

    return {"metric": filters.metric, "totals": totals, "trend": trend, "breakdowns": breakdowns}


@router.get("/breakdown/{dimension}")
def breakdown(
    conn: Conn,
    filters: Filters,
    dimension: str,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
) -> list[dict]:
    """One breakdown, for drill-downs the summary endpoint does not pre-compute."""
    column = BREAKDOWNS.get(dimension)
    if column is None:
        from fastapi import HTTPException

        raise HTTPException(404, f"unknown dimension {dimension!r}")
    where, params = filters.where("e")
    params["limit"] = limit
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT e.{column} AS key, "
            f"       COUNT(DISTINCT e.student_ref) AS headcount, COUNT(e.id) AS records "
            f"FROM enrollment e{where} GROUP BY 1 HAVING e.{column} IS NOT NULL "
            f"ORDER BY 2 DESC LIMIT %(limit)s",
            params,
        )
        return cur.fetchall()


@router.get("/feeder-schools")
def feeder_schools(
    conn: Conn, filters: Filters, limit: Annotated[int, Query(ge=1, le=200)] = 25
) -> list[dict]:
    """Which schools send UC its students — the recruitment view of the same data."""
    where, params = filters.where("e")
    params["limit"] = limit
    clause = where + (" AND " if where else " WHERE ") + "e.prev_school IS NOT NULL"
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT e.prev_school AS school, e.province AS province, "
            f"       COUNT(DISTINCT e.student_ref) AS headcount "
            f"FROM enrollment e{clause} "
            f"GROUP BY 1, 2 ORDER BY 3 DESC LIMIT %(limit)s",
            params,
        )
        return cur.fetchall()
