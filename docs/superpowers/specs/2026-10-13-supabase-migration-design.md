# Supabase migration — design

Date: 2026-10-13 · Status: approved and implemented

## Goal

Make the dashboard easier to deploy by removing the Python API server. Supabase
(Postgres + PostGIS) holds the data **and** serves every read and write; Vercel serves
only the static frontend. Every feature the dashboard has today keeps working with the
same numbers.

### What the user asked for

- "Refactor all logic to point all CRUD to Supabase, and add PostGIS."
- Supabase browser config (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) is
  already in `frontend/.env`, and `@supabase/supabase-js` is installed.
- Uploads from the dashboard go through a **Supabase Edge Function**.

### Assumptions (correct these if wrong)

- remove ingestion api key functionality and change it to an easier ingest flow
  → **Decision:** no shared key. Uploaders sign in with a Supabase Auth email link (no
  password); only addresses in the `ingest_admin` table may load. Uploads are not left
  open, because anyone with the URL could then write to the enrollment table. Choosing
  a file checks it immediately; one click loads it.
- The Python loader stays as the way to load boundaries and large CSVs from a PC. The
  678 MB of GeoPackages never leave the operator's machine.
- `@supabase/ssr` is not needed (this is a client-only SPA, no server rendering) and is
  removed.

## Architecture after the change

```
Browser (Vercel static site)
  ├─ supabase-js ──► PostgREST /rest/v1/rpc/*     read functions (publishable key)
  ├─ MapLibre ─────► PostgREST /rest/v1/rpc/tile  vector tiles, bytea
  └─ Upload panel ─► Edge Function /functions/v1/ingest   (signed-in user JWT)
                         └─ service-role RPC ──► ingest_* functions
PC: python -m app.etl ──► Postgres (session pooler DATABASE_URL)
```

Removed: FastAPI app (`backend/app/main.py`, `backend/app/routers/`, `filters.py`,
`db.py` pool), the Vercel/Render API deployment, `VITE_API_URL`.

## 1. Database — `supabase/migrations/`

Single source of truth for the schema, applied with `supabase db push` or pasted into
the SQL Editor. The Python loader and the test suite apply the same files.

- `…_schema.sql` — today's `001_schema.sql` unchanged in substance:
  `CREATE EXTENSION IF NOT EXISTS postgis`, tables, indexes, views.
  Adds `ENABLE ROW LEVEL SECURITY` on `boundary`, `enrollment`, `ingest_batch`,
  `ingest_rejection` with **no policies**, so the publishable key cannot read or write
  any table directly through the Data API.
- `…_roles.sql` — creates `anon`, `authenticated`, `service_role` only if missing, so
  the migrations also run on plain local Postgres for tests. No-op on Supabase.
- `…_read_api.sql` — read functions (below).
- `…_ingest_api.sql` — write functions (section 3).

### Read functions

All `SECURITY DEFINER`, `STABLE`, `SET search_path = public, extensions`, and
`GRANT EXECUTE … TO anon, authenticated`. They return aggregates and geometry only;
no function returns `student_ref` or any row-level data.

Filters arrive as one `f jsonb` argument shaped like the frontend's `Filters`
(`{"school_year":[2024],"college":["CEA"],"metric":"records",...}`). A shared SQL
helper `enrollment_filtered(f jsonb)` returns the matching enrollment rows, applying
only the whitelisted keys from today's `FILTER_COLUMNS`; unknown keys are ignored.
The metric switch (`COUNT(DISTINCT student_ref)` vs `COUNT(*)`) is a `CASE` on
`f->>'metric'`.

| Today | Function | Returns |
|---|---|---|
| `GET /api/health` | `health()` | `{status, postgis, enrollment_rows, boundaries}` |
| `GET /api/filters` | `filter_options()` | same JSON as today |
| `GET /api/summary` | `summary(f)` | same JSON as today |
| `GET /api/breakdown/{dim}` | `breakdown(dimension, f, lim)` | same rows; unknown dimension raises |
| `GET /api/feeder-schools` | `feeder_schools(f, lim)` | same rows |
| `GET /api/geo/{level}` | `geo(level, f, province, simplified)` | FeatureCollection JSON |
| `GET /api/tiles/{level}/{z}/{x}/{y}.pbf` | `tile(level, z, x, y, f)` | `bytea` (MVT) |
| `GET /api/scale/{level}` | `scale(level, f, classes)` | `{min, max, breaks}` (quantiles) |
| `GET /api/geo/bbox/{level}` | `bbox(level, name, province)` | `{minx, miny, maxx, maxy}` |
| `GET /api/batches` | `batches()` | last 100 batches |

The SQL bodies are today's queries moved as-is. Input checks that the routes did
(tile coordinates in range, `classes` 2–9, municipality GeoJSON needs a province,
limits) become `RAISE EXCEPTION` with the same messages.

**Tiles.** MapLibre requests
`{SUPABASE_URL}/rest/v1/rpc/tile?level=…&z={z}&x={x}&y={y}&f=<urlencoded json>` with
`Accept: application/octet-stream` and the `apikey` header added via MapLibre's
`transformRequest`. PostgREST returns a function's `bytea` result raw for that
`Accept` type.

**Scale fallback.** The "quantiles are degenerate → use log breaks" logic
(`_quantiles_are_degenerate`, `_log_breaks`) moves to `frontend/src/lib/scale.ts`, a
pure function with tests ported from `tests/test_scale.py`. The `Scale` type the
components use is unchanged, including `method`.

