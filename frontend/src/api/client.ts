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
