"""Choropleth payloads: GeoJSON for the small layers, vector tiles for the big one."""

from __future__ import annotations

import math
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from psycopg import Connection

from ..config import get_settings
from ..db import get_conn
from ..filters import Filters

router = APIRouter(prefix="/api", tags=["geo"])

Conn = Annotated[Connection, Depends(get_conn)]

Level = Literal["country", "province", "municipality"]

# Which enrollment column carries the boundary id at each level.
JOIN_COLUMN = {
    "country": "country_id",
    "province": "province_id",
    "municipality": "municipality_id",
}


@router.get("/geo/{level}")
def geo(
    conn: Conn,
    filters: Filters,
    level: Level,
    province: Annotated[
        str | None, Query(description="restrict municipalities to one province")
    ] = None,
    simplified: Annotated[bool, Query()] = True,
) -> dict:
    """A GeoJSON FeatureCollection of boundaries with the metric attached.

    Municipality level is 1,642 polygons nationally and is served as tiles instead; this
    endpoint allows it only when narrowed to a single province, which is the drill-down
    the dashboard actually performs.
    """
    if level == "municipality" and not province:
        raise HTTPException(
            400,
            "municipality GeoJSON must be narrowed with ?province=... — "
            "use /api/tiles/municipality/{z}/{x}/{y}.pbf for the national view",
        )

    where, params = filters.where("e")
    measure = filters.measure("e")
    geom_column = "COALESCE(b.geom_simple, b.geom)" if simplified else "b.geom"
    params["level"] = level

    scope = ""
    if province:
        scope = " AND b.province = %(province)s"
        params["province"] = province

    sql = f"""
    WITH counts AS (
        SELECT e.{JOIN_COLUMN[level]} AS boundary_id,
               COUNT(DISTINCT e.student_ref) AS headcount,
               COUNT(e.id) AS records,
               {measure} AS value
        FROM enrollment e{where}
        GROUP BY 1
    )
    SELECT json_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(json_agg(json_build_object(
            'type', 'Feature',
            'id', b.id,
            'geometry', ST_AsGeoJSON({geom_column})::json,
            'properties', json_build_object(
                'id', b.id,
                'name', b.name,
                'province', b.province,
                'region', b.region,
                'headcount', COALESCE(c.headcount, 0),
                'records', COALESCE(c.records, 0),
                'value', COALESCE(c.value, 0)
            )
        )), '[]'::json)
    ) AS fc
    FROM boundary b
    LEFT JOIN counts c ON c.boundary_id = b.id
    WHERE b.level = %(level)s::boundary_level{scope}
    """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()["fc"]


