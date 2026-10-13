/**
 * CSV reading that behaves like Python's csv.DictReader with the default dialect, so the
 * upload path and the CLI loader (backend/app/etl/enrollments.py) see the same records:
 * comma-separated, double-quote quoting with "" as an escaped quote, quoted fields may
 * span lines, CRLF or LF line ends, and an empty line is skipped rather than read as a
 * record. Pure TypeScript: imported by the Edge Function (Deno) and by the frontend's
 * tests (Vitest).
 */

/** Split CSV text into records. Empty lines produce no record. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let sawAnything = false; // distinguishes an empty line from a line holding ""
  let i = 0;

  const endRecord = () => {
    if (sawAnything) {
      record.push(field);
      records.push(record);
    }
    record = [];
    field = "";
    sawAnything = false;
  };

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      sawAnything = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
      sawAnything = true;
    } else if (ch === "\r" || ch === "\n") {
      endRecord();
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
    } else {
      field += ch;
      sawAnything = true;
    }
    i += 1;
  }
  endRecord();
  return records;
}

/**
 * Records as objects keyed by the header row, as DictReader yields them: a short row
 * leaves the missing keys undefined, extra fields are dropped.
 */
export function readDicts(text: string): {
  header: string[] | null;
  rows: Record<string, string>[];
} {
  const records = parseCsv(text);
  if (records.length === 0) return { header: null, rows: [] };
  const [header, ...body] = records;
  const rows = body.map((values) => {
    const row: Record<string, string> = {};
    header.forEach((name, index) => {
      if (index < values.length) row[name] = values[index];
    });
    return row;
  });
  return { header, rows };
}
