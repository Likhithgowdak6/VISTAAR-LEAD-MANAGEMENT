import { LeadSheetFetchError } from './lead-source.errors.js';

export interface GoogleSheetRef {
  sheetId: string;
  gid: string;
  /** True for a "publish to web" link (`/d/e/2PACX-…`), which uses a different export path. */
  published: boolean;
}

const EDIT_URL_PATTERN = /\/spreadsheets\/d\/(?!e\/)([a-zA-Z0-9-_]+)/;
const PUBLISHED_URL_PATTERN = /\/spreadsheets\/d\/e\/([a-zA-Z0-9-_]+)/;
const GID_PATTERN = /[#?&]gid=(\d+)/;

/**
 * Extracts the spreadsheet id and tab from any of the shapes Google hands out — the edit URL,
 * a `?usp=sharing` copy, or a publish-to-web link. Returns null when the URL is not a Google
 * Sheets link at all, which the caller surfaces as a validation error.
 */
export const parseGoogleSheetUrl = (url: unknown): GoogleSheetRef | null => {
  if (typeof url !== 'string' || url.trim() === '') {
    return null;
  }

  const normalizedUrl = url.trim();
  const gid = GID_PATTERN.exec(normalizedUrl)?.[1] ?? '0';

  const publishedId = PUBLISHED_URL_PATTERN.exec(normalizedUrl)?.[1];

  if (publishedId) {
    return { sheetId: publishedId, gid, published: true };
  }

  const sheetId = EDIT_URL_PATTERN.exec(normalizedUrl)?.[1];

  if (!sheetId) {
    return null;
  }

  return { sheetId, gid, published: false };
};

export const buildCsvExportUrl = ({ sheetId, gid, published }: GoogleSheetRef): string =>
  published
    ? `https://docs.google.com/spreadsheets/d/e/${sheetId}/pub?gid=${gid}&single=true&output=csv`
    : `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

const looksLikeHtml = (body: string): boolean => /^\s*<(!doctype|html)/i.test(body);

export interface FetchSheetCsvOptions {
  sheetRef: GoogleSheetRef;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Reads a link-shared sheet as CSV.
 *
 * A sheet that is not shared does not fail loudly — Google answers with a 200 and an HTML
 * sign-in page, which would otherwise parse as one garbage "lead". Both that and a non-2xx
 * response are converted into a typed error the runner records against the source.
 */
export const fetchSheetCsv = async ({
  sheetRef,
  fetchFn = fetch,
  timeoutMs = 20_000,
}: FetchSheetCsvOptions): Promise<string> => {
  const url = buildCsvExportUrl(sheetRef);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;

  try {
    response = await fetchFn(url, {
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (error: unknown) {
    throw new LeadSheetFetchError('Could not reach the Google Sheet.', { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new LeadSheetFetchError(`Google returned ${response.status} for the sheet.`, {
      code: response.status === 404 ? 'LEAD_SHEET_NOT_FOUND' : 'LEAD_SHEET_FETCH_FAILED',
    });
  }

  const body = await response.text();

  if (looksLikeHtml(body)) {
    throw new LeadSheetFetchError(
      'The sheet is not link-shared. Set it to "anyone with the link can view".',
      { code: 'LEAD_SHEET_NOT_SHARED' },
    );
  }

  return body;
};
