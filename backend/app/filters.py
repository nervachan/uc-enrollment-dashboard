"""Query filters, shared by every read endpoint.

Values are always bound as parameters; only column names are interpolated, and those
come from this module's own whitelist, never from the request.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Literal

from fastapi import Depends, Query

Metric = Literal["headcount", "records"]

# Query parameter -> enrollment column. The whitelist is the security boundary.
FILTER_COLUMNS: dict[str, str] = {
    "school_year": "school_year",
    "term": "term",
    "college": "college",
    "course": "course",
    "program_group": "program_group",
    "status": "status",
    "year_level": "year_level",
    "sex": "sex",
    "nationality": "nationality",
    "region": "region",
    "province": "province",
    "country": "country",
}

MULTI_VALUE = {"college", "course", "status", "program_group", "school_year", "term"}


@dataclass
class EnrollmentFilters:
    school_year: list[int] | None = None
    term: list[int] | None = None
    college: list[str] | None = None
    course: list[str] | None = None
    program_group: list[str] | None = None
    status: list[str] | None = None
    year_level: int | None = None
    sex: str | None = None
    nationality: str | None = None
    region: str | None = None
    province: str | None = None
    country: str | None = None
    metric: Metric = "headcount"

    def where(self, alias: str = "e") -> tuple[str, dict[str, Any]]:
        """Return a SQL fragment starting with WHERE (or empty) plus its parameters."""
        clauses: list[str] = []
        params: dict[str, Any] = {}
        for name, column in FILTER_COLUMNS.items():
            value = getattr(self, name)
            if value in (None, [], ()):
                continue
            key = f"f_{name}"
            if isinstance(value, list):
                clauses.append(f"{alias}.{column} = ANY(%({key})s)")
            else:
                clauses.append(f"{alias}.{column} = %({key})s")
            params[key] = value
        return (" WHERE " + " AND ".join(clauses) if clauses else ""), params

    def measure(self, alias: str = "e") -> str:
        """The SQL expression for the selected metric.

        headcount counts people, records counts enrollment rows. A student enrolled in
        three terms is one headcount and three records; the two answer different
        questions and the API never silently swaps one for the other.
        """
        return (
            f"COUNT(DISTINCT {alias}.student_ref)"
            if self.metric == "headcount"
            else f"COUNT({alias}.id)"
        )


def filter_params(
    school_year: Annotated[list[int] | None, Query()] = None,
    term: Annotated[list[int] | None, Query()] = None,
    college: Annotated[list[str] | None, Query()] = None,
    course: Annotated[list[str] | None, Query()] = None,
    program_group: Annotated[list[str] | None, Query()] = None,
    status: Annotated[list[str] | None, Query()] = None,
    year_level: Annotated[int | None, Query(ge=1, le=10)] = None,
    sex: Annotated[str | None, Query()] = None,
    nationality: Annotated[str | None, Query()] = None,
    region: Annotated[str | None, Query()] = None,
    province: Annotated[str | None, Query()] = None,
    country: Annotated[str | None, Query()] = None,
    metric: Annotated[Metric, Query()] = "headcount",
) -> EnrollmentFilters:
    return EnrollmentFilters(
        school_year=school_year, term=term, college=college, course=course,
        program_group=program_group, status=status, year_level=year_level, sex=sex,
        nationality=nationality, region=region, province=province, country=country,
        metric=metric,
    )


Filters = Annotated[EnrollmentFilters, Depends(filter_params)]
