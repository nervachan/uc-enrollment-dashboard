/** Typed access to the dashboard API. */

// Trailing slashes stripped, so "https://api.example.com/" does not produce "//api/...".
export const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

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

/** Build the query string. Repeated keys, so the API's `= ANY(...)` sees a real list. */
export function toSearchParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  return params;
}

export function apiUrl(path: string, filters?: Filters): string {
  const query = filters ? toSearchParams(filters).toString() : "";
  return `${API_BASE}${path}${query ? `?${query}` : ""}`;
}

async function getJson<T>(path: string, filters?: Filters): Promise<T> {
  const response = await fetch(apiUrl(path, filters));
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status} ${path}: ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as T;
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

export interface Scale {
  level: string;
  metric: Metric;
  min: number;
  max: number;
  breaks: number[];
  /** How the class breaks were chosen. Quantiles unless one boundary dominates. */
  method: "quantile" | "logarithmic";
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

/** Thrown with the API's own message, so the upload panel can show why it refused. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function postFile<T>(path: string, file: File, apiKey: string, note?: string): Promise<T> {
  const body = new FormData();
  body.append("file", file);
  const headers: Record<string, string> = { "X-API-Key": apiKey };
  if (note) headers["note"] = note;
  const response = await fetch(`${API_BASE}${path}`, { method: "POST", body, headers });
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
  health: () => getJson<{ status: string; enrollment_rows: number }>("/api/health"),
  filters: () => getJson<FilterOptions>("/api/filters"),
  summary: (filters: Filters) => getJson<Summary>("/api/summary", filters),
  scale: (level: string, filters: Filters) => getJson<Scale>(`/api/scale/${level}`, filters),
  geo: (level: string, filters: Filters) =>
    getJson<{ features: BoundaryFeature[] }>(`/api/geo/${level}`, filters),
  bbox: (level: string, name: string, province?: string) => {
    const params = new URLSearchParams({ name });
    if (province) params.set("province", province);
    return getJson<{ minx: number; miny: number; maxx: number; maxy: number }>(
      `/api/geo/bbox/${level}?${params.toString()}`,
    );
  },
  feederSchools: (filters: Filters) =>
    getJson<{ school: string; province: string; headcount: number }[]>(
      "/api/feeder-schools",
      filters,
    ),
  batches: () => getJson<Batch[]>("/api/batches"),
  validateUpload: (file: File, apiKey: string) =>
    postFile<ValidationResult>("/api/ingest/validate", file, apiKey),
  ingestUpload: (file: File, apiKey: string, note?: string) =>
    postFile<IngestResult>("/api/ingest", file, apiKey, note),
};
