"""Minimal GeoPackage reader — no GDAL, no geopandas.

A GeoPackage is a SQLite database, and a GeoPackage geometry blob is a small binary
header followed by ordinary WKB. Stripping that header is the only thing standing
between stdlib `sqlite3` and `ST_GeomFromWKB`, so that is all this module does.

Reading the boundaries this way keeps the loader installable with nothing but psycopg,
which matters because it has to run on registrar staff machines, not just on a GIS
workstation. If you would rather use GDAL, `ogr2ogr -f PostgreSQL` is equivalent.

Header layout (GeoPackage 1.2, clause 2.1.3):
    bytes 0-1   magic "GP"
    byte  2     version
    byte  3     flags  — bit 0 byte order, bits 1-3 envelope kind, bit 4 empty geometry
    bytes 4-7   srs_id
    then        envelope (0/32/48/48/64 bytes depending on the envelope kind)
    then        WKB
"""

from __future__ import annotations

import sqlite3
import struct
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

_ENVELOPE_SIZES = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}


class GeoPackageError(RuntimeError):
    pass


@dataclass(frozen=True)
class Layer:
    table_name: str
    geometry_column: str
    srs_id: int
    feature_count: int


def _unwrap_geometry(blob: bytes | None) -> bytes | None:
    """Return the bare WKB inside a GeoPackage geometry blob."""
    if blob is None:
        return None
    if len(blob) < 8 or blob[0:2] != b"GP":
        raise GeoPackageError("not a GeoPackage geometry blob")
    flags = blob[3]
    envelope_kind = (flags >> 1) & 0x07
    if envelope_kind not in _ENVELOPE_SIZES:
        raise GeoPackageError(f"unknown envelope indicator {envelope_kind}")
    if flags & 0x10:  # empty geometry
        return None
    offset = 8 + _ENVELOPE_SIZES[envelope_kind]
    return blob[offset:]


def _srs_of(blob: bytes) -> int:
    little_endian = bool(blob[3] & 0x01)
    return struct.unpack("<i" if little_endian else ">i", blob[4:8])[0]


def list_layers(path: str | Path) -> list[Layer]:
    con = sqlite3.connect(f"file:{Path(path).as_posix()}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT c.table_name, g.column_name, c.srs_id "
            "FROM gpkg_contents c JOIN gpkg_geometry_columns g "
            "  ON g.table_name = c.table_name "
            "WHERE c.data_type = 'features'"
        ).fetchall()
        out = []
        for table, geom_col, srs in rows:
            count = con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            out.append(Layer(table, geom_col, srs, count))
        return out
    finally:
        con.close()


def read_features(
    path: str | Path, layer: str | None = None
) -> Iterator[tuple[dict[str, object], bytes | None]]:
    """Yield (attributes, wkb) per feature. The geometry column is not in attributes."""
    layers = list_layers(path)
    if not layers:
        raise GeoPackageError(f"{path} contains no feature layers")
    chosen = next((x for x in layers if x.table_name == layer), None) if layer else layers[0]
    if chosen is None:
        raise GeoPackageError(f"layer {layer!r} not found in {path}")

    con = sqlite3.connect(f"file:{Path(path).as_posix()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        for row in con.execute(f'SELECT * FROM "{chosen.table_name}"'):
            # .keys() is required: iterating a sqlite3.Row yields values, not keys, so
            # ruff's SIM118 "fix" would silently turn the column names into column data.
            attrs = {k: row[k] for k in row.keys() if k != chosen.geometry_column}  # noqa: SIM118
            blob = row[chosen.geometry_column]
            if blob is not None and _srs_of(blob) not in (0, 4326):
                raise GeoPackageError(
                    f"{path}: expected EPSG:4326 geometry, found SRS {_srs_of(blob)}. "
                    "Reproject the layer before loading."
                )
            yield attrs, _unwrap_geometry(blob)
    finally:
        con.close()
