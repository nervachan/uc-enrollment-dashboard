/** Filters live in the URL, so any view of the dashboard can be pasted to a colleague. */

import { EMPTY_FILTERS, type Filters, type Metric } from "./api";

const LIST_KEYS = ["school_year", "term", "college", "course", "program_group", "status"] as const;
const NUMBER_KEYS = new Set(["school_year", "term"]);

export function filtersFromSearch(search: string): Filters {
  const params = new URLSearchParams(search);
  const filters: Filters = { ...EMPTY_FILTERS };
  for (const key of LIST_KEYS) {
    const values = params.getAll(key).filter(Boolean);
    (filters[key] as (string | number)[]) = NUMBER_KEYS.has(key)
      ? values.map(Number).filter((n) => Number.isFinite(n))
      : values;
  }
  const province = params.get("province");
  if (province) filters.province = province;
  const metric = params.get("metric");
  if (metric === "headcount" || metric === "records") filters.metric = metric as Metric;
  return filters;
}

export function searchFromFilters(filters: Filters): string {
  const params = new URLSearchParams();
  for (const key of LIST_KEYS) {
    for (const value of filters[key]) params.append(key, String(value));
  }
  if (filters.province) params.set("province", filters.province);
  // headcount is the default; leaving it out keeps shared links short.
  if (filters.metric !== "headcount") params.set("metric", filters.metric);
  return params.toString();
}

export function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function activeFilterCount(filters: Filters): number {
  const lists = LIST_KEYS.reduce((total, key) => total + filters[key].length, 0);
  return lists + (filters.province ? 1 : 0);
}
