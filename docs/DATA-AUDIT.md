# Data audit — "Dashboard Files", 12 October 2026

Findings from the five files in the registrar's `Dashboard Files` folder, before any of
this application was written. They are the reason the API recomputes every count from the
CSV instead of serving the numbers already stored in the GeoPackages.

## The files

| File | Size | What it holds |
|---|---|---|
| `Data for dashboard.csv` | 36 MB | 158,101 rows, 20 columns, SY2023–SY2026, terms 1–3 |
| `All Enrollees International (Country-level).gpkg` | 2 MB | 242 country polygons, one `Count` field |
| `All Enrollees Per Program (Provincial-level).gpkg` | 211 MB | 88 provinces × 81 program columns |
| `All Enrollees Per Program and Total (Municipal-level).gpkg` | 224 MB | 1,642 municipalities × 89 columns |
| `New Enrollees Per Program (Municipal-level).gpkg` | 243 MB | **88 provinces**, despite the filename |

The CSV holds **38,007 distinct students** across 158,101 enrollment rows.

## Finding 1 — the municipal layer is joined on municipality name alone

`Total Enrollees` across the municipal layer sums to **42,890**, against 38,007 distinct
students in the source. The gap is not rounding; it is a join defect.

Reproducing the layer from the CSV by matching on municipality **name only**, ignoring
province, returns **42,891** — and reproduces the 2023 column exactly at 21,996. The
match is conclusive.

The consequence is that every municipality whose name repeats across provinces carries
the national total for that name:

| Municipality name | Polygons sharing it | Students with that name | Over-count |
|---|---|---|---|
| Rosario | 5 | 209 | +836 |
| Santa Maria | 6 | 166 | +830 |
| Burgos | 6 | 143 | +715 |
| Santa Cruz | 5 | 170 | +680 |
| San Manuel | 3 | 172 | +344 |

Total inflation from name collisions: **7,325**. Every Rosario on the map shows all 209
Rosario students, in Benguet, La Union, Batangas and Cavite alike.

The provincial layer was checked the same way and is **correct** — province names are
unique, so the same join happened to work there.

*Fixed by:* `boundary` is keyed on `(level, name, province)` and the loader resolves a
municipality by name **and** province. `tests/test_etl.py::test_municipality_is_resolved_by_name_and_province`
is the regression test; it fails if anyone reintroduces a name-only join.

## Finding 2 — "enrollee" means two different things

`Total Enrollees` counts distinct students; the per-year columns (2023–2026) also count
distinct students per year, so they cannot be added across years — 21,996 + 23,097 +
23,619 + 21,382 = 90,094, against a stated total of 42,890. Nothing in the file says
which is meant.

*Fixed by:* two named metrics that are never conflated — `headcount`
(`COUNT(DISTINCT student_ref)`) and `enrollment_records` (`COUNT(*)`). Both are shown on
the dashboard at all times, and `?metric=` chooses which one the map colours by.

## Finding 3 — the "New Enrollees (Municipal-level)" file is neither

It carries 88 features keyed on `adm2_name`: provinces, not municipalities. Its values
match **new enrollees for SY2026, term 1** (verified against every school-year/term
combination; SY2026 T1 matches to within 11 students across all 88 provinces, every other
combination is off by hundreds).

So the file is a single-term provincial snapshot with a filename that promises an
all-time municipal one.

*Handled by:* the loader ignores this file. "New" is a filter in the dashboard
(`?status=New`), applied to the same fact table, at any level and any term.

## Finding 4 — the geometry cannot be served as it stands

678 MB of boundary geometry for roughly 1,800 polygons: Palawan's geometry alone is
31 MB. No browser will load that as GeoJSON.

*Fixed by:* geometry is stored once in PostGIS, with a simplified copy for GeoJSON and a
Web Mercator copy for tiles. The API serves Mapbox Vector Tiles built with `ST_AsMVT`;
measured tile sizes are 1–9 KB and tiles render in 0.03–0.2 s. Storing the Mercator copy
rather than reprojecting per request took the country tile from 2.1 s to 0.20 s.

## Finding 5 — the CSV carries sensitive personal data the dashboard does not need

Per-student religion (denomination), civil status, sex, home municipality and previous
school. Under the Data Privacy Act religion and civil status are sensitive personal
information, and nothing on this dashboard is answered by either.

*Fixed by:* the loader never stores the denomination-level `RELIGION` column at all, and
`BROAD_RELIGION` and `CIVIL_STATUS` are dropped unless `--include-sensitive` is passed
deliberately. `student_ref` is the registrar's pseudonymous `USER_INDEX`; no name, birth
date or contact field is present in the source and none is stored.

## Finding 6 — small stuff worth knowing

- **3 duplicate rows** on `(student, school year, term, course)`. The natural-key index
  skips them and the batch record reports them; nothing silently doubles.
- **7 students appear in two municipalities** across different terms, presumably a
  corrected address. Each counts once in its own municipality and once nationally, which
  is why per-municipality headcounts sum to 38,014 against 38,007 students. Documented
  rather than silently de-duplicated — picking a "true" municipality is a registrar
  decision, not an engineering one.
- **2,083 rows report no origin at all** ("Not Reported"), and 7 report "Not Applicable".
  They are loaded, counted in totals, and excluded from the map, where they have nowhere
  to go. The ingest report lists every unmatched origin with its row count.
- **Region names contain stray double spaces and tabs** ("Cordillera Administrative
  Region   (CAR)"), which would create duplicate filter entries. Whitespace is collapsed
  on load.
- **All country names matched** the country layer except the two placeholders above.

## What was verified against the full dataset

Findings 1, 2, 3 and 6 were computed against the complete 158,101-row CSV and the full
GeoPackages on the originating machine. The application itself was built and tested
against the full CSV plus a 21-province geometry subset (northern Luzon, 419
municipalities), because the complete boundary set is 678 MB. Nothing in the loader or
the API is sensitive to which provinces are present; loading the full folder is the same
command.
