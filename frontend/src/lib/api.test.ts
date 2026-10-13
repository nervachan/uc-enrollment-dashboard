import { describe, expect, it } from "vitest";
import { apiUrl, EMPTY_FILTERS, toSearchParams } from "./api";

describe("query building", () => {
  it("repeats a key per value so the API sees a list", () => {
    const params = toSearchParams({ ...EMPTY_FILTERS, college: ["CITCS", "COE"] });
    expect(params.getAll("college")).toEqual(["CITCS", "COE"]);
  });

  it("drops empty lists rather than sending empty parameters", () => {
    const params = toSearchParams(EMPTY_FILTERS);
    expect(params.has("college")).toBe(false);
    expect(params.get("metric")).toBe("headcount");
  });

  it("builds a tile URL with the filters attached", () => {
    const url = apiUrl("/api/tiles/province/{z}/{x}/{y}.pbf", {
      ...EMPTY_FILTERS,
      college: ["CITCS"],
    });
    expect(url).toContain("/api/tiles/province/{z}/{x}/{y}.pbf?");
    expect(url).toContain("college=CITCS");
  });

  it("omits the query string when nothing is filtered", () => {
    expect(apiUrl("/api/health")).toBe("/api/health");
  });
});
