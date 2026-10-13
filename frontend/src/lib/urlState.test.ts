import { describe, expect, it } from "vitest";
import { activeFilterCount, filtersFromSearch, searchFromFilters, toggleValue } from "./urlState";
import { EMPTY_FILTERS } from "./api";

describe("filters in the URL", () => {
  it("reads repeated keys as a list", () => {
    const filters = filtersFromSearch("?college=CITCS&college=COE&school_year=2025");
    expect(filters.college).toEqual(["CITCS", "COE"]);
    expect(filters.school_year).toEqual([2025]);
  });

  it("ignores school years that are not numbers", () => {
    expect(filtersFromSearch("?school_year=abc").school_year).toEqual([]);
  });

  it("defaults the metric to headcount and rejects anything else", () => {
    expect(filtersFromSearch("").metric).toBe("headcount");
    expect(filtersFromSearch("?metric=guesswork").metric).toBe("headcount");
    expect(filtersFromSearch("?metric=records").metric).toBe("records");
  });

  it("round-trips", () => {
    const original = {
      ...EMPTY_FILTERS,
      college: ["CITCS"],
      school_year: [2025, 2026],
      province: "Benguet",
      metric: "records" as const,
    };
    expect(filtersFromSearch(`?${searchFromFilters(original)}`)).toEqual(original);
  });

  it("leaves the default metric out of the query string", () => {
    expect(searchFromFilters({ ...EMPTY_FILTERS, metric: "headcount" })).toBe("");
    expect(searchFromFilters({ ...EMPTY_FILTERS, metric: "records" })).toContain("metric=records");
  });

  it("counts what the reader has narrowed", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(
      activeFilterCount({ ...EMPTY_FILTERS, college: ["CITCS", "COE"], province: "Benguet" }),
    ).toBe(3);
  });
});

describe("toggleValue", () => {
  it("adds then removes", () => {
    expect(toggleValue<string>([], "a")).toEqual(["a"]);
    expect(toggleValue(["a", "b"], "a")).toEqual(["b"]);
  });
});
