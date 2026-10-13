-- Read API: everything the dashboard reads, as functions the browser calls through
-- Supabase (PostgREST /rest/v1/rpc/<name>).
--
-- Each public function is SECURITY DEFINER, so it reads the RLS-protected tables with
-- its owner's rights, and returns aggregates and geometry only — never student_ref or
-- any other row-level value. Filters arrive as one jsonb argument shaped like the
-- frontend's Filters object: {"college": ["COE"], "school_year": [2025], "metric": "records"}.
-- Only the keys in private.where_sql's whitelist are honoured; anything else is ignored.

-- ---------------------------------------------------------------- helpers (private)

-- Values for one filter key: a JSON array, a single scalar, or absent. NULL means
-- "no filter on this key".
CREATE OR REPLACE FUNCTION private.filter_values(f jsonb, key text)
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN f -> key IS NULL OR jsonb_typeof(f -> key) = 'null' THEN NULL
        WHEN jsonb_typeof(f -> key) = 'array' THEN NULLIF(
            ARRAY(SELECT jsonb_array_elements_text(f -> key)), '{}'::text[])
        ELSE ARRAY[f ->> key]
    END
$$;

-- " WHERE ..." for the enrollment alias, or ''. Values are quoted with %L and column
-- names come from this list, never from the request — the whitelist is the security
-- boundary, as FILTER_COLUMNS was in the Python API.
CREATE OR REPLACE FUNCTION private.where_sql(f jsonb, alias text DEFAULT 'e')
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    spec record;
    vals text[];
    clauses text[] := '{}';
BEGIN
    FOR spec IN
        SELECT * FROM (VALUES
            ('school_year', 'int'), ('term', 'int'), ('college', 'text'),
            ('course', 'text'), ('program_group', 'text'), ('status', 'text'),
            ('year_level', 'int'), ('sex', 'text'), ('nationality', 'text'),
            ('region', 'text'), ('province', 'text'), ('country', 'text')
        ) AS t(col, typ)
    LOOP
        vals := private.filter_values(coalesce(f, '{}'::jsonb), spec.col);
        IF vals IS NOT NULL THEN
            clauses := clauses || format('%I.%I = ANY(%L::%s[])', alias, spec.col, vals, spec.typ);
        END IF;
    END LOOP;
    IF cardinality(clauses) = 0 THEN
        RETURN '';
    END IF;
    RETURN ' WHERE ' || array_to_string(clauses, ' AND ');
END
$$;

-- The selected metric. headcount counts people, records counts enrollment rows; a
-- student enrolled in three terms is one headcount and three records.
CREATE OR REPLACE FUNCTION private.measure_sql(f jsonb, alias text DEFAULT 'e')
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE WHEN coalesce(f ->> 'metric', 'headcount') = 'records'
        THEN format('COUNT(%I.id)', alias)
        ELSE format('COUNT(DISTINCT %I.student_ref)', alias)
    END
$$;

