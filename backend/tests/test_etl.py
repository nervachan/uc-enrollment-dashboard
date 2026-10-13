"""Loading behaviour, including the defect this project exists to fix."""

from __future__ import annotations

from app.etl.enrollments import load_csv


def test_boundaries_loaded_at_three_levels(loaded, conn):
    with conn.cursor() as cur:
        cur.execute("SELECT level, COUNT(*) AS n FROM boundary GROUP BY 1")
        counts = {r["level"]: r["n"] for r in cur.fetchall()}
    assert counts == {"country": 2, "province": 2, "municipality": 3}


def test_municipality_is_resolved_by_name_and_province(loaded, conn):
    """The regression test for the inflated municipal counts.

    Two municipalities named Rosario, one student each. A join on name alone — which is
    what produced the shipped layer — gives both of them 2.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT province, headcount FROM v_municipality_totals "
            "WHERE municipality = 'Rosario' ORDER BY province"
        )
        rows = cur.fetchall()
    assert [(r["province"], r["headcount"]) for r in rows] == [
        ("Benguet", 1),
        ("La Union", 1),
    ]


def test_headcount_and_records_are_different_numbers(loaded, conn):
    """Student 1001 appears three times: one person, three enrollment records."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT headcount, enrollment_records FROM v_municipality_totals "
            "WHERE municipality = 'Baguio City'"
        )
        row = cur.fetchone()
    assert row["headcount"] == 2
    assert row["enrollment_records"] == 4


def test_parent_links_are_set(loaded, conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT p.name AS parent FROM boundary m JOIN boundary p ON p.id = m.parent_id "
            "WHERE m.level = 'municipality' AND m.name = 'Baguio City'"
        )
        assert cur.fetchone()["parent"] == "Benguet"


def test_simplified_and_mercator_geometry_are_populated(loaded, conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) AS n FROM boundary "
            "WHERE geom_simple IS NULL OR geom_3857 IS NULL"
        )
        assert cur.fetchone()["n"] == 0


def test_reloading_the_same_file_inserts_nothing(conn, sample_csv):
    before = load_csv(conn, sample_csv)
    assert before.rows_inserted == 0, "fixture already loaded this file once"
    assert before.rows_duplicate > 0


def test_unmatched_origins_are_reported_not_silently_dropped(loaded):
    unmatched = {m for m, _p, _n in loaded.unmatched_municipality}
    assert "Beijing" in unmatched, "a foreign city has no municipal polygon and must be surfaced"


def test_batch_record_counts_match_the_file(loaded, conn):
    with conn.cursor() as cur:
        cur.execute("SELECT rows_read, rows_loaded, rows_rejected FROM ingest_batch WHERE id = %s",
                    (loaded.batch_id,))
        row = cur.fetchone()
    assert row["rows_read"] == 7
    assert row["rows_loaded"] == 7
    assert row["rows_rejected"] == 0
