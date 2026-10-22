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

/**
 * Queuing an attachment.
 *
 * The row that gets written here is the only record of what should be sent, so the things worth
 * asserting are the ones a later stage cannot recover: which type it is, where the bytes are,
 * whether it is a voice note, and what the inbox preview says when there is no caption to show.
 */
describe('enqueueOutboundMessage - attachments', () => {
  const media = {
    objectKey: 'org/conv/photo.jpg',
    type: 'image' as const,
    mimeType: 'image/jpeg',
    fileName: 'venue.jpg',
    sizeBytes: 81_234,
    isVoiceNote: false,
  };

  it('records the type, the key and the metadata on the message row', async () => {
    const { service, createOutboundMessageRecord } = createHarness();

    await service.enqueueOutboundMessage({
      organizationId: 'org-1',
      conversation,
      actor: { _id: 'user-1' } as never,
      body: 'The hall at golden hour',
      idempotencyKey: 'idem-media-1',
      media,
    });

    expect(createOutboundMessageRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'image',
        mediaObjectKey: 'org/conv/photo.jpg',
        body: 'The hall at golden hour',
        media: expect.objectContaining({
          mimeType: 'image/jpeg',
          fileName: 'venue.jpg',
          sizeBytes: 81_234,
          // The upload route wrote the bytes before this row existed, so there is never a
          // window where a queued message points at nothing.
          storageStatus: 'stored',
          isVoiceNote: false,
        }),
      }),
    );
  });

  it('stores a null body for an attachment sent with no caption', async () => {
    // Not an empty string: `body` is the caption, and "" would send a blank line with the file.
    const { service, createOutboundMessageRecord } = createHarness();

    await service.enqueueOutboundMessage({
      organizationId: 'org-1',
      conversation,
      actor: { _id: 'user-1' } as never,
      idempotencyKey: 'idem-media-2',
      media,
    });

    expect(createOutboundMessageRecord).toHaveBeenCalledWith(
      expect.objectContaining({ body: null }),
    );
  });

  it('keeps the voice-note flag, which decides the push-to-talk bubble', async () => {
    const { service, createOutboundMessageRecord } = createHarness();

    await service.enqueueOutboundMessage({
      organizationId: 'org-1',
      conversation,
      actor: { _id: 'user-1' } as never,
      idempotencyKey: 'idem-media-3',
      media: { ...media, type: 'audio', mimeType: 'audio/ogg', isVoiceNote: true },
    });

    expect(createOutboundMessageRecord).toHaveBeenCalledWith(
      expect.objectContaining({ media: expect.objectContaining({ isVoiceNote: true }) }),
    );
  });

  it('writes a plain text message exactly as it always did', async () => {
    // The regression that would matter most: media must be additive.
    const { service, createOutboundMessageRecord } = createHarness();

    await service.enqueueOutboundMessage({
      organizationId: 'org-1',
      conversation,
      actor: { _id: 'user-1' } as never,
      body: 'just words',
      idempotencyKey: 'idem-text-1',
    });

    const params = createOutboundMessageRecord.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.body).toBe('just words');
    expect(params.type).toBeUndefined();
    expect(params.mediaObjectKey).toBeUndefined();
    expect(params.media).toBeUndefined();
  });

  it('returns the existing message when the same idempotency key is sent twice', async () => {
    // Unchanged by attachments, and the thing that stops a double-tap on Send from sending a
    // photo twice: the duplicate key collides and the first message is returned.
    const duplicate = Object.assign(new Error('duplicate'), { code: 11000 });
    const findMessageByIdempotencyKey = vi.fn().mockResolvedValue({ _id: 'msg-out-1' });

    const service = createOutboundMessageService({
      createOutboundMessageRecord: vi.fn().mockRejectedValue(duplicate) as never,
      findMessageByIdempotencyKey: findMessageByIdempotencyKey as never,
      updateConversationPreview: vi.fn().mockResolvedValue(undefined) as never,
      updateAssignment: vi.fn().mockResolvedValue(undefined) as never,
      createActivity: vi.fn().mockResolvedValue(undefined) as never,
      publishEvent: vi.fn().mockResolvedValue(undefined) as never,
      createTrace: ({ seed }) =>
        createPipelineTrace({
          seed,
          config: { WHATSAPP_TRACE_ENABLED: false },
          write: () => {},
        }),
      now: () => new Date(2026, 0, 2, 15, 41, 10),
    });

    const result = await service.enqueueOutboundMessage({
      organizationId: 'org-1',
      conversation,
      actor: { _id: 'user-1' } as never,
      idempotencyKey: 'idem-media-1',
      media,
    });

    expect(result.created).toBe(false);
    expect(findMessageByIdempotencyKey).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'idem-media-1' }),
    );
  });
});
