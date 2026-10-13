"""Command-line loader.

    python -m app.etl --data-dir "/path/to/Dashboard Files"          # boundaries + CSV
    python -m app.etl --data-dir ... --boundaries-only
    python -m app.etl --csv "Data for dashboard.csv" --dry-run       # validate, load nothing

Run it once to populate the database, and again after each term's export. Re-running the
same file is safe: rows conflict on the natural key and are skipped, not duplicated.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from ..config import get_settings
from ..db import apply_schema
from .boundaries import discover_sources, load_boundaries
from .enrollments import load_csv, validate_stream

DEFAULT_CSV = "Data for dashboard.csv"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.etl", description=__doc__)
    parser.add_argument("--data-dir", type=Path, help="folder holding the GeoPackages and the CSV")
    parser.add_argument(
        "--csv", type=Path, help="enrollment CSV (defaults to the one in --data-dir)"
    )
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--boundaries-only", action="store_true")
    parser.add_argument("--csv-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="validate the CSV, write nothing")
    parser.add_argument(
        "--include-sensitive",
        action="store_true",
        help="also load broad religion and civil status (off by default; see app/validate.py)",
    )
    parser.add_argument("--note", default=None, help="free text stored with the batch record")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)-7s %(message)s",
    )

    csv_path = args.csv or (args.data_dir / DEFAULT_CSV if args.data_dir else None)

    if args.dry_run:
        if csv_path is None:
            parser.error("--dry-run needs --csv or --data-dir")
        with csv_path.open("r", encoding="utf-8-sig", newline="") as fh:
            rows, report = validate_stream(fh, args.include_sensitive)
            for _ in rows:
                pass
        print(
            f"read {report.rows_read}, valid {report.rows_valid}, "
            f"rejected {report.rows_rejected}"
        )
        if report.ignored_columns:
            print("ignored columns:", ", ".join(report.ignored_columns))
        for rejection in report.rejections[:20]:
            print(f"  row {rejection.row_number}: {rejection.reason}")
        return 1 if report.rows_rejected else 0

    url = args.database_url or get_settings().database_url
    with psycopg.connect(url, row_factory=dict_row) as conn:
        apply_schema(conn)

        if not args.csv_only:
            if args.data_dir is None:
                parser.error("loading boundaries needs --data-dir")
            sources = discover_sources(args.data_dir)
            if not sources:
                print("no GeoPackages found in", args.data_dir, file=sys.stderr)
                return 2
            counts = load_boundaries(conn, sources, get_settings().geojson_tolerance)
            for level, n in counts.items():
                print(f"boundaries: {level:<13} {n:>6} features")

        if not args.boundaries_only:
            if csv_path is None:
                parser.error("loading enrollments needs --csv or --data-dir")
            result = load_csv(conn, csv_path, args.include_sensitive, args.note)
            print(result.summary())
            if result.unmatched_municipality:
                print("\nmunicipalities with no matching polygon (top 10):")
                for name, province, n in result.unmatched_municipality[:10]:
                    print(f"  {n:>6}  {name} / {province}")
            if result.unmatched_country:
                print("\ncountries with no matching polygon (top 10):")
                for name, n in result.unmatched_country[:10]:
                    print(f"  {n:>6}  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
