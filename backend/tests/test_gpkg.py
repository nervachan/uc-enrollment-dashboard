"""The GeoPackage reader."""

from __future__ import annotations

import struct

import pytest

from app.gpkg import GeoPackageError, list_layers, read_features
from tests.conftest import _gpkg_blob, _wkb_square, write_gpkg

ONE_SQUARE = [{"name": "A", "x": 1, "y": 1}]


def one_layer(tmp_path):
    """A GeoPackage with a single square, used by most cases here."""
    return write_gpkg(tmp_path / "x.gpkg", "places", {"name": "TEXT"}, ONE_SQUARE)


def test_lists_layer_and_feature_count(tmp_path):
    path = write_gpkg(
        tmp_path / "x.gpkg", "places", {"name": "TEXT"},
        [{"name": "A", "x": 1, "y": 1}, {"name": "B", "x": 2, "y": 2}],
    )
    layers = list_layers(path)
    assert len(layers) == 1
    assert layers[0].table_name == "places"
    assert layers[0].feature_count == 2
    assert layers[0].srs_id == 4326


def test_reads_attributes_without_the_geometry_column(tmp_path):
    path = one_layer(tmp_path)
    attrs, wkb = next(iter(read_features(path)))
    assert attrs["name"] == "A"
    assert "geom" not in attrs
    # The header is gone and what is left is a bare little-endian polygon.
    assert wkb is not None
    assert struct.unpack("<BI", wkb[:5]) == (1, 3)


def test_header_with_envelope_is_stripped_correctly(tmp_path):
    """Envelope indicator 1 adds 32 bytes between the header and the WKB."""
    import sqlite3

    path = one_layer(tmp_path)
    wkb = _wkb_square(1, 1)
    envelope = struct.pack("<dddd", 1, 2, 1, 2)
    blob = b"GP" + bytes([0, 0x03]) + struct.pack("<i", 4326) + envelope + wkb
    con = sqlite3.connect(path)
    con.execute("UPDATE places SET geom = ?", (blob,))
    con.commit()
    con.close()
    _, parsed = next(iter(read_features(path)))
    assert parsed == wkb


def test_rejects_a_non_geopackage_blob(tmp_path):
    import sqlite3

    path = one_layer(tmp_path)
    con = sqlite3.connect(path)
    con.execute("UPDATE places SET geom = ?", (b"NOTAGPKG" + b"\x00" * 16,))
    con.commit()
    con.close()
    with pytest.raises(GeoPackageError):
        list(read_features(path))


def test_rejects_geometry_in_another_crs(tmp_path):
    import sqlite3

    path = one_layer(tmp_path)
    blob = b"GP" + bytes([0, 0x01]) + struct.pack("<i", 32651) + _wkb_square(1, 1)
    con = sqlite3.connect(path)
    con.execute("UPDATE places SET geom = ?", (blob,))
    con.commit()
    con.close()
    with pytest.raises(GeoPackageError, match="EPSG:4326"):
        list(read_features(path))


def test_empty_geometry_flag_yields_none(tmp_path):
    import sqlite3

    path = one_layer(tmp_path)
    blob = b"GP" + bytes([0, 0x11]) + struct.pack("<i", 4326)
    con = sqlite3.connect(path)
    con.execute("UPDATE places SET geom = ?", (blob,))
    con.commit()
    con.close()
    _, parsed = next(iter(read_features(path)))
    assert parsed is None


def test_unknown_layer_name_is_an_error(tmp_path):
    path = one_layer(tmp_path)
    with pytest.raises(GeoPackageError, match="not found"):
        list(read_features(path, layer="nope"))


def test_blob_helper_round_trips():
    wkb = _wkb_square(0, 0)
    assert _gpkg_blob(wkb)[8:] == wkb
