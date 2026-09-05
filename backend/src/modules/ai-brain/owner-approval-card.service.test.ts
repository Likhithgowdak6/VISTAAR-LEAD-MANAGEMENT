/**
 * Exercises owner-approval-card.service.ts's two halves:
 *  - the pure reply parser/classifier (splitIntoCodeSegments, classifyApprovalReplyText,
 *    resolveApprovalTarget) against the reference behavior spec: explicit codes, the
 *    approve/skip word lists (including the Hindi terms), implicit single-pending targeting,
 *    ambiguous multi-pending-no-code, bulk multi-code replies, and unknown codes;
 *  - sendApprovalCard's failure isolation and handleOwnerApprovalReply's end-to-end wiring,
 *    with every collaborator injected - no real Mongo/Redis/WhatsApp session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:27017/test',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'test-secret-at-least-32-characters-long',
    LOG_LEVEL: 'silent',
  },
}));

vi.mock('../../config/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../../config/database.js', () => ({
  runInTransaction: (command: (session: undefined) => unknown) => command(undefined),
}));

import { AI_BRAIN_APPROVAL_RESOLUTIONS } from '../../constants/ai-brain-statuses.js';
import { CONVERSATION_STAGES } from '../../constants/conversation-stages.js';
import {
  applyHandoverDecision,
  buildHandoverCardText,
  buildHandoverSummaryBlock,
  classifyApprovalReplyText,
  handleOwnerApprovalReply,
  resolveApprovalTarget,
  resolveHandoverChoice,
  sendApprovalCard,
  sendEscalationAlert,
  buildEscalationAlertText,
  sendOptOutAlert,
  buildOptOutAlertText,
  sendHandoverCard,
  splitIntoCodeSegments,
} from './owner-approval-card.service.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --------------------------------------------------------------------------
// splitIntoCodeSegments
// --------------------------------------------------------------------------
describe('splitIntoCodeSegments', () => {
  it('returns a single null-code segment when there is no code anywhere', () => {
    expect(splitIntoCodeSegments('yes please')).toEqual([{ code: null, remainder: 'yes please' }]);
  });

  it('extracts a single leading code and its remainder', () => {
    expect(splitIntoCodeSegments('A7 1')).toEqual([{ code: 'A7', remainder: '1' }]);
  });

  it('is case-insensitive for the code letter', () => {
    expect(splitIntoCodeSegments('a7 1')).toEqual([{ code: 'A7', remainder: '1' }]);
  });

  it('does not treat a letter+digit inside a word as a code', () => {
    expect(splitIntoCodeSegments('hi5 there')).toEqual([{ code: null, remainder: 'hi5 there' }]);
  });

  it('splits a bulk multi-code reply into independent segments', () => {
    expect(splitIntoCodeSegments('A7 1  B3 3')).toEqual([
      { code: 'A7', remainder: '1' },
      { code: 'B3', remainder: '3' },
    ]);
  });

  it('gives each segment a free-text instruction remainder when present', () => {
    expect(splitIntoCodeSegments('A7 change it to mention the discount')).toEqual([
      { code: 'A7', remainder: 'change it to mention the discount' },
    ]);
  });
});

// --------------------------------------------------------------------------
// classifyApprovalReplyText
// --------------------------------------------------------------------------
describe('classifyApprovalReplyText', () => {
  it.each(['1', 'yes', 'y', 'send', 'ok', 'okay', 'sure', 'go', 'haan', 'theek hai', 'theek'])(
    'classifies "%s" as approve',
    (word) => {
      expect(classifyApprovalReplyText(word)).toEqual({
        verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE,
        instruction: '',
      });
    },
  );

  it.each(['3', 'skip', 'no', 'cancel', 'nah', 'nahi'])('classifies "%s" as skip', (word) => {
    expect(classifyApprovalReplyText(word)).toEqual({
      verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP,
      instruction: '',
    });
  });

  it('is case-insensitive', () => {
    expect(classifyApprovalReplyText('YES').verdict).toBe(AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE);
    expect(classifyApprovalReplyText('Skip').verdict).toBe(AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP);
  });

  it('treats a bare "2" as an edit', () => {
    expect(classifyApprovalReplyText('2')).toEqual({
      verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.EDIT,
      instruction: '2',
    });
  });

  it('treats any other free text as an edit, using the text itself as the instruction', () => {
    expect(classifyApprovalReplyText('change it to mention the discount')).toEqual({
      verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.EDIT,
      instruction: 'change it to mention the discount',
    });
    expect(classifyApprovalReplyText('revise').verdict).toBe(AI_BRAIN_APPROVAL_RESOLUTIONS.EDIT);
  });
});

// --------------------------------------------------------------------------
// resolveApprovalTarget
// --------------------------------------------------------------------------
describe('resolveApprovalTarget', () => {
  const approvalA = { _id: 'appr-a', conversationId: 'conv-a', code: 'A7' };
  const approvalB = { _id: 'appr-b', conversationId: 'conv-b', code: 'B3' };

  it('matches an explicit code', () => {
    expect(resolveApprovalTarget({ code: 'A7', pendingApprovals: [approvalA, approvalB] })).toEqual({
      approval: approvalA,
    });
  });

  it('reports not-found for an unknown code, even with exactly one pending', () => {
    expect(resolveApprovalTarget({ code: 'Z9', pendingApprovals: [approvalA] })).toEqual({
      notFound: true,
    });
  });

  it('implicitly targets the sole pending approval when no code is given', () => {
    expect(resolveApprovalTarget({ code: null, pendingApprovals: [approvalA] })).toEqual({
      approval: approvalA,
    });
  });

  it('is ambiguous when 2+ are pending and no code is given, and lists their codes', () => {
    expect(resolveApprovalTarget({ code: null, pendingApprovals: [approvalA, approvalB] })).toEqual({
      ambiguous: true,
      pendingCodes: ['A7', 'B3'],
    });
  });
});

// --------------------------------------------------------------------------
// sendEscalationAlert - the AI stopped and the owner has to hear about it
// --------------------------------------------------------------------------
describe('buildEscalationAlertText', () => {
  it('leads with who it is about, why, and what the owner should do', () => {
    const text = buildEscalationAlertText({
      leadDisplayName: 'Riya Sharma',
      reason: 'The lead has pushed on price more than once.',
      lastLeadMessage: 'Noo i need within 40k only',
    });

    expect(text).toContain('Needs you');
    expect(text).toContain('Riya Sharma');
    expect(text).toContain('pushed on price more than once');
    expect(text).toContain('Noo i need within 40k only');
    expect(text).toContain('Automation is paused');
  });

  it('omits the quote block entirely when there is no last message', () => {
    const text = buildEscalationAlertText({
      leadDisplayName: 'Riya Sharma',
      reason: 'Needs a human.',
      lastLeadMessage: '   ',
    });

    expect(text).not.toContain('Last message:');
  });

  it('truncates a very long quote rather than sending a wall of text', () => {
    const text = buildEscalationAlertText({
      leadDisplayName: 'Riya Sharma',
      reason: 'Needs a human.',
      lastLeadMessage: 'x'.repeat(500),
    });

    expect(text).toContain('\u2026');
    expect(text.length).toBeLessThan(500);
  });

  it('still says something useful when the AI gave no reason', () => {
    const text = buildEscalationAlertText({
      leadDisplayName: 'Riya Sharma',
      reason: '',
      lastLeadMessage: null,
    });

    expect(text).toContain('Needs you');
    expect(text).toContain('needs a person');
  });
});

describe('sendEscalationAlert', () => {
  it('sends the alert to the owner through notifyOwner', async () => {
    const notifyOwner = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-9' });

    await sendEscalationAlert({
      organizationId: 'org-1',
      accountId: 'account-1',
      conversationId: 'conv-1',
      leadDisplayName: 'Riya Sharma',
      reason: 'Discount requested.',
      lastLeadMessage: 'can you reduce it',
      notifyOwner,
    });

    expect(notifyOwner).toHaveBeenCalledWith({
      accountId: 'account-1',
      organizationId: 'org-1',
      text: expect.stringContaining('Riya Sharma'),
    });
  });

  it('is failure-isolated: the pause stands even when the alert cannot be delivered', async () => {
    const notifyOwner = vi.fn().mockRejectedValue(new Error('WHATSAPP_SESSION_NOT_RUNNING'));
    const logger = { error: vi.fn() };

    await expect(
      sendEscalationAlert({
        organizationId: 'org-1',
        accountId: 'account-1',
        conversationId: 'conv-1',
        leadDisplayName: 'Riya Sharma',
        reason: 'Discount requested.',
        notifyOwner,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// sendApprovalCard
// --------------------------------------------------------------------------
describe('sendApprovalCard', () => {
  it('composes the card text with the code and draft, and sends it through notifyOwner', async () => {
    const notifyOwner = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-1' });

    await sendApprovalCard({
      organizationId: 'org-1',
      accountId: 'account-1',
      conversationId: 'conv-1',
      approvalId: 'appr-1',
      draft: 'Yes, we do house-warming shoots.',
      leadDisplayName: 'Riya Sharma',
      code: 'A7',
      notifyOwner,
    });

    expect(notifyOwner).toHaveBeenCalledWith({
      accountId: 'account-1',
      organizationId: 'org-1',
      text: expect.stringContaining('A7 1 to send, A7 2 to revise, A7 3 to skip'),
    });
    const [{ text }] = notifyOwner.mock.calls[0];
    expect(text).toContain('New draft for Riya Sharma');
    expect(text).toContain('Yes, we do house-warming shoots.');
  });

  it('is failure-isolated: a notifyOwner throw never propagates out of sendApprovalCard', async () => {
    const notifyOwner = vi.fn().mockRejectedValue(new Error('WHATSAPP_SESSION_NOT_RUNNING'));
    const logger = { error: vi.fn() };

    await expect(
      sendApprovalCard({
        organizationId: 'org-1',
        accountId: 'account-1',
        conversationId: 'conv-1',
        approvalId: 'appr-1',
        draft: 'Draft text',
        leadDisplayName: 'Riya Sharma',
        code: 'A7',
        notifyOwner,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// handleOwnerApprovalReply
// --------------------------------------------------------------------------
describe('handleOwnerApprovalReply', () => {
  const organizationId = 'org-1';
  const whatsappAccountId = 'account-1';

  const createHarness = (
    pendingApprovals: Array<{ _id: string; conversationId: string; code: string }>,
    escalatedConversation: { _id: string; displayName: string } | null = null,
  ) => {
    const listPendingApprovals = vi.fn().mockResolvedValue(pendingApprovals);
    const resolveApprovalForActor = vi.fn().mockResolvedValue({ approval: {}, sent: true });
    const ownerActor = { actor: { _id: 'owner-1' }, permissions: ['messages.send'] };
    const getOwnerActorForOrganization = vi.fn().mockResolvedValue(ownerActor);
    const notifyOwner = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-1' });
    const findMostRecentlyEscalatedConversation = vi.fn().mockResolvedValue(escalatedConversation);
    const resumeEscalatedConversationWithInstruction = vi.fn().mockResolvedValue(undefined);

    return {
      listPendingApprovals,
      resolveApprovalForActor,
      getOwnerActorForOrganization,
      notifyOwner,
      findMostRecentlyEscalatedConversation,
      resumeEscalatedConversationWithInstruction,
      ownerActor,
      run: (text: string) =>
        handleOwnerApprovalReply({
          organizationId,
          whatsappAccountId,
          text,
          messageId: 'owner-msg-1',
          listPendingApprovals,
          resolveApprovalForActor,
          getOwnerActorForOrganization,
          findMostRecentlyEscalatedConversation,
          resumeEscalatedConversationWithInstruction,
          notifyOwner,
          logger: { error: vi.fn() },
        }),
    };
  };

  it('does nothing when there are no pending approvals and nothing recently escalated', async () => {
    const h = createHarness([]);

    await h.run('1');

    expect(h.resolveApprovalForActor).not.toHaveBeenCalled();
    expect(h.resumeEscalatedConversationWithInstruction).not.toHaveBeenCalled();
    expect(h.notifyOwner).not.toHaveBeenCalled();
  });

  it('treats free text as an instruction for the most recently escalated conversation when nothing is pending', async () => {
    const h = createHarness([], { _id: 'conv-escalated', displayName: 'Likhith' });

    await h.run('ask them the budget and try to handle');

    expect(h.resumeEscalatedConversationWithInstruction).toHaveBeenCalledWith({
      organizationId,
      conversation: { _id: 'conv-escalated', displayName: 'Likhith' },
      instruction: 'ask them the budget and try to handle',
      ownerMessageId: 'owner-msg-1',
    });
    expect(h.notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Likhith') }),
    );
  });

  it('resolves an explicit-code approve and confirms it was sent', async () => {
    const h = createHarness([{ _id: 'appr-1', conversationId: 'conv-1', code: 'A7' }]);

    await h.run('A7 1');

    expect(h.resolveApprovalForActor).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        conversationId: 'conv-1',
        actor: h.ownerActor.actor,
        permissions: h.ownerActor.permissions,
        verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE,
        instruction: '',
      }),
    );
    expect(h.notifyOwner).toHaveBeenCalledWith({
      accountId: whatsappAccountId,
      organizationId,
      text: 'Sent ✅',
    });
  });

  it('implicitly targets the sole pending draft when the reply has no code', async () => {
    const h = createHarness([{ _id: 'appr-1', conversationId: 'conv-1', code: 'A7' }]);

    await h.run('1');

    expect(h.resolveApprovalForActor).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE }),
    );
  });

  it('resolves a skip and confirms it was skipped', async () => {
    const h = createHarness([{ _id: 'appr-1', conversationId: 'conv-1', code: 'A7' }]);

    await h.run('A7 skip');

    expect(h.resolveApprovalForActor).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP }),
    );
    expect(h.notifyOwner).toHaveBeenCalledWith({
      accountId: whatsappAccountId,
      organizationId,
      text: 'Skipped.',
    });
  });

  it('resolves an edit with the free text as the instruction, and sends no generic confirmation', async () => {
    const h = createHarness([{ _id: 'appr-1', conversationId: 'conv-1', code: 'A7' }]);

    await h.run('A7 change it to mention the discount');

    expect(h.resolveApprovalForActor).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.EDIT,
        instruction: 'change it to mention the discount',
      }),
    );
    // No approve/skip confirmation for an edit - sendApprovalCard (from ai-brain.service.ts's
    // own edit-path hook) is what shows the owner the revised draft.
    expect(h.notifyOwner).not.toHaveBeenCalled();
  });

  it('replies with the still-pending codes when ambiguous (2+ pending, no code)', async () => {
    const h = createHarness([
      { _id: 'appr-1', conversationId: 'conv-1', code: 'A7' },
      { _id: 'appr-2', conversationId: 'conv-2', code: 'B3' },
    ]);

    await h.run('1');

    expect(h.resolveApprovalForActor).not.toHaveBeenCalled();
    expect(h.notifyOwner).toHaveBeenCalledWith({
      accountId: whatsappAccountId,
      organizationId,
      text: expect.stringContaining('A7, B3'),
    });
  });

  it('replies that the code is unknown rather than guessing', async () => {
    const h = createHarness([{ _id: 'appr-1', conversationId: 'conv-1', code: 'A7' }]);

    await h.run('Z9 1');

    expect(h.resolveApprovalForActor).not.toHaveBeenCalled();
    expect(h.notifyOwner).toHaveBeenCalledWith({
      accountId: whatsappAccountId,
      organizationId,
      text: expect.stringContaining('Z9'),
    });
  });

  it('resolves a bulk multi-code reply independently per segment', async () => {
    const h = createHarness([
      { _id: 'appr-1', conversationId: 'conv-1', code: 'A7' },
      { _id: 'appr-2', conversationId: 'conv-2', code: 'B3' },
    ]);

    await h.run('A7 1  B3 3');

    expect(h.resolveApprovalForActor).toHaveBeenCalledTimes(2);
    expect(h.resolveApprovalForActor).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE }),
    );
    expect(h.resolveApprovalForActor).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-2', verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP }),
    );
  });

  it('never throws, even when resolving one segment fails', async () => {
    const h = createHarness([{ _id: 'appr-1', conversationId: 'conv-1', code: 'A7' }]);
    h.resolveApprovalForActor.mockRejectedValue(new Error('boom'));

    await expect(h.run('A7 1')).resolves.toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// Handover cards (Phase 5): the card text, the 1/2/3 mapping, and what each answer applies.
// --------------------------------------------------------------------------
describe('buildHandoverCardText', () => {
  it('asks the owner to confirm a "won" reading rather than announcing it', () => {
    const text = buildHandoverCardText({ leadDisplayName: 'Riya Sharma', verdict: 'won', code: 'H4' });

    expect(text).toBe(
      "Riya Sharma — looks like this one's Won. Reply H4 1 to mark it Won, H4 2 if it's still open, H4 3 to leave it with you.",
    );
  });

  it('uses the Lost wording for a "lost" reading', () => {
    const text = buildHandoverCardText({ leadDisplayName: 'Riya Sharma', verdict: 'lost', code: 'H4' });

    expect(text).toContain("looks like this one's Lost");
    expect(text).toContain('H4 1 to mark it Lost');
  });

  it('asks what is happening for an "unclear" reading', () => {
    const text = buildHandoverCardText({
      leadDisplayName: 'Riya Sharma',
      verdict: 'unclear',
      code: 'H4',
    });

    expect(text).toBe(
      "Riya Sharma — I can't tell where this stands. Reply H4 1 if you're on it, H4 2 if I should follow up, H4 3 if it's finished.",
    );
  });
});

describe('the handover card\'s summary block', () => {
  const summary = {
    headline: 'Riya wants candid wedding photography in Pune on 14 Feb.',
    suggestedNextStep: 'Confirm the date and send the two-photographer option.',
  };

  it('carries the catch-up read above the question, so the owner can answer without scrolling', () => {
    const text = buildHandoverCardText({
      leadDisplayName: 'Riya Sharma',
      verdict: 'won',
      code: 'H4',
      summary,
    });

    expect(text).toBe(
      'Where it stands: Riya wants candid wedding photography in Pune on 14 Feb.\n' +
        'Next: Confirm the date and send the two-photographer option.\n\n' +
        "Riya Sharma — looks like this one's Won. Reply H4 1 to mark it Won, H4 2 if it's still open, H4 3 to leave it with you.",
    );
  });

  it('says out loud that the read predates the latest messages', () => {
    expect(buildHandoverSummaryBlock({ ...summary, stale: true })).toContain(
      '(Read before the latest messages.)',
    );
  });

  it('leaves the card exactly as it was when there is no summary', () => {
    const withNothing = buildHandoverCardText({
      leadDisplayName: 'Riya Sharma',
      verdict: 'unclear',
      code: 'H4',
    });

    expect(withNothing).toBe(
      "Riya Sharma — I can't tell where this stands. Reply H4 1 if you're on it, H4 2 if I should follow up, H4 3 if it's finished.",
    );
    expect(
      buildHandoverCardText({
        leadDisplayName: 'Riya Sharma',
        verdict: 'unclear',
        code: 'H4',
        summary: { headline: '   ', suggestedNextStep: '' },
      }),
    ).toBe(withNothing);
  });

  it('drops a half-empty summary to the half that exists rather than printing a blank label', () => {
    expect(buildHandoverSummaryBlock({ headline: '', suggestedNextStep: 'Call her.' })).toBe(
      'Next: Call her.',
    );
    expect(buildHandoverSummaryBlock(null)).toBe('');
  });

  it('keeps the card readable on a phone: long lines are collapsed and truncated', () => {
    const block = buildHandoverSummaryBlock({
      headline: `${'wedding '.repeat(40)}`,
      suggestedNextStep: 'Call\n  her.',
    });

    const [headlineLine, nextLine] = block.split('\n');
    expect(headlineLine!.length).toBeLessThanOrEqual('Where it stands: '.length + 161);
    expect(headlineLine!.endsWith('…')).toBe(true);
    expect(nextLine).toBe('Next: Call her.');
  });
});

describe('sendHandoverCard', () => {
  it('is failure-isolated: a notifyOwner throw never propagates', async () => {
    const notifyOwner = vi.fn().mockRejectedValue(new Error('WHATSAPP_SESSION_NOT_RUNNING'));
    const logger = { error: vi.fn() };

    await expect(
      sendHandoverCard({
        organizationId: 'org-1',
        accountId: 'account-1',
        conversationId: 'conv-1',
        approvalId: 'appr-1',
        leadDisplayName: 'Riya Sharma',
        verdict: 'won',
        code: 'H4',
        notifyOwner,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});

describe('resolveHandoverChoice', () => {
  it('maps the shared parser\'s approve/skip verdicts onto options 1 and 3', () => {
    expect(resolveHandoverChoice(classifyApprovalReplyText('1'))).toBe(1);
    expect(resolveHandoverChoice(classifyApprovalReplyText('yes'))).toBe(1);
    expect(resolveHandoverChoice(classifyApprovalReplyText('3'))).toBe(3);
    expect(resolveHandoverChoice(classifyApprovalReplyText('skip'))).toBe(3);
  });

  it('maps a bare "2" onto option 2', () => {
    expect(resolveHandoverChoice(classifyApprovalReplyText('2'))).toBe(2);
  });

  it('refuses to read arbitrary free text as option 2 - a mis-read would re-open a closed deal', () => {
    expect(resolveHandoverChoice(classifyApprovalReplyText('they went with someone else'))).toBeNull();
  });
});

describe('applyHandoverDecision', () => {
  const organizationId = 'org-1';
  const resolvedBy = 'owner-1';

  const createHarness = () => {
    const conversationRepository = {
      findConversationById: vi.fn().mockResolvedValue({
        _id: 'conv-1',
        whatsappAccountId: 'account-1',
      }),
      updateStage: vi.fn().mockResolvedValue(undefined),
      updateAutomationState: vi.fn().mockResolvedValue(undefined),
      bumpNurtureStep: vi.fn().mockResolvedValue(undefined),
    };
    const resolveApproval = vi.fn().mockResolvedValue({ _id: 'appr-1', status: 'resolved' });
    const createActivity = vi.fn().mockResolvedValue(undefined);
    const enqueueConversationChanged = vi.fn().mockResolvedValue(undefined);

    return {
      conversationRepository,
      resolveApproval,
      createActivity,
      enqueueConversationChanged,
      run: (handoverVerdict: string, choice: 1 | 2 | 3) =>
        applyHandoverDecision({
          organizationId,
          approval: {
            _id: 'appr-1',
            conversationId: 'conv-1',
            code: 'H4',
            kind: 'handover',
            handoverVerdict,
          },
          choice,
          resolvedBy,
          conversationRepository: conversationRepository as never,
          resolveApproval: resolveApproval as never,
          createActivity: createActivity as never,
          enqueueConversationChanged: enqueueConversationChanged as never,
        }),
    };
  };

  it.each([
    ['won', CONVERSATION_STAGES.WON, 'Marked Won.'],
    ['lost', CONVERSATION_STAGES.LOST, 'Marked Lost.'],
  ])('%s card + 1 sets the stage and resolves the card', async (verdict, stage, confirmation) => {
    const h = createHarness();

    await expect(h.run(verdict, 1)).resolves.toBe(confirmation);

    expect(h.conversationRepository.updateStage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', stage }),
    );
    expect(h.conversationRepository.updateAutomationState).not.toHaveBeenCalled();
    expect(h.resolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'appr-1', resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE }),
    );
    expect(h.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ai_brain.handover_resolved' }),
    );
    expect(h.enqueueConversationChanged).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', reason: 'stage' }),
    );
  });

  it.each(['won', 'lost'])(
    '%s card + 2 turns automation back on and leaves the stage alone',
    async (verdict) => {
      const h = createHarness();

      await expect(h.run(verdict, 2)).resolves.toBe('Back on it.');

      expect(h.conversationRepository.updateStage).not.toHaveBeenCalled();
      expect(h.conversationRepository.updateAutomationState).toHaveBeenCalledWith(
        expect.objectContaining({ aiAutomationEnabled: true, aiAutomationPausedReason: null }),
      );
      expect(h.conversationRepository.bumpNurtureStep).not.toHaveBeenCalled();
    },
  );

  it.each(['won', 'lost'])('%s card + 3 leaves it owner-handled and quiet', async (verdict) => {
    const h = createHarness();

    await expect(h.run(verdict, 3)).resolves.toBe('Left with you.');

    expect(h.conversationRepository.updateStage).not.toHaveBeenCalled();
    expect(h.conversationRepository.updateAutomationState).not.toHaveBeenCalled();
    expect(h.resolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP }),
    );
  });

  it('unclear card + 1 ("I\'m on it") changes nothing but resolves the card', async () => {
    const h = createHarness();

    await expect(h.run('unclear', 1)).resolves.toBe('Left with you.');

    expect(h.conversationRepository.updateStage).not.toHaveBeenCalled();
    expect(h.conversationRepository.updateAutomationState).not.toHaveBeenCalled();
    expect(h.conversationRepository.bumpNurtureStep).not.toHaveBeenCalled();
    expect(h.resolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP }),
    );
  });

  it('unclear card + 2 ("you follow up") re-enables automation AND restarts the nurture cadence', async () => {
    const h = createHarness();

    await expect(h.run('unclear', 2)).resolves.toBe('Back on it.');

    expect(h.conversationRepository.updateAutomationState).toHaveBeenCalledWith(
      expect.objectContaining({ aiAutomationEnabled: true, aiAutomationPausedReason: null }),
    );
    expect(h.conversationRepository.bumpNurtureStep).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', step: 0 }),
    );
  });

  it('unclear card + 3 ("it\'s finished") closes the conversation', async () => {
    const h = createHarness();

    await expect(h.run('unclear', 3)).resolves.toBe('Marked closed.');

    expect(h.conversationRepository.updateStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: CONVERSATION_STAGES.CLOSED }),
    );
  });

  it('does nothing for a verdict it has no table for', async () => {
    const h = createHarness();

    await expect(h.run('wait', 1)).resolves.toBeNull();
    expect(h.resolveApproval).not.toHaveBeenCalled();
  });
});

describe('handleOwnerApprovalReply - handover cards', () => {
  const organizationId = 'org-1';
  const whatsappAccountId = 'account-1';

  const createHarness = (
    pendingApprovals: Array<Record<string, unknown>>,
    applyResult: string | null = 'Marked Won.',
  ) => {
    const listPendingApprovals = vi.fn().mockResolvedValue(pendingApprovals);
    const resolveApprovalForActor = vi.fn().mockResolvedValue({ approval: {}, sent: true });
    const applyHandoverDecisionMock = vi.fn().mockResolvedValue(applyResult);
    const ownerActor = { actor: { _id: 'owner-1' }, permissions: ['messages.send'] };
    const getOwnerActorForOrganization = vi.fn().mockResolvedValue(ownerActor);
    const notifyOwner = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-1' });

    return {
      listPendingApprovals,
      resolveApprovalForActor,
      applyHandoverDecision: applyHandoverDecisionMock,
      getOwnerActorForOrganization,
      notifyOwner,
      ownerActor,
      run: (text: string) =>
        handleOwnerApprovalReply({
          organizationId,
          whatsappAccountId,
          text,
          listPendingApprovals,
          resolveApprovalForActor,
          applyHandoverDecision: applyHandoverDecisionMock as never,
          getOwnerActorForOrganization,
          notifyOwner,
          logger: { error: vi.fn() },
        }),
    };
  };

  const handoverCard = (handoverVerdict: string) => ({
    _id: 'appr-1',
    conversationId: 'conv-1',
    code: 'H4',
    kind: 'handover',
    handoverVerdict,
  });

  it('never routes a handover card through resolveApprovalForActor (there is no interrupt to resume)', async () => {
    const h = createHarness([handoverCard('won')]);

    await h.run('H4 1');

    expect(h.resolveApprovalForActor).not.toHaveBeenCalled();
    expect(h.applyHandoverDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        choice: 1,
        resolvedBy: 'owner-1',
        approval: expect.objectContaining({ handoverVerdict: 'won' }),
      }),
    );
    expect(h.notifyOwner).toHaveBeenCalledWith({
      accountId: whatsappAccountId,
      organizationId,
      text: 'Marked Won.',
    });
  });

  it.each([
    ['H4 1', 1],
    ['H4 2', 2],
    ['H4 3', 3],
  ])('maps the reply "%s" onto option %i', async (text, choice) => {
    const h = createHarness([handoverCard('unclear')], 'Back on it.');

    await h.run(text);

    expect(h.applyHandoverDecision).toHaveBeenCalledWith(expect.objectContaining({ choice }));
  });

  it('asks for a number when the reply is unrecognizable free text', async () => {
    const h = createHarness([handoverCard('won')]);

    await h.run('H4 they are still deciding honestly');

    expect(h.applyHandoverDecision).not.toHaveBeenCalled();
    expect(h.notifyOwner).toHaveBeenCalledWith({
      accountId: whatsappAccountId,
      organizationId,
      text: 'Reply H4 with 1, 2 or 3.',
    });
  });

  it('still routes a reply card through resolveApprovalForActor when both kinds are in play', async () => {
    const h = createHarness([
      handoverCard('won'),
      { _id: 'appr-2', conversationId: 'conv-2', code: 'A7', kind: 'reply', handoverVerdict: null },
    ]);

    await h.run('H4 1  A7 1');

    expect(h.applyHandoverDecision).toHaveBeenCalledTimes(1);
    expect(h.resolveApprovalForActor).toHaveBeenCalledTimes(1);
    expect(h.resolveApprovalForActor).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-2' }),
    );
  });

  it('treats a record with no kind at all as the reply card it is', async () => {
    const h = createHarness([{ _id: 'appr-1', conversationId: 'conv-1', code: 'A7' }]);

    await h.run('A7 1');

    expect(h.applyHandoverDecision).not.toHaveBeenCalled();
    expect(h.resolveApprovalForActor).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// sendOptOutAlert - the lead asked to stop, and the owner needs to know they now own this chat
// --------------------------------------------------------------------------
describe('buildOptOutAlertText', () => {
  it('names the lead, quotes what they said, and says automation is off for good', () => {
    const text = buildOptOutAlertText({
      leadDisplayName: 'Riya Sharma',
      lastLeadMessage: 'band karo',
    });

    expect(text).toContain('Opted out');
    expect(text).toContain('Riya Sharma');
    expect(text).toContain('band karo');
    expect(text).toContain('Automation is off');
  });

  it('omits the quote when the opt-out message is empty', () => {
    const text = buildOptOutAlertText({ leadDisplayName: 'Riya Sharma', lastLeadMessage: '  ' });

    expect(text).toContain('Riya Sharma');
    expect(text).not.toContain('""');
  });

  it('truncates a very long message rather than sending a wall of text', () => {
    const text = buildOptOutAlertText({
      leadDisplayName: 'Riya Sharma',
      lastLeadMessage: `stop ${'x'.repeat(500)}`,
    });

    expect(text).toContain('\u2026');
    expect(text.length).toBeLessThan(400);
  });
});

describe('sendOptOutAlert', () => {
  it('sends the alert to the owner through notifyOwner', async () => {
    const notifyOwner = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-11' });

    await sendOptOutAlert({
      organizationId: 'org-1',
      accountId: 'account-1',
      conversationId: 'conv-1',
      leadDisplayName: 'Riya Sharma',
      lastLeadMessage: 'stop',
      notifyOwner,
    });

    expect(notifyOwner).toHaveBeenCalledWith({
      accountId: 'account-1',
      organizationId: 'org-1',
      text: expect.stringContaining('Riya Sharma'),
    });
  });

  it('is failure-isolated: the opt-out stands even when the alert cannot be delivered', async () => {
    const notifyOwner = vi.fn().mockRejectedValue(new Error('WHATSAPP_SESSION_NOT_RUNNING'));
    const logger = { error: vi.fn() };

    await expect(
      sendOptOutAlert({
        organizationId: 'org-1',
        accountId: 'account-1',
        conversationId: 'conv-1',
        leadDisplayName: 'Riya Sharma',
        lastLeadMessage: 'stop',
        notifyOwner,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});
