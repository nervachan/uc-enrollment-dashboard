# Deployment

GitHub for the code, Render for the API, Vercel (or a Render Static Site) for the
frontend, and a managed Postgres with PostGIS. This serves one university office, so
nothing here needs to scale.

## Required settings

| Setting | Where | Value |
|---|---|---|
| `DATABASE_URL` | backend | `postgresql://user:pass@host:5432/uc_enrollment` (add `?sslmode=require` from outside the provider's network) |
| `CORS_ORIGINS` | backend | the exact frontend origin, no trailing slash |
| `INGEST_API_KEY` | backend | set it to turn on the in-app **Upload data** panel; unset makes the ingest routes return 503 and the panel say so. One shared key, not a personal login |
| `PYTHON_VERSION` | backend (Render) | `3.13.1`, so the interpreter is pinned rather than inherited |
| `VITE_API_URL` | frontend build | the API origin. Read at **build** time — changing it needs a redeploy |

## The four steps

1. **GitHub.** `git init -b main`, check `git status` shows no `.env`, `.gpkg` or `.csv`,
   commit, push to a private repository.
2. **Database.** Create Postgres on Render or Neon, then `CREATE EXTENSION postgis;`.
   Both support PostGIS. Render's free database **expires 30 days after creation**;
   Neon's free tier does not expire.
3. **API on Render.** Web Service, Root Directory `backend`, build
   `pip install -r requirements.txt`, start
   `uvicorn app.main:app --host 0.0.0.0 --port $PORT`, health check `/api/health`.
4. **Frontend on Vercel.** Framework Vite, Root Directory `frontend`, set
   `VITE_API_URL`. Then set the API's `CORS_ORIGINS` to the Vercel URL and redeploy.

Load the data afterwards, from a machine that has the GeoPackages — they are 678 MB and
do not belong in the repository:

```bash
DATABASE_URL=<production url> python -m app.etl --data-dir "/path/to/Dashboard Files"
```

## Storage: read this before picking a plan

Loaded as-is, the full boundary set does not fit a 1 GB free database. Measured on the
21-province test build, and scaled to the full 1,642 municipalities:

| | Test subset (measured) | Full dataset (estimated) |
|---|---|---|
| `boundary` table, as loaded | 73 MB | ~1.5 GB |
| whole database, as loaded | 167 MB | ~1.6 GB |
| `boundary` after simplifying | 6.3 MB | ~130 MB |
| whole database after simplifying | 100 MB | ~210 MB |

Simplifying the stored geometry to 0.0005° (~55 m) cut the boundary table by 92% with no
visible change to the municipal map and no invalid geometry:

```sql
UPDATE boundary
SET geom = ST_Multi(ST_MakeValid(ST_SimplifyPreserveTopology(geom, 0.0005))),
    geom_3857 = ST_Multi(ST_MakeValid(ST_Transform(ST_SimplifyPreserveTopology(geom, 0.0005), 3857)));
```

Then, as separate statements, `VACUUM FULL boundary;` and `ANALYZE boundary;`.

`VACUUM FULL` needs temporary space equal to the old table, which a 1 GB instance does
not have — so simplify **locally** and move the finished database up:

```bash
pg_dump -Fc --no-owner --no-acl -f uc.dump uc_enrollment
pg_restore --no-owner --no-acl -d "<production url>" uc.dump
```

Create the PostGIS extension in the target first; `pg_restore` warns that it already
exists, which is harmless. The compressed dump is ~60 MB rather than a 678 MB upload.

## Two traps

- **`.mjs` must be served as JavaScript.** MapLibre's worker is built as
  `assets/maplibre-gl-worker-*.mjs`. Served as `application/octet-stream`, the browser
  refuses it as a module worker and the map renders blank while everything else works.
  Vercel and Render get this right; on your own nginx add `types { application/javascript mjs; }`.
- **Render's free web service sleeps** after 15 minutes idle and takes about a minute to
  wake. Fine for an office dashboard, surprising if nobody warned you.

## Before it faces the public internet

- Put the read API behind the university SSO, an allowlist or basic auth. It serves
  aggregates rather than records, but enrollment geography is still institutional data.
- Vercel's Hobby plan is restricted to non-commercial, personal use. A university office
  dashboard is institutional use — either run it on a Pro team or serve the built
  frontend from a Render Static Site, which has no such restriction.
- `INGEST_API_KEY` is a single shared secret: anyone holding it can write to the fact
  table, and nothing records which person uploaded. Fine inside the office, not fine on a
  public URL — put the upload panel behind SSO before the dashboard leaves the building.
- The frontend sends `noindex, nofollow`. Remove it only when the University has approved
  publication.
- Do not load with `--include-sensitive`. Religion and civil status answer nothing on
  this dashboard and are sensitive personal information under the Data Privacy Act.
