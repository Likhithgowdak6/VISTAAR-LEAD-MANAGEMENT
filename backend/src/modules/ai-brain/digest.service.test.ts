/**
 * Exercises the 9:10am owner digest: the pure composition (each section renders when populated,
 * is omitted when empty, and the whole thing collapses to the all-clear heartbeat when nothing
 * needs the owner), and the gathering/sending wiring with every collaborator injected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { ALL_CLEAR_TEXT, APPROVAL_USAGE_HINT, composeDigestText, createDigestService } = await import(
  './digest.service.js'
);

const NOW = new Date('2026-08-25T03:40:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('composeDigestText', () => {
  const empty = { newLeadCount: 0, waiting: [], parked: [], goingCold: [] };

  it('sends the all-clear heartbeat when every section is empty', () => {
    expect(composeDigestText(empty)).toBe(ALL_CLEAR_TEXT);
  });

  it('sends the all-clear even when new leads came in but nothing needs a decision', () => {
    expect(composeDigestText({ ...empty, newLeadCount: 3 })).toBe(ALL_CLEAR_TEXT);
  });

  it('renders the "waiting on you" section with code, lead and age, plus the usage hint', () => {
    const text = composeDigestText({
      ...empty,
      newLeadCount: 2,
      waiting: [
        { code: 'A7', leadDisplayName: 'Riya Sharma', hoursOld: 3 },
        { code: 'B3', leadDisplayName: 'Amit Verma', hoursOld: 1 },
      ],
    });

    expect(text).toContain('*Waiting on you*');
    expect(text).toContain('• A7 Riya Sharma (3 hrs old)');
    expect(text).toContain('• B3 Amit Verma (1 hr old)');
    expect(text).toContain(APPROVAL_USAGE_HINT);
  });

  it('puts the 24h new-lead count in the header line', () => {
    const text = composeDigestText({
      ...empty,
      newLeadCount: 4,
      parked: [{ leadDisplayName: 'Riya Sharma', reason: 'You replied here.' }],
    });

    expect(text.split('\n')[0]).toBe('Good morning — 4 new leads in the last 24h.');
  });

  it('singularizes a count of one', () => {
    const text = composeDigestText({
      ...empty,
      newLeadCount: 1,
      parked: [{ leadDisplayName: 'Riya Sharma', reason: 'You replied here.' }],
    });

    expect(text.split('\n')[0]).toBe('Good morning — 1 new lead in the last 24h.');
  });

  it('renders "parked for you" with each lead and its reason', () => {
    const text = composeDigestText({
      ...empty,
      parked: [{ leadDisplayName: 'Riya Sharma', reason: 'You replied here, so the AI stepped back.' }],
    });

    expect(text).toContain('*Parked for you*');
    expect(text).toContain('• Riya Sharma — You replied here, so the AI stepped back.');
  });

  it('renders "about to go cold" with how far into the cadence each lead is', () => {
    const text = composeDigestText({
      ...empty,
      goingCold: [{ leadDisplayName: 'Amit Verma', nurtureStep: 3 }],
    });

    expect(text).toContain('*About to go cold*');
    expect(text).toContain('• Amit Verma (nudge 3 sent, no reply)');
  });

  it('omits every section that has nothing in it', () => {
    const text = composeDigestText({
      ...empty,
      newLeadCount: 1,
      waiting: [{ code: 'A7', leadDisplayName: 'Riya Sharma', hoursOld: 2 }],
    });

    expect(text).toContain('*Waiting on you*');
    expect(text).not.toContain('*Parked for you*');
    expect(text).not.toContain('*About to go cold*');
  });
});

describe('sendDigest', () => {
  const createHarness = (overrides: Record<string, unknown> = {}) => {
    const conversationRepository = {
      findConversationById: vi.fn().mockResolvedValue({ displayName: 'Riya Sharma' }),
      findParkedConversations: vi.fn().mockResolvedValue([]),
      findGoingColdConversations: vi.fn().mockResolvedValue([]),
      countConversationsCreatedSince: vi.fn().mockResolvedValue(0),
    };
    const listPendingApprovals = vi.fn().mockResolvedValue([]);
    const listOrganizations = vi.fn().mockResolvedValue([{ _id: 'org-1' }, { _id: 'org-2' }]);
    const findAccountsByOrganization = vi.fn().mockResolvedValue([{ _id: 'account-1' }]);
    const notifyOwner = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-1' });
    const logger = { error: vi.fn() };

    const service = createDigestService({
      conversationRepository: conversationRepository as never,
      listPendingApprovals: listPendingApprovals as never,
      listOrganizations: listOrganizations as never,
      findAccountsByOrganization: findAccountsByOrganization as never,
      notifyOwner,
      logger,
      now: () => NOW,
      ...overrides,
    });

    return {
      service,
      conversationRepository,
      listPendingApprovals,
      listOrganizations,
      findAccountsByOrganization,
      notifyOwner,
      logger,
    };
  };

  it('sends one message to the organization\'s connected account self-chat', async () => {
    const h = createHarness();

    const result = await h.service.sendDigest({ organizationId: 'org-1' });

    expect(h.listOrganizations).not.toHaveBeenCalled();
    expect(h.notifyOwner).toHaveBeenCalledTimes(1);
    expect(h.notifyOwner).toHaveBeenCalledWith({
      accountId: 'account-1',
      organizationId: 'org-1',
      text: ALL_CLEAR_TEXT,
    });
    expect(result).toMatchObject({ organizations: 1, sent: 1, failed: 0 });
  });

  it('fans out across every active organization when none is named', async () => {
    const h = createHarness();

    const result = await h.service.sendDigest({});

    expect(h.notifyOwner).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ organizations: 2, sent: 2 });
  });

  it('turns each pending approval into a waiting line with its lead name and age in hours', async () => {
    const h = createHarness();
    h.listPendingApprovals.mockResolvedValue([
      { _id: 'appr-1', conversationId: 'conv-1', code: 'A7', createdAt: hoursAgo(5) },
    ]);
    h.conversationRepository.countConversationsCreatedSince.mockResolvedValue(2);

    await h.service.sendDigest({ organizationId: 'org-1' });

    const [{ text }] = h.notifyOwner.mock.calls[0] as [{ text: string }];
    expect(text).toContain('• A7 Riya Sharma (5 hrs old)');
    expect(text).toContain('2 new leads in the last 24h');
  });

  it('reads parked and going-cold leads straight off the conversation repository', async () => {
    const h = createHarness();
    h.conversationRepository.findParkedConversations.mockResolvedValue([
      { displayName: 'Riya Sharma', aiAutomationPausedReason: 'You replied here.' },
    ]);
    h.conversationRepository.findGoingColdConversations.mockResolvedValue([
      { displayName: 'Amit Verma', nurtureStep: 3 },
    ]);

    await h.service.sendDigest({ organizationId: 'org-1' });

    const [{ text }] = h.notifyOwner.mock.calls[0] as [{ text: string }];
    expect(text).toContain('• Riya Sharma — You replied here.');
    expect(text).toContain('• Amit Verma (nudge 3 sent, no reply)');
  });

  it('isolates a per-organization failure so the others still get their digest', async () => {
    const h = createHarness();
    h.notifyOwner
      .mockRejectedValueOnce(new Error('WHATSAPP_SESSION_NOT_RUNNING'))
      .mockResolvedValue({ providerMessageId: 'MSG-2' });

    const result = await h.service.sendDigest({});

    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ organizations: 2, sent: 1, failed: 1 });
  });
});
