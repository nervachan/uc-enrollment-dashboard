"""Load administrative boundaries from the registrar's GeoPackages.

The GeoPackages also carry pre-computed enrollment columns. Those are deliberately NOT
read: the municipal layer's counts were produced by a join on municipality name alone
and are inflated wherever a name repeats across provinces (docs/DATA-AUDIT.md). Geometry
is the only thing taken from these files; every count is recomputed from the CSV.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from psycopg import Connection

from ..gpkg import read_features

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class BoundarySource:
    """Where one administrative level's geometry comes from."""

    level: str
    path: Path
    layer: str | None
    name_field: str
    province_field: str | None = None
    region_field: str | None = None


# Filenames as the registrar's Drive folder ships them.
DEFAULT_SOURCES = {
    "country": ("All Enrollees International (Country-level).gpkg", "NAME_LONG", None, None),
    "province": ("All Enrollees Per Program (Provincial-level).gpkg", "adm2_name", None, None),
    "municipality": (
        "All Enrollees Per Program and Total (Municipal-level).gpkg",
        "Muncipality",  # the source file's spelling
        "Province",
        "Region",
    ),
}


def discover_sources(data_dir: Path) -> list[BoundarySource]:
    sources: list[BoundarySource] = []
    for level, (filename, name_f, prov_f, region_f) in DEFAULT_SOURCES.items():
        path = data_dir / filename
        if not path.exists():
            log.warning("skipping %s: %s not found", level, filename)
            continue
        sources.append(BoundarySource(level, path, None, name_f, prov_f, region_f))
    return sources


UPSERT = """
INSERT INTO boundary (level, name, province, region, geom)
VALUES (%(level)s::boundary_level, %(name)s, %(province)s, %(region)s,
        ST_Multi(ST_MakeValid(ST_GeomFromWKB(%(wkb)s, 4326))))
ON CONFLICT (level, name, COALESCE(province, ''))
DO UPDATE SET geom = EXCLUDED.geom,
              region = EXCLUDED.region,
              geom_simple = NULL,
              geom_3857 = NULL
"""


def load_boundaries(
    conn: Connection, sources: list[BoundarySource], tolerance: float = 0.005
) -> dict[str, int]:
    """Insert or refresh boundary geometry. Returns feature counts per level."""
    counts: dict[str, int] = {}
    for source in sources:
        loaded = skipped = 0
        with conn.cursor() as cur:
            for attrs, wkb in read_features(source.path, source.layer):
                name = attrs.get(source.name_field)
                if not name or wkb is None:
                    skipped += 1
                    continue
                cur.execute(
                    UPSERT,
                    {
                        "level": source.level,
                        "name": str(name).strip(),
                        "province": (
                            str(attrs.get(source.province_field) or "").strip() or None
                            if source.province_field
                            else None
                        ),
                        "region": (
                            " ".join(str(attrs.get(source.region_field) or "").split()) or None
                            if source.region_field
                            else None
                        ),
                        "wkb": wkb,
                    },
                )
                loaded += 1
        conn.commit()
        counts[source.level] = loaded
        log.info("%s: %d features loaded, %d skipped", source.level, loaded, skipped)

    with conn.cursor() as cur:
        # Parent links: a municipality belongs to the province of the same name.
        cur.execute(
            "UPDATE boundary m SET parent_id = p.id "
            "FROM boundary p "
            "WHERE m.level = 'municipality' AND p.level = 'province' "
            "  AND p.name = m.province AND m.parent_id IS DISTINCT FROM p.id"
        )
        # Simplified geometry for GeoJSON at national zoom. Topology-preserving, so
        # shared borders stay shared and no slivers open up between neighbours.
        cur.execute(
            "UPDATE boundary SET geom_simple = "
            "  ST_Multi(ST_MakeValid(ST_SimplifyPreserveTopology(geom, %s))) "
            "WHERE geom_simple IS NULL",
            (tolerance,),
        )
        # Store the Web Mercator copy once, at load time, so the tile endpoint never
        # reprojects. Measured on the country layer: 2.1 s per tile before, ~40 ms after.
        cur.execute(
            "UPDATE boundary SET geom_3857 = ST_Multi(ST_MakeValid(ST_Transform(geom, 3857))) "
            "WHERE geom_3857 IS NULL"
        )
        cur.execute("ANALYZE boundary")
    conn.commit()
    return counts
