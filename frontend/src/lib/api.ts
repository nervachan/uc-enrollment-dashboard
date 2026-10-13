/**
 * Typed access to the dashboard's data, all of it served by Supabase: reads are database
 * functions (supabase/migrations/*_read_api.sql) called through supabase-js, map tiles
 * are fetched by MapLibre from the `tile` function, and uploads go to the `ingest` Edge
 * Function. Components only ever see the `api` object and these types.
 */

import { finaliseScale, type RawScale, type Scale } from "./scale";
import { SUPABASE_KEY, SUPABASE_URL, supabase } from "./supabase";

export type { Scale } from "./scale";

export type Metric = "headcount" | "records";

export interface Filters {
  school_year: number[];
  term: number[];
  college: string[];
  course: string[];
  program_group: string[];
  status: string[];
  province?: string;
  metric: Metric;
}

export const EMPTY_FILTERS: Filters = {
  school_year: [],
  term: [],
  college: [],
  course: [],
  program_group: [],
  status: [],
  metric: "headcount",
};

/** The `f` argument every read function takes: set filters only, empty lists dropped. */
export function filterArg(filters: Filters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Vector tile URL template for MapLibre. The {z}/{x}/{y} placeholders stay literal for
 * MapLibre to fill; the request needs the headers from tileRequestHeaders().
 */
export function tileUrl(level: string, filters: Filters): string {
  const f = encodeURIComponent(JSON.stringify(filterArg(filters)));
  return `${SUPABASE_URL}/rest/v1/rpc/tile?level=${encodeURIComponent(level)}&z={z}&x={x}&y={y}&f=${f}`;
}

/** Headers a tile request needs: the project key, and raw bytes rather than JSON. */
export function tileRequestHeaders(url: string): Record<string, string> | undefined {
  if (!SUPABASE_URL || !url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/tile`)) return undefined;
  return { apikey: SUPABASE_KEY, Accept: "application/octet-stream" };
}

export interface Totals {
  headcount: number;
  records: number;
  programs: number;
  municipalities: number;
  provinces: number;
  countries: number;
}

export interface Summary {
  metric: Metric;
  totals: Totals;
  trend: { year: number; headcount: number; records: number }[];
  breakdowns: Record<string, { key: string | number; value: number }[]>;
}

export interface FilterOptions {
  school_year: number[];
  term: number[];
  college: string[];
  course: string[];
  program_group: string[];
  status: string[];
  sex: string[];
  year_level: number[];
  region: string[];
  nationality: string[];
  courses_by_college: { college: string; course: string; records: number }[];
}

export interface BoundaryFeature {
  properties: {
    id: number;
    name: string;
    province: string | null;
    region: string | null;
    headcount: number;
    records: number;
    value: number;
  };
}

export interface ValidationResult {
  filename: string;
  rows_read: number;
  rows_valid: number;
  rows_rejected: number;
  ignored_columns: string[];
  rejections: { row: number; reason: string }[];
}

export interface IngestResult {
  batch_id: number;
  rows_read: number;
  rows_inserted: number;
  rows_duplicate: number;
  rows_rejected: number;
  unmatched_municipalities: { municity: string; province: string; rows: number }[];
}

export interface Batch {
  id: number;
  filename: string;
  loaded_at: string;
  rows_read: number;
  rows_loaded: number;
  rows_rejected: number;
  note: string | null;
}

/** Thrown with the server's own message, so the panels can show why it refused. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error, status } = await supabase.rpc(fn, args);
  if (error) throw new ApiError(status, error.message);
  return data as T;
}

async function postUpload<T>(file: File, dryRun: boolean): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(401, "sign in to upload");

  const body = new FormData();
  body.append("file", file);
  const response = await fetch(
    `${SUPABASE_URL}/functions/v1/ingest${dryRun ? "?dry_run=1" : ""}`,
    {
      method: "POST",
      body,
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY },
    },
  );
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      detail = (JSON.parse(text) as { detail?: string }).detail ?? detail;
    } catch {
      /* some errors are not JSON; the raw text is the best message available */
    }
    throw new ApiError(response.status, detail);
  }
  return JSON.parse(text) as T;
}

export const api = {
  health: () => rpc<{ status: string; enrollment_rows: number }>("health"),
  filters: () => rpc<FilterOptions>("filter_options"),
  summary: (filters: Filters) => rpc<Summary>("summary", { f: filterArg(filters) }),
  scale: async (level: string, filters: Filters): Promise<Scale> =>
    finaliseScale(await rpc<RawScale>("scale", { level, f: filterArg(filters) })),
  geo: (level: string, filters: Filters) =>
    rpc<{ features: BoundaryFeature[] }>("geo", { level, f: filterArg(filters) }),
  bbox: (level: string, name: string, province?: string) =>
    rpc<{ minx: number; miny: number; maxx: number; maxy: number }>("bbox", {
      level,
      name,
      ...(province ? { province } : {}),
    }),
  feederSchools: (filters: Filters) =>
    rpc<{ school: string; province: string; headcount: number }[]>("feeder_schools", {
      f: filterArg(filters),
    }),
  batches: () => rpc<Batch[]>("batches"),
  validateUpload: (file: File) => postUpload<ValidationResult>(file, true),
  ingestUpload: (file: File) => postUpload<IngestResult>(file, false),
};
