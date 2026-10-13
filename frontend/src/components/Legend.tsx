import type { Scale } from "../lib/api";
import { legendClasses } from "../lib/choropleth";

/** Quantile classes, labelled with their ranges — a colour ramp with no numbers is decoration. */
export function Legend({ scale, dark = false }: { scale: Scale; dark?: boolean }) {
  const classes = legendClasses(scale.breaks, scale.max, dark);
  return (
    <div className="absolute bottom-3 left-3 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)]/95 px-3 py-2 backdrop-blur">
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] font-medium text-[var(--color-ink-2)]">
          {scale.metric === "headcount" ? "Students" : "Enrollment records"}
        </span>
        {scale.method === "logarithmic" ? (
          // Say so. A reader comparing two shades is entitled to know the classes are
          // not evenly spaced — at country level the Philippines is 94% of the data.
          <span
            className="text-[10px] text-[var(--color-ink-muted)]"
            title="Class breaks are geometric because one boundary holds most of the data"
          >
            log scale
          </span>
        ) : null}
      </div>
      <ul className="mt-1 flex gap-3">
        {classes.map((item) => (
          <li key={item.label} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-3 w-3 rounded-sm ring-1 ring-[var(--color-hairline)]"
              style={{ background: item.color }}
            />
            <span className="text-[11px] tabular-nums text-[var(--color-ink-muted)]">
              {item.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
