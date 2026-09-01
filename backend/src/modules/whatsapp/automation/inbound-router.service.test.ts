/**
 * Exercises the owner-message branching in routeInboundMessage: echoes are silently dropped,
 * self-chat fromMe messages go to the (stub) owner-reply handler, a fromMe message matching an
 * existing conversation triggers markOwnerTookOver, and one matching no contact/conversation is
 * a no-op. All collaborators are injected - no real Mongo/Redis.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:27017/test',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'test-secret-at-least-32-characters-long',
    // routeInboundMessage now reaches the owner-reply -> owner-approval-card -> ai-brain.service
    // chain (still through mocked collaborators only, never invoked in these tests), which pulls
    // in config/logger.js - the only extra env field its real pino() setup needs at import time.
    LOG_LEVEL: 'silent',
  },
}));

vi.mock('../../../config/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../../../config/database.js', () => ({
  runInTransaction: (command: (session: undefined) => unknown) => command(undefined),
}));

import {
  createPipelineTrace,
  deriveTraceId,
} from '../../../observability/pipeline-trace.js';
import { REALTIME_REASONS } from '../../realtime/realtime.events.js';
import { createNumberAllowlist } from './allowlist.js';
import { createInboundMessageRouter } from './inbound-router.service.js';

const createHarness = ({
  allowedNumbers = '',
  ownerNumber = '',
}: { allowedNumbers?: string; ownerNumber?: string } = {}) => {
  const ingestInboundMessage = vi.fn().mockResolvedValue(undefined);
  const echoGuardService = { isOwnMessage: vi.fn().mockResolvedValue(false), remember: vi.fn() };
  const handleOwnerSelfChatReply = vi.fn().mockResolvedValue(undefined);
  const contactRepository = { findContactByProviderKey: vi.fn() };
  const conversationRepository = {
    findConversationByAccountAndContact: vi.fn(),
    markOwnerTookOver: vi.fn(),
  };
  const computeContactProviderKey = vi.fn((jid: unknown) => (jid ? `key:${jid}` : null));
  const publishEvent = vi.fn().mockResolvedValue(true);
  const logger = { error: vi.fn(), warn: vi.fn() };

  const router = createInboundMessageRouter({
    ingestInboundMessage,
    allowlist: createNumberAllowlist(allowedNumbers),
    ownerNumbers: createNumberAllowlist(ownerNumber),
    echoGuardService: echoGuardService as never,
    handleOwnerSelfChatReply,
    contactRepository: contactRepository as never,
    conversationRepository: conversationRepository as never,
    computeContactProviderKey,
    publishEvent,
    logger,
  });

  return {
    router,
    ingestInboundMessage,
    echoGuardService,
    handleOwnerSelfChatReply,
    contactRepository,
    conversationRepository,
    publishEvent,
    logger,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('routeInboundMessage', () => {
  it('ingests a normal (non-fromMe) message unchanged', async () => {
    const { router, ingestInboundMessage, echoGuardService } = createHarness();

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm1',
        remoteJid: '919999999999@s.whatsapp.net',
      } as never,
    });

    expect(echoGuardService.isOwnMessage).not.toHaveBeenCalled();
    expect(ingestInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', whatsappAccountId: 'account-1' }),
    );
  });

  it('does nothing for an echo of our own just-sent message', async () => {
    const { router, ingestInboundMessage, echoGuardService, handleOwnerSelfChatReply, conversationRepository } =
      createHarness();
    echoGuardService.isOwnMessage.mockResolvedValue(true);

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: true,
        isSelfChat: false,
        messageId: 'm2',
        remoteJid: '919999999999@s.whatsapp.net',
      } as never,
    });

    expect(ingestInboundMessage).not.toHaveBeenCalled();
    expect(handleOwnerSelfChatReply).not.toHaveBeenCalled();
    expect(conversationRepository.markOwnerTookOver).not.toHaveBeenCalled();
  });

  it('routes a self-chat fromMe message to the owner-reply stub, not ingestion', async () => {
    const { router, ingestInboundMessage, handleOwnerSelfChatReply } = createHarness();

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: true,
        isSelfChat: true,
        messageId: 'm3',
        text: '1',
        remoteJid: '911234567890@s.whatsapp.net',
      } as never,
    });

    expect(handleOwnerSelfChatReply).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', whatsappAccountId: 'account-1', text: '1' }),
    );
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('marks owner takeover for a fromMe message matching an existing conversation', async () => {
    const { router, ingestInboundMessage, contactRepository, conversationRepository, publishEvent } =
      createHarness();
    contactRepository.findContactByProviderKey.mockResolvedValue({ _id: 'contact-1' });
    conversationRepository.findConversationByAccountAndContact.mockResolvedValue({
      _id: 'conv-1',
      assignedTo: 'user-1',
    });
    conversationRepository.markOwnerTookOver.mockResolvedValue({
      _id: 'conv-1',
      assignedTo: 'user-1',
    });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: true,
        isSelfChat: false,
        messageId: 'm4',
        remoteJid: '919999999999@s.whatsapp.net',
      } as never,
    });

    expect(conversationRepository.markOwnerTookOver).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', organizationId: 'org-1' }),
    );
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', reason: REALTIME_REASONS.OWNER_TAKEOVER }),
    );
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('does nothing for a fromMe message matching no contact', async () => {
    const { router, contactRepository, conversationRepository, ingestInboundMessage } = createHarness();
    contactRepository.findContactByProviderKey.mockResolvedValue(null);

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: true,
        isSelfChat: false,
        messageId: 'm5',
        remoteJid: '919999999999@s.whatsapp.net',
      } as never,
    });

    expect(conversationRepository.markOwnerTookOver).not.toHaveBeenCalled();
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('does nothing for a fromMe message matching a contact with no conversation on this account', async () => {
    const { router, contactRepository, conversationRepository, ingestInboundMessage } = createHarness();
    contactRepository.findContactByProviderKey.mockResolvedValue({ _id: 'contact-1' });
    conversationRepository.findConversationByAccountAndContact.mockResolvedValue(null);

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: true,
        isSelfChat: false,
        messageId: 'm6',
        remoteJid: '919999999999@s.whatsapp.net',
      } as never,
    });

    expect(conversationRepository.markOwnerTookOver).not.toHaveBeenCalled();
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });
});

describe('routeInboundMessage - test-number allowlist', () => {
  it('ingests a message from the allowed number', async () => {
    const { router, ingestInboundMessage } = createHarness({ allowedNumbers: '8183003081' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm1',
        senderJid: '918183003081@s.whatsapp.net',
        remoteJid: '918183003081@s.whatsapp.net',
      } as never,
    });

    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('drops a message from any other number before it is ever persisted', async () => {
    const { router, ingestInboundMessage } = createHarness({ allowedNumbers: '8183003081' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm1',
        senderJid: '919876543210@s.whatsapp.net',
        remoteJid: '919876543210@s.whatsapp.net',
      } as never,
    });

    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('accepts on the resolved phone JID when the raw sender is an opaque @lid', async () => {
    const { router, ingestInboundMessage } = createHarness({ allowedNumbers: '8183003081' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm1',
        senderPhoneJid: '918183003081@s.whatsapp.net',
        senderJid: '123456789012345@lid',
        remoteJid: '123456789012345@lid',
      } as never,
    });

    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an unmapped @lid while the allowlist is active', async () => {
    const { router, ingestInboundMessage } = createHarness({ allowedNumbers: '8183003081' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm1',
        senderJid: '123456789012345@lid',
        remoteJid: '123456789012345@lid',
      } as never,
    });

    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('ingests everything once the allowlist is cleared for production', async () => {
    const { router, ingestInboundMessage } = createHarness({ allowedNumbers: '' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm1',
        senderJid: '123456789012345@lid',
        remoteJid: '123456789012345@lid',
      } as never,
    });

    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
  });
});


describe('routeInboundMessage - a separate owner number', () => {
  const OWNER = '9000000001';
  const LEAD = '918183003081';

  it("treats the owner's message as a decision, never as a lead", async () => {
    const { router, ingestInboundMessage, handleOwnerSelfChatReply } = createHarness({
      ownerNumber: OWNER,
      allowedNumbers: LEAD,
    });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm1',
        text: 'A7 1',
        senderJid: `${OWNER}@s.whatsapp.net`,
        remoteJid: `${OWNER}@s.whatsapp.net`,
      } as never,
    });

    expect(handleOwnerSelfChatReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'A7 1', whatsappAccountId: 'account-1' }),
    );
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('reaches the owner even when the test allowlist would not have let them through', async () => {
    // The owner is not a lead, so the lead-facing allowlist must not gate their decisions.
    const { router, handleOwnerSelfChatReply, ingestInboundMessage } = createHarness({
      ownerNumber: OWNER,
      allowedNumbers: LEAD,
    });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm2',
        text: '1',
        senderJid: `${OWNER}@s.whatsapp.net`,
        remoteJid: `${OWNER}@s.whatsapp.net`,
      } as never,
    });

    expect(handleOwnerSelfChatReply).toHaveBeenCalledTimes(1);
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('matches the owner with or without the country code', async () => {
    const { router, handleOwnerSelfChatReply } = createHarness({ ownerNumber: '9000000001' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm3',
        text: '2 make it warmer',
        senderJid: '919000000001@s.whatsapp.net',
        remoteJid: '919000000001@s.whatsapp.net',
      } as never,
    });

    expect(handleOwnerSelfChatReply).toHaveBeenCalledTimes(1);
  });

  it('still ingests a real lead normally', async () => {
    const { router, ingestInboundMessage, handleOwnerSelfChatReply } = createHarness({
      ownerNumber: OWNER,
      allowedNumbers: LEAD,
    });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm4',
        text: 'Do you shoot birthdays?',
        senderJid: `${LEAD}@s.whatsapp.net`,
        remoteJid: `${LEAD}@s.whatsapp.net`,
      } as never,
    });

    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    expect(handleOwnerSelfChatReply).not.toHaveBeenCalled();
  });

  it('a failing owner-reply handler never breaks the inbound pipeline', async () => {
    const { router, handleOwnerSelfChatReply } = createHarness({ ownerNumber: OWNER });
    handleOwnerSelfChatReply.mockRejectedValue(new Error('boom'));

    await expect(
      router.routeInboundMessage({
        organizationId: 'org-1',
        whatsappAccountId: 'account-1',
        inboundMessage: {
          fromMe: false,
          isSelfChat: false,
          messageId: 'm5',
          text: '1',
          senderJid: `${OWNER}@s.whatsapp.net`,
          remoteJid: `${OWNER}@s.whatsapp.net`,
        } as never,
      }),
    ).resolves.toBeUndefined();
  });

  it('leaves the old self-chat behaviour alone when no owner number is set', async () => {
    const { router, ingestInboundMessage, handleOwnerSelfChatReply } = createHarness({
      ownerNumber: '',
    });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm6',
        text: 'hello',
        senderJid: '919999999999@s.whatsapp.net',
        remoteJid: '919999999999@s.whatsapp.net',
      } as never,
    });

    expect(handleOwnerSelfChatReply).not.toHaveBeenCalled();
    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
  });
});


describe('routeInboundMessage - the owner number stored in the dashboard', () => {
  const OWNER = '918183003081';

  /**
   * No `ownerNumbers` injected here on purpose: that option is an explicit override, and leaving
   * it out is what makes the router resolve the number per message from the organization's
   * settings - the behaviour that lets an admin change it without a restart.
   */
  const createSettingsHarness = (ownerNumber: string) => {
    const ingestInboundMessage = vi.fn().mockResolvedValue(undefined);
    const handleOwnerSelfChatReply = vi.fn().mockResolvedValue(undefined);
    const getOwnerNumber = vi.fn().mockResolvedValue(ownerNumber);

    const router = createInboundMessageRouter({
      ingestInboundMessage,
      config: { WHATSAPP_TEST_ALLOWED_NUMBERS: '', WHATSAPP_OWNER_NUMBER: '' } as never,
      organizationSettingsService: { getOwnerNumber },
      echoGuardService: { isOwnMessage: vi.fn().mockResolvedValue(false), remember: vi.fn() } as never,
      handleOwnerSelfChatReply,
      contactRepository: { findContactByProviderKey: vi.fn() } as never,
      conversationRepository: {
        findConversationByAccountAndContact: vi.fn(),
        markOwnerTookOver: vi.fn(),
      } as never,
      computeContactProviderKey: vi.fn((jid: unknown) => (jid ? `key:${jid}` : null)),
      publishEvent: vi.fn().mockResolvedValue(true),
      logger: { error: vi.fn() },
    });

    const messageFrom = (phone: string, messageId: string) =>
      router.routeInboundMessage({
        organizationId: 'org-1',
        whatsappAccountId: 'account-1',
        inboundMessage: {
          fromMe: false,
          isSelfChat: false,
          messageId,
          text: 'A7 1',
          senderJid: `${phone}@s.whatsapp.net`,
          remoteJid: `${phone}@s.whatsapp.net`,
        } as never,
      });

    return { getOwnerNumber, ingestInboundMessage, handleOwnerSelfChatReply, messageFrom };
  };

  it('routes a message from the stored owner number to the owner-reply handler, not ingestion', async () => {
    const h = createSettingsHarness(OWNER);

    await h.messageFrom(OWNER, 'm1');

    expect(h.getOwnerNumber).toHaveBeenCalledWith({ organizationId: 'org-1' });
    expect(h.handleOwnerSelfChatReply).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', text: 'A7 1' }),
    );
    expect(h.ingestInboundMessage).not.toHaveBeenCalled();
  });

  it('still ingests a real lead while a stored owner number is in force', async () => {
    const h = createSettingsHarness(OWNER);

    await h.messageFrom('919876543210', 'm2');

    expect(h.handleOwnerSelfChatReply).not.toHaveBeenCalled();
    expect(h.ingestInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('follows a change to the stored number without the router being rebuilt', async () => {
    const h = createSettingsHarness(OWNER);

    await h.messageFrom(OWNER, 'm3');
    expect(h.handleOwnerSelfChatReply).toHaveBeenCalledTimes(1);

    // The admin saves a different phone in the dashboard; the same router instance must follow.
    h.getOwnerNumber.mockResolvedValue('919876543210');

    await h.messageFrom(OWNER, 'm4');
    await h.messageFrom('919876543210', 'm5');

    expect(h.handleOwnerSelfChatReply).toHaveBeenCalledTimes(2);
    expect(h.ingestInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves the older behaviour in place when nothing is stored and no env default is set', async () => {
    const h = createSettingsHarness('');

    await h.messageFrom(OWNER, 'm6');

    expect(h.handleOwnerSelfChatReply).not.toHaveBeenCalled();
    expect(h.ingestInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('a failing settings lookup falls back to the env default rather than dropping the message', async () => {
    const h = createSettingsHarness('');
    h.getOwnerNumber.mockRejectedValue(new Error('mongo down'));

    await h.messageFrom('919876543210', 'm7');

    expect(h.ingestInboundMessage).toHaveBeenCalledTimes(1);
  });
});

describe('routeInboundMessage - a blocked message is never silent', () => {
  it('warns when the allowlist drops a sender, so a blocked lead is diagnosable', async () => {
    const { router, ingestInboundMessage, logger } = createHarness({ allowedNumbers: '8183003081' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm1',
        senderJid: '919876543210@s.whatsapp.net',
        remoteJid: '919876543210@s.whatsapp.net',
      } as never,
    });

    expect(ingestInboundMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('warns for an unmapped @lid too - the fail-closed case that looks like nothing arrived', async () => {
    const { router, ingestInboundMessage, logger } = createHarness({ allowedNumbers: '8183003081' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm2',
        senderJid: '123456789012345@lid',
        remoteJid: '123456789012345@lid',
      } as never,
    });

    expect(ingestInboundMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not mask away which chat it was, but never logs a full number', async () => {
    const { router, logger } = createHarness({ allowedNumbers: '8183003081' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm3',
        senderJid: '919876543210@s.whatsapp.net',
        remoteJid: '919876543210@s.whatsapp.net',
      } as never,
    });

    const [fields] = logger.warn.mock.calls[0];
    expect(fields.senderJid).toContain('***');
    expect(fields.senderJid).not.toContain('919876543210');
  });

  it('stays quiet when the message is allowed through', async () => {
    const { router, ingestInboundMessage, logger } = createHarness({ allowedNumbers: '8183003081' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: {
        fromMe: false,
        isSelfChat: false,
        messageId: 'm4',
        senderJid: '918183003081@s.whatsapp.net',
        remoteJid: '918183003081@s.whatsapp.net',
      } as never,
    });

    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('routeInboundMessage - the pipeline trace (stages 4-6)', () => {
  const createTracingHarness = ({
    allowedNumbers = '',
    ownerNumber = '',
  }: { allowedNumbers?: string; ownerNumber?: string } = {}) => {
    const lines: string[] = [];
    const base = createHarness({ allowedNumbers, ownerNumber });
    const ingestInboundMessage = vi.fn().mockResolvedValue(undefined);
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

    const router = createInboundMessageRouter({
      ingestInboundMessage,
      allowlist: createNumberAllowlist(allowedNumbers),
      ownerNumbers: createNumberAllowlist(ownerNumber),
      echoGuardService: { isOwnMessage: vi.fn().mockResolvedValue(false) } as never,
      handleOwnerSelfChatReply: vi.fn().mockResolvedValue(undefined),
      contactRepository: base.contactRepository as never,
      conversationRepository: base.conversationRepository as never,
      computeContactProviderKey: vi.fn(() => null),
      publishEvent: vi.fn(),
      createTrace: ({ seed }) =>
        createPipelineTrace({
          seed,
          config: { WHATSAPP_TRACE_ENABLED: true },
          write: (line) => lines.push(line),
        }),
      logger,
    });

    return { router, lines, logger, ingestInboundMessage };
  };

  const leadMessage = (overrides: Record<string, unknown> = {}) => ({
    fromMe: false,
    isSelfChat: false,
    messageId: 'trace-m1',
    text: 'need a photographer for 14 Feb',
    senderJid: '919876543210@s.whatsapp.net',
    remoteJid: '919876543210@s.whatsapp.net',
    ...overrides,
  });

  it('prints stages 4, 5 and 6 for a lead message that gets through', async () => {
    const { router, lines, ingestInboundMessage } = createTracingHarness();

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: leadMessage() as never,
    });

    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(' 4/13');
    expect(lines[1]).toContain(' 5/13');
    expect(lines[2]).toContain(' 6/13');
    expect(lines.join('\n')).not.toContain('STOPPED');
  });

  it('shares its correlation id with the provider stages, derived from the same message id', async () => {
    const { router, lines } = createTracingHarness();

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: leadMessage() as never,
    });

    expect(lines[0]).toContain(`[wa ${deriveTraceId('trace-m1')}]`);
  });

  it('the owner-number drop becomes ONE trace stop, not a second competing log line', async () => {
    const { router, lines, logger, ingestInboundMessage } = createTracingHarness({
      ownerNumber: '9876543210',
    });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: leadMessage() as never,
    });

    expect(ingestInboundMessage).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    const stops = lines.filter((line) => line.includes('STOPPED'));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain(' 5/13');
    expect(stops[0]).toContain('!!!');
    expect(stops[0]).toContain('WHATSAPP_OWNER_NUMBER');
  });

  it('the allowlist drop becomes ONE trace stop, not a second competing warn', async () => {
    const { router, lines, logger, ingestInboundMessage } = createTracingHarness({
      allowedNumbers: '8183003081',
    });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: leadMessage() as never,
    });

    expect(ingestInboundMessage).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    const stops = lines.filter((line) => line.includes('STOPPED'));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain(' 6/13');
    expect(stops[0]).toContain('WHATSAPP_TEST_ALLOWED_NUMBERS');
  });

  it('never prints a lead phone number in full on any of those lines', async () => {
    const { router, lines } = createTracingHarness({ allowedNumbers: '8183003081' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: leadMessage() as never,
    });

    expect(lines.join('\n')).not.toContain('919876543210');
    expect(lines.join('\n')).toContain('***');
  });

  it('reports a fromMe echo as HANDLED, not as an alarming stop', async () => {
    const lines: string[] = [];
    const router = createInboundMessageRouter({
      ingestInboundMessage: vi.fn(),
      allowlist: createNumberAllowlist(''),
      ownerNumbers: createNumberAllowlist(''),
      echoGuardService: { isOwnMessage: vi.fn().mockResolvedValue(true) } as never,
      handleOwnerSelfChatReply: vi.fn(),
      contactRepository: { findContactByProviderKey: vi.fn() } as never,
      conversationRepository: {
        findConversationByAccountAndContact: vi.fn(),
        markOwnerTookOver: vi.fn(),
      } as never,
      computeContactProviderKey: vi.fn(() => null),
      publishEvent: vi.fn(),
      createTrace: ({ seed }) =>
        createPipelineTrace({
          seed,
          config: { WHATSAPP_TRACE_ENABLED: true },
          write: (line) => lines.push(line),
        }),
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: leadMessage({ fromMe: true }) as never,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(' 4/13');
    expect(lines[0]).toContain('echo');
    expect(lines[0]).toContain('branch=echo');

    // An echo happens for EVERY message the agent sends, so it is the most routine event in the
    // system. The `!!!` gutter exists to make a genuinely unwanted stop findable in a wall of
    // terminal output; spending it on the routine case teaches the reader to skip `!!!`, which
    // costs exactly the thing this trace was built for.
    expect(lines[0]).toContain('HANDLED');
    expect(lines[0]).not.toContain('STOPPED');
    expect(lines[0]).not.toContain('!!!');
  });

  it('writes nothing at all while WHATSAPP_TRACE_ENABLED is off, and keeps the old warn', async () => {
    const { router, ingestInboundMessage, logger } = createHarness({ allowedNumbers: '8183003081' });

    await router.routeInboundMessage({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      inboundMessage: leadMessage() as never,
    });

    expect(ingestInboundMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
