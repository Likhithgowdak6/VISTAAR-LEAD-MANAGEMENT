/**
 * Covers what ingestion does around persisting an inbound message, with every collaborator
 * injected - no real Mongo, no real WhatsApp session:
 *
 *  - the new-lead alert: fires only on a lead's first-ever inbound message, skipped after that,
 *    and can never break ingestion no matter how it fails;
 *  - opt-out: a lead who says "stop" is marked, their message is still saved as the evidence
 *    they asked, and the AI is never given the chance to reply to it;
 *  - media: the message type and the cheap media metadata reach the message row, and a
 *    caption-less photo gets a readable conversation preview instead of a blank one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { createInboundMessageIngestionService } = await import('./inbound-message.service.js');
const { createPipelineTrace, deriveTraceId } = await import(
  '../../../observability/pipeline-trace.js'
);

const inboundMessage = {
  eventType: 'message.received',
  messageId: 'PROVIDER-MSG-1',
  remoteJid: '919876543210@s.whatsapp.net',
  senderJid: '919876543210@s.whatsapp.net',
  pushName: 'Riya Sharma',
  text: 'Hi, do you shoot house-warmings?',
  timestamp: 1_774_000_000,
};

const createHarness = (
  conversationOverrides: Record<string, unknown> = {},
  inboundOverrides: Record<string, unknown> = {},
  /** Extra conversation-repository doubles, e.g. the pasted-form merge. */
  conversationRepositoryOverrides: Record<string, unknown> = {},
) => {
  const conversation = {
    _id: 'conv-1',
    organizationId: 'org-1',
    leadId: 'LEAD-20260825-ABC123',
    displayName: 'Riya Sharma',
    assignedTo: null,
    lastInboundAt: null,
    ...conversationOverrides,
  };

  const sendNewLeadAlert = vi.fn().mockResolvedValue({ sent: true });
  const recomputeLeadScore = vi.fn().mockResolvedValue(null);
  const sendOptOutAlert = vi.fn().mockResolvedValue(undefined);
  const handleAutomation = vi.fn().mockResolvedValue(undefined);
  const markOptedOut = vi.fn().mockResolvedValue(conversation);
  const updateConversationPreview = vi.fn().mockResolvedValue(conversation);
  const createInboundMessage = vi.fn().mockResolvedValue({
    _id: 'msg-1',
    sentAt: new Date('2026-08-25T03:00:00.000Z'),
  });
  const logger = { error: vi.fn() };

  const service = createInboundMessageIngestionService({
    contactRepository: {
      findOrCreateContactByProviderKey: vi.fn().mockResolvedValue({
        contact: {
          _id: 'contact-1',
          leadId: 'LEAD-20260825-ABC123',
          displayName: 'Riya Sharma',
        },
        created: true,
      }),
      attachContactPhoneIfMissing: vi.fn().mockResolvedValue(undefined),
    } as never,
    conversationRepository: {
      upsertConversationForContact: vi.fn().mockResolvedValue(conversation),
      updateConversationPreview,
      markOptedOut,
      ...conversationRepositoryOverrides,
    } as never,
    messageRepository: {
      createInboundMessage,
    } as never,
    computeContactProviderKey: () => 'provider-key-1',
    extractPhoneFromJid: () => '919876543210',
    normalizeProviderJid: (jid: unknown) => String(jid),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    handleAutomation: handleAutomation as never,
    sendNewLeadAlert: sendNewLeadAlert as never,
    sendOptOutAlert: sendOptOutAlert as never,
    recomputeLeadScore: recomputeLeadScore as never,
    logger,
    now: () => new Date('2026-08-25T03:00:00.000Z'),
  });

  return {
    service,
    sendNewLeadAlert,
    sendOptOutAlert,
    recomputeLeadScore,
    handleAutomation,
    markOptedOut,
    updateConversationPreview,
    createInboundMessage,
    logger,
    run: () =>
      service.ingestInboundMessage({
        organizationId: 'org-1',
        whatsappAccountId: 'account-1',
        inboundMessage: { ...inboundMessage, ...inboundOverrides } as never,
      }),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ingestInboundMessage - new-lead alert', () => {
  it('alerts the owner on a lead\'s first-ever inbound message', async () => {
    const h = createHarness({ lastInboundAt: null });

    await h.run();

    expect(h.sendNewLeadAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        whatsappAccountId: 'account-1',
        conversationId: 'conv-1',
        leadDisplayName: 'Riya Sharma',
        firstMessage: 'Hi, do you shoot house-warmings?',
      }),
    );
  });

  it('does not alert again once the conversation has inbound history', async () => {
    const h = createHarness({ lastInboundAt: new Date('2026-08-20T10:00:00.000Z') });

    await h.run();

    expect(h.sendNewLeadAlert).not.toHaveBeenCalled();
  });

  it('still persists the message and runs automation when the alert blows up', async () => {
    const h = createHarness();
    h.sendNewLeadAlert.mockRejectedValue(new Error('unexpected'));

    const result = await h.run();

    expect(result).toMatchObject({ persisted: true, conversationId: 'conv-1' });
    expect(h.handleAutomation).toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe('ingestInboundMessage - lead score', () => {
  it('rescores the lead on every inbound message, passing the text through', async () => {
    const h = createHarness();

    await h.run();

    expect(h.recomputeLeadScore).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        conversationId: 'conv-1',
        whatsappAccountId: 'account-1',
        inboundText: 'Hi, do you shoot house-warmings?',
      }),
    );
  });

  it('reports a reply when we had already sent this lead something', async () => {
    const h = createHarness({
      lastInboundAt: new Date('2026-08-20T10:00:00.000Z'),
      lastOutboundAt: new Date('2026-08-24T10:00:00.000Z'),
    });

    await h.run();

    expect(h.recomputeLeadScore).toHaveBeenCalledWith(
      expect.objectContaining({ repliedToAi: true }),
    );
  });

  it('does not call an unprompted first message a reply', async () => {
    const h = createHarness({ lastInboundAt: null, lastOutboundAt: null });

    await h.run();

    expect(h.recomputeLeadScore).toHaveBeenCalledWith(
      expect.objectContaining({ repliedToAi: false }),
    );
  });

  it('rescores AFTER a pasted form has been merged, so the form\'s facts count', async () => {
    const mergeConversationAiContext = vi.fn().mockResolvedValue({ _id: 'conv-1' });
    const h = createHarness(
      { lastInboundAt: null },
      {
        text: [
          'Hello! I filled out your form',
          'What is the event: House warming',
          'Event date: 12 September 2026',
          'Venue: Whitefield, Bangalore',
          'Budget: 1.2 lakh',
        ].join('\n'),
      },
      { mergeConversationAiContext },
    );

    await h.run();

    expect(mergeConversationAiContext).toHaveBeenCalled();
    expect(mergeConversationAiContext.mock.invocationCallOrder[0]).toBeLessThan(
      h.recomputeLeadScore.mock.invocationCallOrder[0]!,
    );
  });

  it('still persists the message and runs automation when scoring blows up', async () => {
    const h = createHarness();
    h.recomputeLeadScore.mockRejectedValue(new Error('unexpected'));

    const result = await h.run();

    expect(result).toMatchObject({ persisted: true, conversationId: 'conv-1' });
    expect(h.handleAutomation).toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe('ingestInboundMessage - opt-out', () => {
  it('marks the conversation opted out when the lead says stop', async () => {
    const h = createHarness({}, { text: 'STOP' });

    await h.run();

    expect(h.markOptedOut).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        organizationId: 'org-1',
        pausedReason: expect.stringContaining('stop'),
      }),
    );
  });

  it("still persists the lead's message - it is the evidence they asked", async () => {
    const h = createHarness({}, { text: 'stop' });

    const result = await h.run();

    expect(h.createInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'stop', providerMessageId: 'PROVIDER-MSG-1' }),
    );
    expect(result).toMatchObject({ persisted: true, optedOut: true, messageId: 'msg-1' });
  });

  it('never lets the AI reply to an opt-out', async () => {
    const h = createHarness({}, { text: 'unsubscribe' });

    await h.run();

    expect(h.handleAutomation).not.toHaveBeenCalled();
  });

  it('leaves a conversation that already opted out alone, and still runs no automation', async () => {
    const h = createHarness(
      { optedOutAt: new Date('2026-08-20T10:00:00.000Z') },
      { text: 'actually what are your rates' },
    );

    const result = await h.run();

    expect(h.markOptedOut).not.toHaveBeenCalled();
    expect(h.handleAutomation).not.toHaveBeenCalled();
    expect(result).toMatchObject({ persisted: true, optedOut: true });
  });

  it('runs automation as normal for a message that is not an opt-out', async () => {
    const h = createHarness();

    await h.run();

    expect(h.markOptedOut).not.toHaveBeenCalled();
    expect(h.handleAutomation).toHaveBeenCalled();
  });

  it('tells the owner which lead opted out', async () => {
    const h = createHarness({}, { text: 'band karo' });

    await h.run();

    expect(h.sendOptOutAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        accountId: 'account-1',
        conversationId: 'conv-1',
        leadDisplayName: 'Riya Sharma',
        lastLeadMessage: 'band karo',
      }),
    );
  });

  it('still ingests, and still suppresses the AI, when the owner alert blows up', async () => {
    const h = createHarness({}, { text: 'stop' });
    h.sendOptOutAlert.mockRejectedValue(new Error('no whatsapp session'));

    const result = await h.run();

    expect(result).toMatchObject({ persisted: true, optedOut: true });
    expect(h.handleAutomation).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('still suppresses the AI when the opt-out write itself fails', async () => {
    const h = createHarness({}, { text: 'stop' });
    h.markOptedOut.mockRejectedValue(new Error('mongo is down'));

    const result = await h.run();

    expect(result).toMatchObject({ persisted: true, optedOut: true });
    expect(h.handleAutomation).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();
  });
});