CREATE OR REPLACE FUNCTION private.metric(f jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE WHEN coalesce(f ->> 'metric', 'headcount') = 'records'
        THEN 'records' ELSE 'headcount' END
$$;

-- Which enrollment column carries the boundary id at each level.
CREATE OR REPLACE FUNCTION private.join_column(level text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
    RETURN CASE level
        WHEN 'country' THEN 'country_id'
        WHEN 'province' THEN 'province_id'
        WHEN 'municipality' THEN 'municipality_id'
        ELSE NULL
    END;
END
$$;

CREATE OR REPLACE FUNCTION private.require_level(level text)
RETURNS void
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
    IF private.join_column(level) IS NULL THEN
        RAISE EXCEPTION 'unknown level %', quote_literal(level) USING ERRCODE = '22023';
    END IF;
END
$$;

-- One grouped breakdown as a jsonb array of {key, value}, largest first.
CREATE OR REPLACE FUNCTION private.breakdown_json(col text, f jsonb, lim int DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    result jsonb;
BEGIN
    EXECUTE format(
        'SELECT coalesce(jsonb_agg(jsonb_build_object(''key'', t.key, ''value'', t.value) '
        '       ORDER BY t.value DESC), ''[]''::jsonb) '
        'FROM (SELECT e.%1$I AS key, %2$s AS value FROM enrollment e%3$s '
        '      GROUP BY 1 HAVING e.%1$I IS NOT NULL ORDER BY 2 DESC %4$s) t',
        col, private.measure_sql(f), private.where_sql(f),
        CASE WHEN lim IS NULL THEN '' ELSE 'LIMIT ' || lim END
    ) INTO result;
    RETURN result;
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;

-- ---------------------------------------------------------------- public API

CREATE OR REPLACE FUNCTION public.health()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
    SELECT jsonb_build_object(
        'status', 'ok',
        'postgis', postgis_version(),
        'enrollment_rows', (SELECT count(*) FROM enrollment),
        'boundaries', (SELECT count(*) FROM boundary)
    )
$$;

-- Distinct values for every filterable column, for the dashboard's controls.
CREATE OR REPLACE FUNCTION public.filter_options()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    col text;
    vals jsonb;
    result jsonb := '{}'::jsonb;
BEGIN
    FOREACH col IN ARRAY ARRAY['school_year', 'term', 'college', 'course', 'program_group',
                               'status', 'year_level', 'sex', 'region', 'nationality']
    LOOP
        EXECUTE format(
            'SELECT coalesce(jsonb_agg(v ORDER BY v), ''[]''::jsonb) '
            'FROM (SELECT DISTINCT %1$I AS v FROM enrollment WHERE %1$I IS NOT NULL) t',
            col
        ) INTO vals;
        result := result || jsonb_build_object(col, vals);
    END LOOP;
    -- Courses grouped under their college, so the course list can narrow when a
    -- college is picked without a second round trip.
    SELECT result || jsonb_build_object('courses_by_college', coalesce(jsonb_agg(
               jsonb_build_object('college', college, 'course', course, 'records', n)
               ORDER BY college, course), '[]'::jsonb))
    INTO result
    FROM (SELECT college, course, count(*) AS n FROM enrollment
          WHERE college IS NOT NULL AND course IS NOT NULL GROUP BY 1, 2) t;
    RETURN result;
END
$$;

-- Headline figures plus the standard breakdowns, under the current filters.
CREATE OR REPLACE FUNCTION public.summary(f jsonb DEFAULT '{}')
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    w text := private.where_sql(f);
    totals jsonb;
    trend jsonb;
    breakdowns jsonb := '{}'::jsonb;
    col text;
BEGIN
    EXECUTE format(
        'SELECT jsonb_build_object('
        '  ''headcount'', COUNT(DISTINCT e.student_ref), ''records'', COUNT(e.id), '
        '  ''programs'', COUNT(DISTINCT e.course), '
        '  ''municipalities'', COUNT(DISTINCT e.municipality_id), '
        '  ''provinces'', COUNT(DISTINCT e.province_id), '
        '  ''countries'', COUNT(DISTINCT e.country_id)) '
        'FROM enrollment e%s', w
    ) INTO totals;

    EXECUTE format(
        'SELECT coalesce(jsonb_agg(jsonb_build_object(''year'', t.year, '
        '       ''headcount'', t.headcount, ''records'', t.records) ORDER BY t.year), ''[]''::jsonb) '
        'FROM (SELECT e.school_year AS year, COUNT(DISTINCT e.student_ref) AS headcount, '
        '             COUNT(e.id) AS records FROM enrollment e%s GROUP BY 1) t', w
    ) INTO trend;

    FOREACH col IN ARRAY ARRAY['college', 'status', 'sex', 'year_level', 'program_group']
    LOOP
        breakdowns := breakdowns || jsonb_build_object(col, private.breakdown_json(col, f));
    END LOOP;
    breakdowns := breakdowns
        || jsonb_build_object('top_courses', private.breakdown_json('course', f, 15))
        || jsonb_build_object('top_provinces', private.breakdown_json('province', f, 15));

    RETURN jsonb_build_object(
        'metric', private.metric(f), 'totals', totals, 'trend', trend,
        'breakdowns', breakdowns
    );
END
$$;

-- One breakdown, for drill-downs the summary does not pre-compute.
CREATE OR REPLACE FUNCTION public.breakdown(dimension text, f jsonb DEFAULT '{}', lim int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    result jsonb;
BEGIN
    IF dimension NOT IN ('college', 'course', 'status', 'sex', 'year_level', 'program_group',
                         'school_year', 'term', 'nationality', 'region', 'province') THEN
        -- P0002 is mapped to HTTP 404 by PostgREST, matching the old API.
        RAISE EXCEPTION 'unknown dimension %', quote_literal(dimension) USING ERRCODE = 'P0002';
    END IF;
    IF lim NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'lim must be between 1 and 500' USING ERRCODE = '22023';
    END IF;
    EXECUTE format(
        'SELECT coalesce(jsonb_agg(jsonb_build_object(''key'', t.key, '
        '       ''headcount'', t.headcount, ''records'', t.records) ORDER BY t.headcount DESC), '
        '       ''[]''::jsonb) '
        'FROM (SELECT e.%1$I AS key, COUNT(DISTINCT e.student_ref) AS headcount, '
        '             COUNT(e.id) AS records FROM enrollment e%2$s '
        '      GROUP BY 1 HAVING e.%1$I IS NOT NULL ORDER BY 2 DESC LIMIT %3$s) t',
        dimension, private.where_sql(f), lim
    ) INTO result;
    RETURN result;
END
$$;

-- Which schools send UC its students — the recruitment view of the same data.
CREATE OR REPLACE FUNCTION public.feeder_schools(f jsonb DEFAULT '{}', lim int DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    w text := private.where_sql(f);
    result jsonb;
BEGIN
    IF lim NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'lim must be between 1 and 200' USING ERRCODE = '22023';
    END IF;
    w := w || CASE WHEN w = '' THEN ' WHERE ' ELSE ' AND ' END || 'e.prev_school IS NOT NULL';
    EXECUTE format(
        'SELECT coalesce(jsonb_agg(jsonb_build_object(''school'', t.school, '
        '       ''province'', t.province, ''headcount'', t.headcount) ORDER BY t.headcount DESC), '
        '       ''[]''::jsonb) '
        'FROM (SELECT e.prev_school AS school, e.province AS province, '
        '             COUNT(DISTINCT e.student_ref) AS headcount FROM enrollment e%s '
        '      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT %s) t',
        w, lim
    ) INTO result;
    RETURN result;
END
$$;

-- A GeoJSON FeatureCollection of boundaries with the metric attached. Municipality
-- level is 1,642 polygons nationally and is served as tiles instead; it is allowed here
-- only when narrowed to one province, the drill-down the dashboard performs.
CREATE OR REPLACE FUNCTION public.geo(
    level text,
    f jsonb DEFAULT '{}',
    province text DEFAULT NULL,
    simplified boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    scope text := coalesce(province, f ->> 'province');
    ff jsonb := coalesce(f, '{}'::jsonb);
    result jsonb;
BEGIN
    PERFORM private.require_level(level);
    IF level = 'municipality' AND scope IS NULL THEN
        RAISE EXCEPTION 'municipality GeoJSON must be narrowed with a province — use the tile function for the national view'
            USING ERRCODE = '22023';
    END IF;
    -- As in the old API, the province both scopes the boundaries and filters enrollments.
    IF scope IS NOT NULL THEN
        ff := ff || jsonb_build_object('province', scope);
    END IF;

    EXECUTE format($sql$
        WITH counts AS (
            SELECT e.%1$I AS boundary_id,
                   COUNT(DISTINCT e.student_ref) AS headcount,
                   COUNT(e.id) AS records,
                   %2$s AS value
            FROM enrollment e%3$s
            GROUP BY 1
        )
        SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'features', coalesce(jsonb_agg(jsonb_build_object(
                'type', 'Feature',
                'id', b.id,
                'geometry', ST_AsGeoJSON(%4$s)::jsonb,
                'properties', jsonb_build_object(
                    'id', b.id, 'name', b.name, 'province', b.province, 'region', b.region,
                    'headcount', coalesce(c.headcount, 0),
                    'records', coalesce(c.records, 0),
                    'value', coalesce(c.value, 0)
                )
            )), '[]'::jsonb)
        )
        FROM boundary b
        LEFT JOIN counts c ON c.boundary_id = b.id
        WHERE b.level = %5$L::boundary_level %6$s
    $sql$,
        private.join_column(level), private.measure_sql(ff), private.where_sql(ff),
        CASE WHEN simplified THEN 'coalesce(b.geom_simple, b.geom)' ELSE 'b.geom' END,
        level,
        CASE WHEN scope IS NULL THEN '' ELSE format('AND b.province = %L', scope) END
    ) INTO result;
    RETURN result;
END
$$;

-- Mapbox Vector Tile for one boundary level, with the metric baked into each feature.
-- ST_AsMVTGeom clips to the tile and quantises to its grid, and the simplification
-- tolerance tracks zoom, so a national view ships coarse outlines and a city view ships
-- full detail. Called with Accept: application/octet-stream, PostgREST returns the
-- bytea as the raw response body.
CREATE OR REPLACE FUNCTION public.tile(level text, z int, x int, y int, f jsonb DEFAULT '{}')
RETURNS bytea
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    tolerance double precision;
    result bytea;
BEGIN
    PERFORM private.require_level(level);
    IF z NOT BETWEEN 0 AND 22 OR x < 0 OR y < 0 OR x >= (2 ^ z) OR y >= (2 ^ z) THEN
        RAISE EXCEPTION 'tile coordinates out of range' USING ERRCODE = '22023';
    END IF;
    -- Web Mercator metres: roughly a quarter of a screen pixel at this zoom.
    tolerance := greatest(156543.03392 / (2 ^ z) / 4, 0.0);

    EXECUTE format($sql$
        WITH envelope AS (
            SELECT ST_TileEnvelope(%1$s, %2$s, %3$s) AS geom
        ),
        counts AS (
            SELECT e.%4$I AS boundary_id,
                   COUNT(DISTINCT e.student_ref) AS headcount,
                   COUNT(e.id) AS records,
                   %5$s AS value
            FROM enrollment e%6$s
            GROUP BY 1
        ),
        mvt AS (
            SELECT b.id, b.name, b.province, b.region,
                   coalesce(c.headcount, 0) AS headcount,
                   coalesce(c.records, 0) AS records,
                   coalesce(c.value, 0) AS value,
                   ST_AsMVTGeom(ST_Simplify(b.geom_3857, %7$s), envelope.geom, 4096, 64, true) AS geom
            FROM boundary b
            LEFT JOIN counts c ON c.boundary_id = b.id
            CROSS JOIN envelope
            WHERE b.level = %8$L::boundary_level
              AND b.geom_3857 && envelope.geom
        )
        SELECT ST_AsMVT(mvt.*, %8$L, 4096, 'geom') FROM mvt WHERE geom IS NOT NULL
    $sql$,
        z, x, y, private.join_column(level), private.measure_sql(f), private.where_sql(f),
        tolerance, level
    ) INTO result;
    RETURN coalesce(result, ''::bytea);
END
$$;

-- Class breaks for the choropleth legend: min, max and quantile breaks of the per-
-- boundary values. Quantiles, not equal intervals: Baguio City holds an order of
-- magnitude more students than any other municipality. The frontend (lib/scale.ts)
-- rounds them and falls back to logarithmic breaks when quantiles are degenerate.
CREATE OR REPLACE FUNCTION public.scale(level text, f jsonb DEFAULT '{}', classes int DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    fractions double precision[];
    result jsonb;
BEGIN
    PERFORM private.require_level(level);
    IF classes NOT BETWEEN 2 AND 9 THEN
        RAISE EXCEPTION 'classes must be between 2 and 9' USING ERRCODE = '22023';
    END IF;
    fractions := ARRAY(SELECT i::double precision / classes FROM generate_series(1, classes - 1) i);

    EXECUTE format($sql$
        WITH counts AS (
            SELECT e.%1$I AS boundary_id, %2$s AS value
            FROM enrollment e%3$s
            GROUP BY 1
        )
        SELECT jsonb_build_object(
            'min', coalesce(min(value), 0),
            'max', coalesce(max(value), 0),
            'breaks', coalesce(to_jsonb(percentile_cont(%4$L::double precision[])
                                        WITHIN GROUP (ORDER BY value)), '[]'::jsonb)
        )
        FROM counts WHERE boundary_id IS NOT NULL AND value > 0
    $sql$,
        private.join_column(level), private.measure_sql(f), private.where_sql(f), fractions
    ) INTO result;

    RETURN result || jsonb_build_object('level', level, 'metric', private.metric(f));
END
$$;

-- Bounding box of one boundary, so the map can fly to a drill-down target.
CREATE OR REPLACE FUNCTION public.bbox(level text, name text, province text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    ext box2d;
BEGIN
    PERFORM private.require_level(level);
    SELECT ST_Extent(b.geom) INTO ext
    FROM boundary b
    WHERE b.level = bbox.level::boundary_level
      AND b.name = bbox.name
      AND (bbox.province IS NULL OR b.province = bbox.province);
    IF ext IS NULL THEN
        RAISE EXCEPTION 'no % named %', level, quote_literal(name) USING ERRCODE = 'P0002';
    END IF;
    RETURN jsonb_build_object(
        'minx', ST_XMin(ext), 'miny', ST_YMin(ext),
        'maxx', ST_XMax(ext), 'maxy', ST_YMax(ext)
    );
END
$$;

-- Ingest history — what was loaded, when, and how much of it was refused.
CREATE OR REPLACE FUNCTION public.batches()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.loaded_at DESC), '[]'::jsonb)
    FROM (SELECT id, filename, loaded_at, rows_read, rows_loaded, rows_rejected, note
          FROM ingest_batch ORDER BY loaded_at DESC LIMIT 100) t
$$;

-- ---------------------------------------------------------------- grants

REVOKE ALL ON FUNCTION
    public.health(), public.filter_options(), public.summary(jsonb),
    public.breakdown(text, jsonb, int), public.feeder_schools(jsonb, int),
    public.geo(text, jsonb, text, boolean), public.tile(text, int, int, int, jsonb),
    public.scale(text, jsonb, int), public.bbox(text, text, text), public.batches()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    public.health(), public.filter_options(), public.summary(jsonb),
    public.breakdown(text, jsonb, int), public.feeder_schools(jsonb, int),
    public.geo(text, jsonb, text, boolean), public.tile(text, int, int, int, jsonb),
    public.scale(text, jsonb, int), public.bbox(text, text, text), public.batches()
TO anon, authenticated, service_role;

-- Supabase caps anon statements at a few seconds; the heaviest of these queries takes
-- ~400 ms warm, so this is headroom for a cold cache rather than a working budget.
ALTER ROLE anon SET statement_timeout = '15s';
ALTER ROLE authenticated SET statement_timeout = '15s';

NOTIFY pgrst, 'reload schema';
