import { type AuthSessionData } from './models';

/** Standard success envelope returned by most CRM endpoints. */
export interface ApiSuccessResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Error body shapes the API client understands when parsing non-2xx responses. */
export interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export interface ApiErrorFields {
  status: number;
  code: string;
  message?: string;
  details?: unknown;
}

export type AuthResponse = ApiSuccessResponse<AuthSessionData>;

export type QueryPrimitive = string | number | boolean;
export type QueryParams = Record<string, QueryPrimitive | null | undefined>;
