/**
 * The first half of pipeline stage 13: the line printed the moment an outbound message is
 * queued. It exists because an AI reply deliberately waits out a human-like delay before it is
 * eligible to send - and during that wait nothing else prints anything at all, so without this
 * line "the agent did nothing" and "the agent sends at 15:42:10" look identical in a terminal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    WHATSAPP_HUMAN_DELAY_MIN_MS: 60_000,
    WHATSAPP_HUMAN_DELAY_MAX_MS: 60_000,
    WHATSAPP_TRACE_ENABLED: false,
  },
}));

vi.mock('../../config/database.js', () => ({
  runInTransaction: (command: (session: undefined) => unknown) => command(undefined),
}));

const { createOutboundMessageService } = await import('./outbound-message.service.js');
const { createPipelineTrace, deriveTraceId } = await import(
  '../../observability/pipeline-trace.js'
);

const conversation = {
  _id: 'conv-1',
  whatsappAccountId: 'account-1',
  contactId: 'contact-1',
  assignedTo: null,
} as never;

const createHarness = ({ traceEnabled = true }: { traceEnabled?: boolean } = {}) => {
  const lines: string[] = [];
  const createOutboundMessageRecord = vi.fn(async (params: Record<string, unknown>) => ({
    _id: 'msg-out-1',
    ...params,
  }));

  const service = createOutboundMessageService({
    createOutboundMessageRecord: createOutboundMessageRecord as never,
    findMessageByIdempotencyKey: vi.fn() as never,
    updateConversationPreview: vi.fn().mockResolvedValue(undefined) as never,
    updateAssignment: vi.fn().mockResolvedValue(undefined) as never,
    createActivity: vi.fn().mockResolvedValue(undefined) as never,
    publishEvent: vi.fn().mockResolvedValue(undefined) as never,
    createTrace: ({ seed }) =>
      createPipelineTrace({
        seed,
        config: { WHATSAPP_TRACE_ENABLED: traceEnabled },
        write: (line) => lines.push(line),
      }),
    now: () => new Date(2026, 0, 2, 15, 41, 10),
  });

  return { service, lines, createOutboundMessageRecord };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueOutboundMessage - the queued half of pipeline stage 13', () => {
  it('prints the time an AI-authored reply will actually go out', async () => {
    const { service, lines } = createHarness();

    await service.enqueueOutboundMessage({
      organizationId: 'org-1',
      conversation,
      actor: { _id: 'ai-system-user' } as never,
      body: 'What city are you in?',
      idempotencyKey: 'ai-brain-asked:msg-1',
      authoredBy: 'ai',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('13/13');
    expect(lines[0]).toContain('step=queued');
    expect(lines[0]).toContain('author=ai');
    // 60s delay window, both bounds equal, off a 15:41:10 clock.
    expect(lines[0]).toContain('sendAt=15:42:10');
  });

  it('says a staff-authored send goes immediately, since only AI sends are delayed', async () => {
    const { service, lines } = createHarness();

    await service.enqueueOutboundMessage({
      organizationId: 'org-1',
      conversation,
      actor: { _id: 'user-1' } as never,
      body: 'on my way',
      idempotencyKey: 'dashboard-send-1',
    });

    expect(lines[0]).toContain('sendAt=immediately');
    expect(lines[0]).toContain('author=human');
  });

  it('seeds its id from the idempotency key, which is what the delivery poller still has later', async () => {
    const { service, lines } = createHarness();

    await service.enqueueOutboundMessage({
      organizationId: 'org-1',
      conversation,
      actor: { _id: 'ai-system-user' } as never,
      body: 'hello',
      idempotencyKey: 'ai-brain-asked:msg-1',
      authoredBy: 'ai',
    });

    expect(lines[0]).toContain(`[wa ${deriveTraceId('ai-brain-asked:msg-1')}]`);
  });

  it('truncates the queued body rather than printing the whole reply', async () => {
    const { service, lines } = createHarness();

    await service.enqueueOutboundMessage({
      organizationId: 'org-1',
      conversation,
      actor: { _id: 'user-1' } as never,
      body: 'q'.repeat(300),
      idempotencyKey: 'k-long',
    });

    expect(lines[0]).toContain('…');
    expect(lines[0]).not.toContain('q'.repeat(120));
  });

  it('writes nothing at all while WHATSAPP_TRACE_ENABLED is off', async () => {
    const { service, lines } = createHarness({ traceEnabled: false });

    await service.enqueueOutboundMessage({
      organizationId: 'org-1',
      conversation,
      actor: { _id: 'user-1' } as never,
      body: 'hello',
      idempotencyKey: 'k-off',
    });

    expect(lines).toHaveLength(0);
  });
});
