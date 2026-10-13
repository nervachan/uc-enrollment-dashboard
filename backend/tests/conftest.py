"""Test fixtures.

The suite runs against a real PostGIS database, because almost everything worth testing
here — the identity join, ST_AsMVT, the natural-key conflict — is behaviour of the
database, and a mocked connection would assert nothing. Point TEST_DATABASE_URL at a
scratch database; it is dropped and recreated on every run.
"""

from __future__ import annotations

import os
import sqlite3
import struct
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from app.config import get_settings
from app.db import apply_schema

ADMIN_URL = os.environ.get(
    "ADMIN_DATABASE_URL", "postgresql://uc:ucdash@localhost:5432/postgres"
)
TEST_DB = os.environ.get("TEST_DATABASE_NAME", "uc_enrollment_test")
TEST_URL = os.environ.get(
    "TEST_DATABASE_URL", f"postgresql://uc:ucdash@localhost:5432/{TEST_DB}"
)


def _wkb_square(x: float, y: float, size: float = 1.0) -> bytes:
    """Little-endian WKB for a square polygon."""
    ring = [(x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y)]
    body = struct.pack("<BII", 1, 3, 1) + struct.pack("<I", len(ring))
    for px, py in ring:
        body += struct.pack("<dd", px, py)
    return body


def _gpkg_blob(wkb: bytes) -> bytes:
    """Wrap WKB in a GeoPackage geometry header (no envelope, EPSG:4326)."""
    return b"GP" + bytes([0, 0x01]) + struct.pack("<i", 4326) + wkb


def write_gpkg(path: Path, table: str, columns: dict[str, str], rows: list[dict]) -> Path:
    """Write a minimal but valid single-layer GeoPackage."""
    con = sqlite3.connect(path)
    con.execute("PRAGMA application_id=1196444487")
    con.execute("PRAGMA user_version=10200")
    con.execute(
        "CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, "
        "identifier TEXT, description TEXT, last_change TEXT, min_x REAL, min_y REAL, "
        "max_x REAL, max_y REAL, srs_id INTEGER)"
    )
    con.execute(
        "CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, "
        "geometry_type_name TEXT, srs_id INTEGER, z INTEGER, m INTEGER)"
    )
    cols = ", ".join(f'"{name}" {sqltype}' for name, sqltype in columns.items())
    con.execute(f'CREATE TABLE "{table}" (fid INTEGER PRIMARY KEY, geom BLOB, {cols})')
    con.execute(
        "INSERT INTO gpkg_contents VALUES (?, 'features', ?, '', '', 0, 0, 0, 0, 4326)",
        (table, table),
    )
    con.execute(
        "INSERT INTO gpkg_geometry_columns VALUES (?, 'geom', 'POLYGON', 4326, 0, 0)",
        (table,),
    )
    names = list(columns)
    placeholders = ", ".join("?" * (len(names) + 1))
    for row in rows:
        con.execute(
            f'INSERT INTO "{table}" (geom, {", ".join(chr(34) + n + chr(34) for n in names)}) '
            f"VALUES ({placeholders})",
            [_gpkg_blob(_wkb_square(row["x"], row["y"]))] + [row[n] for n in names],
        )
    con.commit()
    con.close()
    return path


@pytest.fixture(scope="session")
def database_url() -> str:
    try:
        with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)')
            conn.execute(f'CREATE DATABASE "{TEST_DB}"')
        with psycopg.connect(TEST_URL, autocommit=True) as conn:
            conn.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    except psycopg.OperationalError as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"PostGIS not reachable for tests: {exc}")
    return TEST_URL


@pytest.fixture(scope="session")
def conn(database_url: str):
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        apply_schema(connection)
        yield connection


