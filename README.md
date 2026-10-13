# UC Enrollment Geography Dashboard

Where University of the Cordilleras students come from — by country, province and
municipality, filterable by school year, term, college, program and enrollment status.

Built for the UC AI Unit from the registrar's SY2023–SY2026 extract (158,101 enrollment
records, 38,007 students) and the boundary GeoPackages in the `Dashboard Files` folder.

| Layer | Choice |
|---|---|
| Database | **Supabase** — PostgreSQL + **PostGIS**, schema in `supabase/migrations/` |
| API | Postgres functions called through Supabase (no server of our own — the work here is SQL) |
| Tiles | `ST_AsMVT` vector tiles from the `tile` function |
| Uploads | Supabase Edge Function `ingest`, behind Supabase Auth email sign-in |
| Loader | Python + psycopg 3 (`backend/`), run from a PC for boundaries and big CSVs |
| Frontend | React 19 + Vite 8 + **Tailwind 4 (CSS-first)** + MapLibre GL 6 + TanStack Query + supabase-js |
| Tests | pytest against a real PostGIS (`backend/`), Vitest (`frontend/`, including the Edge Function) |

**Read [`docs/DATA-AUDIT.md`](docs/DATA-AUDIT.md) first.** The counts in the source
GeoPackages are inflated by a join on municipality name alone; this application
recomputes everything from the CSV and treats those files as geometry only.

## The two metrics

Everything in the API and the UI is one of:

- **headcount** — `COUNT(DISTINCT student_ref)`. People.
- **enrollment_records** — `COUNT(*)`. One row per student, school year and term.

A student enrolled in three terms is **one** headcount and **three** records. The source
data conflated these, which is how a 38,007-student dataset came to report 42,890
"enrollees". Both are always on screen; the `metric` filter (`headcount` or `records`)
selects which one the map colours by.

## Quick start

### 1. Database (Supabase)

Create a Supabase project, then apply the schema — tables, PostGIS, row-level security
and the API functions — with the Supabase CLI:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

(Or paste each file in `supabase/migrations/`, in order, into the SQL Editor.) Every
migration is idempotent.

### 2. Loader

```bash
cd backend
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -e .
cp .env.example .env                              # then set DATABASE_URL
```

`DATABASE_URL` is Supabase's **Session pooler** connection string (Connect → Session
pooler) with `?sslmode=require`. The loader applies the migrations itself too, so it also
works against a plain local PostGIS.

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
cp .env.example .env     # VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
npm install
npm run dev              # http://localhost:5173, talking to your Supabase project
```

Both variables are read at **build** time.

## Data API

The browser calls Postgres functions through Supabase (`/rest/v1/rpc/<name>`). Each read
function takes the filters as one JSON argument `f`, e.g.
`{"college": ["COE"], "school_year": [2025], "metric": "records"}`; recognised keys are
`school_year`, `term`, `college`, `course`, `program_group`, `status`, `year_level`,
`sex`, `nationality`, `region`, `province`, `country`, `metric`.

| Function | Purpose |
|---|---|
| `health()` | status, PostGIS version, row counts |
| `filter_options()` | every filter vocabulary, plus courses grouped by college |
| `summary(f)` | totals, the school-year trend, and the standard breakdowns |
| `breakdown(dimension, f, lim)` | one ranked dimension, both metrics |
| `feeder_schools(f, lim)` | which schools send UC its students |
| `geo(level, f, province)` | GeoJSON with the metric attached (municipality level needs a province) |
| `tile(level, z, x, y, f)` | vector tile bytes — the national municipal view |
| `scale(level, f, classes)` | quantile class breaks for the legend |
| `bbox(level, name, province)` | bounding box, for fly-to |
| `batches()` | load history |

All of them return aggregates or geometry only. Every table has row-level security on
with no policies, so the publishable key cannot read a single enrollment row directly;
it can only call these functions. Uploads go to the `ingest` Edge Function instead
(`POST /functions/v1/ingest`, `?dry_run=1` to validate without writing).

### Why tiles and not GeoJSON

The source geometry is 678 MB for ~1,800 polygons. As vector tiles the browser receives
1–9 KB per view and the metric travels inside the tile, so changing a filter recolours
without a second geometry request. Country and provincial levels are small enough to also
be served as simplified GeoJSON, which is what the `geo` function is for.

### Why there is no pre-aggregated cube

Headcount is a distinct count, which is not additive: no cube of per-cell counts can be
summed back into a correct headcount for an arbitrary filter. So aggregates are computed
live, and the composite indexes in the schema migration make the unfiltered municipal
choropleth land at ~150 ms on 158k rows; filtered views run in tens of milliseconds.

## Uploads

**Upload data** in the header opens the load desk. Sign in with your email (Supabase
sends a one-time link; there is no password), drop a term's CSV, and the file is checked
straight away: how many rows will load, how many are refused and why. Only then is the
Load button offered. After a load every figure on the page refreshes, and the panel keeps
a history of every batch.

Only addresses on the upload list can load data. Add someone in the SQL Editor:

```sql
INSERT INTO ingest_admin (email) VALUES ('someone@uc-bcf.edu.ph');
```

The batch record notes who uploaded it. Files over 20 MB (`MAX_UPLOAD_MB` on the Edge
Function) are refused with a pointer to the command-line loader, which is also the only
path that can load boundaries.

## Tests

```bash
cd backend && pytest          # needs a reachable PostGIS; creates its own database
cd frontend && npm test       # UI, data layer, Edge Function handler, validator parity
```

The backend suite runs the migrations against real PostGIS and calls the API functions
directly — the identity join, `ST_AsMVT`, row-level security and the natural-key conflict
are database behaviour, and mocking them would assert nothing. Point
`TEST_DATABASE_URL`/`ADMIN_DATABASE_URL` at a scratch server; the test role needs
`CREATEDB` and `CREATEROLE` (the migrations create Supabase's `anon`, `authenticated`
and `service_role` roles when they are missing).

The CSV validator exists twice — Python for the loader, TypeScript for the Edge
Function — and both are tested against `supabase/functions/_shared/validate.cases.json`,
which is generated from the Python one.

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
- **No sign-in for reading.** Anyone with the site's URL can see the aggregates (never
  individual records). Put the site behind the university's SSO or an allowlist before
  it faces the public internet. See `docs/DEPLOYMENT.md`.
