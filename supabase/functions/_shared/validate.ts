/**
 * The row contract for enrollment extracts — a line-for-line port of
 * backend/app/validate.py, so a file that loads from the command line cannot be rejected
 * by the upload panel, or the reverse. Both implementations are tested against the same
 * cases in validate.cases.json.
 *
 * Pure TypeScript: imported by the Edge Function (Deno) and by the frontend's tests.
 */

import { readDicts } from "./csv.ts";

/** Source column -> internal field. The registrar's export header is the contract. */
export const COLUMN_MAP: Record<string, string> = {
  USER_INDEX: "student_ref",
  SEX: "sex",
  BROAD_RELIGION: "broad_religion",
  CIVIL_STATUS: "civil_status",
  COLLEGE: "college",
  COURSE: "course",
  YEAR_LEVEL: "year_level",
  "YEAR OF ENTRY": "year_of_entry",
  "TERM OF ENTRY": "term_of_entry",
  NATIONALITY: "nationality",
  STATUS: "status",
  "SCHOOL YEAR": "school_year",
  TERM: "term",
  PROGRAM_GROUP: "program_group",
  MUNICITY: "municity",
  PROVINCE: "province",
  REGION: "region",
  COUNTRY: "country",
  "PREV_SCHOOL CORRECTED": "prev_school",
};

export const REQUIRED_COLUMNS = ["COURSE", "SCHOOL YEAR", "TERM", "USER_INDEX"];

/**
 * Collected but never loaded from the upload panel. RELIGION is never loaded at all;
 * BROAD_RELIGION and CIVIL_STATUS are sensitive personal information under the Data
 * Privacy Act and only the CLI loader's --include-sensitive flag can turn them on.
 */
export const SENSITIVE_FIELDS = new Set(["broad_religion", "civil_status"]);

const INT_FIELDS = new Set(["school_year", "term", "year_level", "year_of_entry", "term_of_entry"]);

const PLACEHOLDERS = new Set(["na", "n/a", "null", "none", "-"]);

/** Matches what Python's float() accepts for the numbers this export contains. */
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export type Value = string | number | null;
export type Row = Record<string, Value>;

export interface Rejection {
  row_number: number;
  reason: string;
  payload: Record<string, string>;
}

export interface ValidationReport {
  rows_read: number;
  rows_valid: number;
  rejections: Rejection[];
  ignored_columns: string[];
}

/** The file cannot be processed at all — raised before any row is read. */
export class HeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeaderError";
  }
}

/** Python sorts strings by code point; so does this. */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Validate the header; return the columns that will be ignored. */
export function checkHeader(header: string[] | null): string[] {
  if (!header || header.length === 0) throw new HeaderError("file has no header row");
  const present = new Set(header.map((h) => h.trim().replace(/^﻿/, "")));
  const missing = REQUIRED_COLUMNS.filter((c) => !present.has(c));
  if (missing.length) {
    throw new HeaderError("missing required column(s): " + missing.join(", "));
  }
  return [...present].filter((c) => !(c in COLUMN_MAP)).sort(byCodePoint);
}

/** Trim, collapse internal whitespace, and map placeholder text to null. */
export function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\t/g, " ").replace(/\s+/g, " ").trim();
  if (text === "" || PLACEHOLDERS.has(text.toLowerCase())) return null;
  return text;
}

/** Python's repr() of a string, as the CLI's rejection messages print it. */
function pyRepr(text: string): string {
  if (text.includes("'") && !text.includes('"')) return `"${text}"`;
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Map one source row onto internal fields, or explain why it cannot be used. */
export function normaliseRow(
  raw: Record<string, string>,
  rowNumber: number,
  includeSensitive = false,
): { row: Row | null; rejection: Rejection | null } {
  const row: Row = {};
  const reject = (reason: string) => ({
    row: null,
    rejection: { row_number: rowNumber, reason, payload: { ...raw } },
  });

  for (const [source, target] of Object.entries(COLUMN_MAP)) {
    if (SENSITIVE_FIELDS.has(target) && !includeSensitive) {
      row[target] = null;
      continue;
    }
    const value = clean(raw[source]);
    if (INT_FIELDS.has(target) && value !== null) {
      if (!NUMBER.test(value)) return reject(`${source}: ${pyRepr(value)} is not a number`);
      row[target] = Math.trunc(Number(value));
    } else {
      row[target] = value;
    }
  }

  for (const required of ["student_ref", "school_year", "term", "course"]) {
    if (row[required] === null || row[required] === "") return reject(`${required} is empty`);
  }

  const year = row.school_year as number;
  if (year < 1900 || year > 2200) return reject(`school_year ${year} out of range`);
  const term = row.term as number;
  if (term < 1 || term > 4) return reject(`term ${term} out of range 1-4`);
  const level = row.year_level as number | null;
  if (level !== null && (level < 1 || level > 10)) {
    return reject(`year_level ${level} out of range 1-10`);
  }
  return { row, rejection: null };
}

/**
 * Validate a whole CSV. Rejections are capped at 1,000, as in the CLI loader. Throws
 * HeaderError when the file cannot be read at all.
 */
export function validateCsv(
  text: string,
  includeSensitive = false,
): { rows: Row[]; report: ValidationReport } {
  const { header, rows: raws } = readDicts(text.replace(/^﻿/, ""));
  const report: ValidationReport = {
    rows_read: 0,
    rows_valid: 0,
    rejections: [],
    ignored_columns: checkHeader(header),
  };
  const rows: Row[] = [];
  raws.forEach((raw, index) => {
    report.rows_read += 1;
    const { row, rejection } = normaliseRow(raw, index + 2, includeSensitive); // row 1 is the header
    if (rejection) {
      if (report.rejections.length < 1000) report.rejections.push(rejection);
      return;
    }
    report.rows_valid += 1;
    rows.push(row as Row);
  });
  return { rows, report };
}
