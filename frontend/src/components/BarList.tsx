import { useState } from "react";
import { formatNumber, percent, titleCase } from "../lib/format";

export interface BarDatum {
  key: string | number;
  value: number;
}

interface Props {
  title: string;
  data: BarDatum[];
  total?: number;
  limit?: number;
  humanise?: boolean;
  onSelect?: (key: string) => void;
  selected?: string[];
  emptyMessage?: string;
}

/**
 * Horizontal bars for a ranked category. One series, so no legend — the title names it —
 * and every bar is directly labelled with its value, which is what people read here.
 */
export function BarList({
  title,
  data,
  total,
  limit = 10,
  humanise = false,
  onSelect,
  selected = [],
  emptyMessage = "No data for these filters",
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const rows = data.slice(0, limit);
  const max = Math.max(...rows.map((row) => row.value), 1);

  return (
    <section className="rounded-xl border border-[var(--color-hairline)] bg-[var(--color-surface)] p-4">
      <h3 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-ink-muted)]">{emptyMessage}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => {
            const key = String(row.key);
            const label = humanise ? titleCase(key) : key;
            const isSelected = selected.includes(key);
            const Row = onSelect ? "button" : "div";
            return (
              <li key={key}>
                <Row
                  {...(onSelect
                    ? { type: "button" as const, onClick: () => onSelect(key), "aria-pressed": isSelected }
                    : {})}
                  onMouseEnter={() => setHovered(key)}
                  onMouseLeave={() => setHovered(null)}
                  title={total ? `${label}: ${formatNumber(row.value)} (${percent(row.value, total)})` : undefined}
                  className={`block w-full text-left ${onSelect ? "cursor-pointer" : ""}`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span
                      className={`truncate text-[13px] ${
                        isSelected
                          ? "font-semibold text-[var(--color-ink)]"
                          : "text-[var(--color-ink-2)]"
                      }`}
                    >
                      {label}
                    </span>
                    <span className="shrink-0 text-[13px] tabular-nums text-[var(--color-ink-2)]">
                      {formatNumber(row.value)}
                      {total ? (
                        <span className="ml-1 text-[var(--color-ink-muted)]">
                          {percent(row.value, total)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full rounded-full bg-[var(--color-grid)]">
                    <div
                      data-testid={`bar-${key}`}
                      className="h-2 rounded-full bg-[var(--color-series-1)] transition-[width,opacity] duration-200"
                      style={{
                        width: `${Math.max((row.value / max) * 100, 1.5)}%`,
                        opacity: hovered && hovered !== key ? 0.55 : 1,
                      }}
                    />
                  </div>
                </Row>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
