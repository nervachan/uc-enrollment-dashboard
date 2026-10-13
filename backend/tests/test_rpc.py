"""The dashboard's data API: the database functions the browser calls through Supabase.

Same fixtures and assertions as the old HTTP tests, now calling the functions in
supabase/migrations/*_read_api.sql and *_ingest_api.sql directly.
"""

from __future__ import annotations

import psycopg
import pytest
from psycopg import errors

# ---------------------------------------------------------------- reads


def test_health_reports_postgis_and_row_counts(call):
    body = call("health")
    assert body["status"] == "ok"
    assert body["postgis"].startswith("3.")
    assert body["enrollment_rows"] == 7


def test_summary_separates_headcount_from_records(call):
    body = call("summary", {})
    assert body["totals"]["headcount"] == 5
    assert body["totals"]["records"] == 7
    assert body["metric"] == "headcount"


def test_filters_narrow_the_result(call):
    body = call("summary", {"college": ["COE"]})
    assert body["totals"]["headcount"] == 2
    assert {b["key"] for b in body["breakdowns"]["college"]} == {"COE"}


def test_multiple_values_for_one_filter_are_or_ed(call):
    assert call("summary", {"college": ["COE", "CITCS"]})["totals"]["headcount"] == 5


def test_metric_switch_changes_the_measure(call):
    body = call("summary", {"metric": "records", "college": ["CITCS"]})
    assert body["metric"] == "records"
    assert body["breakdowns"]["college"] == [{"key": "CITCS", "value": 5}]


def test_breakdown_reports_both_measures(call):
    by_college = {r["key"]: (r["headcount"], r["records"]) for r in call("breakdown", "college")}
    assert by_college["CITCS"] == (3, 5)


def test_unknown_breakdown_dimension_is_not_found(call):
    # P0002 is what PostgREST turns into HTTP 404.
    with pytest.raises(errors.NoDataFound):
        call("breakdown", "prev_school")


def test_filter_vocabularies_are_offered(call):
    body = call("filter_options")
    assert set(body["college"]) == {"CITCS", "COE"}
    assert 2025 in body["school_year"]
    assert any(c["college"] == "COE" for c in body["courses_by_college"])


def test_region_whitespace_was_normalised_on_load(call):
    assert call("filter_options")["region"] == ["Cordillera Administrative Region (CAR)"]


def test_province_geojson_carries_the_metric(call):
    body = call("geo", "province")
    assert body["type"] == "FeatureCollection"
    values = {f["properties"]["name"]: f["properties"]["value"] for f in body["features"]}
    assert values["Benguet"] == 3  # students 1001, 1002, 1004
    assert values["La Union"] == 1
    assert all(f["geometry"]["type"] in ("Polygon", "MultiPolygon") for f in body["features"])


def test_boundaries_with_no_students_are_still_returned(call):
    body = call("geo", "province", {"college": ["COE"]})
    values = {f["properties"]["name"]: f["properties"]["value"] for f in body["features"]}
    assert values["Benguet"] == 1 and values["La Union"] == 1
    assert len(body["features"]) == 2, "a zero must render as zero, not as a hole in the map"


def test_national_municipality_geojson_is_refused(call):
    with pytest.raises(psycopg.Error, match="tile"):
        call("geo", "municipality")


def test_municipality_geojson_within_one_province(call):
    body = call("geo", "municipality", {}, "Benguet")
    assert {f["properties"]["name"] for f in body["features"]} == {"Baguio City", "Rosario"}


def test_unknown_level_is_refused(call):
    with pytest.raises(errors.InvalidParameterValue):
        call("geo", "planet")


def test_vector_tile_is_protobuf(call):
    # z=7 tile covering north-western Luzon, where the fixture squares sit.
    tile = call("tile", "province", 7, 106, 58)
    assert isinstance(tile, bytes) and len(tile) > 0


def test_tile_outside_the_data_is_empty_not_an_error(call):
    assert call("tile", "province", 7, 10, 10) == b""


def test_tile_coordinates_are_range_checked(call):
    with pytest.raises(psycopg.Error, match="out of range"):
        call("tile", "province", 3, 99, 99)


