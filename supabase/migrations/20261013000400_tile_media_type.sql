-- Vector tiles as a real media type.
--
-- PostgREST only sends a function's result as raw bytes when the function declares what
-- those bytes are, through a domain named after the media type (a "media type handler").
-- A plain bytea result is refused with 406 for Accept: application/octet-stream on current
-- Supabase. Returning this domain makes /rest/v1/rpc/tile answer with
-- Content-Type: application/vnd.mapbox-vector-tile, which is what MapLibre expects.
--
-- The first release defined tile() returning bytea in the read_api migration. A return
-- type cannot be changed in place, so that version is dropped first when present.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'application/vnd.mapbox-vector-tile') THEN
        CREATE DOMAIN "application/vnd.mapbox-vector-tile" AS bytea;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.tile(text, integer, integer, integer, jsonb)')
          AND prorettype = 'bytea'::regtype
    ) THEN
        DROP FUNCTION public.tile(text, integer, integer, integer, jsonb);
    END IF;
END $$;

-- Mapbox Vector Tile for one boundary level, with the metric baked into each feature.
-- ST_AsMVTGeom clips to the tile and quantises to its grid, and the simplification
-- tolerance tracks zoom, so a national view ships coarse outlines and a city view ships
-- full detail.
CREATE OR REPLACE FUNCTION public.tile(level text, z int, x int, y int, f jsonb DEFAULT '{}')
RETURNS "application/vnd.mapbox-vector-tile"
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
    RETURN coalesce(result, ''::bytea)::"application/vnd.mapbox-vector-tile";
END
$$;

REVOKE ALL ON FUNCTION public.tile(text, int, int, int, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tile(text, int, int, int, jsonb) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
