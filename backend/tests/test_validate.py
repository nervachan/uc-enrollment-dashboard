"""The row contract."""

from __future__ import annotations

import pytest

from app.validate import HeaderError, check_header, clean, normalise_row

HEADER = ["USER_INDEX", "SCHOOL YEAR", "TERM", "COURSE", "SEX", "SOMETHING ELSE"]


def base_row(**over) -> dict[str, str]:
    row = {
        "USER_INDEX": "1001",
        "SCHOOL YEAR": "2025",
        "TERM": "1",
        "COURSE": "BS INFORMATION TECHNOLOGY",
        "SEX": "F",
        "YEAR_LEVEL": "2",
        "BROAD_RELIGION": "Christianity",
        "CIVIL_STATUS": "Single",
    }
    row.update(over)
    return row


def test_header_lists_ignored_columns():
    assert check_header(HEADER) == ["SOMETHING ELSE"]


def test_header_rejects_missing_required_column():
    with pytest.raises(HeaderError, match="COURSE"):
        check_header(["USER_INDEX", "SCHOOL YEAR", "TERM"])


def test_header_rejects_empty_file():
    with pytest.raises(HeaderError):
        check_header(None)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("  Baguio   City ", "Baguio City"),
        ("Cordillera\tAdministrative   Region   (CAR)", "Cordillera Administrative Region (CAR)"),
        ("N/A", None),
        ("", None),
        ("  ", None),
    ],
)
def test_clean_collapses_whitespace_and_placeholders(raw, expected):
    assert clean(raw) == expected


def test_numeric_fields_are_coerced():
    row, rejection = normalise_row(base_row(), 2)
    assert rejection is None
    assert row["school_year"] == 2025 and row["term"] == 1 and row["year_level"] == 2


def test_sensitive_fields_are_dropped_by_default():
    row, _ = normalise_row(base_row(), 2)
    assert row["broad_religion"] is None
    assert row["civil_status"] is None


def test_sensitive_fields_load_only_when_requested():
    row, _ = normalise_row(base_row(), 2, include_sensitive=True)
    assert row["broad_religion"] == "Christianity"


def test_detailed_religion_is_never_loaded():
    row, _ = normalise_row(base_row(RELIGION="Roman Catholic"), 2, include_sensitive=True)
    assert "religion" not in row


@pytest.mark.parametrize(
    "override,reason",
    [
        ({"USER_INDEX": ""}, "student_ref is empty"),
        ({"TERM": "9"}, "term 9 out of range"),
        ({"SCHOOL YEAR": "20x5"}, "not a number"),
        ({"YEAR_LEVEL": "44"}, "year_level 44 out of range"),
    ],
)
def test_bad_rows_are_rejected_with_a_reason(override, reason):
    row, rejection = normalise_row(base_row(**override), 7)
    assert row is None
    assert rejection is not None and rejection.row_number == 7
    assert reason in rejection.reason
    assert rejection.payload  # the offending row is kept for the operator
