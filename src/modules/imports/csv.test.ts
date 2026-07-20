import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";

function cells(result: ReturnType<typeof parseCsv>): string[][] {
  if (!result.ok) throw new Error(`parse failed: ${result.message}`);
  return result.records.map((r) => r.cells);
}

describe("parseCsv", () => {
  it("parses a simple header and rows", () => {
    const result = parseCsv("name,serial\nLaptop A,SN-1\nLaptop B,SN-2\n");
    expect(cells(result)).toEqual([
      ["name", "serial"],
      ["Laptop A", "SN-1"],
      ["Laptop B", "SN-2"],
    ]);
  });

  it("handles CRLF line endings", () => {
    const result = parseCsv("a,b\r\n1,2\r\n");
    expect(cells(result)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("parses a final record without a trailing newline", () => {
    const result = parseCsv("a,b\n1,2");
    expect(cells(result)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    const result = parseCsv('name,notes\n"Dock, USB-C","said ""fine"""\n');
    expect(cells(result)).toEqual([
      ["name", "notes"],
      ["Dock, USB-C", 'said "fine"'],
    ]);
  });

  it("preserves newlines inside quoted fields", () => {
    const result = parseCsv('name,notes\nA,"line one\nline two"\n');
    expect(cells(result)).toEqual([
      ["name", "notes"],
      ["A", "line one\nline two"],
    ]);
  });

  it("keeps empty cells, including trailing ones", () => {
    const result = parseCsv("a,b,c\n1,,\n");
    expect(cells(result)).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
    ]);
  });

  it("skips blank lines but keeps a lone quoted empty cell", () => {
    const result = parseCsv('a\n\n1\n\n""\n');
    expect(cells(result)).toEqual([["a"], ["1"], [""]]);
  });

  it("strips a UTF-8 BOM before the header", () => {
    const result = parseCsv("\uFEFFname\nA\n");
    expect(cells(result)).toEqual([["name"], ["A"]]);
  });

  it("returns an empty record list for empty input", () => {
    const result = parseCsv("");
    expect(result).toEqual({ ok: true, records: [] });
  });

  it("reports the physical line each record starts on", () => {
    const result = parseCsv('h\n"multi\nline"\nlast\n');
    if (!result.ok) throw new Error(result.message);
    expect(result.records.map((r) => r.line)).toEqual([1, 2, 4]);
  });

  it("rejects an unterminated quoted field", () => {
    const result = parseCsv('a\n"unclosed\n');
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("unterminated quoted field"),
    });
  });

  it("rejects text after a closing quote", () => {
    const result = parseCsv('a\n"x"y\n');
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("after closing quote"),
    });
  });

  it("rejects a quote opening mid-field", () => {
    const result = parseCsv('a\nb"c"\n');
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("quote may only start a field"),
    });
  });
});
