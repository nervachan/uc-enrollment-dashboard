import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api, type Filters } from "./lib/api";
import { filtersFromSearch, searchFromFilters, activeFilterCount } from "./lib/urlState";
import { BarList } from "./components/BarList";
import { FilterBar } from "./components/FilterBar";
import type { Level } from "./components/MapPanel";

// MapLibre is ~800 kB of the bundle — more than everything else combined. Loading it
// on demand lets the tiles, totals and charts paint while the map engine arrives.
const MapPanel = lazy(() =>
  import("./components/MapPanel").then((module) => ({ default: module.MapPanel })),
);
import { StatTiles } from "./components/StatTiles";
import { UploadPanel } from "./components/UploadPanel";
import { TrendChart } from "./components/TrendChart";
import { formatNumber, titleCase } from "./lib/format";

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("uc-theme") : null;
    if (stored === "light" || stored === "dark") return stored;
    return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("uc-theme", theme);
    } catch {
      /* private browsing — the toggle still works for this session */
    }
  }, [theme]);
  return { theme, toggle: () => setTheme((current) => (current === "dark" ? "light" : "dark")) };
}

export default function App() {
  const { theme, toggle } = useTheme();
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearch(window.location.search));
  const [level, setLevel] = useState<Level>("province");
  const [uploadOpen, setUploadOpen] = useState(false);

  // The URL is the source of truth for a shared view; pushing on every change would
  // bury the back button, so filter edits replace instead.
  useEffect(() => {
    const search = searchFromFilters(filters);
    window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
  }, [filters]);

  const options = useQuery({ queryKey: ["filters"], queryFn: api.filters, staleTime: Infinity });
  const summary = useQuery({ queryKey: ["summary", filters], queryFn: () => api.summary(filters) });
  const scale = useQuery({
    queryKey: ["scale", level, filters],
    queryFn: () => api.scale(level, filters),
  });
  const feeders = useQuery({
    queryKey: ["feeders", filters],
    queryFn: () => api.feederSchools(filters),
  });

  const onDrillDown = useCallback(
    (from: Level, name: string, province: string | null) => {
      if (from === "country") return;
      if (from === "province") {
        setFilters((current) => ({ ...current, province: name }));
        setLevel("municipality");
      } else if (province) {
        // Already at municipality level: clicking filters to that municipality's province.
        setFilters((current) => ({ ...current, province }));
      }
    },
    [],
  );

  const totals = summary.data?.totals;
  const breakdowns = summary.data?.breakdowns ?? {};
  const activeCount = activeFilterCount(filters);

  const scopeLabel = useMemo(() => {
    if (filters.province) return filters.province;
    return "All origins";
  }, [filters.province]);

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">UC Enrollment Geography</h1>
          <p className="text-sm text-[var(--color-ink-2)]">
            Where University of the Cordilleras students come from, SY2023–SY2026.{" "}
            <span className="text-[var(--color-ink-muted)]">
              Counts recomputed from the registrar extract.
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {summary.data ? (
            <span className="text-xs text-[var(--color-ink-muted)]">
              {formatNumber(summary.data.totals.records)} records loaded
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            className="rounded-lg border border-[var(--color-hairline)] px-3 py-1.5 text-xs text-[var(--color-ink-2)] hover:bg-[var(--color-grid)]"
          >
            Upload data
          </button>
          <button
            type="button"
            onClick={toggle}
            className="rounded-lg border border-[var(--color-hairline)] px-3 py-1.5 text-xs text-[var(--color-ink-2)] hover:bg-[var(--color-grid)]"
          >
            {theme === "dark" ? "Light" : "Dark"} mode
          </button>
        </div>
      </header>

      {uploadOpen ? <UploadPanel onClose={() => setUploadOpen(false)} /> : null}

      <FilterBar
        options={options.data}
        filters={filters}
        onChange={setFilters}
        onReset={() => {
          setFilters(filtersFromSearch(""));
          setLevel("province");
        }}
      />

      {summary.isError ? (
        <p className="mt-4 rounded-xl border border-[var(--color-hairline)] bg-[var(--color-surface)] p-4 text-sm">
          The API is unreachable. Check that the backend is running and that{" "}
          <code>VITE_API_URL</code> points at it.
        </p>
      ) : null}

      <div className="mt-4">
        {totals ? <StatTiles totals={totals} metric={filters.metric} /> : null}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="rounded-xl border border-[var(--color-hairline)] bg-[var(--color-surface)] p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {(["country", "province", "municipality"] as Level[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setLevel(item)}
                  aria-pressed={level === item}
                  className={`rounded-full border px-3 py-1 text-xs capitalize ${
                    level === item
                      ? "border-[var(--color-series-1)] bg-[var(--color-series-1)] text-white"
                      : "border-[var(--color-hairline)] text-[var(--color-ink-2)] hover:bg-[var(--color-grid)]"
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
              <span>{scopeLabel}</span>
              {activeCount > 0 ? (
                <span className="rounded-full bg-[var(--color-grid)] px-2 py-0.5">
                  {activeCount} filter{activeCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
          </div>
          <Suspense
            fallback={
              <div className="flex h-[560px] items-center justify-center rounded-xl border border-[var(--color-hairline)] text-sm text-[var(--color-ink-muted)]">
                Loading map…
              </div>
            }
          >
            <MapPanel
              level={level}
              filters={filters}
              scale={scale.data}
              isDark={theme === "dark"}
              onDrillDown={onDrillDown}
            />
          </Suspense>
          <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
            Click a province to drill into its municipalities. Municipalities are matched on
            name and province together — a count shown here is for that municipality only.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          <TrendChart data={summary.data?.trend ?? []} metric={filters.metric} />
          <BarList
            title="Colleges"
            data={breakdowns.college ?? []}
            total={totals?.[filters.metric === "headcount" ? "headcount" : "records"]}
            selected={filters.college}
            onSelect={(key) =>
              setFilters((current) => ({
                ...current,
                college: current.college.includes(key)
                  ? current.college.filter((item) => item !== key)
                  : [...current.college, key],
                course: [],
              }))
            }
          />
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <BarList title="Top programs" data={breakdowns.top_courses ?? []} humanise limit={10} />
        <BarList title="Top provinces of origin" data={breakdowns.top_provinces ?? []} limit={10} />
        <section className="rounded-xl border border-[var(--color-hairline)] bg-[var(--color-surface)] p-4">
          <h3 className="text-sm font-semibold">Top feeder schools</h3>
          <ul className="mt-3 space-y-1.5">
            {(feeders.data ?? []).slice(0, 10).map((row) => (
              <li key={`${row.school}-${row.province}`} className="flex justify-between gap-3 text-[13px]">
                <span className="truncate text-[var(--color-ink-2)]">{titleCase(row.school)}</span>
                <span className="shrink-0 tabular-nums text-[var(--color-ink-2)]">
                  {formatNumber(row.headcount)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <footer className="mt-6 text-xs text-[var(--color-ink-muted)]">
        Students = distinct people. Enrollment records = one row per student, school year and
        term; a student enrolled in three terms is one student and three records.
      </footer>
    </div>
  );
}
