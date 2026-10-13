"""The HTTP surface."""

from __future__ import annotations

import io


def test_health_reports_postgis_and_row_counts(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["postgis"].startswith("3.")
    assert body["enrollment_rows"] == 7


def test_summary_separates_headcount_from_records(client):
    body = client.get("/api/summary").json()
    assert body["totals"]["headcount"] == 5
    assert body["totals"]["records"] == 7


def test_filters_narrow_the_result(client):
    body = client.get("/api/summary", params={"college": "COE"}).json()
    assert body["totals"]["headcount"] == 2
    assert {b["key"] for b in body["breakdowns"]["college"]} == {"COE"}


def test_multiple_values_for_one_filter_are_or_ed(client):
    body = client.get("/api/summary", params=[("college", "COE"), ("college", "CITCS")]).json()
    assert body["totals"]["headcount"] == 5


def test_metric_switch_changes_the_measure(client):
    headcount = client.get("/api/breakdown/college").json()
    by_college = {r["key"]: (r["headcount"], r["records"]) for r in headcount}
    assert by_college["CITCS"] == (3, 5)


def test_unknown_breakdown_dimension_is_404(client):
    assert client.get("/api/breakdown/prev_school").status_code == 404


def test_filter_vocabularies_are_offered(client):
    body = client.get("/api/filters").json()
    assert set(body["college"]) == {"CITCS", "COE"}
    assert 2025 in body["school_year"]
    assert any(c["college"] == "COE" for c in body["courses_by_college"])


def test_region_whitespace_was_normalised_on_load(client):
    regions = client.get("/api/filters").json()["region"]
    assert regions == ["Cordillera Administrative Region (CAR)"]


def test_province_geojson_carries_the_metric(client):
    body = client.get("/api/geo/province").json()
    assert body["type"] == "FeatureCollection"
    values = {f["properties"]["name"]: f["properties"]["value"] for f in body["features"]}
    assert values["Benguet"] == 3  # students 1001, 1002, 1004
    assert values["La Union"] == 1
    assert all(f["geometry"]["type"] in ("Polygon", "MultiPolygon") for f in body["features"])


def test_boundaries_with_no_students_are_still_returned(client):
    body = client.get("/api/geo/province", params={"college": "COE"}).json()
    values = {f["properties"]["name"]: f["properties"]["value"] for f in body["features"]}
    assert values["Benguet"] == 1 and values["La Union"] == 1
    assert len(body["features"]) == 2, "a zero must render as zero, not as a hole in the map"


def test_national_municipality_geojson_is_refused(client):
    response = client.get("/api/geo/municipality")
    assert response.status_code == 400
    assert "tiles" in response.json()["detail"]


def test_municipality_geojson_within_one_province(client):
    body = client.get("/api/geo/municipality", params={"province": "Benguet"}).json()
    assert {f["properties"]["name"] for f in body["features"]} == {"Baguio City", "Rosario"}


def test_vector_tile_is_served_as_protobuf(client):
    # z=7 tile covering north-western Luzon, where the fixture squares sit.
    response = client.get("/api/tiles/province/7/106/58.pbf")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/vnd.mapbox-vector-tile")
    assert len(response.content) > 0


def test_tile_outside_the_data_is_empty_not_an_error(client):
    response = client.get("/api/tiles/province/7/10/10.pbf")
    assert response.status_code == 200
    assert response.content == b""


def test_tile_coordinates_are_range_checked(client):
    assert client.get("/api/tiles/province/3/99/99.pbf").status_code == 400


def test_bbox_supports_fly_to(client):
    body = client.get("/api/geo/bbox/province", params={"name": "Benguet"}).json()
    assert body["minx"] < body["maxx"] and body["miny"] < body["maxy"]


def test_bbox_unknown_name_is_404(client):
    assert client.get("/api/geo/bbox/province", params={"name": "Atlantis"}).status_code == 404


def test_feeder_schools_are_ranked(client):
    body = client.get("/api/feeder-schools").json()
    assert body[0]["school"] == "Baguio City High School"
    assert body[0]["headcount"] >= 1


def test_ingest_requires_the_api_key(client):
    response = client.post("/api/ingest/validate", files={"file": ("x.csv", b"USER_INDEX\n")})
    assert response.status_code == 401


def test_ingest_validate_reports_rejections_without_loading(client, conn):
    from tests.conftest import HEADER, csv_row

    bad = "\n".join([HEADER, csv_row("2001", "Baguio City", "Benguet", TERM="7")])
    response = client.post(
        "/api/ingest/validate",
        headers={"X-API-Key": "test-key"},
        files={"file": ("bad.csv", io.BytesIO(bad.encode()), "text/csv")},
    )
    body = response.json()
    assert response.status_code == 200
    assert body["rows_read"] == 1 and body["rows_rejected"] == 1
    assert "term 7" in body["rejections"][0]["reason"]
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM enrollment WHERE student_ref = '2001'")
        assert cur.fetchone()["n"] == 0


def test_ingest_rejects_a_file_with_a_missing_column(client):
    response = client.post(
        "/api/ingest/validate",
        headers={"X-API-Key": "test-key"},
        files={"file": ("bad.csv", io.BytesIO(b"USER_INDEX,TERM\n1,1\n"), "text/csv")},
    )
    assert response.status_code == 422
    assert "COURSE" in response.json()["detail"]


def test_ingest_loads_new_rows_and_skips_duplicates(client, conn):
    from tests.conftest import HEADER, csv_row

    payload = "\n".join([
        HEADER,
        csv_row("3001", "Baguio City", "Benguet"),      # new
        csv_row("1001", "Baguio City", "Benguet"),      # already loaded by the fixture
    ])
    response = client.post(
        "/api/ingest",
        headers={"X-API-Key": "test-key"},
        files={"file": ("more.csv", io.BytesIO(payload.encode()), "text/csv")},
    )
    body = response.json()
    assert response.status_code == 200
    assert body["rows_inserted"] == 1
    assert body["rows_duplicate"] == 1
    assert client.get("/api/summary").json()["totals"]["headcount"] == 6

    assert any(b["filename"] == "more.csv" for b in client.get("/api/batches").json())

    # This test mutates shared state, so it puts it back: the fixture baseline must not
    # depend on which test file pytest happens to collect first.
    with conn.cursor() as cur:
        cur.execute("DELETE FROM enrollment WHERE student_ref = '3001'")
    conn.commit()
    assert client.get("/api/summary").json()["totals"]["headcount"] == 5


def test_scale_returns_quantile_breaks(client):
    body = client.get("/api/scale/province", params={"classes": 3}).json()
    assert body["min"] >= 1 and body["max"] >= body["min"]
    assert all(body["min"] <= b <= body["max"] for b in body["breaks"])


def test_scale_class_count_is_bounded(client):
    assert client.get("/api/scale/province", params={"classes": 99}).status_code == 400


def test_scale_reports_the_method_it_used(client):
    body = client.get("/api/scale/province", params={"classes": 3}).json()
    assert body["method"] in {"quantile", "logarithmic"}
    assert body["breaks"] == sorted(set(body["breaks"]))
