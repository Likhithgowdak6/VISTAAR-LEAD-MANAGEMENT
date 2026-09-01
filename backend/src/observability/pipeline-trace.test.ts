/**
 * The trace format itself: correlation ids that survive a restart, an off switch that really
 * costs nothing, masking and truncation, and - the point of the whole module - a STOP that a
 * person scanning a wall of terminal output cannot miss, always carrying its reason.
 */
import { describe, expect, it, vi } from 'vitest';

// pipeline-trace reads WHATSAPP_TRACE_ENABLED off the env module, whose real implementation
// calls process.exit(1) under vitest where no variables are set. Every test here passes its own
// `config` explicitly, so this mock only has to keep the import alive.
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    WHATSAPP_TRACE_ENABLED: false,
  },
}));

import {
  createPipelineTrace,
  deriveTraceId,
  maskJid,
  NOOP_PIPELINE_TRACE,
  PIPELINE_STAGE,
  PIPELINE_STAGE_TOTAL,
  PIPELINE_STAGES,
  preview,
} from './pipeline-trace.js';

const ON = { WHATSAPP_TRACE_ENABLED: true } as const;
const OFF = { WHATSAPP_TRACE_ENABLED: false } as const;

/** A trace wired to a fixed clock, so the printed lines are byte-for-byte predictable. */
const tracing = (config: { WHATSAPP_TRACE_ENABLED: boolean } = ON) => {
  const lines: string[] = [];

  return {
    lines,
    trace: createPipelineTrace({
      seed: 'ABC123MESSAGEID',
      config,
      write: (line) => lines.push(line),
      now: () => new Date(2026, 0, 2, 15, 42, 10),
    }),
  };
};

describe('the stage list', () => {
  it('is the single ordered definition every stage number is counted against', () => {
    expect(PIPELINE_STAGE_TOTAL).toBe(PIPELINE_STAGES.length);
    expect(PIPELINE_STAGES).toHaveLength(13);
    expect(new Set(PIPELINE_STAGES.map((stage) => stage.key)).size).toBe(PIPELINE_STAGE_TOTAL);
  });

  it('exposes every stage key through the PIPELINE_STAGE constants, so no call site types one', () => {
    expect(new Set(Object.values(PIPELINE_STAGE))).toEqual(
      new Set(PIPELINE_STAGES.map((stage) => stage.key)),
    );
  });

  it('numbers a stage by its position in that list', () => {
    const { trace, lines } = tracing();

    trace.pass(PIPELINE_STAGE.PROVIDER_RECEIVED);
    trace.pass(PIPELINE_STAGE.ROUTER_ALLOWLIST);
    trace.pass(PIPELINE_STAGE.OUTBOUND_DELIVERY);

    expect(lines[0]).toContain(' 1/13');
    expect(lines[1]).toContain(' 6/13');
    expect(lines[2]).toContain('13/13');
  });
});

