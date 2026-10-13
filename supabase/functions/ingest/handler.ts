/**
 * The upload endpoint, as a plain function of (Request, dependencies) so it can be
 * tested without Deno or a live Supabase project. index.ts wires the real dependencies.
 *
 *   POST /functions/v1/ingest?dry_run=1   validate only, write nothing
 *   POST /functions/v1/ingest             validate and load
 *
 * Multipart form: `file` (the CSV), optional `note`. The caller must be signed in to
 * Supabase Auth (Authorization: Bearer <access token>) with an email address on the
 * ingest_admin list. Responses and error bodies ({"detail": "..."}) keep the shapes the
 * dashboard's upload panel already understands.
 */

import { HeaderError, validateCsv, type Row } from "../_shared/validate.ts";

export interface IngestDeps {
  /** Email of the user the access token belongs to, or null if the token is not valid. */
  userEmail(accessToken: string): Promise<string | null>;
  isAdmin(email: string): Promise<boolean>;
  /** Call a database function with the service-role key. Throws on error. */
  rpc<T>(name: string, args: Record<string, unknown>): Promise<T>;
  maxUploadMb: number;
}

export const CHUNK_ROWS = 5000;

interface ChunkResult {
  staged: number;
  inserted: number;
  unmatched_municipalities: { municity: string; province: string; rows: number }[];
  unmatched_countries: { country: string; rows: number }[];
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const fail = (status: number, detail: string) => json({ detail }, status);

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleIngest(req: Request, deps: IngestDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return fail(405, "use POST");

  // ---- who is asking
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return fail(401, "sign in to upload");
  const email = await deps.userEmail(token);
  if (!email) return fail(401, "your sign-in has expired; sign in again");
  if (!(await deps.isAdmin(email))) {
    return fail(403, `${email} is not on the upload list. Ask an administrator to add it.`);
  }

  // ---- the file
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "expected a multipart form with a file field");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return fail(400, "no file was uploaded");
  if (file.size > deps.maxUploadMb * 1024 * 1024) {
    return fail(
      413,
      `file exceeds ${deps.maxUploadMb} MB; load files this large with the command-line loader`,
    );
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) return fail(400, "file is empty");
  // TextDecoder drops a leading BOM and replaces bad bytes, as utf-8-sig/errors="replace" do.
  const text = new TextDecoder("utf-8").decode(bytes);

  let rows: Row[];
  let report: ReturnType<typeof validateCsv>["report"];
  try {
    ({ rows, report } = validateCsv(text));
  } catch (error) {
    if (error instanceof HeaderError) return fail(422, error.message);
    throw error;
  }

  const dryRun = new URL(req.url).searchParams.get("dry_run");
  if (dryRun === "1" || dryRun === "true") {
    return json({
      filename: file.name,
      rows_read: report.rows_read,
      rows_valid: report.rows_valid,
      rows_rejected: report.rejections.length,
      ignored_columns: report.ignored_columns,
      rejections: report.rejections.slice(0, 100).map((r) => ({ row: r.row_number, reason: r.reason })),
    });
  }

  // ---- the load
  const note = (form.get("note") as string | null) || `uploaded from the dashboard by ${email}`;
  try {
    const batchId = await deps.rpc<number>("ingest_begin", {
      p_filename: file.name || "upload.csv",
      p_sha256: await sha256(bytes),
      p_note: note,
    });

    let staged = 0;
    let inserted = 0;
    const unmatched = new Map<string, { municity: string; province: string; rows: number }>();
    for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
      const chunk = await deps.rpc<ChunkResult>("ingest_chunk", {
        p_batch_id: batchId,
        p_rows: rows.slice(start, start + CHUNK_ROWS),
      });
      staged += chunk.staged;
      inserted += chunk.inserted;
      for (const m of chunk.unmatched_municipalities) {
        const key = `${m.municity}\u0000${m.province}`;
        const seen = unmatched.get(key);
        unmatched.set(key, { ...m, rows: (seen?.rows ?? 0) + m.rows });
      }
    }

    await deps.rpc("ingest_finish", {
      p_batch_id: batchId,
      p_rows_read: report.rows_read,
      p_rejections: report.rejections,
    });

    return json({
      batch_id: batchId,
      rows_read: report.rows_read,
      rows_inserted: inserted,
      rows_duplicate: staged - inserted,
      rows_rejected: report.rejections.length,
      unmatched_municipalities: [...unmatched.values()]
        .sort((a, b) => b.rows - a.rows)
        .slice(0, 25),
    });
  } catch (error) {
    // Rows already inserted stay; uploading the same file again finishes the job.
    const message = error instanceof Error ? error.message : String(error);
    return fail(500, `the load stopped partway: ${message}. Upload the same file again to finish it.`);
  }
}
