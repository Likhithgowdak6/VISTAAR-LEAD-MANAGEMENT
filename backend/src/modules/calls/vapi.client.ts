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
  /**
   * Hard ceiling on the call, sent with every request rather than trusted to the assistant's
   * dashboard config. This alert is one sentence long, so a call that is still up a minute later
   * is a call nobody is listening to - and every second of it is billed by both Vapi and the
   * telephony carrier. Enforced here because the alternative failed in practice: the assistant
   * would SAY "goodbye, the call has ended" without invoking its end-call tool, and the line
   * stayed open until a silence timeout eventually killed it.
   */
  maxDurationSeconds?: number;
}

/** Long enough for the alert plus a short "ok, got it", short enough that a forgotten handset
 *  cannot run up a bill. */
export const DEFAULT_MAX_CALL_DURATION_SECONDS = 60;

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
  maxDurationSeconds = DEFAULT_MAX_CALL_DURATION_SECONDS,
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
      // One overrides object, always sent: the duration ceiling must not depend on whether this
      // particular call happened to carry variables.
      assistantOverrides: {
        maxDurationSeconds,
        ...(variableValues ? { variableValues } : {}),
      },
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

export interface CallOutcome {
  /** Vapi's lifecycle status: `queued` / `ringing` / `in-progress` / `ended`. */
  status: string | null;
  /** Why it ended, once it has. This is the field that distinguishes a call the owner actually
   *  answered from one the carrier refused - e.g. `customer-did-not-answer`, or the
   *  `call.in-progress.error-sip-outbound-call-failed-to-connect` a dead trunk produces. */
  endedReason: string | null;
  /** Seconds of connected audio, when Vapi reports it. 0 for a call that never connected. */
  durationSeconds: number | null;
  /** True once this call will never change again, so it is safe to record and stop asking. */
  settled: boolean;
}

/**
 * GET /call/{id} - reads back what became of a call. Needed because POST /call answering 2xx
 * only means Vapi accepted the request: every real failure we hit in practice (no wallet
 * balance, unregistered SIP trunk, refused number) happened downstream of that and was visible
 * nowhere in this system until someone opened Vapi's own dashboard.
 */
export const getCall = async (callId: string): Promise<CallOutcome> => {
  if (!env.VAPI_API_KEY) {
    throw new VapiNotConfiguredError();
  }

  const response = await fetch(
    `${env.VAPI_API_BASE.replace(/\/+$/, '')}/call/${encodeURIComponent(callId)}`,
    { headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` } },
  );

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new VapiRequestError(
      `Vapi returned ${response.status} for GET /call/${callId}.`,
      response.status,
      parsed,
    );
  }

  const body = parsed as
    | { status?: string; endedReason?: string; startedAt?: string; endedAt?: string }
    | null;

  const status = body?.status ?? null;
  const startedAt = body?.startedAt ? Date.parse(body.startedAt) : NaN;
  const endedAt = body?.endedAt ? Date.parse(body.endedAt) : NaN;

  return {
    status,
    endedReason: body?.endedReason ?? null,
    durationSeconds:
      Number.isFinite(startedAt) && Number.isFinite(endedAt)
        ? Math.max(0, Math.round((endedAt - startedAt) / 1000))
        : null,
    // `ended` is Vapi's terminal status; an endedReason without it still means it is over.
    settled: status === 'ended' || Boolean(body?.endedReason),
  };
};
