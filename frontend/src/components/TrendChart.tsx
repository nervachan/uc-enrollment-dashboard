import { useState } from "react";
import { formatNumber } from "../lib/format";

export interface TrendPoint {
  year: number;
  headcount: number;
  records: number;
}

interface Props {
  data: TrendPoint[];
  metric: "headcount" | "records";
}

const WIDTH = 520;
const HEIGHT = 190;
const PADDING = { top: 16, right: 20, bottom: 28, left: 48 };

/**
 * Enrollment over school years. One series, so no legend; a crosshair and a value
 * readout on hover rather than a number printed on every point.
 */
export function TrendChart({ data, metric }: Props) {
  const [active, setActive] = useState<number | null>(null);
  if (data.length === 0) {
    return (
      <section className="rounded-xl border border-[var(--color-hairline)] bg-[var(--color-surface)] p-4">
        <h3 className="text-sm font-semibold">Enrollment by school year</h3>
        <p className="mt-3 text-sm text-[var(--color-ink-muted)]">No data for these filters</p>
      </section>
    );
  }

  const values = data.map((point) => point[metric]);
  const max = Math.max(...values);
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const x = (index: number) =>
    PADDING.left + (data.length === 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth);
  const y = (value: number) => PADDING.top + plotHeight - (value / (max || 1)) * plotHeight;
  const path = data.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point[metric])}`).join(" ");
  const ticks = [0, max / 2, max];
  const point = active === null ? null : data[active];

  return (
    <section className="rounded-xl border border-[var(--color-hairline)] bg-[var(--color-surface)] p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Enrollment by school year</h3>
        <span data-testid="trend-readout" className="text-xs text-[var(--color-ink-muted)]">
          {point ? `SY ${point.year}: ${formatNumber(point[metric])}` : metric}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-2 w-full"
        role="img"
        aria-label={`Enrollment ${metric} by school year`}
        onMouseLeave={() => setActive(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--color-grid)"
              strokeWidth={1}
            />
            <text
              x={PADDING.left - 8}
              y={y(tick) + 4}
              textAnchor="end"
              className="fill-[var(--color-ink-muted)] text-[10px] tabular-nums"
            >
              {formatNumber(Math.round(tick))}
            </text>
          </g>
        ))}

        <path d={path} fill="none" stroke="var(--color-series-2)" strokeWidth={2} />

        {data.map((item, index) => (
          <g key={item.year}>
            <circle
              cx={x(index)}
              cy={y(item[metric])}
              r={active === index ? 6 : 4}
              fill="var(--color-series-2)"
              stroke="var(--color-surface)"
              strokeWidth={2}
            />
            <text
              x={x(index)}
              y={HEIGHT - 8}
              textAnchor="middle"
              className="fill-[var(--color-ink-muted)] text-[11px] tabular-nums"
            >
              {item.year}
            </text>
            {/* Hit target wider than the mark, as pointer targets should be. */}
            <rect
              data-testid={`hit-${item.year}`}
              x={x(index) - plotWidth / (data.length * 2)}
              y={PADDING.top}
              width={plotWidth / data.length}
              height={plotHeight}
              fill="transparent"
              onMouseEnter={() => setActive(index)}
            >
              <title>{`SY ${item.year}: ${formatNumber(item[metric])}`}</title>
            </rect>
          </g>
        ))}
      </svg>
    </section>
  );
}
