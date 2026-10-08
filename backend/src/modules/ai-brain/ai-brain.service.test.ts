/**
 * Exercises the branching logic in ai-brain.service.ts - what gets sent, what waits for a
 * human, what moves a stage - without a real Mongo connection or a real ai-brain-service.
 * Every collaborator (Mongo-backed repositories, the outbound-message service, the HTTP client
 * to ai-brain-service, transactions) is mocked; this test is only checking that this module
 * wires them together correctly for each result ai-brain-service can return.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_BRAIN_APPROVAL_RESOLUTIONS, AI_BRAIN_RESULT_STATUSES } from '../../constants/ai-brain-statuses.js';
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { CONVERSATION_STAGES } from '../../constants/conversation-stages.js';
import { MESSAGE_AUTHORS } from '../../constants/message-authors.js';
import { deriveTraceId } from '../../observability/pipeline-trace.js';
import { REALTIME_REASONS } from '../realtime/realtime.events.js';

const mocks = vi.hoisted(() => ({
  loadVisibleConversationForActor: vi.fn(),
  mergeConversationAiContext: vi.fn(),
  findConversationById: vi.fn(),
  updateAutomationState: vi.fn(),
  updateStage: vi.fn(),
  findMessagesByConversationCursor: vi.fn(),
  enqueueOutboundMessage: vi.fn(),
  createActivity: vi.fn(),
  enqueueConversationChanged: vi.fn(),
  sendLeadMessage: vi.fn(),
  classifyIntent: vi.fn(),
  setAiIntent: vi.fn(),
  sendOwnerDecision: vi.fn(),
  getOutcome: vi.fn(),
  generateProposal: vi.fn(),
  reviseProposal: vi.fn(),
  renderProposal: vi.fn(),
  buildAiBrainContext: vi.fn(),
  findPendingApprovalForConversation: vi.fn(),
  listPendingApprovals: vi.fn(),
  resolveApproval: vi.fn(),
  upsertPendingApproval: vi.fn(),
  getOrCreateAiSystemUser: vi.fn(),
  loadTemplateBase64ForCategory: vi.fn(),
  sendApprovalCard: vi.fn(),
  sendEscalationAlert: vi.fn(),
  recomputeLeadScore: vi.fn(),
}));

// Mutable so the pipeline-trace tests at the bottom can switch WHATSAPP_TRACE_ENABLED on for
// themselves; every other test in this file runs with it off, exactly like production default.
const envMock = vi.hoisted(() => ({ AI_BRAIN_ENABLED: true, WHATSAPP_TRACE_ENABLED: false }));

vi.mock('../../config/env.js', () => ({
  env: envMock,
}));

vi.mock('../../config/database.js', () => ({
  runInTransaction: (command: (session: undefined) => unknown) => command(undefined),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../conversations/conversation.service.js', () => ({
  loadVisibleConversationForActor: mocks.loadVisibleConversationForActor,
}));

vi.mock('../conversations/conversation.repository.js', () => ({
  AI_FACTS_PRECEDENCE: { STORED: 'stored', NEW_ANSWERS: 'new_answers' },
  mergeConversationAiContext: mocks.mergeConversationAiContext,
  findConversationById: mocks.findConversationById,
  updateAutomationState: mocks.updateAutomationState,
  setAiIntent: mocks.setAiIntent,
  updateStage: mocks.updateStage,
}));

vi.mock('../conversations/lead-score.service.js', () => ({
  recomputeLeadScore: mocks.recomputeLeadScore,
}));

vi.mock('../messages/message.repository.js', () => ({
  findMessagesByConversationCursor: mocks.findMessagesByConversationCursor,
}));

vi.mock('../messages/outbound-message.service.js', () => ({
  createOutboundMessageService: () => ({ enqueueOutboundMessage: mocks.enqueueOutboundMessage }),
}));

vi.mock('../activity/activity-log.repository.js', () => ({
  createActivity: mocks.createActivity,
}));

vi.mock('../realtime/realtime-outbox.repository.js', () => ({
  enqueueConversationChanged: mocks.enqueueConversationChanged,
}));

vi.mock('./ai-brain.client.js', () => ({
  sendLeadMessage: mocks.sendLeadMessage,
  classifyIntent: mocks.classifyIntent,
  sendOwnerDecision: mocks.sendOwnerDecision,
  getOutcome: mocks.getOutcome,
  generateProposal: mocks.generateProposal,
  reviseProposal: mocks.reviseProposal,
  renderProposal: mocks.renderProposal,
  AiBrainNotConfiguredError: class AiBrainNotConfiguredError extends Error {},
  AiBrainRequestError: class AiBrainRequestError extends Error {},
}));

vi.mock('./ai-brain-context.service.js', () => ({
  buildAiBrainContext: mocks.buildAiBrainContext,
}));

vi.mock('./ai-brain-approval.repository.js', () => ({
  findPendingApprovalForConversation: mocks.findPendingApprovalForConversation,
  listPendingApprovals: mocks.listPendingApprovals,
  resolveApproval: mocks.resolveApproval,
  upsertPendingApproval: mocks.upsertPendingApproval,
}));

vi.mock('./ai-brain-system-user.service.js', () => ({
  getOrCreateAiSystemUser: mocks.getOrCreateAiSystemUser,
}));

vi.mock('./proposal-templates.js', () => ({
  loadTemplateBase64ForCategory: mocks.loadTemplateBase64ForCategory,
}));

// The owner's WhatsApp cards are a real side effect of this module; mocked so the escalation
// tests below can assert the owner was actually told, without a running WhatsApp session.
vi.mock('./owner-approval-card.service.js', () => ({
  sendApprovalCard: mocks.sendApprovalCard,
  sendEscalationAlert: mocks.sendEscalationAlert,
}));

const {
  handleInboundMessageForAutomation,
  resolveApprovalForActor,
  setAutomationForActor,
  checkOutcomeForActor,
} = await import('./ai-brain.service.js');

const organizationId = 'org-1';
const conversationId = 'conv-1';

const baseConversation = () => ({
  _id: conversationId,
  organizationId,
  whatsappAccountId: 'account-1',
  assignedTo: 'user-1',
  displayName: 'Jane Lead',
  stage: CONVERSATION_STAGES.NEW,
  aiCategory: 'unknown',
  aiFacts: {},
});

const actor = { _id: 'user-1' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  // Re-set every call: mockClear keeps implementations, so a test that makes one of these
  // reject would otherwise leak into the next.
  mocks.mergeConversationAiContext.mockResolvedValue(null);
  // The intent gate sits in front of every inbound now. Defaulted to "yes, a customer" so the
  // tests written before it exists still describe what they were written to describe; the gate's
  // own behaviour is exercised in its own block at the bottom of this file.
  mocks.classifyIntent.mockResolvedValue({ intent: 'sales_lead', confidence: 0.9, reason: 'asked a price' });
  mocks.setAiIntent.mockResolvedValue(null);
  mocks.findMessagesByConversationCursor.mockResolvedValue([]);
  mocks.buildAiBrainContext.mockResolvedValue({
    requiredFields: [],
    catalogText: '(none)',
    knowledgeText: '(none)',
    rulesText: '(none)',
    serviceBrief: '(none)',
    styleExamples: '(none)',
  });
});

describe('handleInboundMessageForAutomation', () => {
  it('does nothing when the conversation has automation turned off', async () => {
    await handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: false } as never,
      inboundMessageId: 'msg-1',
      inboundText: 'hi',
    });

    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
  });

  it('does nothing when a draft is already pending for this conversation', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue({ _id: 'approval-1' });

    await handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: 'msg-1',
      inboundText: 'hi',
    });

    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
  });

  it('sends the qualifying question and moves stage to contacted on "asked"', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ASKED,
      message: 'What city are you in?',
      facts: { city: null },
      escalation_reason: '',
    });
    mocks.getOrCreateAiSystemUser.mockResolvedValue({ _id: 'ai-system-user' });

    await handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: 'msg-1',
      inboundText: 'Hi, I need photos',
    });

    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'What city are you in?',
        idempotencyKey: 'ai-brain-asked:msg-1',
        actor: { _id: 'ai-system-user' },
        // Not cosmetic bookkeeping: `authoredBy` is the ONLY thing that puts this message
        // behind the send-time guard stack in outbound-delivery.service.ts - the opt-out
        // re-check, the automation re-check, the staleness drop and quiet hours all live
        // inside `if (message.authoredBy === MESSAGE_AUTHORS.AI)`. Enqueue a qualifying
        // question as HUMAN and it goes out at 3 AM with none of them applied.
        authoredBy: MESSAGE_AUTHORS.AI,
      }),
    );
    expect(mocks.updateStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: CONVERSATION_STAGES.CONTACTED }),
    );
    expect(mocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: ACTIVITY_EVENTS.AI_BRAIN_MESSAGE_SENT }),
    );
  });

  it('writes everything the AI learned this turn onto the conversation', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ASKED,
      message: 'Great — and which venue?',
      facts: { event_type: 'Wedding', event_date: '12th September', city: 'Whitefield' },
      escalation_reason: '',
    });
    mocks.getOrCreateAiSystemUser.mockResolvedValue({ _id: 'ai-system-user' });

    await handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: 'msg-1',
      inboundText: 'The wedding is on 12th September in Whitefield',
    });

    // Not just the date: a venue given in chat used to be dropped on the floor, so the AI asked
    // for it again next turn. The merge also refreshes the typed `eventDate` column from the
    // merged blob, which is why nothing lifts the date out separately any more.
    expect(mocks.mergeConversationAiContext).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        conversationId: 'conv-1',
        facts: { event_type: 'Wedding', event_date: '12th September', city: 'Whitefield' },
        factsPrecedence: 'new_answers',
      }),
    );
  });

  it('merges the learned facts before rescoring, so the score reads the stored blob', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ASKED,
      message: 'Which venue is it at?',
      facts: { city: 'Whitefield' },
      escalation_reason: '',
    });
    mocks.getOrCreateAiSystemUser.mockResolvedValue({ _id: 'ai-system-user' });

    await handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: 'msg-1',
      inboundText: 'Whitefield',
    });

    expect(mocks.mergeConversationAiContext.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.recomputeLeadScore.mock.invocationCallOrder[0]!,
    );
  });

  it('still sends the owner their approval card when the facts write fails', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.mergeConversationAiContext.mockRejectedValue(new Error('mongo is having a day'));
    mocks.upsertPendingApproval.mockResolvedValue({ _id: 'approval-9', code: 'A1B2' });
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.AWAITING_APPROVAL,
      message: 'Here are two options...',
      facts: { city: 'Whitefield' },
      escalation_reason: '',
    });

    await handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: 'msg-1',
      inboundText: 'What would it cost?',
    });

    // A lost fact comes back next turn; a lost approval card leaves a lead waiting on a person
    // who never learned they were needed.
    expect(mocks.sendApprovalCard).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'approval-9' }),
    );
  });

  it('opens a pending approval and pings realtime on "awaiting_approval"', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.AWAITING_APPROVAL,
      message: 'Here is a quote for you...',
      facts: { city: 'Pune' },
      escalation_reason: '',
    });

    await handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: 'msg-2',
      inboundText: 'What is the price?',
    });

    expect(mocks.upsertPendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({ draft: 'Here is a quote for you...', facts: { city: 'Pune' } }),
    );
    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(mocks.enqueueConversationChanged).toHaveBeenCalledWith(
      expect.objectContaining({ reason: REALTIME_REASONS.AI_PENDING }),
    );
  });

  it('turns automation off and logs why on "escalated"', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ESCALATED,
      message: '',
      facts: {},
      escalation_reason: 'Lead is angry, needs a human.',
    });

    await handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: 'msg-3',
      inboundText: 'This is unacceptable!',
    });

    expect(mocks.updateAutomationState).toHaveBeenCalledWith(
      expect.objectContaining({
        aiAutomationEnabled: false,
        aiAutomationPausedReason: 'Lead is angry, needs a human.',
      }),
    );
  });

  it('rescores the lead with the facts the AI just learned', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ASKED,
      message: 'Which venue is it at?',
      facts: { event_date: '12 September 2026', city: 'Whitefield' },
    });

    await handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: 'msg-4',
      inboundText: 'It is on 12 September in Whitefield',
    });

    // No second copy of the facts: they are on the conversation by now, and recomputeLeadScore
    // re-reads it. The `facts` workaround that used to be needed here is gone.
    expect(mocks.recomputeLeadScore).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, conversationId: 'conv-1' }),
    );
    expect(mocks.recomputeLeadScore.mock.calls[0]![0]).not.toHaveProperty('facts');
  });

  it('alerts the owner as well as pausing on "escalated"', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ESCALATED,
      message: '',
      facts: {},
      escalation_reason: 'Lead is angry, needs a human.',
    });

    await handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: 'msg-3',
      inboundText: 'This is unacceptable!',
    });

    expect(mocks.sendEscalationAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Lead is angry, needs a human.' }),
    );
  });

  it('never throws when ai-brain-service is unreachable', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.sendLeadMessage.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      handleInboundMessageForAutomation({
        organizationId,
        conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
        inboundMessageId: 'msg-4',
        inboundText: 'hello?',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('handleInboundMessageForAutomation - media the AI cannot read', () => {
  const runWith = (params: Record<string, unknown>) =>
    handleInboundMessageForAutomation({
      organizationId,
      // aiIntent is what now gates the escalation: paging the owner is right for a thread that
      // has already asked about a shoot, and wrong for a stranger whose promo blast is images.
      conversation: { ...baseConversation(), aiAutomationEnabled: true, aiIntent: 'sales_lead' } as never,
      inboundMessageId: 'msg-media',
      ...params,
    } as never);

  beforeEach(() => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
  });

  it('escalates a voice note to the owner instead of asking the AI about an empty string', async () => {
    await runWith({ inboundText: '', messageType: 'audio', isVoiceNote: true });

    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
    expect(mocks.updateAutomationState).toHaveBeenCalledWith(
      expect.objectContaining({
        aiAutomationEnabled: false,
        aiAutomationPausedReason: expect.stringContaining('voice note'),
      }),
    );
    expect(mocks.sendEscalationAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        leadDisplayName: 'Jane Lead',
        reason: expect.stringContaining('voice note'),
      }),
    );
    expect(mocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: ACTIVITY_EVENTS.AI_BRAIN_ESCALATED }),
    );
    expect(mocks.enqueueConversationChanged).toHaveBeenCalledWith(
      expect.objectContaining({ reason: REALTIME_REASONS.AI_PENDING }),
    );
  });

  it('escalates uncaptioned media, saying what kind arrived', async () => {
    await runWith({ inboundText: '', messageType: 'image', isVoiceNote: false });

    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
    expect(mocks.sendEscalationAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('📷 Photo') }),
    );
  });

  it('escalates an uncaptioned document too', async () => {
    await runWith({ inboundText: '   ', messageType: 'document', isVoiceNote: false });

    expect(mocks.sendEscalationAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('📎 Document') }),
    );
  });

  it('proceeds normally on a captioned image, using the caption', async () => {
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ASKED,
      message: 'Lovely venue! What date is the function?',
      facts: {},
      escalation_reason: '',
    });
    mocks.getOrCreateAiSystemUser.mockResolvedValue({ _id: 'ai-system-user' });

    await runWith({
      inboundText: 'This is the venue',
      messageType: 'image',
      isVoiceNote: false,
    });

    expect(mocks.sendLeadMessage).toHaveBeenCalledWith(
      conversationId,
      expect.objectContaining({ text: 'This is the venue' }),
    );
    expect(mocks.sendEscalationAlert).not.toHaveBeenCalled();
  });

  it('says nothing about an empty text message, and does not page the owner either', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and that is how the production incident got
    // through code review: it required `sendLeadMessage` to be called for a TEXT message with
    // an empty body. The intent was benign - WhatsApp delivers protocol and reaction nodes that
    // resolve to TEXT with no body, and escalating those would page the owner about plumbing.
    // But a marketing `templateMessage` and a bot `listMessage` land in the same shape, because
    // the Baileys extractor cannot read their bodies either. So this assertion was a standing
    // instruction to hand the brain an empty string, which it answered with the studio's
    // introduction. Fifty times, after one reconnect replayed months of history.
    //
    // Both halves of the original intent still hold - no owner alert for invisible plumbing -
    // but the AI now says nothing at all.
    mocks.getOrCreateAiSystemUser.mockResolvedValue({ _id: 'ai-system-user' });

    await runWith({ inboundText: '', messageType: 'text', isVoiceNote: false });

    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(mocks.sendEscalationAlert).not.toHaveBeenCalled();
    expect(mocks.updateAutomationState).not.toHaveBeenCalled();
  });
});
describe('resolveApprovalForActor', () => {
  it('sends the message and resolves the approval on "sent"', async () => {
    mocks.loadVisibleConversationForActor.mockResolvedValue(baseConversation());
    mocks.findPendingApprovalForConversation.mockResolvedValue({ _id: 'approval-1' });
    mocks.sendOwnerDecision.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.SENT,
      message: 'Approved reply text',
      facts: {},
      escalation_reason: '',
    });
    mocks.resolveApproval.mockResolvedValue({ _id: 'approval-1', status: 'resolved' });

    const result = await resolveApprovalForActor({
      organizationId,
      conversationId,
      permissions: [],
      actor,
      verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE,
    });

    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Approved reply text',
        idempotencyKey: 'ai-brain-approved:approval-1',
        // An owner-approved draft is still AI-authored, so it still waits for the quiet-hours
        // window to close rather than going out the moment the owner taps approve at 2 AM.
        authoredBy: MESSAGE_AUTHORS.AI,
      }),
    );
    expect(result.sent).toBe(true);
  });

  it('updates the same pending draft in place on an "edit"', async () => {
    mocks.loadVisibleConversationForActor.mockResolvedValue(baseConversation());
    mocks.findPendingApprovalForConversation.mockResolvedValue({ _id: 'approval-1' });
    mocks.sendOwnerDecision.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.AWAITING_APPROVAL,
      message: 'Revised reply text',
      facts: {},
      escalation_reason: '',
    });
    mocks.upsertPendingApproval.mockResolvedValue({ _id: 'approval-1', status: 'pending' });

    const result = await resolveApprovalForActor({
      organizationId,
      conversationId,
      permissions: [],
      actor,
      verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.EDIT,
      instruction: 'make it shorter',
    });

    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(mocks.resolveApproval).not.toHaveBeenCalled();
    expect(result.sent).toBe(false);
  });

  it('throws AI_BRAIN_APPROVAL_NOT_FOUND when nothing is pending', async () => {
    mocks.loadVisibleConversationForActor.mockResolvedValue(baseConversation());
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);

    await expect(
      resolveApprovalForActor({
        organizationId,
        conversationId,
        permissions: [],
        actor,
        verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE,
      }),
    ).rejects.toThrow('AI_BRAIN_APPROVAL_NOT_FOUND');
  });
});

describe('setAutomationForActor', () => {
  it('flips the flag and logs it', async () => {
    mocks.loadVisibleConversationForActor.mockResolvedValue(baseConversation());
    mocks.updateAutomationState.mockResolvedValue({ ...baseConversation(), aiAutomationEnabled: true });

    await setAutomationForActor({
      organizationId,
      conversationId,
      permissions: [],
      actor,
      enabled: true,
    });

    expect(mocks.updateAutomationState).toHaveBeenCalledWith(
      expect.objectContaining({ aiAutomationEnabled: true, aiAutomationPausedReason: null }),
    );
    expect(mocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: ACTIVITY_EVENTS.AI_BRAIN_AUTOMATION_TOGGLED }),
    );
  });
});

describe('checkOutcomeForActor', () => {
  it('moves the conversation to won and pings realtime', async () => {
    mocks.loadVisibleConversationForActor.mockResolvedValue(baseConversation());
    mocks.findMessagesByConversationCursor.mockResolvedValue([]);
    mocks.getOutcome.mockResolvedValue({ decision: 'won', message: '', reasoning: 'client confirmed booking' });

    const outcome = await checkOutcomeForActor({
      organizationId,
      conversationId,
      permissions: [],
      actor,
    });

    expect(outcome.decision).toBe('won');
    expect(mocks.updateStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: CONVERSATION_STAGES.WON }),
    );
    expect(mocks.enqueueConversationChanged).toHaveBeenCalledWith(
      expect.objectContaining({ reason: REALTIME_REASONS.STAGE }),
    );
  });
});

describe('handleInboundMessageForAutomation - the pipeline trace (stages 10-12)', () => {
  let lines: string[];
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lines = [];
    envMock.WHATSAPP_TRACE_ENABLED = true;
    consoleLog = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  });

  afterEach(() => {
    envMock.WHATSAPP_TRACE_ENABLED = false;
    consoleLog.mockRestore();
  });

  const run = (conversation: Record<string, unknown> = {}) =>
    handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true, ...conversation } as never,
      inboundMessageId: 'msg-1',
      inboundText: 'do you shoot house-warmings?',
      traceId: 'abcd1234',
    });

  it('names AI_BRAIN_ENABLED as the thing that stopped the message', async () => {
    envMock.AI_BRAIN_ENABLED = false;

    await run();

    envMock.AI_BRAIN_ENABLED = true;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('10/13');
    expect(lines[0]).toContain('STOPPED');
    expect(lines[0]).toContain('AI_BRAIN_ENABLED is false');
  });

  it('quotes the pause reason when automation is off for this one conversation', async () => {
    await run({
      aiAutomationEnabled: false,
      aiAutomationPausedReason: 'You replied here, so the AI stepped back.',
    });

    expect(lines[0]).toContain('STOPPED');
    expect(lines[0]).toContain('You replied here');
  });

  it('says a draft is already waiting rather than going quiet', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue({ _id: 'approval-1' });

    await run();

    expect(lines.at(-1)).toContain('STOPPED');
    expect(lines.at(-1)).toContain('already waiting for your approval');
  });

  it('says the AI cannot hear a voice note, on the same line that pauses the conversation', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.updateAutomationState.mockResolvedValue(null);

    await handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true, aiIntent: 'sales_lead' } as never,
      inboundMessageId: 'msg-1',
      inboundText: '',
      messageType: 'audio' as never,
      isVoiceNote: true,
      traceId: 'abcd1234',
    });

    expect(lines[0]).toContain('STOPPED');
    expect(lines[0]).toContain("can't listen to it");
  });

  it('reports the context it assembled and the decision the brain returned, with a latency', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.buildAiBrainContext.mockResolvedValue({
      requiredFields: ['event_date', 'city'],
      catalogText: '(none)',
      knowledgeText: '- Company: we shoot weddings',
      rulesText: '(none)',
      serviceBrief: '(none)',
      styleExamples: '(none)',
    });
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.AWAITING_APPROVAL,
      message: 'Happy to help - what date is it?',
      facts: {},
      escalation_reason: '',
    });
    mocks.upsertPendingApproval.mockResolvedValue(null);

    await run({ aiCategory: 'wedding', aiFacts: { city: 'Bangalore' } });

    const context = lines.find((line) => line.includes('11/13'));
    const decision = lines.find((line) => line.includes('12/13'));

    expect(context).toContain('category=wedding');
    expect(context).toContain('playbook=wedding');
    expect(context).toContain('facts=1');
    expect(context).toContain('knowledgeBase=found');
    expect(decision).toContain('decision=awaiting_approval');
    expect(decision).toMatch(/ms=\d+/);
  });

  it('prints the outbound correlation id on an "asked" decision, so the two halves join up', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ASKED,
      message: 'What city are you in?',
      facts: {},
      escalation_reason: '',
    });
    mocks.getOrCreateAiSystemUser.mockResolvedValue({ _id: 'ai-system-user' });

    await run();

    expect(lines.find((line) => line.includes('12/13'))).toContain(
      `outbound=${deriveTraceId('ai-brain-asked:msg-1')}`,
    );
  });

  it('reports a brain call that threw, with how long it burned first', async () => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.sendLeadMessage.mockRejectedValue(new Error('brain unreachable'));

    await run();

    const failure = lines.find((line) => line.includes('FAILED'));
    expect(failure).toContain('12/13');
    expect(failure).toContain('brain unreachable');
    expect(failure).toMatch(/ms=\d+/);
  });

  it('uses the correlation id ingestion handed over, not one of its own', async () => {
    await run({ aiAutomationEnabled: false });

    expect(lines[0]).toContain('[wa abcd1234]');
  });

  it('writes nothing at all while WHATSAPP_TRACE_ENABLED is off', async () => {
    envMock.WHATSAPP_TRACE_ENABLED = false;

    await run({ aiAutomationEnabled: false });

    expect(lines).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// The service-enquiry gate, as the brain applies it.
//
// ai-eligibility.test.ts covers the decision itself. What these cover is the consequence, and
// the consequence changed: a non-enquiry used to pause automation and ring the owner's phone.
// It must now do NEITHER, because a conversation that has been paused cannot answer the real
// enquiry that follows a minute later - which is exactly what happened in production when a
// "hi" and a bank alert silenced threads for good.
// --------------------------------------------------------------------------
describe('handleInboundMessageForAutomation - the service-enquiry gate', () => {
  const runWith = (inboundText: string) =>
    handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: 'msg-gate',
      inboundText,
    } as never);

  beforeEach(() => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
  });

  it.each(['non_lead', 'unclear'])('says nothing at all when the verdict is %s', async (intent) => {
    mocks.classifyIntent.mockResolvedValue({ intent, confidence: 0.9, reason: 'because' });

    await runWith('Your membership has been renewed for October');

    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
  });

  it.each(['non_lead', 'unclear'])('leaves automation ON after a %s verdict', async (intent) => {
    mocks.classifyIntent.mockResolvedValue({ intent, confidence: 0.9, reason: 'because' });

    await runWith('Buy 2 formal pants and save 10%');

    // THE REGRESSION THAT MATTERS. Pausing here is what stopped the next real enquiry landing.
    expect(mocks.updateAutomationState).not.toHaveBeenCalled();
  });

  it('does not alert the owner about an ordinary non-lead', async () => {
    mocks.classifyIntent.mockResolvedValue({ intent: 'non_lead', confidence: 0.9, reason: '' });

    await runWith('Your OTP is 123456');

    // One of these per promo blast would train the owner to ignore the alerts that matter.
    expect(mocks.sendEscalationAlert).not.toHaveBeenCalled();
    expect(mocks.createActivity).not.toHaveBeenCalled();
  });

  it('creates no draft, no approval and no follow-up', async () => {
    mocks.classifyIntent.mockResolvedValue({ intent: 'non_lead', confidence: 0.9, reason: '' });

    await runWith('Join our webinar at 11 AM');

    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
  });

  it('still records the verdict, so the dashboard can show what it made of the thread', async () => {
    mocks.classifyIntent.mockResolvedValue({ intent: 'non_lead', confidence: 0.9, reason: '' });

    await runWith('Your invoice is ready');

    expect(mocks.setAiIntent).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'non_lead' }),
    );
  });

  it('answers a genuine enquiry', async () => {
    mocks.classifyIntent.mockResolvedValue({ intent: 'sales_lead', confidence: 0.95, reason: '' });
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ASKED,
      message: 'What date is the wedding?',
      facts: {},
      escalation_reason: '',
    });
    mocks.getOrCreateAiSystemUser.mockResolvedValue({ _id: 'ai-system-user' });

    await runWith('How much for wedding photography?');

    expect(mocks.sendLeadMessage).toHaveBeenCalled();
    expect(mocks.enqueueOutboundMessage).toHaveBeenCalled();
  });
});

describe('handleInboundMessageForAutomation - the gate fails closed', () => {
  const runWith = (inboundText: string) =>
    handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: 'msg-closed',
      inboundText,
    } as never);

  beforeEach(() => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
  });

  it.each([
    ['the request times out', () => mocks.classifyIntent.mockRejectedValue(new Error('ETIMEDOUT'))],
    ['the service returns 500', () => mocks.classifyIntent.mockRejectedValue(new Error('AI_BRAIN_REQUEST_FAILED'))],
    ['the verdict is invented', () => mocks.classifyIntent.mockResolvedValue({ intent: 'probably' })],
    ['there is no verdict at all', () => mocks.classifyIntent.mockResolvedValue({})],
    ['the response is null', () => mocks.classifyIntent.mockResolvedValue(null)],
  ])('stays silent when %s', async (_label, arrange) => {
    arrange();

    await runWith('How much?');

    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
    // Silent, but still not paused: the next message deserves a working classifier.
    expect(mocks.updateAutomationState).not.toHaveBeenCalled();
  });

  it('does not brand the conversation when the classifier was simply unreachable', async () => {
    mocks.classifyIntent.mockRejectedValue(new Error('ETIMEDOUT'));

    await runWith('How much?');

    expect(mocks.setAiIntent).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// The two bypasses that used to exist, and why only one of them survives.
// --------------------------------------------------------------------------
describe('handleInboundMessageForAutomation - what may skip the gate', () => {
  beforeEach(() => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
  });

  const runWith = (conversation: Record<string, unknown>, inboundText: string, ownerInstruction = '') =>
    handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true, ...conversation } as never,
      inboundMessageId: 'msg-bypass',
      inboundText,
      ownerInstruction,
    } as never);

  it('classifies a lead-source conversation like any other', async () => {
    // A lead source means the PERSON may be a customer. It says nothing about THIS message, and
    // a Meta lead whose number also carries their bank's alerts must not be answered for one.
    mocks.classifyIntent.mockResolvedValue({ intent: 'non_lead', confidence: 0.9, reason: '' });

    await runWith({ leadSourceId: 'src-1' }, 'Your subscription renewal is due');

    expect(mocks.classifyIntent).toHaveBeenCalled();
    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
  });

  it('classifies a human-added lead like any other', async () => {
    mocks.classifyIntent.mockResolvedValue({ intent: 'non_lead', confidence: 0.9, reason: '' });

    await runWith({ manualOutreachApprovedAt: new Date() }, 'Payment successful');

    expect(mocks.classifyIntent).toHaveBeenCalled();
    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
  });

  it('re-classifies a thread already known to be a sales lead', async () => {
    // Yesterday's enquiry is not a licence for today's invoice.
    mocks.classifyIntent.mockResolvedValue({ intent: 'non_lead', confidence: 0.9, reason: '' });

    await runWith({ aiIntent: 'sales_lead' }, 'Please share the renewal documents by Friday');

    expect(mocks.classifyIntent).toHaveBeenCalled();
    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
  });

  it('obeys an owner instruction without consulting the classifier', async () => {
    // The surviving bypass: a human, or the imported-lead greeting job, directing the AI. This
    // is what keeps auto-greet and "resume with an instruction" working - both arrive with an
    // empty inboundText and an instruction, and neither is a customer message.
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ASKED,
      message: 'Hi! Thanks for enquiring about the wedding package.',
      facts: {},
      escalation_reason: '',
    });
    mocks.getOrCreateAiSystemUser.mockResolvedValue({ _id: 'ai-system-user' });

    await runWith({ leadSourceId: 'src-1' }, '', 'Greet this imported lead from the wedding form.');

    expect(mocks.classifyIntent).not.toHaveBeenCalled();
    expect(mocks.sendLeadMessage).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// The exact production sequence. Both halves have to hold or the fix is worthless: the first
// message must be ignored, and the second must still be answered.
// --------------------------------------------------------------------------
describe('handleInboundMessageForAutomation - ignored now, served later', () => {
  beforeEach(() => {
    mocks.findPendingApprovalForConversation.mockResolvedValue(null);
    mocks.getOrCreateAiSystemUser.mockResolvedValue({ _id: 'ai-system-user' });
  });

  const run = (inboundText: string, id: string) =>
    handleInboundMessageForAutomation({
      organizationId,
      conversation: { ...baseConversation(), aiAutomationEnabled: true } as never,
      inboundMessageId: id,
      inboundText,
    } as never);

  it('ignores "Hi" and then answers "I need a wedding photographer for December"', async () => {
    mocks.classifyIntent.mockResolvedValue({ intent: 'unclear', confidence: 0.4, reason: '' });

    await run('Hi', 'msg-1');

    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
    expect(mocks.updateAutomationState).not.toHaveBeenCalled();

    mocks.classifyIntent.mockResolvedValue({ intent: 'sales_lead', confidence: 0.95, reason: '' });
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ASKED,
      message: 'Congratulations! Which date in December?',
      facts: {},
      escalation_reason: '',
    });

    await run('I need a wedding photographer for December', 'msg-2');

    expect(mocks.sendLeadMessage).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueOutboundMessage).toHaveBeenCalled();
  });

  it('ignores a renewal notice and then answers the enquiry that follows it', async () => {
    mocks.classifyIntent.mockResolvedValue({ intent: 'non_lead', confidence: 0.95, reason: '' });

    await run('Your subscription has been renewed', 'msg-3');

    expect(mocks.sendLeadMessage).not.toHaveBeenCalled();
    expect(mocks.updateAutomationState).not.toHaveBeenCalled();

    mocks.classifyIntent.mockResolvedValue({ intent: 'sales_lead', confidence: 0.95, reason: '' });
    mocks.sendLeadMessage.mockResolvedValue({
      status: AI_BRAIN_RESULT_STATUSES.ASKED,
      message: 'Happy to help - what date?',
      facts: {},
      escalation_reason: '',
    });

    await run('Actually I need a photographer for my wedding', 'msg-4');

    expect(mocks.sendLeadMessage).toHaveBeenCalledTimes(1);
  });
});
