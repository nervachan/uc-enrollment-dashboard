import type { Filters, FilterOptions, Metric } from "../lib/api";
import { toggleValue } from "../lib/urlState";
import { titleCase } from "../lib/format";

interface Props {
  options?: FilterOptions;
  filters: Filters;
  onChange: (next: Filters) => void;
  onReset: () => void;
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? "border-[var(--color-series-1)] bg-[var(--color-series-1)] text-white"
          : "border-[var(--color-hairline)] text-[var(--color-ink-2)] hover:bg-[var(--color-grid)]"
      }`}
    >
      {label}
    </button>
  );
}

/** One row of controls above the charts, as filters should be. */
export function FilterBar({ options, filters, onChange, onReset }: Props) {
  const courses = filters.college.length
    ? (options?.courses_by_college ?? [])
        .filter((row) => filters.college.includes(row.college))
        .map((row) => row.course)
    : (options?.course ?? []);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-hairline)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 text-xs font-medium text-[var(--color-ink-muted)]">School year</span>
        {(options?.school_year ?? []).map((year) => (
          <Chip
            key={year}
            label={String(year)}
            active={filters.school_year.includes(year)}
            onClick={() => onChange({ ...filters, school_year: toggleValue(filters.school_year, year) })}
          />
        ))}
        <span className="ml-4 text-xs font-medium text-[var(--color-ink-muted)]">Term</span>
        {(options?.term ?? []).map((term) => (
          <Chip
            key={term}
            label={String(term)}
            active={filters.term.includes(term)}
            onClick={() => onChange({ ...filters, term: toggleValue(filters.term, term) })}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 text-xs font-medium text-[var(--color-ink-muted)]">College</span>
        {(options?.college ?? []).map((college) => (
          <Chip
            key={college}
            label={college}
            active={filters.college.includes(college)}
            onClick={() =>
              onChange({ ...filters, college: toggleValue(filters.college, college), course: [] })
            }
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="w-24 shrink-0 text-xs font-medium text-[var(--color-ink-muted)]">
          Program
        </span>
        <select
          aria-label="Program"
          value={filters.course[0] ?? ""}
          onChange={(event) =>
            onChange({ ...filters, course: event.target.value ? [event.target.value] : [] })
          }
          className="max-w-xs rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)]"
        >
          <option value="">All programs</option>
          {courses.map((course) => (
            <option key={course} value={course}>
              {titleCase(course)}
            </option>
          ))}
        </select>

        <span className="text-xs font-medium text-[var(--color-ink-muted)]">Status</span>
        {(options?.status ?? []).map((status) => (
          <Chip
            key={status}
            label={status}
            active={filters.status.includes(status)}
            onClick={() => onChange({ ...filters, status: toggleValue(filters.status, status) })}
          />
        ))}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--color-ink-muted)]">Measure</span>
          {(["headcount", "records"] as Metric[]).map((metric) => (
            <Chip
              key={metric}
              label={metric === "headcount" ? "Students" : "Records"}
              active={filters.metric === metric}
              onClick={() => onChange({ ...filters, metric })}
            />
          ))}
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg border border-[var(--color-hairline)] px-3 py-1 text-xs text-[var(--color-ink-2)] hover:bg-[var(--color-grid)]"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
