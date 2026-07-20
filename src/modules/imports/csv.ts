// Minimal RFC 4180 CSV parser for asset imports. Deliberately dependency-
// free and runtime-neutral (plain string scanning, no Bun/Node APIs).
// Quoted fields may contain commas, escaped quotes (""), and newlines;
// records end at LF or CRLF; a UTF-8 BOM on the first header is stripped;
// blank records are skipped. The parser returns raw cells only — header
// mapping and per-field validation belong to the import service.

export interface CsvRecord {
  /** 1-based physical line where the record starts (for error messages). */
  line: number;
  cells: string[];
}

export type CsvParseResult =
  | { ok: true; records: CsvRecord[] }
  | { ok: false; message: string };

export function parseCsv(text: string): CsvParseResult {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];

  let cells: string[] = [];
  let field = "";
  // A record with one empty unquoted cell is a blank line, not data — but
  // `""` (a lone quoted empty cell) is a real record, so quoting is tracked.
  let sawQuotedCell = false;
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;

  const endField = () => {
    cells.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    const isBlankLine =
      cells.length === 1 && cells[0] === "" && !sawQuotedCell;
    if (!isBlankLine) {
      records.push({ line: recordStartLine, cells });
    }
    cells = [];
    sawQuotedCell = false;
    recordStartLine = line;
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        // A closing quote must end the field: only a separator, a record
        // end, or EOF may follow.
        const next = input[i];
        if (
          next !== undefined &&
          next !== "," &&
          next !== "\n" &&
          next !== "\r"
        ) {
          return {
            ok: false,
            message: `line ${line}: unexpected character after closing quote`,
          };
        }
        continue;
      }
      if (ch === "\n") line += 1;
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field !== "") {
        return {
          ok: false,
          message: `line ${line}: quote may only start a field`,
        };
      }
      inQuotes = true;
      sawQuotedCell = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r" && input[i + 1] === "\n") {
      line += 1;
      endRecord();
      i += 2;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      line += 1;
      endRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (inQuotes) {
    return {
      ok: false,
      message: `line ${recordStartLine}: unterminated quoted field`,
    };
  }
  // Final record when the file does not end with a newline.
  if (field !== "" || cells.length > 0 || sawQuotedCell) {
    endRecord();
  }

  return { ok: true, records };
}

/**
 * Serialize records to RFC 4180 CSV (CRLF record ends, quotes doubled).
 * Cells that spreadsheet apps would treat as formulas (leading = + - @ or
 * a control char) are prefixed with a single quote — the standard export
 * mitigation against CSV formula injection via stored data.
 */
export function serializeCsv(records: string[][]): string {
  const cell = (value: string): string => {
    let v = value;
    if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
    if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  return records.map((r) => r.map(cell).join(",") + "\r\n").join("");
}
