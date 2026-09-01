/**
 * The inbound/outbound WhatsApp pipeline, printed one aligned line per stage so a message that
 * stops somewhere says so in the terminal instead of vanishing.
 *
 * Two rounds of live testing were lost to exactly that: a guard clause dropped an inbound
 * message, nothing was written anywhere, and from outside the process that is indistinguishable
 * from "WhatsApp never delivered anything". So the contract of this module is narrow and
 * absolute:
 *
 *   - Every stage a message reaches prints a line, numbered against a known total. A reader who
 *     sees `4/13` and nothing after it knows the message reached stage 4 and stopped there.
 *   - A STOP is a terminal outcome and is marked so it cannot be scrolled past: an `!!!` gutter,
 *     the word STOPPED, and always a reason in the owner's words.
 *   - Nothing in here can change behaviour. Every emit is wrapped; a formatting bug must cost a
 *     log line and nothing else.
 *
 * This module owns the FORMAT and nothing else - no business logic, no decisions, no knowledge
 * of what any stage means beyond its label.
 *
 * Why `console.log` rather than the pino logger: this is read by a person watching a terminal
 * while they message the agent from their phone. pino emits one JSON object per line, which
 * destroys the column alignment that makes a stalled message obvious at a glance. Everything
 * printed here is masked or truncated at the point of writing (see `maskJid` / `preview`), plus
 * a formatter-level backstop below, so nothing depends on pino's redaction to stay safe.
 *
 * Off unless WHATSAPP_TRACE_ENABLED=true. When off, `createPipelineTrace` hands back a shared
 * no-op: no id is derived, no detail object is built (details are passed as a thunk, which is
 * never invoked), and nothing is formatted.
 */
import { createHash, randomBytes } from 'node:crypto';

import { env, type Env } from '../config/env.js';

/**
 * The pipeline, in order. ONE definition - stage numbers are positions in this array, so a stage
 * cannot drift out of sync with the total printed beside it, and nothing else in the codebase
 * spells these strings out.
 *
 * Inserting a stage renumbers the ones after it, which is correct: the numbers describe today's
 * pipeline, not a stable external contract.
 */
export const PIPELINE_STAGES = Object.freeze([
  { key: 'provider.received', label: 'provider · received' },
  { key: 'provider.gateway', label: 'provider · gateway' },
  { key: 'provider.normalized', label: 'provider · normalized' },
  { key: 'router.from-me', label: 'router · fromMe branch' },
  { key: 'router.owner-check', label: 'router · owner number' },
  { key: 'router.allowlist', label: 'router · allowlist' },
  { key: 'ingest.contact', label: 'ingest · contact' },
  { key: 'ingest.conversation', label: 'ingest · conversation' },
  { key: 'ingest.message', label: 'ingest · message saved' },
  { key: 'ai.eligibility', label: 'ai · eligibility' },
  { key: 'ai.context', label: 'ai · context' },
  { key: 'ai.decision', label: 'ai · brain call' },
  { key: 'outbound.delivery', label: 'outbound · delivery' },
] as const);

export type PipelineStageKey = (typeof PIPELINE_STAGES)[number]['key'];

/** Named constants for call sites, so no file hard-codes a stage string. */
export const PIPELINE_STAGE = Object.freeze({
  PROVIDER_RECEIVED: 'provider.received',
  PROVIDER_GATEWAY: 'provider.gateway',
  PROVIDER_NORMALIZED: 'provider.normalized',
  ROUTER_FROM_ME: 'router.from-me',
  ROUTER_OWNER_CHECK: 'router.owner-check',
  ROUTER_ALLOWLIST: 'router.allowlist',
  INGEST_CONTACT: 'ingest.contact',
  INGEST_CONVERSATION: 'ingest.conversation',
  INGEST_MESSAGE: 'ingest.message',
  AI_ELIGIBILITY: 'ai.eligibility',
  AI_CONTEXT: 'ai.context',
  AI_DECISION: 'ai.decision',
  OUTBOUND_DELIVERY: 'outbound.delivery',
} as const satisfies Record<string, PipelineStageKey>);

export const PIPELINE_STAGE_TOTAL = PIPELINE_STAGES.length;

const STAGE_POSITIONS = new Map<string, { number: number; label: string }>(
  PIPELINE_STAGES.map((stage, index) => [stage.key, { number: index + 1, label: stage.label }]),
);

/** Widest label in PIPELINE_STAGES, so every line's detail column starts in the same place. */
const LABEL_WIDTH = PIPELINE_STAGES.reduce((widest, stage) => Math.max(widest, stage.label.length), 0);

const OUTCOME_WIDTH = 'STOPPED'.length;

