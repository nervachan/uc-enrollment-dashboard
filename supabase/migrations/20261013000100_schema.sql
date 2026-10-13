-- UC Enrollment Geography Dashboard — schema
-- PostgreSQL 16 + PostGIS 3.4
--
-- Design notes
--   * The GeoPackages are treated as GEOMETRY SOURCES ONLY. Every count served by the
--     API is recomputed from the enrollment table, because the shipped municipal layer
--     was joined on municipality name alone and is inflated (see docs/DATA-AUDIT.md).
--   * A municipality is identified by (name, province). Name alone is not unique in the
--     Philippines — "Rosario" exists in five provinces in this dataset.
--   * Two metrics are exposed separately and never conflated:
--       headcount           = COUNT(DISTINCT student_ref)
--       enrollment_records  = COUNT(*)
--   * Every table has Row Level Security on and no policies. On Supabase that means
--     the browser's publishable key cannot read or write any table through the Data
--     API; it can only call the functions in the read_api migration, which return
--     aggregates. The loader connects as the table owner, which RLS does not restrict.

CREATE EXTENSION IF NOT EXISTS postgis;

DO $$ BEGIN
    CREATE TYPE boundary_level AS ENUM ('country', 'province', 'municipality');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- boundaries

CREATE TABLE IF NOT EXISTS boundary (
    id           bigserial PRIMARY KEY,
    level        boundary_level NOT NULL,
    name         text           NOT NULL,
    province     text,                       -- municipalities only
    region       text,
    parent_id    bigint REFERENCES boundary(id) ON DELETE SET NULL,
    geom         geometry(MultiPolygon, 4326) NOT NULL,
    -- Pre-simplified geometry for GeoJSON responses at national zoom. Tolerance is in
    -- degrees; 0.005 ~= 500 m at this latitude, invisible on a country-wide choropleth.
    geom_simple  geometry(MultiPolygon, 4326),
    -- Web Mercator copy, maintained by the loader. Transforming 242 country polygons on
    -- every tile request cost ~2.1 s; reading a stored, indexed 3857 column costs ~40 ms.
    geom_3857    geometry(MultiPolygon, 3857),
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- Upgrades in place. CREATE TABLE IF NOT EXISTS does nothing to an existing table, so
-- every column added after the first release needs its own idempotent ALTER here.
ALTER TABLE boundary ADD COLUMN IF NOT EXISTS geom_simple geometry(MultiPolygon, 4326);
ALTER TABLE boundary ADD COLUMN IF NOT EXISTS geom_3857   geometry(MultiPolygon, 3857);

CREATE UNIQUE INDEX IF NOT EXISTS boundary_identity_idx
    ON boundary (level, name, COALESCE(province, ''));
CREATE INDEX IF NOT EXISTS boundary_geom_idx        ON boundary USING gist (geom);
CREATE INDEX IF NOT EXISTS boundary_geom_simple_idx ON boundary USING gist (geom_simple);
CREATE INDEX IF NOT EXISTS boundary_geom_3857_idx   ON boundary USING gist (geom_3857);
CREATE INDEX IF NOT EXISTS boundary_level_idx       ON boundary (level);

-- ---------------------------------------------------------------- ingest log

CREATE TABLE IF NOT EXISTS ingest_batch (
    id             bigserial PRIMARY KEY,
    filename       text        NOT NULL,
    sha256         text        NOT NULL,
    loaded_at      timestamptz NOT NULL DEFAULT now(),
    rows_read      integer     NOT NULL DEFAULT 0,
    rows_loaded    integer     NOT NULL DEFAULT 0,
    rows_rejected  integer     NOT NULL DEFAULT 0,
    note           text
);

CREATE TABLE IF NOT EXISTS ingest_rejection (
    id         bigserial PRIMARY KEY,
    batch_id   bigint NOT NULL REFERENCES ingest_batch(id) ON DELETE CASCADE,
    row_number integer NOT NULL,
    reason     text    NOT NULL,
    payload    jsonb
);

CREATE INDEX IF NOT EXISTS ingest_rejection_batch_idx ON ingest_rejection (batch_id);

-- ---------------------------------------------------------------- facts

CREATE TABLE IF NOT EXISTS enrollment (
    id              bigserial PRIMARY KEY,
    student_ref     text     NOT NULL,     -- USER_INDEX; pseudonymous, not a name
    school_year     smallint NOT NULL,
    term            smallint NOT NULL,
    course          text     NOT NULL,
    college         text,
    year_level      smallint,
    program_group   text,
    status          text,
    year_of_entry   smallint,
    term_of_entry   smallint,
    sex             text,
    broad_religion  text,
    civil_status    text,
    nationality     text,
    -- origin as reported, kept verbatim so a failed geo match is still queryable
    municity        text,
    province        text,
    region          text,
    country         text,
    prev_school     text,
    -- resolved geography
    municipality_id bigint REFERENCES boundary(id) ON DELETE SET NULL,
    province_id     bigint REFERENCES boundary(id) ON DELETE SET NULL,
    country_id      bigint REFERENCES boundary(id) ON DELETE SET NULL,
    batch_id        bigint REFERENCES ingest_batch(id) ON DELETE SET NULL
);

-- Natural key: a student appears once per school year, term and course.
CREATE UNIQUE INDEX IF NOT EXISTS enrollment_natural_key
    ON enrollment (student_ref, school_year, term, course);

CREATE INDEX IF NOT EXISTS enrollment_year_term_idx  ON enrollment (school_year, term);
CREATE INDEX IF NOT EXISTS enrollment_college_idx    ON enrollment (college);
CREATE INDEX IF NOT EXISTS enrollment_course_idx     ON enrollment (course);
CREATE INDEX IF NOT EXISTS enrollment_status_idx     ON enrollment (status);
CREATE INDEX IF NOT EXISTS enrollment_group_idx      ON enrollment (program_group);
CREATE INDEX IF NOT EXISTS enrollment_muni_idx       ON enrollment (municipality_id);
CREATE INDEX IF NOT EXISTS enrollment_prov_idx       ON enrollment (province_id);
CREATE INDEX IF NOT EXISTS enrollment_country_idx    ON enrollment (country_id);
CREATE INDEX IF NOT EXISTS enrollment_student_idx    ON enrollment (student_ref);

-- Headcount is COUNT(DISTINCT student_ref), which no pre-aggregated cube can make
-- additive, so it is always computed live. These composite indexes let the per-boundary
-- distinct count run as an index-only scan: the unfiltered municipal choropleth drops
-- from ~390 ms to ~150 ms on 158k rows, and filtered views land in the tens of ms.
CREATE INDEX IF NOT EXISTS enrollment_muni_student_idx    ON enrollment (municipality_id, student_ref);
CREATE INDEX IF NOT EXISTS enrollment_prov_student_idx    ON enrollment (province_id, student_ref);
CREATE INDEX IF NOT EXISTS enrollment_country_student_idx ON enrollment (country_id, student_ref);

-- ---------------------------------------------------------------- read models
--
-- 158k fact rows aggregate in single-digit milliseconds, so the API queries the fact
-- table directly rather than maintaining a cube. These views exist for QGIS, for ad-hoc
-- SQL, and as the documented definition of each metric.

CREATE OR REPLACE VIEW v_enrollment_geo AS
SELECT e.*,
       m.name  AS municipality_name,
       p.name  AS province_name,
       c.name  AS country_name
FROM enrollment e
LEFT JOIN boundary m ON m.id = e.municipality_id
LEFT JOIN boundary p ON p.id = e.province_id
LEFT JOIN boundary c ON c.id = e.country_id;

-- Per-municipality metrics. Replaces the inflated "Total Enrollees" column in the
-- shipped GeoPackage; joins on identity, not on name.
CREATE OR REPLACE VIEW v_municipality_totals AS
SELECT b.id   AS boundary_id,
       b.name AS municipality,
       b.province,
       b.region,
       COUNT(DISTINCT e.student_ref) AS headcount,
       COUNT(e.id)                   AS enrollment_records
FROM boundary b
LEFT JOIN enrollment e ON e.municipality_id = b.id
WHERE b.level = 'municipality'
GROUP BY b.id, b.name, b.province, b.region;

CREATE OR REPLACE VIEW v_province_totals AS
SELECT b.id   AS boundary_id,
       b.name AS province,
       COUNT(DISTINCT e.student_ref) AS headcount,
       COUNT(e.id)                   AS enrollment_records
FROM boundary b
LEFT JOIN enrollment e ON e.province_id = b.id
WHERE b.level = 'province'
GROUP BY b.id, b.name;

-- ---------------------------------------------------------------- access

ALTER TABLE boundary         ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_batch     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_rejection ENABLE ROW LEVEL SECURITY;

-- The read models would otherwise run with their owner's rights and skip RLS.
ALTER VIEW v_enrollment_geo      SET (security_invoker = true);
ALTER VIEW v_municipality_totals SET (security_invoker = true);
ALTER VIEW v_province_totals     SET (security_invoker = true);
REVOKE ALL ON v_enrollment_geo, v_municipality_totals, v_province_totals
    FROM anon, authenticated;