@pytest.fixture(scope="session")
def boundary_files(tmp_path_factory) -> Path:
    """Two provinces, each containing a municipality called 'Rosario'.

    That collision is the whole point: the shipped GeoPackage joined counts on
    municipality name alone, so both Rosarios received the national total for the name.
    """
    directory = tmp_path_factory.mktemp("gpkg")
    write_gpkg(
        directory / "All Enrollees International (Country-level).gpkg",
        "joined_layer",
        {"NAME_LONG": "TEXT"},
        [{"NAME_LONG": "Philippines", "x": 120.0, "y": 16.0},
         {"NAME_LONG": "China", "x": 100.0, "y": 30.0}],
    )
    write_gpkg(
        directory / "All Enrollees Per Program (Provincial-level).gpkg",
        "all_per_prov",
        {"adm2_name": "TEXT"},
        [{"adm2_name": "Benguet", "x": 120.0, "y": 16.0},
         {"adm2_name": "La Union", "x": 120.0, "y": 16.5}],
    )
    write_gpkg(
        directory / "All Enrollees Per Program and Total (Municipal-level).gpkg",
        "per_municity_final",
        {"Muncipality": "TEXT", "Province": "TEXT", "Region": "TEXT"},
        [
            {"Muncipality": "Baguio City", "Province": "Benguet", "Region": "CAR", "x": 120.0, "y": 16.0},
            {"Muncipality": "Rosario", "Province": "Benguet", "Region": "CAR", "x": 120.2, "y": 16.1},
            {"Muncipality": "Rosario", "Province": "La Union", "Region": "Region I", "x": 120.4, "y": 16.3},
        ],
    )
    return directory


HEADER = (
    "USER_INDEX,SEX,RELIGION,BROAD_RELIGION,CIVIL_STATUS,COLLEGE,COURSE,YEAR_LEVEL,"
    "YEAR OF ENTRY,TERM OF ENTRY,NATIONALITY,STATUS,SCHOOL YEAR,TERM,PROGRAM_GROUP,"
    "MUNICITY,PROVINCE,REGION,COUNTRY,PREV_SCHOOL CORRECTED"
)


def csv_row(student: str, municity: str, province: str, **over) -> str:
    values = {
        "SEX": "F", "RELIGION": "Roman Catholic", "BROAD_RELIGION": "Christianity",
        "CIVIL_STATUS": "Single", "COLLEGE": "CITCS",
        "COURSE": "BACHELOR OF SCIENCE IN INFORMATION TECHNOLOGY", "YEAR_LEVEL": "1",
        "YEAR OF ENTRY": "2024", "TERM OF ENTRY": "1", "NATIONALITY": "Filipino",
        "STATUS": "New", "SCHOOL YEAR": "2025", "TERM": "1",
        "PROGRAM_GROUP": "Undergraduate", "REGION": "Cordillera  Administrative Region   (CAR)",
        "COUNTRY": "Philippines", "PREV_SCHOOL CORRECTED": "Baguio City High School",
    }
    values.update(over)
    values["MUNICITY"] = municity
    values["PROVINCE"] = province
    order = HEADER.split(",")
    values["USER_INDEX"] = student
    return ",".join(str(values.get(k, "")) for k in order)


@pytest.fixture(scope="session")
def sample_csv(tmp_path_factory) -> Path:
    path = tmp_path_factory.mktemp("csv") / "sample.csv"
    lines = [
        HEADER,
        csv_row("1001", "Baguio City", "Benguet"),
        csv_row("1001", "Baguio City", "Benguet", TERM="2"),
        csv_row("1001", "Baguio City", "Benguet", **{"SCHOOL YEAR": "2026"}),
        csv_row("1002", "Rosario", "Benguet", COLLEGE="COE"),
        csv_row("1003", "Rosario", "La Union", COLLEGE="COE"),
        csv_row("1004", "Baguio City", "Benguet", SEX="M", STATUS="Old"),
        csv_row("1005", "Beijing", "International", COUNTRY="China", NATIONALITY="Chinese"),
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


@pytest.fixture(scope="session")
def loaded(conn, boundary_files, sample_csv, database_url):
    from app.etl.boundaries import discover_sources, load_boundaries
    from app.etl.enrollments import load_csv

    load_boundaries(conn, discover_sources(boundary_files))
    result = load_csv(conn, sample_csv)
    return result


@pytest.fixture()
def client(loaded, database_url, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("INGEST_API_KEY", "test-key")
    get_settings.cache_clear()
    from app import db as db_module

    db_module.close_pool()
    from app.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client
    db_module.close_pool()
    get_settings.cache_clear()
