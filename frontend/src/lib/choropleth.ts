/** The choropleth colour ramp and its legend.
 *
 * Magnitude is a sequential encoding, so the rule that matters is **monotone
 * lightness**: every step is perceptibly darker (on light) or lighter (on dark) than the
 * one before it, and the reader never has to decide whether green outranks blue. The
 * ramp travels green → blue → near-black, which is a two-hue sequential scheme of the
 * GnBu family rather than a rainbow; hue carries nothing on its own.
 *
 * Both ramps were checked rather than eyeballed — OKLab lightness is monotone and every
 * adjacent step gap clears 0.06:
 *   light mode  L 0.955 → 0.265, smallest gap 0.079
 *   dark mode   L 0.299 → 0.863, smallest gap 0.077
 * Re-run that check if you re-step either ramp; an earlier dark candidate put teal and
 * blue 0.012 apart, which reads as one colour.
 */

/** Light surface: pale green for the smallest counts, near-black navy for the largest. */
export const SEQUENTIAL_LIGHT = [
  "#e4f5ea",
  "#b4e3c8",
  "#74c79f",
  "#2fa58b",
  "#1d7a94",
  "#1b4f7a",
  "#11263f",
] as const;

/** Dark surface: the direction inverts, because a near-black top step would vanish. */
export const SEQUENTIAL_DARK = [
  "#12352a",
  "#185a44",
  "#1d8568",
  "#2f94c0",
  "#63b4e0",
  "#a9daf6",
] as const;

/** Boundaries with no students at all. Neutral, so zero reads as absence, not as "few". */
export const ZERO_LIGHT = "#edece7";
export const ZERO_DARK = "#232322";

export interface LegendClass {
  color: string;
  from: number;
  to: number | null;
  label: string;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function rampColors(dark = false): readonly string[] {
  return dark ? SEQUENTIAL_DARK : SEQUENTIAL_LIGHT;
}

/** Colours for one more class than there are breaks, as a choropleth requires. */
export function rampFor(breaks: number[], dark = false): string[] {
  const source = rampColors(dark);
  const needed = Math.min(breaks.length + 1, source.length);
  const step = (source.length - 1) / Math.max(needed - 1, 1);
  return Array.from({ length: needed }, (_, i) => source[Math.round(i * step)]);
}

/**
 * A MapLibre `step` expression over the feature's `value` property.
 * Zero gets its own colour before the ramp starts.
 */
export function stepExpression(breaks: number[], zeroColor: string, dark = false): unknown[] {
  const colors = rampFor(breaks, dark);
  const expression: unknown[] = ["step", ["get", "value"], zeroColor, 1, colors[0]];
  breaks.forEach((breakpoint, index) => {
    const color = colors[Math.min(index + 1, colors.length - 1)];
    // A step expression needs strictly increasing stops; quantiles on a skewed
    // distribution can repeat, and a repeated stop is a MapLibre error, not a warning.
    const previous = expression[expression.length - 2] as number;
    if (breakpoint > previous) expression.push(breakpoint, color);
  });
  return expression;
}

export function legendClasses(breaks: number[], max: number, dark = false): LegendClass[] {
  const colors = rampFor(breaks, dark);
  const bounds = [1, ...breaks];
  return bounds.map((from, index) => {
    const to = index < breaks.length ? breaks[index + 0] : null;
    const upper = index < bounds.length - 1 ? bounds[index + 1] - 1 : max;
    return {
      color: colors[Math.min(index, colors.length - 1)],
      from,
      to,
      label:
        index === bounds.length - 1
          ? `${compact.format(from)}+`
          : `${compact.format(from)}–${compact.format(Math.max(upper, from))}`,
    };
  });
}
