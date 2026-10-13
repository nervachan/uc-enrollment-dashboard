import { describe, expect, it } from "vitest";
import {
  legendClasses,
  rampFor,
  stepExpression,
  SEQUENTIAL_DARK,
  SEQUENTIAL_LIGHT,
} from "./choropleth";

// sRGB -> OKLab lightness. Magnitude is carried by lightness, so that is what the tests
// check; the green-to-blue hue travel is decoration and must not be load-bearing.
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function lightness(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

describe("the sequential ramp", () => {
  it("runs green to near-black on a light surface", () => {
    expect(SEQUENTIAL_LIGHT[0]).toBe("#e4f5ea");
    expect(SEQUENTIAL_LIGHT.at(-1)).toBe("#11263f");
  });

  it("gets darker at every step on a light surface", () => {
    const steps = SEQUENTIAL_LIGHT.map(lightness);
    steps.forEach((value, i) => i && expect(value).toBeLessThan(steps[i - 1]));
  });

  it("inverts direction on a dark surface, where near-black would vanish", () => {
    const steps = SEQUENTIAL_DARK.map(lightness);
    steps.forEach((value, i) => i && expect(value).toBeGreaterThan(steps[i - 1]));
  });

  it("keeps every adjacent step perceptibly apart in both modes", () => {
    for (const ramp of [SEQUENTIAL_LIGHT, SEQUENTIAL_DARK]) {
      const steps = ramp.map(lightness);
      const gaps = steps.slice(1).map((value, i) => Math.abs(value - steps[i]));
      // 0.012 apart was the bug in an earlier dark candidate: teal and blue read as one.
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0.06);
    }
  });

  it("gives one more colour than there are breaks", () => {
    expect(rampFor([10, 20, 30])).toHaveLength(4);
    expect(rampFor([])).toHaveLength(1);
  });

  it("never asks for more steps than the ramp holds", () => {
    expect(rampFor([1, 2, 3, 4, 5, 6, 7, 8])).toHaveLength(SEQUENTIAL_LIGHT.length);
    expect(rampFor([1, 2, 3, 4, 5, 6, 7, 8], true)).toHaveLength(SEQUENTIAL_DARK.length);
  });

  it("serves a different ramp per mode", () => {
    expect(rampFor([10, 20], false)).not.toEqual(rampFor([10, 20], true));
  });
});

describe("the MapLibre step expression", () => {
  it("colours zero separately from the lowest class", () => {
    const expression = stepExpression([5, 10], "#eeeeee");
    expect(expression[0]).toBe("step");
    expect(expression[2]).toBe("#eeeeee");
    expect(expression[3]).toBe(1);
  });

  it("keeps stops strictly increasing when quantiles repeat", () => {
    // A skewed distribution produces duplicate quantiles; a repeated stop is a
    // MapLibre error, so duplicates must be dropped rather than passed through.
    const expression = stepExpression([1, 1, 4], "#eeeeee");
    const stops = expression.filter((item): item is number => typeof item === "number");
    const sorted = [...stops].sort((a, b) => a - b);
    expect(stops).toEqual(sorted);
    expect(new Set(stops).size).toBe(stops.length);
  });
});

describe("the legend", () => {
  it("labels every class and leaves the top class open-ended", () => {
    const classes = legendClasses([10, 50], 900);
    expect(classes).toHaveLength(3);
    expect(classes.at(-1)?.label).toMatch(/\+$/);
    expect(classes[0].label).toContain("–");
  });

  it("has a colour per class", () => {
    const classes = legendClasses([10, 50, 100], 900);
    expect(new Set(classes.map((item) => item.color)).size).toBe(classes.length);
  });
});
