import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, EMPTY_FILTERS, filterArg, tileRequestHeaders, tileUrl } from "./api";
import { supabase } from "./supabase";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("filter argument", () => {
  it("passes lists through so the database sees every value", () => {
    expect(filterArg({ ...EMPTY_FILTERS, college: ["CITCS", "COE"] }).college).toEqual([
      "CITCS",
      "COE",
    ]);
  });

  it("drops empty lists rather than sending empty filters", () => {
    expect(filterArg(EMPTY_FILTERS)).toEqual({ metric: "headcount" });
  });

  it("keeps a single-valued province", () => {
    expect(filterArg({ ...EMPTY_FILTERS, province: "Benguet" }).province).toBe("Benguet");
  });
});

describe("tiles", () => {
  it("points MapLibre at the Supabase tile function with the filters attached", () => {
    const url = tileUrl("province", { ...EMPTY_FILTERS, college: ["CITCS"] });
    expect(url.startsWith("https://test-project.supabase.co/rest/v1/rpc/tile?level=province")).toBe(
      true,
    );
    expect(url).toContain("&z={z}&x={x}&y={y}&");
    const f = new URL(url.replace(/[{}]/g, "")).searchParams.get("f");
    expect(JSON.parse(f!)).toEqual({ college: ["CITCS"], metric: "headcount" });
  });

  it("adds the project key and asks for the tile media type on tile requests only", () => {
    const url = tileUrl("municipality", EMPTY_FILTERS).replace("{z}/{x}/{y}", "7/106/58");
    expect(tileRequestHeaders(url)).toEqual({
      apikey: "sb_publishable_test",
      Accept: "application/vnd.mapbox-vector-tile",
    });
    expect(tileRequestHeaders("https://elsewhere.example/glyphs/0-255.pbf")).toBeUndefined();
  });
});

describe("read calls", () => {
  it("calls the matching database function with the filter argument", async () => {
    const rpc = vi
      .spyOn(supabase, "rpc")
      .mockResolvedValue({ data: { totals: {} }, error: null, status: 200 } as never);
    await api.summary({ ...EMPTY_FILTERS, status: ["New"] });
    expect(rpc).toHaveBeenCalledWith("summary", { f: { status: ["New"], metric: "headcount" } });
  });

  it("turns database errors into ApiError with the status", async () => {
    vi.spyOn(supabase, "rpc").mockResolvedValue({
      data: null,
      error: { message: "no province named 'Atlantis'" },
      status: 404,
    } as never);
    await expect(api.bbox("province", "Atlantis")).rejects.toMatchObject({
      status: 404,
      message: "no province named 'Atlantis'",
    });
  });

  it("finalises the scale: rounded quantiles, or log breaks when they are degenerate", async () => {
    vi.spyOn(supabase, "rpc").mockResolvedValue({
      data: { level: "country", metric: "headcount", min: 1, max: 35562, breaks: [1, 2, 4.4, 7] },
      error: null,
      status: 200,
    } as never);
    const scale = await api.scale("country", EMPTY_FILTERS);
    expect(scale.method).toBe("logarithmic");
    expect(scale.breaks.at(-1)).toBeGreaterThan(326);
  });
});

describe("uploads", () => {
  it("refuses before sending anything when nobody is signed in", async () => {
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
      error: null,
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.validateUpload(new File(["x"], "a.csv"))).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the file to the ingest function with the user's token", async () => {
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "user-jwt" } },
      error: null,
    } as never);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rows_read: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.validateUpload(new File(["x"], "a.csv"));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://test-project.supabase.co/functions/v1/ingest?dry_run=1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer user-jwt");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("surfaces the function's own error message", async () => {
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "user-jwt" } },
      error: null,
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "file is empty" }), { status: 400 })),
    );
    await expect(api.ingestUpload(new File(["x"], "a.csv"))).rejects.toMatchObject({
      status: 400,
      message: "file is empty",
    });
  });
});
