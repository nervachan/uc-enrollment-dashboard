// @vitest-environment node
/**
 * The ingest Edge Function's handler (supabase/functions/ingest/handler.ts), with the
 * Supabase calls replaced by an in-memory fake. Runs in Node because the handler uses
 * the platform Request/FormData/crypto that Deno also provides.
 */

import { describe, expect, it, vi } from "vitest";

import {
  CHUNK_ROWS,
  handleIngest,
  type IngestDeps,
} from "../../../supabase/functions/ingest/handler.ts";

const HEADER = "USER_INDEX,SCHOOL YEAR,TERM,COURSE,MUNICITY,PROVINCE,RELIGION";

function upload(body: string, { dryRun = false, token = "jwt" } = {}): Request {
  const form = new FormData();
  form.append("file", new File([body], "term.csv", { type: "text/csv" }));
  return new Request(`https://x.supabase.co/functions/v1/ingest${dryRun ? "?dry_run=1" : ""}`, {
    method: "POST",
    body: form,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function deps(overrides: Partial<IngestDeps> = {}): IngestDeps & { calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    userEmail: vi.fn(async (token: string) => (token === "jwt" ? "registrar@uc-bcf.edu.ph" : null)),
    isAdmin: vi.fn(async () => true),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      if (name === "ingest_begin") return 42;
      if (name === "ingest_chunk") {
        const rows = args.p_rows as Record<string, unknown>[];
        return {
          staged: rows.length,
          inserted: rows.length - 1,
          unmatched_municipalities: [{ municity: "Beijing", province: "International", rows: 1 }],
          unmatched_countries: [],
        };
      }
      return {};
    }) as IngestDeps["rpc"],
    maxUploadMb: 1,
    ...overrides,
  };
}

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("who may upload", () => {
  it("answers the browser's CORS preflight", async () => {
    const response = await handleIngest(new Request("https://x/ingest", { method: "OPTIONS" }), deps());
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("authorization");
  });

  it("refuses an anonymous request", async () => {
    const response = await handleIngest(upload(`${HEADER}\n`, { token: "" }), deps());
    expect(response.status).toBe(401);
  });

  it("refuses an expired or forged token", async () => {
    const response = await handleIngest(upload(`${HEADER}\n`, { token: "bogus" }), deps());
    expect(response.status).toBe(401);
    expect((await body(response)).detail).toMatch(/expired/);
  });

  it("refuses a signed-in user who is not on the upload list, naming the address", async () => {
    const d = deps({ isAdmin: vi.fn(async () => false) });
    const response = await handleIngest(upload(`${HEADER}\n`), d);
    expect(response.status).toBe(403);
    expect((await body(response)).detail).toContain("registrar@uc-bcf.edu.ph");
    expect(d.calls).toHaveLength(0);
  });
});

describe("checking a file", () => {
  it("dry-runs without writing anything", async () => {
    const d = deps();
    const response = await handleIngest(
      upload(`${HEADER}\n1,2025,1,BS IT,Baguio City,Benguet,x\n2,2025,9,BS IT,,,\n`, { dryRun: true }),
      d,
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      filename: "term.csv",
      rows_read: 2,
      rows_valid: 1,
      rows_rejected: 1,
      ignored_columns: ["RELIGION"],
      rejections: [{ row: 3, reason: "term 9 out of range 1-4" }],
    });
    expect(d.calls).toHaveLength(0);
  });

  it("refuses a file without the required columns with 422", async () => {
    const response = await handleIngest(upload("USER_INDEX\n1\n", { dryRun: true }), deps());
    expect(response.status).toBe(422);
    expect((await body(response)).detail).toMatch(/missing required column/);
  });

  it("refuses a file over the size limit and points at the CLI", async () => {
    const big = `${HEADER}\n${"x".repeat(1024 * 1024 + 1)}`;
    const response = await handleIngest(upload(big, { dryRun: true }), deps());
    expect(response.status).toBe(413);
    expect((await body(response)).detail).toMatch(/command-line loader/);
  });
});

describe("loading a file", () => {
  it("loads in chunks, then records the batch, and reports the totals", async () => {
    const lines = Array.from({ length: CHUNK_ROWS + 3 }, (_, i) => `${i},2025,1,BS IT,Baguio City,Benguet,x`);
    const d = deps();
    const response = await handleIngest(upload(`${HEADER}\n${lines.join("\n")}\n2,2025,7,BS IT,,,\n`), d);
    expect(response.status).toBe(200);

    expect(d.calls.map(([name]) => name)).toEqual([
      "ingest_begin",
      "ingest_chunk",
      "ingest_chunk",
      "ingest_finish",
    ]);
    const begin = d.calls[0][1];
    expect(begin.p_filename).toBe("term.csv");
    expect(begin.p_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(begin.p_note).toContain("registrar@uc-bcf.edu.ph");
    expect((d.calls[1][1].p_rows as unknown[]).length).toBe(CHUNK_ROWS);
    const finish = d.calls[3][1];
    expect(finish).toMatchObject({ p_batch_id: 42, p_rows_read: CHUNK_ROWS + 4 });
    expect((finish.p_rejections as unknown[]).length).toBe(1);

    expect(await body(response)).toEqual({
      batch_id: 42,
      rows_read: CHUNK_ROWS + 4,
      rows_inserted: CHUNK_ROWS + 1,
      rows_duplicate: 2,
      rows_rejected: 1,
      unmatched_municipalities: [{ municity: "Beijing", province: "International", rows: 2 }],
    });
  });

  it("never sends sensitive fields from the upload path", async () => {
    const d = deps();
    await handleIngest(
      upload("USER_INDEX,SCHOOL YEAR,TERM,COURSE,BROAD_RELIGION,CIVIL_STATUS\n1,2025,1,BS IT,Christianity,Single\n"),
      d,
    );
    const [row] = d.calls[1][1].p_rows as Record<string, unknown>[];
    expect(row.broad_religion).toBeNull();
    expect(row.civil_status).toBeNull();
  });

  it("says how to recover when the load stops partway", async () => {
    const d = deps();
    d.rpc = vi.fn(async (name: string) => {
      if (name === "ingest_begin") return 1;
      throw new Error("canceling statement due to statement timeout");
    }) as IngestDeps["rpc"];
    const response = await handleIngest(upload(`${HEADER}\n1,2025,1,BS IT,,,\n`), d);
    expect(response.status).toBe(500);
    expect((await body(response)).detail).toMatch(/Upload the same file again/);
  });
});
