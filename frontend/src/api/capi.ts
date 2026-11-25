/**
 * Meta Conversions API settings.
 *
 * Kept out of the 1,800-line `endpoints.ts` for the same reason `billing.ts` is: a feature with
 * its own screen and its own permission reads better beside itself.
 *
 * THERE IS NO `getAccessToken`. The server does not expose one, so there is nothing here that
 * could return it and nothing a component could accidentally render.
 */
import { apiFetch } from './client';
import { type ApiSuccessResponse } from '../types';

interface TokenParams {
  token: string | null;
}

/** A CRM milestone this installation can report, and the name Meta receives for it. */
export interface CapiAvailableEvent {
  key: string;
  metaEventName: string;
}

export interface CapiConnection {
  connected: boolean;
  /** Credentials stored AND delivery switched on. Storing a token does not enable it. */
  enabled: boolean;
  datasetId: string | null;
  accessTokenLast4: string | null;
  /** Present means events go to Meta's Test Events tab, not the advertiser's live reporting. */
  testEventCode: string | null;
  selectedEvents: string[];
  connectedAt: string | null;
  lastDeliveredAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  availableEvents?: CapiAvailableEvent[];
}

export interface CapiFailure {
  eventKey: string | null;
  state: string | null;
  attempts: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface CapiStatus {
  counts: Record<string, number>;
  maxAttempts: number;
  recentFailures: CapiFailure[];
}

export const getCapiConnection = ({
  token,
}: TokenParams): Promise<ApiSuccessResponse<CapiConnection>> =>
  apiFetch('/settings/capi', { token });

/** Stores the credential. Deliberately does not start delivery — see `setCapiEnabled`. */
export const connectCapi = ({
  token,
  ...body
}: TokenParams & {
  datasetId: string;
  accessToken: string;
  testEventCode?: string | null;
  selectedEvents: string[];
}): Promise<ApiSuccessResponse<CapiConnection>> =>
  apiFetch('/settings/capi', { method: 'PUT', token, body });

export const setCapiEnabled = ({
  token,
  enabled,
}: TokenParams & { enabled: boolean }): Promise<ApiSuccessResponse<CapiConnection>> =>
  apiFetch('/settings/capi/enabled', { method: 'POST', token, body: { enabled } });

export const setCapiEvents = ({
  token,
  ...body
}: TokenParams & {
  selectedEvents: string[];
  testEventCode?: string | null;
}): Promise<ApiSuccessResponse<CapiConnection>> =>
  apiFetch('/settings/capi/events', { method: 'POST', token, body });

export const getCapiStatus = ({
  token,
}: TokenParams): Promise<ApiSuccessResponse<CapiStatus>> =>
  apiFetch('/settings/capi/status', { token });
