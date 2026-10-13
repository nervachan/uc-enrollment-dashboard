# Deployment

Two services, no server of our own:

- **Supabase** holds the data (Postgres + PostGIS), serves every read through database
  functions, sends sign-in emails, and runs the `ingest` Edge Function for uploads.
- **Vercel** serves the built frontend as static files.

The 678 MB of GeoPackages never go to either. You load them from your own PC with the
Python loader, pointed at Supabase.

This serves one university office, so nothing here needs to scale.

## Settings at a glance

| Setting | Where | Value |
|---|---|---|
| `VITE_SUPABASE_URL` | Vercel (frontend build) | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Vercel (frontend build) | the project's publishable key (`sb_publishable_…`) |
| `DATABASE_URL` | `backend/.env` on your PC | Session pooler string + `?sslmode=require` |
| `MAX_UPLOAD_MB` | Edge Function secret (optional) | default 20 |

The two `VITE_` values are public by design and are read at **build** time — change
them on Vercel and redeploy. `DATABASE_URL` holds the database password: it stays in
`backend/.env`, which git ignores.

## Step 1 — Supabase project

1. supabase.com → **New project**. Region: **Southeast Asia (Singapore)**. Save the
   database password somewhere safe.
2. Apply the schema. From the repository root:

   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```

   This creates PostGIS, the tables (all with row-level security), and the API
   functions. No CLI? Paste each file in `supabase/migrations/` into the **SQL Editor**,
   oldest first.
3. Check it: SQL Editor → `select health();` should return `"status": "ok"`, a PostGIS
   version, and zero rows.

## Step 2 — Load the data from your PC

In Supabase, **Connect → Session pooler**, copy the URI and put it in `backend/.env` as
`DATABASE_URL`, with `?sslmode=require` on the end. (The Session pooler works from any
network; the "direct connection" is IPv6-only on the free plan.)

```bash
cd backend
.venv\Scripts\activate
python -m app.etl --data-dir "D:\...\Dashboard Files" --note "first production load"
```

Expect the same output as a local load. Then `select health();` should show
158,098 enrollment rows and 1,972 boundaries.

**Read the storage section below first** — on the free plan you must simplify the
geometry, and doing that locally then restoring is much faster than uploading 678 MB.

## Step 3 — Uploads (Edge Function + sign-in)

```bash
npx supabase functions deploy ingest
```

Then in the Supabase dashboard:

1. **Authentication → URL Configuration**: set **Site URL** to your Vercel URL and add it
   (and `http://localhost:5173` for development) to **Redirect URLs**. Sign-in links only
   return to addresses on this list.
2. **SQL Editor** — say who may upload:

   ```sql
   INSERT INTO ingest_admin (email) VALUES ('registrar@uc-bcf.edu.ph');
   ```

   Anyone can request a sign-in link, but only these addresses can load data.
3. Optional: `npx supabase secrets set MAX_UPLOAD_MB=30`. Keep it modest; very large
   files belong to the command-line loader.

Supabase's built-in email sender is rate-limited (a few emails an hour) and meant for
testing. For regular use, set up custom SMTP under **Authentication → Emails**.

## Step 4 — Frontend on Vercel

**Add New → Project**, import the repository, then:

| Field | Value |
|---|---|
| Root Directory | `frontend` |
| Framework Preset | Vite |
| Build Command / Output | defaults (`npm run build`, `dist`) |
| Environment Variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` |

Deploy. Open the URL: the tiles should read 38,007 students and 158,098 records, the
provincial map should be coloured, and Municipality → Benguet should draw the municipal
tiles. Then sign in from **Upload data** to check the email link returns to the site.

If you previously deployed the Python API as a second Vercel (or Render) project, delete
it — nothing uses it now.

## Storage: read this before picking a plan

Supabase's free plan includes **500 MB** of database. Loaded as-is, the full boundary set
does not fit. Measured on the 21-province test build, and scaled to the full 1,642
municipalities:

| | Test subset (measured) | Full dataset (estimated) |
|---|---|---|
| `boundary` table, as loaded | 73 MB | ~1.5 GB |
| whole database, as loaded | 167 MB | ~1.6 GB |
| `boundary` after simplifying | 6.3 MB | ~130 MB |
| whole database after simplifying | 100 MB | ~210 MB |

Simplifying the stored geometry to 0.0005° (~55 m) cut the boundary table by 92% with no
visible change to the municipal map and no invalid geometry. Do it on a **local** PostGIS
(load there first with the same loader), because `VACUUM FULL` needs free space equal to
the old table:

```sql
UPDATE boundary
SET geom = ST_Multi(ST_MakeValid(ST_SimplifyPreserveTopology(geom, 0.0005))),
    geom_3857 = ST_Multi(ST_MakeValid(ST_Transform(ST_SimplifyPreserveTopology(geom, 0.0005), 3857)));
```

Then, as separate statements, `VACUUM FULL boundary;` and `ANALYZE boundary;`. Copy only
the data up (the schema is already there from Step 1):

```bash
pg_dump -Fc --data-only --no-owner --no-acl -t boundary -t ingest_batch -t ingest_rejection -t enrollment -f uc.dump uc_enrollment
pg_restore --data-only --no-owner --no-acl --single-transaction -d "<session pooler url>" uc.dump
```

Then, in the Supabase SQL Editor, move the id counters past the restored rows so the
next upload does not collide with them:

```sql
SELECT setval(pg_get_serial_sequence('boundary', 'id'),         (SELECT max(id) FROM boundary));
SELECT setval(pg_get_serial_sequence('ingest_batch', 'id'),     (SELECT max(id) FROM ingest_batch));
SELECT setval(pg_get_serial_sequence('ingest_rejection', 'id'), greatest((SELECT max(id) FROM ingest_rejection), 1));
SELECT setval(pg_get_serial_sequence('enrollment', 'id'),       (SELECT max(id) FROM enrollment));
ANALYZE;
```

`uc.dump` contains the enrollment data; `*.dump` is git-ignored, and it should be
deleted once restored.

## Things that surprise people

- **Free projects pause** after 7 days without activity. The dashboard then shows "the
  data could not be loaded"; restore the project from the Supabase dashboard.
- **`VITE_` variables are baked in at build time.** Changing them on Vercel does nothing
  until you redeploy.
- **Sign-in link opens a blank or wrong page** — the site's URL is missing from
  Authentication → Redirect URLs.
- **"… is not on the upload list"** — add the address to `ingest_admin`.
- **`.mjs` must be served as JavaScript.** MapLibre's worker is built as
  `assets/maplibre-gl-worker-*.mjs`. Vercel gets this right; on your own nginx add
  `types { application/javascript mjs; }`.

## Before it faces the public internet

- Reading needs no sign-in: anyone with the URL sees the aggregates (never individual
  records — row-level security keeps every table closed to the publishable key). Put the
  site behind the university SSO or an allowlist before it is shared widely.
- Vercel's Hobby plan is restricted to non-commercial, personal use. A university office
  dashboard is institutional use — run it on a Pro team, or serve the built `dist/` from
  another static host.
- Keep `ingest_admin` short, and remove people when they change roles.
- The frontend sends `noindex, nofollow`. Remove it only when the University has approved
  publication.
- Do not load with `--include-sensitive`. Religion and civil status answer nothing on
  this dashboard and are sensitive personal information under the Data Privacy Act. The
  upload panel never stores them.