def test_scale_returns_quantiles_for_the_frontend_to_finalise(call):
    body = call("scale", "province", {})
    assert body["level"] == "province" and body["metric"] == "headcount"
    assert body["max"] == 3
    assert len(body["breaks"]) == 4


def test_scale_class_count_is_checked(call):
    with pytest.raises(psycopg.Error, match="classes"):
        call("scale", "province", {}, 12)


def test_bbox_supports_fly_to(call):
    body = call("bbox", "province", "Benguet")
    assert body["minx"] < body["maxx"] and body["miny"] < body["maxy"]


def test_bbox_unknown_name_is_not_found(call):
    with pytest.raises(errors.NoDataFound):
        call("bbox", "province", "Atlantis")


def test_feeder_schools_are_ranked(call):
    body = call("feeder_schools", {})
    assert body[0]["school"] == "Baguio City High School"
    assert body[0]["headcount"] >= 1


def test_batches_list_the_load(call, loaded):
    batches = {b["id"]: b for b in call("batches")}
    assert batches[loaded.batch_id]["rows_loaded"] == 7


def test_filter_values_are_quoted_and_unknown_keys_ignored(call):
    hostile = {"college": ["x' OR 1=1 --"], "student_ref": ["1001"]}
    assert call("summary", hostile)["totals"]["headcount"] == 0
    assert call("summary", {"nonsense": ["1"]})["totals"]["headcount"] == 5


# ---------------------------------------------------------------- the upload path


def test_upload_functions_share_the_natural_key(call):
    batch = call("ingest_begin", "again.csv", "abc", None)
    row = {
        "student_ref": "1001", "school_year": 2025, "term": 1,
        "course": "BACHELOR OF SCIENCE IN INFORMATION TECHNOLOGY",
        "municity": "Atlantis", "province": "Benguet",
    }
    chunk = call("ingest_chunk", batch, [row])
    assert chunk["staged"] == 1 and chunk["inserted"] == 0, "already loaded by the CLI"
    assert chunk["unmatched_municipalities"] == [
        {"municity": "Atlantis", "province": "Benguet", "rows": 1}
    ]
    done = call(
        "ingest_finish", batch, 2,
        [{"row_number": 3, "reason": "term 9 out of range 1-4", "payload": {"TERM": "9"}}],
    )
    assert (done["rows_read"], done["rows_loaded"], done["rows_rejected"]) == (2, 0, 1)


# ---------------------------------------------------------------- who can do what


@pytest.fixture()
def as_role(conn):
    """Run statements as a Supabase API role, the way PostgREST does."""

    def _as(role: str, sql: str, params=None):
        with conn.cursor() as cur:
            try:
                cur.execute(f"GRANT {role} TO CURRENT_USER")
            except psycopg.Error:
                conn.rollback()
            try:
                cur.execute(f"SET LOCAL ROLE {role}")
            except psycopg.Error as exc:
                conn.rollback()
                pytest.skip(f"cannot switch to {role} here: {exc}")
            try:
                cur.execute(sql, params)
                return cur.fetchall()
            finally:
                conn.rollback()

    return _as


def test_the_public_key_can_read_aggregates(loaded, as_role):
    assert as_role("anon", "SELECT health() AS h")[0]["h"]["enrollment_rows"] == 7


def test_the_public_key_cannot_read_raw_rows(loaded, conn, as_role):
    # Supabase grants anon SELECT on new tables by default; RLS must still hide the rows.
    with conn.cursor() as cur:
        cur.execute("GRANT SELECT ON enrollment, v_enrollment_geo TO anon")
    conn.commit()
    assert as_role("anon", "SELECT student_ref FROM enrollment") == []
    assert as_role("anon", "SELECT student_ref FROM v_enrollment_geo") == []


def test_the_public_key_cannot_write(loaded, as_role):
    with pytest.raises(errors.InsufficientPrivilege):
        as_role("anon", "SELECT ingest_begin('x', 'y', NULL)")


def test_the_public_key_cannot_reach_the_private_helpers(loaded, as_role):
    with pytest.raises(errors.InsufficientPrivilege):
        as_role("anon", "SELECT private.where_sql('{}'::jsonb)")
