/**
 * The upload path's validator (supabase/functions/_shared) against the cases generated
 * from the CLI loader's Python validator. If these disagree, a file could load from the
 * command line and be refused by the upload panel, or the reverse.
 */

import { describe, expect, it } from "vitest";

import { parseCsv } from "../../../supabase/functions/_shared/csv.ts";
import cases from "../../../supabase/functions/_shared/validate.cases.json";
import {
  checkHeader,
  HeaderError,
  normaliseRow,
  validateCsv,
} from "../../../supabase/functions/_shared/validate.ts";

describe("row contract matches backend/app/validate.py", () => {
  it.each(cases.rows.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const { row, rejection } = normaliseRow(
      c.raw as Record<string, string>,
      c.row_number,
      c.include_sensitive,
    );
    if ("reason" in c.expect) {
      expect(row).toBeNull();
      expect(rejection?.reason).toBe(c.expect.reason);
    } else {
      expect(rejection).toBeNull();
      expect(row).toEqual(c.expect.row);
    }
  });
});

describe("header contract matches backend/app/validate.py", () => {
  it.each(cases.headers.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    if ("error" in c.expect) {
      expect(() => checkHeader(c.header)).toThrow(new HeaderError(c.expect.error as string));
    } else {
      expect(checkHeader(c.header)).toEqual(c.expect.ignored);
    }
  });
});

describe("CSV reading behaves like Python's csv module", () => {
  it("handles quotes, escaped quotes, embedded newlines and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",3\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["two\nlines", "3"],
    ]);
  });

  it("skips empty lines but keeps a line holding an empty quoted field", () => {
    expect(parseCsv('a\n\n""\n1')).toEqual([["a"], [""], ["1"]]);
  });

  it("numbers rows the way the CLI reports them: header is row 1", () => {
    const text = "﻿USER_INDEX,SCHOOL YEAR,TERM,COURSE\n1,2025,1,BS IT\n\n2,2025,9,BS IT\n";
    const { rows, report } = validateCsv(text);
    expect(rows).toHaveLength(1);
    expect(report.rows_read).toBe(2);
    expect(report.rejections[0]).toMatchObject({ row_number: 3, reason: "term 9 out of range 1-4" });
  });

  it("refuses a file without the required columns before reading rows", () => {
    expect(() => validateCsv("USER_INDEX,TERM\n1,1\n")).toThrow(HeaderError);
  });
});
