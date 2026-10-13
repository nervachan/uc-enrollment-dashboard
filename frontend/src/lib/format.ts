const full = new Intl.NumberFormat("en-PH");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export const formatNumber = (value: number): string => full.format(value);
export const formatCompact = (value: number): string => compact.format(value);

export function percent(part: number, whole: number): string {
  if (!whole) return "0%";
  const share = (part / whole) * 100;
  return `${share >= 10 ? Math.round(share) : share.toFixed(1)}%`;
}

/** Programme names are shouted in the source data; title-case them for display. */
export function titleCase(value: string): string {
  const minor = new Set(["in", "of", "and", "the", "for", "a", "an"]);
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) =>
      index > 0 && minor.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}
