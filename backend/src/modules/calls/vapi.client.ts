/**
 * HTTP client for Vapi (https://docs.vapi.ai) - the only file in wam-crm-ai that knows Vapi's
 * URL shape. Vapi is the voice AI agent; it dials out over the SIP trunk/DID that was imported
 * from VoiceLink on Vapi's own dashboard (BYO SIP Trunk Number), so this client only ever has to
 * ask Vapi to place a call - it never talks to VoiceLink directly.
 */
import { env } from '../../config/env.js';

export class VapiNotConfiguredError extends Error {
  constructor() {
    super('VAPI_NOT_CONFIGURED');
    this.name = 'VapiNotConfiguredError';
  }
}

export class VapiRequestError extends Error {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(message: string, statusCode: number, body: unknown) {
    super(message);
    this.name = 'VapiRequestError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

export interface PlaceOutboundCallParams {
  /** E.164, e.g. +919307512816. */
  toNumber: string;
  /** Per-call overrides merged into the assistant's first message - see Vapi's
   *  `assistantOverrides.variableValues`. Used to tell a fixed assistant "why you're calling"
   *  without needing a different assistant per reason. */
  variableValues?: Record<string, string | number>;
  assistantId?: string;
  phoneNumberId?: string;
}

export interface PlaceOutboundCallResult {
  callId: string;
  status: string | null;
  raw: unknown;
}

/**
 * POST /call - see https://docs.vapi.ai/calls/outbound-calling. Throws VapiNotConfiguredError
 * if the three required env vars are not all set, and VapiRequestError on any non-2xx response
 * (Vapi's own error body is preserved on it for the caller to log).
 */
export const placeOutboundCall = async ({
  toNumber,
  variableValues,
  assistantId = env.VAPI_ASSISTANT_ID,
  phoneNumberId = env.VAPI_PHONE_NUMBER_ID,
}: PlaceOutboundCallParams): Promise<PlaceOutboundCallResult> => {
  if (!env.VAPI_API_KEY || !assistantId || !phoneNumberId) {
    throw new VapiNotConfiguredError();
  }

  const response = await fetch(`${env.VAPI_API_BASE.replace(/\/+$/, '')}/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.VAPI_API_KEY}`,
    },
    body: JSON.stringify({
      assistantId,
      phoneNumberId,
      customer: { number: toNumber },
      ...(variableValues
        ? { assistantOverrides: { variableValues } }
        : {}),
    }),
  });

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new VapiRequestError(`Vapi returned ${response.status} for POST /call.`, response.status, parsed);
  }

  const body = parsed as { id?: string; status?: string } | null;

  return {
    callId: body?.id ?? '',
    status: body?.status ?? null,
    raw: parsed,
  };
};
