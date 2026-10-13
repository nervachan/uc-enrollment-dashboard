/**
 * Choropleth class breaks. The database returns quantiles (the `scale` function); this
 * rounds them and decides whether they are usable, falling back to logarithmic breaks
 * when they are not. Ported from the Python API's geo.py, numbers and all.
 */

import type { Metric } from "./api";

export interface RawScale {
  level: string;
  metric: Metric;
  min: number;
  max: number;
  breaks: number[];
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

/** Python's round(): halves go to the even neighbour, so 2.5 -> 2 and 3.5 -> 4. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const uniqueSorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

/**
 * True when quantile classes would hide the thing the map is about.
 *
 * Country level is the case that forces this. 32 countries have students; all but the
 * Philippines are in single or double digits, so the quantiles come back [1, 2, 4, 7]
 * and the Philippines — 94% of the student body — lands in the same colour class as a
 * country with seven students. Either symptom disqualifies quantiles: ties collapsed the
 * class count, or the top break sits far below the maximum.
 */
export function quantilesAreDegenerate(breaks: number[], maximum: number, classes: number): boolean {
  if (breaks.length === 0 || maximum <= 0) return false;
  if (breaks.length < classes - 1) return true;
  return breaks[breaks.length - 1] < 0.02 * maximum;
}

/** Geometric class breaks, for counts spanning orders of magnitude. */
export function logBreaks(minimum: number, maximum: number, classes: number): number[] {
  const low = Math.log10(Math.max(minimum, 1));
  const high = Math.log10(Math.max(maximum, 10));
  const step = (high - low) / classes;
  const breaks = Array.from({ length: classes - 1 }, (_, i) =>
    roundHalfEven(10 ** (low + step * (i + 1))),
  );
  return uniqueSorted(breaks.filter((b) => b > 0 && b <= maximum));
}

export function finaliseScale(raw: RawScale, classes = 5): Scale {
  let breaks = uniqueSorted((raw.breaks ?? []).map(roundHalfEven));
  let method: Scale["method"] = "quantile";
  if (quantilesAreDegenerate(breaks, raw.max, classes)) {
    breaks = logBreaks(raw.min, raw.max, classes);
    method = "logarithmic";
  }
  return { level: raw.level, metric: raw.metric, min: raw.min, max: raw.max, breaks, method };
}