**Timeouts.** Supabase limits the `anon` role to short statements (3 s by default).
The heaviest query today is ~400 ms, so this should hold; the migration sets
`ALTER ROLE anon SET statement_timeout = '15s'` as headroom for cold caches.

## 2. Frontend

- `src/lib/supabase.ts` — one client from `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_PUBLISHABLE_KEY`; a clear error message if either is missing.
- `src/lib/api.ts` — same exported `api` object, types and names; each method calls
  `supabase.rpc(...)` instead of `fetch`. Components keep calling `api.summary(filters)`
  etc. `toSearchParams`/`apiUrl` are replaced by a `tileUrl(level, filters)` helper.
- `MapPanel.tsx` — tile source URL from `tileUrl`, plus `transformRequest` adding
  `apikey` and `Accept` for Supabase tile requests only.
- `App.tsx` — the "API unreachable" message names the Supabase variables instead of
  `VITE_API_URL`.
- `UploadPanel.tsx` — email sign-in link instead of the key field (`lib/auth.ts`);
  choosing a file runs the dry run at once; posts to the Edge Function
  (`/functions/v1/ingest`, `?dry_run=1`) with the user's access token. Responses keep
  today's shape.
- `vite.config.ts` — the `/api` proxy is removed.
- `.env.example` — `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.

## 3. Uploads — Edge Function `supabase/functions/ingest/`

Deno/TypeScript. Replaces `POST /api/ingest` and `POST /api/ingest/validate`.

1. Reject without a valid Supabase Auth access token (401), or when the user's email is
   not in `ingest_admin` (403, naming the address). Gateway JWT verification is off
   (`supabase/config.toml`) so the function can answer with these messages itself.
2. Enforce `MAX_UPLOAD_MB` (default 20; 413 above it). Large initial loads use the
   Python loader.
3. Parse and validate the CSV with `supabase/functions/_shared/validate.ts`, a port of
   `backend/app/validate.py` (same column map, cleaning, sensitive-field exclusion, range
   checks, messages).
4. `?dry_run=1` returns the validation report, as `/api/ingest/validate` does today.
5. Otherwise, with the service-role client:
   `ingest_begin(filename, sha256, note) → batch_id`, then
   `ingest_chunk(batch_id, rows jsonb)` in chunks of 5,000 rows, then
   `ingest_finish(batch_id, rows_read, rejections jsonb)` → result.
   The chunk function is today's `INSERT_FROM_STAGING` (identity join on
   municipality + province, `ON CONFLICT DO NOTHING`); finish computes unmatched
   municipalities/countries for the batch, writes rejections and the batch totals.
   These three functions, and `is_ingest_admin`, are `GRANT`ed to `service_role` only.

Because inserts are idempotent on the natural key, a failure partway is fixed by
uploading the same file again — the same guarantee the CLI loader gives.

**Parity.** Python and TypeScript validators are tested against one shared fixture
file (`supabase/functions/_shared/validate.cases.json`: input row → expected row or
rejection reason), so the CLI and the upload panel cannot drift apart.

## 4. Python loader — `backend/`

Kept for boundaries and big CSV loads. `apply_schema` applies
`supabase/migrations/*.sql` in order instead of `app/sql/001_schema.sql`.
FastAPI, uvicorn and python-multipart are dropped from dependencies; `psycopg` and
`pydantic-settings` remain. `DATABASE_URL` is Supabase's **session pooler** string
(works over IPv4; the direct connection is IPv6-only on the free plan).

## 5. Testing

- **SQL functions** — `backend/tests/test_rpc.py` replaces `test_api.py`: the same
  assertions, calling the functions through psycopg against a PostGIS test database
  (local, or a Supabase branch via `TEST_DATABASE_URL`). Includes: anon cannot
  `SELECT` from `enrollment`; anon cannot execute `ingest_*`.
- **Validator parity** — pytest and the frontend test runner both run the shared cases.
- **Frontend** — existing tests updated for the supabase-backed `api`; new tests for
  `scale.ts` and `tileUrl`.
- **Manual** — after deploy: tiles show 38,007 / 158,098, provincial map coloured,
  Benguet municipal drill-down renders, dry-run upload of a small CSV succeeds.

## 6. Deployment (replaces docs/DEPLOYMENT.md)

1. Supabase project (Singapore). Run the migrations.
2. Settings → API: keep the Data API on (the frontend needs RPC); tables are
   protected by RLS. Add the Vercel URL to allowed CORS origins if restricted.
3. From a PC: simplify geometry locally and `pg_restore` (PDF storage section), or
   run `python -m app.etl` against the session-pooler URL. Free tier is 500 MB; the
   simplified database is ~210 MB, the unsimplified one does not fit.
4. `supabase functions deploy ingest`; add the Vercel URL to Auth → Redirect URLs;
   `INSERT INTO ingest_admin (email) VALUES (…)` for each uploader.
5. Vercel: root `frontend`, env `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`.
   Delete the separate API project.

Free-tier note: Supabase pauses free projects after 7 days without activity.

## Out of scope

SSO for reading the dashboard, changes to the dashboard's UI or metrics, a new geometry pipeline.

## Risks

- **PostgREST bytea tiles + MapLibre headers** is the one piece not exercised today.
  It is built and checked first; fallback is serving tiles from a second Edge
  Function.
- **anon statement timeout** on cold caches — mitigated above; watch the first loads.
- **Edge Function limits** (memory, wall-clock) cap upload size; the 20 MB default
  keeps a term's export well inside them.
