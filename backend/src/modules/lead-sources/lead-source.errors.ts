export interface LeadSourceErrorOptions {
  code?: string;
  cause?: unknown;
}

export class LeadSourceError extends Error {
  public readonly code: string;

  constructor(message: string, { code = 'LEAD_SOURCE_ERROR', cause }: LeadSourceErrorOptions = {}) {
    super(message);
    this.name = 'LeadSourceError';
    this.code = code;

    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** The sheet could not be read: bad link, revoked sharing, or Google returning an error page. */
export class LeadSheetFetchError extends LeadSourceError {
  constructor(message: string, options: LeadSourceErrorOptions = {}) {
    super(message, { code: 'LEAD_SHEET_FETCH_FAILED', ...options });
    this.name = 'LeadSheetFetchError';
  }
}
