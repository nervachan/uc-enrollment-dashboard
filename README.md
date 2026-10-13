# UC Enrollment Geography Dashboard

Where University of the Cordilleras students come from — by country, province and
municipality, filterable by school year, term, college, program and enrollment status.

Built for the UC AI Unit from the registrar's SY2023–SY2026 extract (158,101 enrollment
records, 38,007 students) and the boundary GeoPackages in the `Dashboard Files` folder.

| Layer | Choice |
|---|---|
| Database | PostgreSQL 16 + **PostGIS 3.4** |
| API | FastAPI + psycopg 3 (no ORM — the work here is SQL) |
| Tiles | `ST_AsMVT` vector tiles served by the API |
| Frontend | React 19 + Vite 8 + **Tailwind 4 (CSS-first)** + MapLibre GL 6 + TanStack Query |
| Tests | 56 backend (pytest, against a real PostGIS), 31 frontend (vitest) |

**Read [`docs/DATA-AUDIT.md`](docs/DATA-AUDIT.md) first.** The counts in the source
GeoPackages are inflated by a join on municipality name alone; this application
recomputes everything from the CSV and treats those files as geometry only.

## The two metrics

Everything in the API and the UI is one of:

- **headcount** — `COUNT(DISTINCT student_ref)`. People.
- **enrollment_records** — `COUNT(*)`. One row per student, school year and term.

A student enrolled in three terms is **one** headcount and **three** records. The source
data conflated these, which is how a 38,007-student dataset came to report 42,890
"enrollees". Both are always on screen; `?metric=headcount|records` selects which one the
map colours by.

## Quick start

### 1. Database

```bash
createdb uc_enrollment
psql uc_enrollment -c "CREATE EXTENSION postgis;"
```

Any PostGIS 3.x will do — local, Neon, Supabase, or a Railway Postgres with the extension
enabled.

### 2. Backend

```bash
cd backend
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -e .
cp .env.example .env                              # then edit DATABASE_URL
uvicorn app.main:app --reload --port 8000
```

The schema is applied automatically by the loader and is idempotent — run it as often as
you like.

### 3. Load the data

Point the loader at the folder as it came out of Drive:

```bash
python -m app.etl --data-dir "/path/to/Dashboard Files"
```

It loads boundaries from the GeoPackages, then the CSV, and prints what it did:

```
boundaries: country           242 features
boundaries: province           88 features
boundaries: municipality     1642 features
batch 1: read 158101, inserted 158098, duplicates skipped 3, rejected 0

municipalities with no matching polygon (top 10):
    2083  Not Reported / Not Reported
     138  Riyadh / International
```

Re-running the same file inserts nothing: rows conflict on `(student_ref, school_year,
term, course)` and are skipped. Each term, drop in the new export and run it again.

Useful flags:

| Flag | Effect |
|---|---|
| `--dry-run` | validate the CSV, write nothing, list rejections |
| `--boundaries-only` / `--csv-only` | load one or the other |
| `--include-sensitive` | also store broad religion and civil status (off by default) |
| `--note "SY2027 T1 export"` | free text stored with the batch record |

No GDAL required: `app/gpkg.py` reads GeoPackages with stdlib `sqlite3` and hands the WKB
straight to PostGIS. (`ogr2ogr -f PostgreSQL` works too if you prefer it.)

### 4. Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173, proxies /api to :8000
```

Production build: `npm run build`, with `VITE_API_URL` set to the deployed API's origin
if it differs from the site's.

## API

All read endpoints accept the same filters, repeated for multiple values:
`school_year`, `term`, `college`, `course`, `program_group`, `status`, `year_level`,
`sex`, `nationality`, `region`, `province`, `country`, `metric`.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | status, PostGIS version, row counts |
| `GET /api/filters` | every filter vocabulary, plus courses grouped by college |
| `GET /api/summary` | totals, the school-year trend, and the standard breakdowns |
| `GET /api/breakdown/{dimension}` | one ranked dimension, both metrics |
| `GET /api/feeder-schools` | which schools send UC its students |
| `GET /api/geo/{level}` | GeoJSON with the metric attached (municipality level requires `?province=`) |
| `GET /api/tiles/{level}/{z}/{x}/{y}.pbf` | vector tiles — the national municipal view |
| `GET /api/scale/{level}` | quantile class breaks for the legend |
| `GET /api/geo/bbox/{level}?name=` | bounding box, for fly-to |
| `POST /api/ingest/validate` | dry-run an upload (needs `X-API-Key`) |
| `POST /api/ingest` | load an upload (needs `X-API-Key`) |

Interactive docs at `/docs` when the API is running.

### Why tiles and not GeoJSON

The source geometry is 678 MB for ~1,800 polygons. As vector tiles the browser receives
1–9 KB per view and the metric travels inside the tile, so changing a filter recolours
without a second geometry request. Country and provincial levels are small enough to also
be served as simplified GeoJSON, which is what `/api/geo/{level}` is for.

### Why there is no pre-aggregated cube

Headcount is a distinct count, which is not additive: no cube of per-cell counts can be
summed back into a correct headcount for an arbitrary filter. So aggregates are computed
live, and the composite indexes in `001_schema.sql` make the unfiltered municipal
choropleth land at ~150 ms on 158k rows; filtered views run in tens of milliseconds.

## Uploads

**Upload data** in the header opens the load desk: drop a term's CSV, it dry-runs the file
and reports how many rows will load, how many are refused and why, and only then offers
the Load button. After a load it refreshes every figure on the page and keeps a history of
every batch.

It is guarded by `INGEST_API_KEY`: set it on the API and whoever uploads types the same
key into the panel, where it is held in `sessionStorage` for that tab only. Left unset —
the default — the endpoints return 503 and the panel says uploads are switched off.

Be clear-eyed about what that is: one shared key, not a personal login. The batch record
keeps the file name and the time, not who uploaded it. Before this faces anyone outside
the office, put it behind the university SSO.

## Tests

```bash
cd backend && pytest          # 56 tests, needs a reachable PostGIS
cd frontend && npm test       # 31 tests
```

The backend suite creates and drops its own database (`TEST_DATABASE_URL`, default
`uc_enrollment_test`) and runs against real PostGIS — the identity join, `ST_AsMVT` and
the natural-key conflict are database behaviour, and mocking them would assert nothing.

Lint and typecheck: `ruff check app tests`, `npm run typecheck`.

## Known limits

- **Students who moved.** 7 students appear under two municipalities in different terms.
  Each is counted in both, so per-municipality headcounts sum to 38,014 against 38,007
  students nationally. Resolving this is a registrar decision about which address is
  authoritative, not an engineering one.
- **2,083 rows have no origin** and so never appear on the map, though they are in every
  total. The loader lists them.
- **Foreign cities have no polygon.** International students are mapped at country level
  only; `MUNICITY` values such as "Riyadh" have nowhere to land below that.
- **No authentication on the read API.** It exposes aggregates, not records, but it
  should sit behind the university's SSO or an allowlist before it faces the public
  internet. See `docs/DEPLOYMENT.md`.
