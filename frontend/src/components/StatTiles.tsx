import type { Metric, Totals } from "../lib/api";
import { formatNumber } from "../lib/format";

interface Props {
  totals: Totals;
  metric: Metric;
}

/**
 * Headcount and enrollment records sit side by side on purpose. The source
 * GeoPackages conflated them, which is how a 38,007-student dataset came to report
 * 42,890 "enrollees"; showing both keeps the distinction in front of the reader.
 */
export function StatTiles({ totals, metric }: Props) {
  const tiles = [
    {
      label: "Students",
      value: totals.headcount,
      hint: "distinct people",
      emphasised: metric === "headcount",
    },
    {
      label: "Enrollment records",
      value: totals.records,
      hint: "person × year × term",
      emphasised: metric === "records",
    },
    { label: "Programs", value: totals.programs, hint: "distinct courses" },
    { label: "Municipalities", value: totals.municipalities, hint: "with students" },
    { label: "Provinces", value: totals.provinces, hint: "with students" },
    { label: "Countries", value: totals.countries, hint: "with students" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className={`rounded-xl border bg-[var(--color-surface)] p-3 ${
            tile.emphasised
              ? "border-[var(--color-series-1)]"
              : "border-[var(--color-hairline)]"
          }`}
        >
          <div className="text-xs text-[var(--color-ink-muted)]">{tile.label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-[var(--color-ink)]">
            {formatNumber(tile.value)}
          </div>
          <div className="text-[11px] text-[var(--color-ink-muted)]">{tile.hint}</div>
        </div>
      ))}
    </div>
  );
}
