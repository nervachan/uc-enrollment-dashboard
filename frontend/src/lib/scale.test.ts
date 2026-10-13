/**
 * Class breaks for the choropleth. The numbers are the real ones from the SY2023–SY2026
 * extract, so a regression here is a regression against data that actually exists.
 * Ported from backend/tests/test_scale.py.
 */

import { describe, expect, it } from "vitest";

import { finaliseScale, logBreaks, quantilesAreDegenerate, roundHalfEven } from "./scale";

describe("quantilesAreDegenerate", () => {
  it("recognises country-level quantiles as degenerate", () => {
    // All but the Philippines (35,562) are in single or double digits.
    expect(quantilesAreDegenerate([1, 2, 4, 7], 35562, 5)).toBe(true);
  });

  it("keeps municipal quantiles", () => {
    expect(quantilesAreDegenerate([160, 394, 785, 1100], 14070, 5)).toBe(false);
  });

  it("treats collapsed ties as degenerate", () => {
    expect(quantilesAreDegenerate([1, 2], 900, 5)).toBe(true);
  });

  it("does not call no data degenerate", () => {
    expect(quantilesAreDegenerate([], 0, 5)).toBe(false);
  });
});

describe("logBreaks", () => {
  it("is increasing and inside the range", () => {
    const breaks = logBreaks(1, 35562, 5);
    expect(breaks).toEqual([...new Set(breaks)].sort((a, b) => a - b));
    expect(breaks.every((b) => b > 0 && b <= 35562)).toBe(true);
    expect(breaks).toHaveLength(4);
  });

  it("separates a dominant value: the Philippines alone in the top class", () => {
    const breaks = logBreaks(1, 35562, 5);
    expect(breaks.at(-1)).toBeGreaterThan(326);
    expect(breaks.at(-1)).toBeLessThan(35562);
  });

  it.each([1, 5, 10, 1000, 10_000_000])("never produces a zero or duplicate stop (max %i)", (maximum) => {
    const breaks = logBreaks(1, maximum, 5);
    expect(breaks.every((b) => b > 0)).toBe(true);
    expect(new Set(breaks).size).toBe(breaks.length);
  });
});

describe("roundHalfEven", () => {
  it("rounds halves to the even neighbour, as Python's round() does", () => {
    expect([0.5, 1.5, 2.5, 3.5, 2.4, 2.6].map(roundHalfEven)).toEqual([0, 2, 2, 4, 2, 3]);
  });
});

describe("finaliseScale", () => {
  it("rounds and de-duplicates usable quantiles", () => {
    const scale = finaliseScale({
      level: "municipality",
      metric: "headcount",
      min: 1,
      max: 14070,
      breaks: [159.6, 394, 785.2, 1100],
    });
    expect(scale).toMatchObject({ method: "quantile", breaks: [160, 394, 785, 1100] });
  });

  it("returns no breaks for an empty map", () => {
    const scale = finaliseScale({ level: "province", metric: "records", min: 0, max: 0, breaks: [] });
    expect(scale).toMatchObject({ method: "quantile", breaks: [] });
  });
});
