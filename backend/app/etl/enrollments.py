"""Load an enrollment extract (CSV) into the fact table.

Shape of the load:
    1. validate every row against the shared contract in app/validate.py
    2. COPY the valid rows into a session-scoped staging table
    3. resolve geography by identity — municipality by (name, province), never by name
    4. INSERT ... ON CONFLICT DO NOTHING against the natural key, so re-running a load
       is a no-op rather than a duplication
    5. record the batch, its rejections, and what failed to match geographically
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO

from psycopg import Connection

from ..validate import ValidationReport, check_header, normalise_row

log = logging.getLogger(__name__)

STAGING_COLUMNS = [
    "student_ref", "school_year", "term", "course", "college", "year_level",
    "program_group", "status", "year_of_entry", "term_of_entry", "sex",
    "broad_religion", "civil_status", "nationality", "municity", "province",
    "region", "country", "prev_school",
]

CREATE_STAGING = f"""
CREATE TEMP TABLE staging_enrollment (
    {", ".join(f"{c} text" for c in STAGING_COLUMNS)}
) ON COMMIT DROP
"""

INSERT_FROM_STAGING = f"""
INSERT INTO enrollment (
    {", ".join(STAGING_COLUMNS)},
    municipality_id, province_id, country_id, batch_id
)
SELECT s.student_ref, s.school_year::smallint, s.term::smallint, s.course, s.college,
       s.year_level::smallint, s.program_group, s.status, s.year_of_entry::smallint,
       s.term_of_entry::smallint, s.sex, s.broad_religion, s.civil_status,
       s.nationality, s.municity, s.province, s.region, s.country, s.prev_school,
       m.id, p.id, c.id, %(batch_id)s
FROM staging_enrollment s
LEFT JOIN boundary p ON p.level = 'province'     AND p.name = s.province
LEFT JOIN boundary m ON m.level = 'municipality' AND m.name = s.municity
                                                 AND m.province = s.province
LEFT JOIN boundary c ON c.level = 'country'      AND c.name = s.country
ON CONFLICT (student_ref, school_year, term, course) DO NOTHING
"""


@dataclass
class LoadResult:
    batch_id: int
    report: ValidationReport
    rows_inserted: int = 0
    rows_duplicate: int = 0
    unmatched_municipality: list[tuple[str, str, int]] = field(default_factory=list)
    unmatched_country: list[tuple[str, int]] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"batch {self.batch_id}: read {self.report.rows_read}, "
            f"inserted {self.rows_inserted}, duplicates skipped {self.rows_duplicate}, "
            f"rejected {self.report.rows_rejected}"
        )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_stream(stream: IO[str], include_sensitive: bool = False):
    """Validate a CSV stream. Yields normalised rows; collects rejections in the report."""
    reader = csv.DictReader(stream)
    report = ValidationReport()
    report.ignored_columns = check_header(reader.fieldnames)

    def rows():
        for number, raw in enumerate(reader, start=2):  # row 1 is the header
            report.rows_read += 1
            row, rejection = normalise_row(raw, number, include_sensitive)
            if rejection is not None:
                if len(report.rejections) < 1000:  # cap the report, keep the count honest
                    report.rejections.append(rejection)
                continue
            report.rows_valid += 1
            yield row

    return rows(), report


def load_csv(
    conn: Connection,
    path: Path,
    include_sensitive: bool = False,
    note: str | None = None,
) -> LoadResult:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return load_stream(
            conn, fh, filename=path.name, sha256=_sha256(path),
            include_sensitive=include_sensitive, note=note,
        )


def load_stream(
    conn: Connection,
    stream: IO[str],
    filename: str,
    sha256: str,
    include_sensitive: bool = False,
    note: str | None = None,
) -> LoadResult:
    rows, report = validate_stream(stream, include_sensitive)

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO ingest_batch (filename, sha256, note) VALUES (%s, %s, %s) RETURNING id",
            (filename, sha256, note),
        )
        batch_id = cur.fetchone()["id"]

        cur.execute(CREATE_STAGING)
        copy_sql = f"COPY staging_enrollment ({', '.join(STAGING_COLUMNS)}) FROM STDIN WITH CSV"
        with cur.copy(copy_sql) as copy:
            buffer = io.StringIO()
            writer = csv.writer(buffer)
            for i, row in enumerate(rows, start=1):
                writer.writerow(["" if row[c] is None else row[c] for c in STAGING_COLUMNS])
                if i % 5000 == 0:
                    copy.write(buffer.getvalue())
                    buffer.seek(0)
                    buffer.truncate(0)
            copy.write(buffer.getvalue())

        cur.execute("SELECT COUNT(*) AS n FROM staging_enrollment")
        staged = cur.fetchone()["n"]

        cur.execute(INSERT_FROM_STAGING, {"batch_id": batch_id})
        inserted = cur.rowcount

        # Which origins could not be placed on the map, and how many rows each cost.
        cur.execute(
            "SELECT s.municity, s.province, COUNT(*) AS n FROM staging_enrollment s "
            "LEFT JOIN boundary m ON m.level = 'municipality' AND m.name = s.municity "
            "                    AND m.province = s.province "
            "WHERE m.id IS NULL AND s.municity IS NOT NULL "
            "GROUP BY 1, 2 ORDER BY n DESC LIMIT 50"
        )
        unmatched_muni = [(r["municity"], r["province"], r["n"]) for r in cur.fetchall()]

        cur.execute(
            "SELECT s.country, COUNT(*) AS n FROM staging_enrollment s "
            "LEFT JOIN boundary c ON c.level = 'country' AND c.name = s.country "
            "WHERE c.id IS NULL AND s.country IS NOT NULL "
            "GROUP BY 1 ORDER BY n DESC LIMIT 50"
        )
        unmatched_country = [(r["country"], r["n"]) for r in cur.fetchall()]

        for rejection in report.rejections:
            cur.execute(
                "INSERT INTO ingest_rejection (batch_id, row_number, reason, payload) "
                "VALUES (%s, %s, %s, %s)",
                (
                    batch_id,
                    rejection.row_number,
                    rejection.reason,
                    json.dumps(rejection.payload),
                ),
            )

        cur.execute(
            "UPDATE ingest_batch SET rows_read = %s, rows_loaded = %s, rows_rejected = %s "
            "WHERE id = %s",
            (report.rows_read, inserted, report.rows_rejected, batch_id),
        )
    conn.commit()

    return LoadResult(
        batch_id=batch_id,
        report=report,
        rows_inserted=inserted,
        rows_duplicate=staged - inserted,
        unmatched_municipality=unmatched_muni,
        unmatched_country=unmatched_country,
    )