describe('ingestInboundMessage - inbound media', () => {
  const voiceNote = {
    text: '',
    messageType: 'audio',
    media: { mimeType: 'audio/ogg; codecs=opus', fileName: null, sizeBytes: 8321, isVoiceNote: true },
  };

  it('persists the message type and the media metadata that arrived with the notification', async () => {
    const h = createHarness({}, voiceNote);

    await h.run();

    expect(h.createInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audio',
        media: {
          mimeType: 'audio/ogg; codecs=opus',
          fileName: null,
          sizeBytes: 8321,
          storageStatus: 'not_applicable',
        },
      }),
    );
  });

  it('defaults to a text message with no media block when the provider says nothing', async () => {
    const h = createHarness();

    await h.run();

    expect(h.createInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', media: undefined }),
    );
  });

  it('gives a caption-less photo a readable conversation preview', async () => {
    const h = createHarness(
      {},
      {
        text: '',
        messageType: 'image',
        media: { mimeType: 'image/jpeg', fileName: null, sizeBytes: 90_000, isVoiceNote: false },
      },
    );

    await h.run();

    expect(h.updateConversationPreview).toHaveBeenCalledWith(
      expect.objectContaining({ lastMessagePreview: '📷 Photo' }),
    );
  });

  it('previews a voice note as a voice note, not as generic audio', async () => {
    const h = createHarness({}, voiceNote);

    await h.run();

    expect(h.updateConversationPreview).toHaveBeenCalledWith(
      expect.objectContaining({ lastMessagePreview: '🎤 Voice note' }),
    );
  });

  it('keeps the caption as the preview when there is one - it says more than the label', async () => {
    const h = createHarness(
      {},
      {
        text: 'This is the venue',
        messageType: 'image',
        media: { mimeType: 'image/jpeg', fileName: null, sizeBytes: 90_000, isVoiceNote: false },
      },
    );

    await h.run();

    expect(h.updateConversationPreview).toHaveBeenCalledWith(
      expect.objectContaining({ lastMessagePreview: 'This is the venue' }),
    );
  });

  it('hands the message kind and the voice-note flag to automation', async () => {
    const h = createHarness({}, voiceNote);

    await h.run();

    expect(h.handleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'audio', isVoiceNote: true, inboundText: '' }),
    );
  });
});