describe('deriveTraceId', () => {
  it('is eight hex characters, short enough to compare by eye', () => {
    expect(deriveTraceId('3EB0C431C26A1D5E9F00')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('gives the same WhatsApp message id the same id every time, including across restarts', () => {
    expect(deriveTraceId('3EB0C431C26A1D5E9F00')).toBe(deriveTraceId('3EB0C431C26A1D5E9F00'));
  });

  it('gives different messages different ids', () => {
    expect(deriveTraceId('message-a')).not.toBe(deriveTraceId('message-b'));
  });

  it('falls back to a random id when the event carries no id at all', () => {
    const first = deriveTraceId(undefined);
    const second = deriveTraceId('');

    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(second).toMatch(/^[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  it('is what the two halves of the pipeline use to reach the same id independently', () => {
    const fromProvider = createPipelineTrace({ seed: 'wa-msg-1', config: ON, write: () => {} });
    const fromRouter = createPipelineTrace({ seed: 'wa-msg-1', config: ON, write: () => {} });

    expect(fromProvider.id).toBe(fromRouter.id);
  });

  it('accepts an already-derived id, for a stage that cannot see the WhatsApp id any more', () => {
    const handedOver = createPipelineTrace({ id: 'deadbeef', seed: 'ignored', config: ON });

    expect(handedOver.id).toBe('deadbeef');
  });
});

describe('the off switch', () => {
  it('is off by default in the sense that a false flag yields the shared no-op', () => {
    expect(createPipelineTrace({ seed: 'x', config: OFF })).toBe(NOOP_PIPELINE_TRACE);
    expect(createPipelineTrace({ seed: 'x', config: OFF }).enabled).toBe(false);
  });

  it('writes nothing', () => {
    const write = vi.fn();
    const trace = createPipelineTrace({ seed: 'x', config: OFF, write });

    trace.pass(PIPELINE_STAGE.INGEST_MESSAGE);
    trace.stop(PIPELINE_STAGE.INGEST_MESSAGE, 'nope');
    trace.fail(PIPELINE_STAGE.INGEST_MESSAGE, new Error('boom'));

    expect(write).not.toHaveBeenCalled();
  });

  it('never runs the detail thunk, so no call site builds a string it throws away', () => {
    const describe_ = vi.fn(() => ({ body: 'expensive' }));
    const trace = createPipelineTrace({ seed: 'x', config: OFF, write: () => {} });

    trace.pass(PIPELINE_STAGE.AI_CONTEXT, describe_);
    trace.stop(PIPELINE_STAGE.AI_CONTEXT, 'nope', describe_);
    trace.fail(PIPELINE_STAGE.AI_CONTEXT, new Error('boom'), describe_);

    expect(describe_).not.toHaveBeenCalled();
  });

  it('derives no id while off', () => {
    expect(createPipelineTrace({ seed: 'x', config: OFF }).id).toBe('');
  });
});

describe('a stop', () => {
  it('is marked so it cannot be scrolled past, and always carries its reason', () => {
    const { trace, lines } = tracing();

    trace.stop(PIPELINE_STAGE.ROUTER_ALLOWLIST, 'sender is not on WHATSAPP_TEST_ALLOWED_NUMBERS');

    expect(lines[0]).toBe(
      '!!! 15:42:10 [wa caeb6842]  6/13 router · allowlist     STOPPED  ' +
        'sender is not on WHATSAPP_TEST_ALLOWED_NUMBERS',
    );
  });

  it('looks nothing like the pass line above it', () => {
    const { trace, lines } = tracing();

    trace.pass(PIPELINE_STAGE.ROUTER_OWNER_CHECK);
    trace.stop(PIPELINE_STAGE.ROUTER_ALLOWLIST, 'blocked');

    expect(lines[0].startsWith('   ')).toBe(true);
    expect(lines[0]).toContain('ok');
    expect(lines[0]).not.toContain('STOPPED');
    expect(lines[1].startsWith('!!!')).toBe(true);
    expect(lines[1]).toContain('STOPPED');
  });

  it('keeps its details on the same line, after the reason', () => {
    const { trace, lines } = tracing();

    trace.stop(PIPELINE_STAGE.AI_ELIGIBILITY, 'they opted out', () => ({ conversation: 'c1' }));

    expect(lines[0]).toContain('STOPPED  they opted out  conversation=c1');
  });
});

describe('a failure', () => {
  it('is marked too, and summarises the error without a stack', () => {
    const { trace, lines } = tracing();
    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    trace.fail(PIPELINE_STAGE.AI_DECISION, error, () => ({ ms: 42 }));

    expect(lines[0]).toBe(
      'ERR 15:42:10 [wa caeb6842] 12/13 ai · brain call        FAILED   ' +
        'Error (ECONNREFUSED): connect ECONNREFUSED  ms=42',
    );
  });

  it('copes with something thrown that is not an Error at all', () => {
    const { trace, lines } = tracing();

    trace.fail(PIPELINE_STAGE.AI_DECISION, 'just a string');

    expect(lines[0]).toContain('FAILED');
  });
});

describe('alignment', () => {
  it('starts the detail column in the same place for every stage', () => {
    const { trace, lines } = tracing();

    for (const stage of PIPELINE_STAGES) {
      trace.pass(stage.key, () => ({ marker: 'here' }));
    }

    const columns = lines.map((line) => line.indexOf('marker=here'));

    expect(new Set(columns).size).toBe(1);
    expect(lines).toHaveLength(PIPELINE_STAGE_TOTAL);
  });
});

describe('privacy', () => {
  it('masks a JID down to something recognisable but unusable', () => {
    expect(maskJid('919876543210@s.whatsapp.net')).toBe('919***210@s.whatsapp.net');
    expect(maskJid('')).toBe('(none)');
    expect(maskJid(undefined)).toBe('(none)');
  });

  it('masks a raw JID a call site forgot to mask', () => {
    const { trace, lines } = tracing();

    trace.pass(PIPELINE_STAGE.INGEST_CONTACT, () => ({ from: '919876543210@s.whatsapp.net' }));

    expect(lines[0]).not.toContain('919876543210');
    expect(lines[0]).toContain('919***210@s.whatsapp.net');
  });

  it('masks a bare phone number with no JID to give it away', () => {
    const { trace, lines } = tracing();

    trace.pass(PIPELINE_STAGE.INGEST_CONTACT, () => ({ number: '919876543210' }));

    expect(lines[0]).not.toContain('919876543210');
  });

  it('refuses to print a key that names a secret or contact PII, whatever the value', () => {
    const { trace, lines } = tracing();

    trace.pass(PIPELINE_STAGE.AI_CONTEXT, () => ({
      phone: '919876543210',
      email: 'lead@example.com',
      apiKey: 'sk-ant-real-key',
      token: 'bearer-token',
      category: 'wedding',
    }));

    expect(lines[0]).toContain('phone=[redacted]');
    expect(lines[0]).toContain('email=[redacted]');
    expect(lines[0]).toContain('apiKey=[redacted]');
    expect(lines[0]).toContain('token=[redacted]');
    expect(lines[0]).not.toContain('sk-ant-real-key');
    expect(lines[0]).toContain('category=wedding');
  });
});

describe('preview', () => {
  it('keeps a short message whole', () => {
    expect(preview('need a photographer for 14 Feb')).toBe('need a photographer for 14 Feb');
  });

  it('cuts a long message at 80 characters and marks the cut', () => {
    const long = 'x'.repeat(500);
    const cut = preview(long);

    expect(cut).toHaveLength(81);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('flattens a multi-line message, because one stage is one line', () => {
    expect(preview('Name: Asha\nDate: 14 Feb\n\nCity: Bangalore')).toBe(
      'Name: Asha Date: 14 Feb City: Bangalore',
    );
  });

  it('says so rather than printing nothing when there is no text', () => {
    expect(preview('')).toBe('(empty)');
    expect(preview(undefined)).toBe('(empty)');
  });

  it('truncates a message body inside a trace line', () => {
    const { trace, lines } = tracing();

    trace.pass(PIPELINE_STAGE.INGEST_MESSAGE, () => ({ body: preview('y'.repeat(200)) }));

    expect(lines[0]).toContain('…');
    expect(lines[0]).not.toContain('y'.repeat(100));
  });
});

describe('safety', () => {
  it('never throws when the caller\'s own detail thunk throws', () => {
    const { trace, lines } = tracing();

    expect(() =>
      trace.pass(PIPELINE_STAGE.INGEST_MESSAGE, () => {
        throw new Error('bad detail');
      }),
    ).not.toThrow();
    expect(lines).toHaveLength(0);
  });

  it('never throws when the sink itself throws', () => {
    const trace = createPipelineTrace({
      seed: 'x',
      config: ON,
      write: () => {
        throw new Error('stdout is gone');
      },
    });

    expect(() => trace.stop(PIPELINE_STAGE.ROUTER_ALLOWLIST, 'blocked')).not.toThrow();
  });

  it('never throws on a stage key that is not in the list', () => {
    const { trace, lines } = tracing();

    expect(() => trace.pass('nonsense.stage' as never)).not.toThrow();
    expect(lines[0]).toContain(' 0/13');
  });

  it('drops a detail whose value is null or undefined rather than printing "undefined"', () => {
    const { trace, lines } = tracing();

    trace.pass(PIPELINE_STAGE.AI_DECISION, () => ({ ms: undefined, decision: 'ask', why: null }));

    expect(lines[0]).toContain('decision=ask');
    expect(lines[0]).not.toContain('undefined');
    expect(lines[0]).not.toContain('null');
  });

  it('prints a Date as a wall clock, so "waiting until" reads as a time', () => {
    const { trace, lines } = tracing();

    trace.pass(PIPELINE_STAGE.OUTBOUND_DELIVERY, () => ({
      sendAt: new Date(2026, 0, 2, 15, 43, 25),
    }));

    expect(lines[0]).toContain('sendAt=15:43:25');
  });
});
