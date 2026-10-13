-- Ingest API: the write path behind the dashboard's Upload data panel.
--
-- The browser never calls these. The `ingest` Edge Function does, with the service-role
-- key, after it has checked that the signed-in user is on the upload list. The CLI
-- loader (python -m app.etl) writes directly and does not use them; both paths share
-- the same natural key, identity join and batch record, so they produce the same rows.
--
-- Shape of an upload, mirroring backend/app/etl/enrollments.py:
--     ingest_begin   -> batch id
--     ingest_chunk   -> rows inserted, duplicates skipped, origins with no polygon
--                       (called once per few thousand rows)
--     ingest_finish  -> rejections recorded, batch totals written
-- Every insert is ON CONFLICT DO NOTHING on the natural key, so an upload that fails
-- halfway is repaired by uploading the same file again.

-- ---------------------------------------------------------------- who may upload

-- Email addresses allowed to upload from the dashboard. Add people with:
--     INSERT INTO ingest_admin (email) VALUES ('someone@uc-bcf.edu.ph');
CREATE TABLE IF NOT EXISTS ingest_admin (
    email     text PRIMARY KEY CHECK (email = lower(email)),
    added_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ingest_admin ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_ingest_admin(p_email text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
    SELECT EXISTS (SELECT 1 FROM ingest_admin WHERE email = lower(trim(p_email)))
$$;

-- ---------------------------------------------------------------- the load

CREATE OR REPLACE FUNCTION public.ingest_begin(p_filename text, p_sha256 text, p_note text DEFAULT NULL)
RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, extensions
AS $$
    INSERT INTO ingest_batch (filename, sha256, note)
    VALUES (p_filename, p_sha256, p_note)
    RETURNING id
$$;

-- p_rows: a JSON array of normalised rows, keys as in the staging table of the CLI
-- loader. Returns {"staged", "inserted", "unmatched_municipalities", "unmatched_countries"}.
CREATE OR REPLACE FUNCTION public.ingest_chunk(p_batch_id bigint, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    staged int;
    inserted int;
    unmatched_muni jsonb;
    unmatched_country jsonb;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ingest_batch WHERE id = p_batch_id) THEN
        RAISE EXCEPTION 'unknown batch %', p_batch_id USING ERRCODE = 'P0002';
    END IF;

    CREATE TEMP TABLE IF NOT EXISTS staging_upload (
        student_ref text, school_year smallint, term smallint, course text, college text,
        year_level smallint, program_group text, status text, year_of_entry smallint,
        term_of_entry smallint, sex text, broad_religion text, civil_status text,
        nationality text, municity text, province text, region text, country text,
        prev_school text
    ) ON COMMIT DROP;
    TRUNCATE staging_upload;

    INSERT INTO staging_upload
    SELECT * FROM jsonb_to_recordset(p_rows) AS r(
        student_ref text, school_year smallint, term smallint, course text, college text,
        year_level smallint, program_group text, status text, year_of_entry smallint,
        term_of_entry smallint, sex text, broad_religion text, civil_status text,
        nationality text, municity text, province text, region text, country text,
        prev_school text
    );
    GET DIAGNOSTICS staged = ROW_COUNT;

    -- Geography by identity: municipality by (name, province), never by name alone.
    INSERT INTO enrollment (
        student_ref, school_year, term, course, college, year_level, program_group,
        status, year_of_entry, term_of_entry, sex, broad_religion, civil_status,
        nationality, municity, province, region, country, prev_school,
        municipality_id, province_id, country_id, batch_id
    )
    SELECT s.student_ref, s.school_year, s.term, s.course, s.college, s.year_level,
           s.program_group, s.status, s.year_of_entry, s.term_of_entry, s.sex,
           s.broad_religion, s.civil_status, s.nationality, s.municity, s.province,
           s.region, s.country, s.prev_school,
           m.id, p.id, c.id, p_batch_id
    FROM staging_upload s
    LEFT JOIN boundary p ON p.level = 'province'     AND p.name = s.province
    LEFT JOIN boundary m ON m.level = 'municipality' AND m.name = s.municity
                                                     AND m.province = s.province
    LEFT JOIN boundary c ON c.level = 'country'      AND c.name = s.country
    ON CONFLICT (student_ref, school_year, term, course) DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;

    -- Which origins could not be placed on the map, and how many rows each cost.
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'municity', t.municity, 'province', t.province, 'rows', t.n)), '[]'::jsonb)
    INTO unmatched_muni
    FROM (SELECT s.municity, s.province, count(*) AS n
          FROM staging_upload s
          LEFT JOIN boundary m ON m.level = 'municipality' AND m.name = s.municity
                              AND m.province = s.province
          WHERE m.id IS NULL AND s.municity IS NOT NULL
          GROUP BY 1, 2) t;

    SELECT coalesce(jsonb_agg(jsonb_build_object('country', t.country, 'rows', t.n)), '[]'::jsonb)
    INTO unmatched_country
    FROM (SELECT s.country, count(*) AS n
          FROM staging_upload s
          LEFT JOIN boundary c ON c.level = 'country' AND c.name = s.country
          WHERE c.id IS NULL AND s.country IS NOT NULL
          GROUP BY 1) t;

    UPDATE ingest_batch SET rows_loaded = rows_loaded + inserted WHERE id = p_batch_id;

    RETURN jsonb_build_object(
        'staged', staged, 'inserted', inserted,
        'unmatched_municipalities', unmatched_muni,
        'unmatched_countries', unmatched_country
    );
END
$$;

-- p_rejections: [{"row_number": 12, "reason": "...", "payload": {...}}, ...]
CREATE OR REPLACE FUNCTION public.ingest_finish(p_batch_id bigint, p_rows_read int, p_rejections jsonb DEFAULT '[]')
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    rejected int;
    result jsonb;
BEGIN
    INSERT INTO ingest_rejection (batch_id, row_number, reason, payload)
    SELECT p_batch_id, r.row_number, r.reason, r.payload
    FROM jsonb_to_recordset(coalesce(p_rejections, '[]'::jsonb))
         AS r(row_number int, reason text, payload jsonb);

    SELECT count(*) INTO rejected FROM ingest_rejection WHERE batch_id = p_batch_id;

    UPDATE ingest_batch
    SET rows_read = p_rows_read, rows_rejected = rejected
    WHERE id = p_batch_id
    RETURNING to_jsonb(ingest_batch.*) INTO result;

    IF result IS NULL THEN
        RAISE EXCEPTION 'unknown batch %', p_batch_id USING ERRCODE = 'P0002';
    END IF;
    RETURN result;
END
$$;

-- ---------------------------------------------------------------- grants

-- Service role only: the browser's publishable key must not be able to write.
REVOKE ALL ON FUNCTION
    public.is_ingest_admin(text), public.ingest_begin(text, text, text),
    public.ingest_chunk(bigint, jsonb), public.ingest_finish(bigint, int, jsonb)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.is_ingest_admin(text), public.ingest_begin(text, text, text),
    public.ingest_chunk(bigint, jsonb), public.ingest_finish(bigint, int, jsonb)
TO service_role;

NOTIFY pgrst, 'reload schema';