describe('ingestInboundMessage - the pipeline trace (stages 7-9)', () => {
  const createTracingHarness = ({
    conversation = {},
    inbound = {},
    optedOut = false,
  }: {
    conversation?: Record<string, unknown>;
    inbound?: Record<string, unknown>;
    optedOut?: boolean;
  } = {}) => {
    const lines: string[] = [];
    const handleAutomation = vi.fn().mockResolvedValue(undefined);

    const service = createInboundMessageIngestionService({
      contactRepository: {
        findOrCreateContactByProviderKey: vi.fn().mockResolvedValue({
          contact: { _id: 'contact-1', displayName: 'Riya Sharma' },
          created: true,
        }),
        attachContactPhoneIfMissing: vi.fn().mockResolvedValue(undefined),
      } as never,
      conversationRepository: {
        upsertConversationForContact: vi.fn().mockResolvedValue({
          _id: 'conv-1',
          stage: 'new',
          aiAutomationEnabled: true,
          optedOutAt: optedOut ? new Date() : null,
          ...conversation,
        }),
        updateConversationPreview: vi.fn().mockResolvedValue(undefined),
        markOptedOut: vi.fn().mockResolvedValue(undefined),
      } as never,
      messageRepository: {
        createInboundMessage: vi.fn().mockResolvedValue({ _id: 'msg-1', sentAt: new Date() }),
      } as never,
      computeContactProviderKey: () => 'provider-key-1',
      extractPhoneFromJid: () => '919876543210',
      normalizeProviderJid: (jid: unknown) => String(jid),
      publishEvent: vi.fn().mockResolvedValue(undefined),
      handleAutomation: handleAutomation as never,
      sendNewLeadAlert: vi.fn().mockResolvedValue(undefined) as never,
      sendOptOutAlert: vi.fn().mockResolvedValue(undefined) as never,
      recomputeLeadScore: vi.fn().mockResolvedValue(undefined) as never,
      createTrace: ({ seed }) =>
        createPipelineTrace({
          seed,
          config: { WHATSAPP_TRACE_ENABLED: true },
          write: (line) => lines.push(line),
        }),
      logger: { error: vi.fn() },
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });

    return {
      lines,
      handleAutomation,
      run: () =>
        service.ingestInboundMessage({
          organizationId: 'org-1',
          whatsappAccountId: 'account-1',
          inboundMessage: { ...inboundMessage, ...inbound } as never,
        }),
    };
  };

  it('prints contact, conversation and message-saved, with the conversation id on the last one', async () => {
    const h = createTracingHarness();

    await h.run();

    expect(h.lines).toHaveLength(3);
    expect(h.lines[0]).toContain(' 7/13');
    expect(h.lines[0]).toContain('how=created');
    expect(h.lines[1]).toContain(' 8/13');
    expect(h.lines[2]).toContain(' 9/13');
    expect(h.lines[2]).toContain('conversation=conv-1');
    expect(h.lines[2]).toContain('message=msg-1');
  });

  it('carries the same correlation id the provider and router stages used', async () => {
    const h = createTracingHarness();

    await h.run();

    expect(h.lines[0]).toContain(`[wa ${deriveTraceId('PROVIDER-MSG-1')}]`);
  });

  it('hands that id to the AI stages, which cannot derive it themselves', async () => {
    const h = createTracingHarness();

    await h.run();

    expect(h.handleAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: deriveTraceId('PROVIDER-MSG-1') }),
    );
  });

  it('says out loud that an opted-out lead is saved but will never be replied to', async () => {
    const h = createTracingHarness({ conversation: { optedOutAt: new Date() } });

    await h.run();

    const stops = h.lines.filter((line) => line.includes('STOPPED'));
    expect(h.handleAutomation).not.toHaveBeenCalled();
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain('10/13');
    expect(stops[0]).toContain('opted out');
  });

  it('truncates the message body rather than printing the whole thing', async () => {
    const h = createTracingHarness({ inbound: { text: 'z'.repeat(400) } });

    await h.run();

    expect(h.lines[2]).toContain('…');
    expect(h.lines[2]).not.toContain('z'.repeat(120));
  });

  it('writes nothing at all while WHATSAPP_TRACE_ENABLED is off', async () => {
    const h = createHarness();

    await expect(h.run()).resolves.toMatchObject({ persisted: true });
  });
});
