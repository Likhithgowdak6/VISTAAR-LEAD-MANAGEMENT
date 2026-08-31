export interface HttpErrorOptions {
  statusCode?: number;
  message?: string;
  code?: string;
  details?: unknown;
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor({
    statusCode = 500,
    message = 'Internal server error',
    code = 'INTERNAL_SERVER_ERROR',
    details = null,
  }: HttpErrorOptions = {}) {
    super(message);

    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const createHttpError = ({
  statusCode,
  message,
  code,
  details,
}: HttpErrorOptions): HttpError =>
  new HttpError({
    statusCode,
    message,
    code,
    details,
  });
