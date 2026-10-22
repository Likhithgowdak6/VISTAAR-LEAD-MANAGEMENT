import { type ApiErrorFields } from '../types';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5001/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor({ status, code, message, details }: ApiErrorFields) {
    super(message || 'Request failed.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

const parseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readErrorParts = (payload: unknown): { code: string; message: string; details: unknown } => {
  const root = isRecord(payload) ? payload : null;
  const nested = root && isRecord(root.error) ? root.error : null;

  return {
    code: String(nested?.code ?? root?.code ?? 'REQUEST_FAILED'),
    message: String(nested?.message ?? root?.message ?? 'Request failed.'),
    details: nested?.details ?? root?.details ?? null,
  };
};

export interface ApiFetchOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal | null;
}

/**
 * Low-level fetch wrapper. Sends JSON, attaches a Bearer token when provided, always
 * includes credentials so the httpOnly refresh cookie travels with auth requests, and
 * throws a typed ApiError on any non-2xx response.
 */
export const apiFetch = async <T = unknown>(
  path: string,
  { method = 'GET', body, token, signal }: ApiFetchOptions = {},
): Promise<T> => {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    credentials: 'include',
    signal: signal ?? undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await parseJson(response);

  if (!response.ok) {
    const { code, message, details } = readErrorParts(payload);
    throw new ApiError({
      status: response.status,
      code,
      message,
      details,
    });
  }

  return payload as T;
};

export interface ApiUploadOptions {
  token?: string | null;
  /** Extra text fields sent alongside the file, e.g. `kind: 'voice'`. */
  fields?: Record<string, string>;
  signal?: AbortSignal | null;
}

/**
 * Posts one file as multipart/form-data.
 *
 * Deliberately NOT apiFetch: that one JSON-encodes its body and sets Content-Type, and both are
 * wrong here. The Content-Type header is left unset on purpose - the browser has to add it
 * itself so it can append the multipart boundary, and setting it by hand produces a body the
 * server cannot parse.
 */
export const apiUpload = async <T = unknown>(
  path: string,
  file: Blob,
  fileName: string,
  { token, fields = {}, signal }: ApiUploadOptions = {},
): Promise<T> => {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }

  form.append('file', file, fileName);

  const headers: Record<string, string> = { Accept: 'application/json' };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    signal: signal ?? undefined,
    body: form,
  });

  const payload = await parseJson(response);

  if (!response.ok) {
    const { code, message, details } = readErrorParts(payload);
    throw new ApiError({ status: response.status, code, message, details });
  }

  return payload as T;
};

/**
 * Fetches a protected binary as a Blob.
 *
 * WHY NOT JUST PUT THE URL IN AN `<img src>`. This API authenticates with a Bearer token held in
 * memory, not a cookie the browser would attach on its own, so a plain `src` would arrive
 * unauthenticated and 401. The alternative - a signed URL carrying a token in the query string -
 * would put a credential in something that lands in browser history and server logs. So the
 * bytes are fetched with the header like every other call and handed to the DOM as a blob URL.
 */
export const apiFetchBlob = async (
  path: string,
  { token, signal }: { token?: string | null; signal?: AbortSignal | null } = {},
): Promise<Blob> => {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers,
    credentials: 'include',
    signal: signal ?? undefined,
  });

  if (!response.ok) {
    const payload = await parseJson(response);
    const { code, message, details } = readErrorParts(payload);
    throw new ApiError({ status: response.status, code, message, details });
  }

  return response.blob();
};
