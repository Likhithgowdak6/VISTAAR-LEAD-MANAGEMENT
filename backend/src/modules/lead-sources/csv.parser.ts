export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
}

export interface ParseDelimitedTextOptions {
  /** Auto-detected from the header line when omitted. */
  delimiter?: string;
}

const BYTE_ORDER_MARK = '﻿';

/**
 * Picks the delimiter from the first line. Google's CSV export is comma-separated, but a sheet
 * pasted or re-exported as TSV is common enough to be worth handling, and a Meta lead sheet is
 * full of commas inside answers (`3,50,000/-`) that would otherwise shred a TSV.
 */
const detectDelimiter = (text: string): string => {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ',';
};

/**
 * RFC 4180 reader: handles quoted fields, `""` escapes, and delimiters or newlines inside
 * quotes. Written by hand rather than pulled in as a dependency because the grammar is small
 * and the input is untrusted third-party data.
 */
const splitRecords = (text: string, delimiter: string): string[][] => {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const endField = () => {
    fields.push(field);
    field = '';
  };

  const endRecord = () => {
    endField();
    records.push(fields);
    fields = [];
  };

  while (index < text.length) {
    const char = text[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }

        inQuotes = false;
        index += 1;
        continue;
      }

      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }

    if (char === '\r') {
      index += 1;
      continue;
    }

    if (char === '\n') {
      endRecord();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field !== '' || fields.length > 0) {
    endRecord();
  }

  return records;
};

const isBlankRecord = (record: readonly string[]): boolean =>
  record.every((value) => value.trim() === '');

export const parseDelimitedText = (
  text: unknown,
  { delimiter }: ParseDelimitedTextOptions = {},
): ParsedTable => {
  const normalizedText = typeof text === 'string' ? text.replace(BYTE_ORDER_MARK, '') : '';

  if (normalizedText.trim() === '') {
    return { headers: [], rows: [] };
  }

  const records = splitRecords(normalizedText, delimiter ?? detectDelimiter(normalizedText));
  const headerRecord = records.shift() ?? [];

  // A Meta export ends its header line with a trailing delimiter, producing one empty column.
  // Dropping empty headers keeps that phantom column out of the custom-field list.
  const headers = headerRecord.map((header) => header.trim());

  const rows = records.filter((record) => !isBlankRecord(record)).map((record) => {
    const row: Record<string, string> = {};

    headers.forEach((header, columnIndex) => {
      if (header === '') {
        return;
      }

      row[header] = (record[columnIndex] ?? '').trim();
    });

    return row;
  });

  return {
    headers: headers.filter((header) => header !== ''),
    rows,
  };
};