const TRACE_ID_LENGTH = 8;

const DEFAULT_PREVIEW_LENGTH = 80;

/**
 * Detail keys never printed, whatever a call site passes. logger.ts redacts the same names for
 * pino; this is the equivalent backstop for the trace sink, which does not go through pino.
 */
const SENSITIVE_DETAIL_KEYS = new Set([
  'phone',
  'phonenumber',
  'email',
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'password',
  'passwordhash',
  'authorization',
  'cookie',
  'secret',
  'servicekey',
]);

/** `<something>@<domain>` with enough in front of the @ to be an identifier worth masking. */
const RAW_JID_PATTERN = /^[^@\s]{7,}@[\w.-]+$/;

/** A bare phone number sitting in a detail value with no `@` to give it away. */
const BARE_PHONE_PATTERN = /^\+?\d{8,15}$/;

/**
 * Enough of a JID to recognise in a terminal, never enough to be a phone number. Mirrors the
 * masking inbound-router.service.ts and baileys.provider.ts already do at their own call sites.
 */
export const maskJid = (jid: unknown): string => {
  const value = typeof jid === 'string' ? jid.trim() : '';

  if (value === '') {
    return '(none)';
  }

  const [local = '', domain] = value.split('@');
  const masked = `${local.slice(0, 3)}***${local.slice(-3)}`;

  // A send address is often a bare phone number rather than a JID. Masking it the same way but
  // without inventing an "@unknown" domain keeps the line honest about what it was given.
  return domain === undefined ? masked : `${masked}@${domain}`;
};

/**
 * A readable slice of a message body. The owner's own test messages are genuinely useful to see
 * in the trace - the whole body is not, so it is cut at ~80 characters and flattened onto one
 * line, because one stage is one line.
 */