@router.get(
    "/tiles/{level}/{z}/{x}/{y}.pbf",
    response_class=Response,
    responses={200: {"content": {"application/vnd.mapbox-vector-tile": {}}}},
)
def tiles(conn: Conn, filters: Filters, level: Level, z: int, x: int, y: int) -> Response:
    """Mapbox Vector Tile for one boundary level, with the metric baked into each feature.

    The 680 MB of unsimplified boundary geometry in the source GeoPackages cannot be sent
    to a browser as GeoJSON. ST_AsMVTGeom clips to the tile and quantises to the tile
    grid, and the simplification tolerance tracks zoom, so a national view ships coarse
    outlines and a city view ships full detail.
    """
    if not 0 <= z <= 22 or not 0 <= x < 2**z or not 0 <= y < 2**z:
        raise HTTPException(400, "tile coordinates out of range")

    where, params = filters.where("e")
    measure = filters.measure("e")
    # Tolerance in Web Mercator metres: roughly one screen pixel at this zoom.
    tolerance = max(156543.03392 / (2**z) / 4, 0.0)
    params.update(
        {"z": z, "x": x, "y": y, "level": level, "layer_name": level, "tolerance": tolerance}
    )

    sql = f"""
    WITH envelope AS (
        SELECT ST_TileEnvelope(%(z)s, %(x)s, %(y)s) AS geom
    ),
    counts AS (
        SELECT e.{JOIN_COLUMN[level]} AS boundary_id,
               COUNT(DISTINCT e.student_ref) AS headcount,
               COUNT(e.id) AS records,
               {measure} AS value
        FROM enrollment e{where}
        GROUP BY 1
    ),
    mvt AS (
        SELECT b.id,
               b.name,
               b.province,
               b.region,
               COALESCE(c.headcount, 0) AS headcount,
               COALESCE(c.records, 0) AS records,
               COALESCE(c.value, 0) AS value,
               ST_AsMVTGeom(
                   ST_Simplify(b.geom_3857, %(tolerance)s),
                   envelope.geom, 4096, 64, true
               ) AS geom
        FROM boundary b
        LEFT JOIN counts c ON c.boundary_id = b.id
        CROSS JOIN envelope
        WHERE b.level = %(level)s::boundary_level
          AND b.geom_3857 && envelope.geom
    )
    SELECT ST_AsMVT(mvt.*, %(layer_name)s::text, 4096, 'geom') AS tile
    FROM mvt WHERE geom IS NOT NULL
    """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
    tile = bytes(row["tile"]) if row and row["tile"] is not None else b""
    return Response(
        content=tile,
        media_type="application/vnd.mapbox-vector-tile",
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get("/scale/{level}")
def scale(conn: Conn, filters: Filters, level: Level, classes: int = 5) -> dict:
    """Class breaks for the choropleth legend.

    Tiles carry per-feature values but no global maximum, so the legend and the colour
    steps need their breaks from here. Quantiles, not equal intervals: Baguio City holds
    an order of magnitude more students than any other municipality, and equal intervals
    would paint the whole country the lightest step.
    """
    if not 2 <= classes <= 9:
        raise HTTPException(400, "classes must be between 2 and 9")
    where, params = filters.where("e")
    measure = filters.measure("e")
    fractions = [i / classes for i in range(1, classes)]
    params["fractions"] = fractions

    sql = f"""
    WITH counts AS (
        SELECT e.{JOIN_COLUMN[level]} AS boundary_id, {measure} AS value
        FROM enrollment e{where}
        GROUP BY 1
    )
    SELECT MIN(value) AS min, MAX(value) AS max,
           percentile_cont(%(fractions)s) WITHIN GROUP (ORDER BY value) AS breaks
    FROM counts WHERE boundary_id IS NOT NULL AND value > 0
    """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()

    minimum = row["min"] or 0
    maximum = row["max"] or 0
    breaks = sorted({round(float(b)) for b in (row["breaks"] or [])})
    method = "quantile"

    if _quantiles_are_degenerate(breaks, maximum, classes):
        breaks = _log_breaks(minimum, maximum, classes)
        method = "logarithmic"

    return {
        "level": level,
        "metric": filters.metric,
        "min": minimum,
        "max": maximum,
        "breaks": breaks,
        "method": method,
    }


def _quantiles_are_degenerate(breaks: list[int], maximum: int, classes: int) -> bool:
    """True when quantile classes would hide the thing the map is about.

    Country level is the case that forces this. 32 countries have students; all but the
    Philippines are in single or double digits, so the quantiles come back [1, 2, 4, 7]
    and the Philippines — 94% of the student body — lands in the same colour class as a
    country with seven students.

    Two symptoms, either of which disqualifies quantiles: ties collapsed the class count,
    or the top break sits so far below the maximum that the darkest class spans almost
    the whole range.
    """
    if not breaks or maximum <= 0:
        return False
    if len(breaks) < classes - 1:
        return True
    return breaks[-1] < 0.02 * maximum


def _log_breaks(minimum: int, maximum: int, classes: int) -> list[int]:
    """Geometric class breaks, for counts spanning orders of magnitude."""
    low = math.log10(max(minimum, 1))
    high = math.log10(max(maximum, 10))
    step = (high - low) / classes
    breaks = [round(10 ** (low + step * i)) for i in range(1, classes)]
    return sorted({b for b in breaks if 0 < b <= maximum})


@router.get("/geo/bbox/{level}")
def bbox(conn: Conn, level: Level, name: str, province: str | None = None) -> dict:
    """Bounding box of one boundary, so the map can fly to a drill-down target."""
    params: dict[str, object] = {"level": level, "name": name}
    scope = ""
    if province:
        scope = " AND province = %(province)s"
        params["province"] = province
    with conn.cursor() as cur:
        cur.execute(
            "SELECT ST_XMin(e) AS minx, ST_YMin(e) AS miny, "
            "       ST_XMax(e) AS maxx, ST_YMax(e) AS maxy "
            "FROM (SELECT ST_Extent(geom) AS e FROM boundary "
            f"      WHERE level = %(level)s::boundary_level AND name = %(name)s{scope}) t",
            params,
        )
        row = cur.fetchone()
    if row is None or row["minx"] is None:
        raise HTTPException(404, f"no {level} named {name!r}")
    return row


def default_tolerance() -> float:
    return get_settings().geojson_tolerance
