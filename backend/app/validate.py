"""The row contract for enrollment extracts.

One module, used by both entry points — the CLI loader and the (future) upload screen —
so a file that loads from the command line cannot be rejected by the web form, or the
reverse. Rejections are per row and carry a reason; a bad row never silently disappears.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Source column -> internal field. The registrar's export header is the contract; if it
# changes, this map is the one place that needs editing.
COLUMN_MAP: dict[str, str] = {
    "USER_INDEX": "student_ref",
    "SEX": "sex",
    "BROAD_RELIGION": "broad_religion",
    "CIVIL_STATUS": "civil_status",
    "COLLEGE": "college",
    "COURSE": "course",
    "YEAR_LEVEL": "year_level",
    "YEAR OF ENTRY": "year_of_entry",
    "TERM OF ENTRY": "term_of_entry",
    "NATIONALITY": "nationality",
    "STATUS": "status",
    "SCHOOL YEAR": "school_year",
    "TERM": "term",
    "PROGRAM_GROUP": "program_group",
    "MUNICITY": "municity",
    "PROVINCE": "province",
    "REGION": "region",
    "COUNTRY": "country",
    "PREV_SCHOOL CORRECTED": "prev_school",
}

REQUIRED_COLUMNS = {"USER_INDEX", "SCHOOL YEAR", "TERM", "COURSE"}

# Collected but not loaded unless the operator opts in. RELIGION (denomination-level) is
# never loaded: nothing in this dashboard is answered by it, and the Data Privacy Act
# treats it as sensitive personal information. BROAD_RELIGION and CIVIL_STATUS are
# equally sensitive and off by default; the flag exists so an approved research use can
# turn them on deliberately rather than by accident.
SENSITIVE_FIELDS = {"broad_religion", "civil_status"}

INT_FIELDS = {"school_year", "term", "year_level", "year_of_entry", "term_of_entry"}

_WS = re.compile(r"\s+")


@dataclass
class Rejection:
    row_number: int
    reason: str
    payload: dict[str, str]


@dataclass
class ValidationReport:
    rows_read: int = 0
    rows_valid: int = 0
    rejections: list[Rejection] = field(default_factory=list)
    ignored_columns: list[str] = field(default_factory=list)

    @property
    def rows_rejected(self) -> int:
        return len(self.rejections)


class HeaderError(ValueError):
    """The file cannot be processed at all — raised before any row is read."""


def check_header(header: list[str] | None) -> list[str]:
    """Validate the header; return the list of columns that will be ignored."""
    if not header:
        raise HeaderError("file has no header row")
    present = {h.strip().lstrip("﻿") for h in header}
    missing = REQUIRED_COLUMNS - present
    if missing:
        raise HeaderError("missing required column(s): " + ", ".join(sorted(missing)))
    return sorted(present - set(COLUMN_MAP))


def clean(value: object) -> str | None:
    """Trim, collapse internal whitespace, and map placeholder text to NULL.

    The source data uses several spellings of "no value" and has stray tabs and double
    spaces inside region names ('Cordillera Administrative Region   (CAR)'), which would
    otherwise create two of everything in the filter lists.
    """
    if value is None:
        return None
    text = _WS.sub(" ", str(value).replace("\t", " ")).strip()
    if text == "" or text.lower() in {"na", "n/a", "null", "none", "-"}:
        return None
    return text


def normalise_row(
    raw: dict[str, str], row_number: int, include_sensitive: bool = False
) -> tuple[dict[str, object] | None, Rejection | None]:
    """Map one source row onto internal fields, or explain why it cannot be used."""
    row: dict[str, object] = {}
    for source, target in COLUMN_MAP.items():
        if target in SENSITIVE_FIELDS and not include_sensitive:
            row[target] = None
            continue
        value = clean(raw.get(source))
        if target in INT_FIELDS and value is not None:
            try:
                value = int(float(value))
            except ValueError:
                return None, Rejection(
                    row_number, f"{source}: {value!r} is not a number", dict(raw)
                )
        row[target] = value

    for required in ("student_ref", "school_year", "term", "course"):
        if row.get(required) in (None, ""):
            return None, Rejection(row_number, f"{required} is empty", dict(raw))

    year = int(row["school_year"])  # type: ignore[arg-type]
    if not 1900 <= year <= 2200:
        return None, Rejection(row_number, f"school_year {year} out of range", dict(raw))
    term = int(row["term"])  # type: ignore[arg-type]
    if not 1 <= term <= 4:
        return None, Rejection(row_number, f"term {term} out of range 1-4", dict(raw))
    level = row.get("year_level")
    if level is not None and not 1 <= int(level) <= 10:  # type: ignore[arg-type]
        return None, Rejection(row_number, f"year_level {level} out of range 1-10", dict(raw))

    return row, None