export const preview = (text: unknown, maxLength: number = DEFAULT_PREVIEW_LENGTH): string => {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';

  if (value === '') {
    return '(empty)';
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
};

/**
 * The correlation id for one message: eight hex characters, short enough to read off a terminal
 * and compare by eye.
 *
 * Derived from the WhatsApp message id when there is one, so the same message keeps the same id
 * across a restart and across the halves of the pipeline that never meet in memory (the delivery
 * poller claims a message rows minutes after the AI queued it). No seed - a synthetic or
 * malformed event - falls back to random, which is still a usable handle for that one run.
 */
export const deriveTraceId = (seed?: unknown): string => {
  const value = typeof seed === 'string' ? seed.trim() : seed === undefined || seed === null ? '' : String(seed);

  if (value === '') {
    return randomBytes(TRACE_ID_LENGTH / 2).toString('hex');
  }

  return createHash('sha256').update(value).digest('hex').slice(0, TRACE_ID_LENGTH);
};

export type TraceDetail = Record<string, unknown>;

/** Details are a thunk so that a disabled trace never builds an object it throws away. */
export type TraceDetailThunk = () => TraceDetail;

export interface PipelineTrace {
  /** False on the shared no-op. Guard genuinely expensive preparation on this, nothing else. */
  readonly enabled: boolean;
  /** The correlation id printed on every line. Empty string while tracing is off. */
  readonly id: string;
  /** The message got through this stage and is still moving. */
  pass: (stage: PipelineStageKey, describe?: TraceDetailThunk) => void;
  /** Terminal: the message stops here, and `reason` says why in the owner's words. */
  /**
   * The message ended here and that is the correct outcome - an echo, a self-chat handed to the
   * approval handler, the owner taking a chat over. Prints without the `!!!` gutter; use
   * {@link stop} for an ending somebody might not have wanted.
   */
  done: (stage: PipelineStageKey, reason: string, describe?: TraceDetailThunk) => void;
  stop: (stage: PipelineStageKey, reason: string, describe?: TraceDetailThunk) => void;
  /** The stage threw. Not necessarily terminal - the caller decides what happens next. */
  fail: (stage: PipelineStageKey, error: unknown, describe?: TraceDetailThunk) => void;
}

const formatClock = (at: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

const formatDetailValue = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '(invalid date)' : formatClock(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  const text = typeof value === 'string' ? value : String(value);

  // Backstop, not the primary defence: call sites mask their own JIDs. This catches the one
  // that forgets, which is exactly the mistake this whole module exists to make impossible.
  if (RAW_JID_PATTERN.test(text) && !text.includes('***')) {
    return maskJid(text);
  }

  if (BARE_PHONE_PATTERN.test(text)) {
    return maskJid(text);
  }

  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
};

const formatDetail = (detail: TraceDetail | undefined): string => {
  if (!detail) {
    return '';
  }

  const parts: string[] = [];

  for (const [key, value] of Object.entries(detail)) {
    if (SENSITIVE_DETAIL_KEYS.has(key.toLowerCase())) {
      parts.push(`${key}=[redacted]`);
      continue;
    }

    const formatted = formatDetailValue(value);

    if (formatted !== null) {
      parts.push(`${key}=${formatted}`);
    }
  }

  return parts.join(' ');
};

const summarizeError = (error: unknown): string => {
  const err = error as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const name = typeof err?.name === 'string' && err.name !== '' ? err.name : 'Error';
  const code = err?.code === undefined || err?.code === null ? '' : ` (${String(err.code)})`;
  const message = typeof err?.message === 'string' && err.message !== '' ? `: ${err.message}` : '';

  return preview(`${name}${code}${message}`, 120);
};

/**
 * The left gutter is what makes a stop findable in a wall of output, so `!!!` has to stay rare
 * enough to mean something. That is why `done` exists as well as `stop`.
 *
 * Both END the message's journey, and the difference is only whether a person should care:
 *
 *   done  - the pipeline did the right thing and the message is finished. The echo of our own
 *           outbound send lands here, and there is one of those for EVERY message the agent
 *           sends. Marking those `!!!` would put an alarm next to the most routine event in the
 *           system, and a reader who learns to skip `!!!` has lost the one thing this trace is
 *           for.
 *   stop  - the message went no further and somebody may well not have wanted that: refused by
 *           the allowlist, read as an owner decision, opted out, paused, quiet hours.
 */
const GUTTERS = {
  pass: '   ',
  done: '   ',
  stop: '!!!',
  fail: 'ERR',
} as const;

const OUTCOMES = {
  pass: 'ok',
  done: 'HANDLED',
  stop: 'STOPPED',
  fail: 'FAILED',
} as const;

type Outcome = keyof typeof OUTCOMES;

export interface CreatePipelineTraceOptions {
  /** Usually the WhatsApp message id. Anything stable about this message works. */
  seed?: unknown;
  /** An already-derived id, when one half of the pipeline hands it to the other. */
  id?: string;
  config?: Pick<Env, 'WHATSAPP_TRACE_ENABLED'>;
  write?: (line: string) => void;
  now?: () => Date;
}

const defaultWrite = (line: string): void => {
  console.log(line);
};

/**
 * The shared disabled trace. One frozen object for the whole process: creating a trace while
 * WHATSAPP_TRACE_ENABLED is false allocates nothing and hashes nothing.
 */
export const NOOP_PIPELINE_TRACE: PipelineTrace = Object.freeze({
  enabled: false,
  id: '',
  pass: () => {},
  done: () => {},
  stop: () => {},
  fail: () => {},
});

export const createPipelineTrace = ({
  seed,
  id,
  config = env,
  write = defaultWrite,
  now = () => new Date(),
}: CreatePipelineTraceOptions = {}): PipelineTrace => {
  if (config?.WHATSAPP_TRACE_ENABLED !== true) {
    return NOOP_PIPELINE_TRACE;
  }

  const traceId = typeof id === 'string' && id !== '' ? id : deriveTraceId(seed);

  const emit = (
    outcome: Outcome,
    stage: PipelineStageKey,
    describe: TraceDetailThunk | undefined,
    leading: string,
  ): void => {
    // A logging failure must never break message handling. Everything below - the caller's own
    // detail thunk included - runs inside this guard, and a thrown formatter is swallowed.
    try {
      const position = STAGE_POSITIONS.get(stage) ?? { number: 0, label: stage };
      const detail = formatDetail(describe?.());
      const tail = [leading, detail].filter((part) => part !== '').join('  ');

      write(
        `${GUTTERS[outcome]} ${formatClock(now())} [wa ${traceId}] ` +
          `${String(position.number).padStart(2, ' ')}/${PIPELINE_STAGE_TOTAL} ` +
          `${position.label.padEnd(LABEL_WIDTH)} ${OUTCOMES[outcome].padEnd(OUTCOME_WIDTH)}` +
          `${tail === '' ? '' : `  ${tail}`}`,
      );
    } catch {
      // Deliberately silent: a trace that reports its own failure through the same broken sink
      // achieves nothing, and re-throwing would drop the message this exists to protect.
    }
  };

  return {
    enabled: true,
    id: traceId,
    pass: (stage, describe) => emit('pass', stage, describe, ''),
    done: (stage, reason, describe) => emit('done', stage, describe, reason),
    stop: (stage, reason, describe) => emit('stop', stage, describe, reason),
    fail: (stage, error, describe) => emit('fail', stage, describe, summarizeError(error)),
  };
};
