/**
 * Orchestrates ai-brain-service on wam-crm-ai's side: what gets sent automatically, what waits
 * for a human, and what moves a conversation's stage. ai-brain-service only ever answers "given
 * this, what next" - every side effect (sending, logging, changing a stage) happens here.
 */
import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import {
  AI_BRAIN_APPROVAL_RESOLUTIONS,
  AI_BRAIN_RESULT_STATUSES,
  type AiBrainApprovalResolution,
} from '../../constants/ai-brain-statuses.js';
import { CONVERSATION_STAGES } from '../../constants/conversation-stages.js';
import { MESSAGE_AUTHORS } from '../../constants/message-authors.js';
import { MESSAGE_DIRECTIONS } from '../../constants/message-directions.js';
import { MESSAGE_TYPES, type MessageType } from '../../constants/message-types.js';
import { PERMISSIONS, type Permission } from '../../constants/permissions.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { runInTransaction } from '../../config/database.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity } from '../activity/activity-log.repository.js';
import { loadVisibleConversationForActor } from '../conversations/conversation.service.js';
import { type ConversationDocument } from '../conversations/conversation.model.js';
import {
  AI_FACTS_PRECEDENCE,
  findConversationById,
  mergeConversationAiContext,
  updateAutomationState,
  updateStage as updateConversationStage,
} from '../conversations/conversation.repository.js';
import { recomputeLeadScore } from '../conversations/lead-score.service.js';
import { describeMediaMessage } from '../messages/message-media-labels.js';
import { findMessagesByConversationCursor } from '../messages/message.repository.js';
import { createOutboundMessageService } from '../messages/outbound-message.service.js';
import { REALTIME_REASONS } from '../realtime/realtime.events.js';
import { enqueueConversationChanged } from '../realtime/realtime-outbox.repository.js';
import { type UserDocument } from '../users/user.model.js';
import * as aiBrainClient from './ai-brain.client.js';
import { type AiBrainProposalContent } from './ai-brain.client.js';
import { buildAiBrainContext } from './ai-brain-context.service.js';
import { buildTranscript } from './ai-brain-transcript.js';
import {
  findPendingApprovalForConversation,
  listPendingApprovals,
  resolveApproval,
  upsertPendingApproval,
} from './ai-brain-approval.repository.js';
import { type AiBrainApprovalDocument } from './ai-brain-approval.model.js';
import { serializeAiBrainApproval } from './ai-brain-approval.serializer.js';
import { getOrCreateAiSystemUser } from './ai-brain-system-user.service.js';
import { sendApprovalCard, sendEscalationAlert } from './owner-approval-card.service.js';
import { loadTemplateBase64ForCategory } from './proposal-templates.js';

const outboundMessageService = createOutboundMessageService();

const conversationDoc = (
  conversation: ConversationDocument,
): Record<string, unknown> & { _id: ObjectIdLike; organizationId: ObjectIdLike } =>
  conversation as unknown as Record<string, unknown> & {
    _id: ObjectIdLike;
    organizationId: ObjectIdLike;
  };

// --------------------------------------------------------------------------
// A lead's WhatsApp message arrived. If this conversation has automation on, let ai-brain-
// service decide what happens next. Never throws - a broken or unreachable AI service must
// never stop a message from being received and shown to the team.
// --------------------------------------------------------------------------
export interface HandleInboundForAutomationParams {
  organizationId: ObjectIdLike;
  conversation: HydratedDocument<ConversationDocument>;
  inboundMessageId: ObjectIdLike;
  inboundText: string;
  /** What kind of message arrived. Absent (or `text`) behaves exactly as it did before media. */
  messageType?: MessageType;
  /** True for a recorded voice note - the one media kind the AI cannot ever be given. */
  isVoiceNote?: boolean;
}

/**
 * Why the AI stopped, in the owner's words, when a lead sent something it cannot read. A voice
 * note is called out on its own because it is the common case and because "we can't hear it" is
 * the thing the owner needs to understand - transcription is deliberately not attempted here.
 */
export const buildUnreadableMediaReason = ({
  messageType,
  isVoiceNote,
}: {
  messageType?: MessageType;
  isVoiceNote?: boolean;
}): string => {
  if (isVoiceNote) {
    return "They sent a voice note, and the AI can't listen to it.";
  }

  const label = describeMediaMessage({ type: messageType, isVoiceNote }) ?? 'An attachment';

  return `They sent ${label} with nothing written with it, and the AI can't open it.`;
};

export const handleInboundMessageForAutomation = async ({
  organizationId,
  conversation,
  inboundMessageId,
  inboundText,
  messageType,
  isVoiceNote,
}: HandleInboundForAutomationParams): Promise<void> => {
  if (!env.AI_BRAIN_ENABLED || !conversation.aiAutomationEnabled) {
    return;
  }

  try {
    const alreadyPending = await findPendingApprovalForConversation({
      organizationId,
      conversationId: conversation._id,
    });

    // A draft is already waiting on a human for this conversation - the lead sent another
    // message before it was actioned. Don't run the graph again underneath a live approval.
    if (alreadyPending) {
      return;
    }

    // A photo, a voice note, or a PDF with no caption: there is no text to reason about, and
    // handing ai-brain-service an empty string is exactly what makes the agent chirp back as
    // though the lead said nothing - the single worst response to someone who just sent their
    // venue photos. Escalate to a human instead, on the same path (pause + owner alert) the AI's
    // own ESCALATED verdict takes below. A captioned image needs none of this: the caption is
    // real text and the conversation carries on normally.
    if (
      messageType !== undefined &&
      messageType !== MESSAGE_TYPES.TEXT &&
      (inboundText ?? '').trim() === ''
    ) {
      const reason = buildUnreadableMediaReason({ messageType, isVoiceNote });
      const doc = conversationDoc(conversation);

      await runInTransaction(async (session) => {
        await updateAutomationState({
          conversationId: doc._id,
          organizationId,
          aiAutomationEnabled: false,
          aiAutomationPausedReason: reason,
          session,
        });

        await createActivity({
          organizationId,
          whatsappAccountId: conversation.whatsappAccountId,
          conversationId: conversation._id,
          eventType: ACTIVITY_EVENTS.AI_BRAIN_ESCALATED,
          summary: `AI paused automation for this conversation: ${reason}`,
          metadata: { escalationReason: reason, messageType, isVoiceNote: Boolean(isVoiceNote) },
          session,
        });

        await enqueueConversationChanged({
          organizationId,
          conversationId: conversation._id,
          assignedTo: conversation.assignedTo,
          reason: REALTIME_REASONS.AI_PENDING,
          session,
        });
      });

      await sendEscalationAlert({
        organizationId,
        accountId: conversation.whatsappAccountId,
        conversationId: conversation._id,
        leadDisplayName: conversation.displayName,
        reason,
        lastLeadMessage: null,
      });

      return;
    }

    const context = await buildAiBrainContext({ organizationId, category: conversation.aiCategory });

    const result = await aiBrainClient.sendLeadMessage(conversation._id.toString(), {
      text: inboundText,
      category: conversation.aiCategory,
      facts: conversation.aiFacts ?? {},
      requiredFields: context.requiredFields,
      catalogText: context.catalogText,
      knowledgeText: context.knowledgeText,
      rulesText: context.rulesText,
      serviceBrief: context.serviceBrief,
      styleExamples: context.styleExamples,
    });

    let escalated = false;

    const newlyPendingApproval: AiBrainApprovalDocument | null = await runInTransaction<AiBrainApprovalDocument | null>(async (session) => {
      const doc = conversationDoc(conversation);

      switch (result.status) {
        case AI_BRAIN_RESULT_STATUSES.ASKED: {
          const systemUser = await getOrCreateAiSystemUser({ organizationId });

          await outboundMessageService.enqueueOutboundMessage({
            organizationId,
            conversation,
            actor: systemUser as HydratedDocument<UserDocument>,
            body: result.message,
            idempotencyKey: `ai-brain-asked:${inboundMessageId.toString()}`,
            authoredBy: MESSAGE_AUTHORS.AI,
          });

          if (conversation.stage === CONVERSATION_STAGES.NEW) {
            await updateConversationStage({
              conversationId: doc._id,
              organizationId,
              stage: CONVERSATION_STAGES.CONTACTED,
              session,
            });
          }

          await createActivity({
            organizationId,
            whatsappAccountId: conversation.whatsappAccountId,
            conversationId: conversation._id,
            eventType: ACTIVITY_EVENTS.AI_BRAIN_MESSAGE_SENT,
            summary: 'AI asked a qualifying question.',
            metadata: { facts: result.facts },
            session,
          });
          return null;
        }

        case AI_BRAIN_RESULT_STATUSES.AWAITING_APPROVAL: {
          const pendingApproval = await upsertPendingApproval({
            organizationId,
            conversationId: conversation._id,
            draft: result.message,
            facts: result.facts,
            session,
          });

          await createActivity({
            organizationId,
            whatsappAccountId: conversation.whatsappAccountId,
            conversationId: conversation._id,
            eventType: ACTIVITY_EVENTS.AI_BRAIN_APPROVAL_PENDING,
            summary: 'AI drafted a reply and is waiting for approval.',
            metadata: {},
            session,
          });

          await enqueueConversationChanged({
            organizationId,
            conversationId: conversation._id,
            assignedTo: conversation.assignedTo,
            reason: REALTIME_REASONS.AI_PENDING,
            session,
          });
          return pendingApproval;
        }

        case AI_BRAIN_RESULT_STATUSES.ESCALATED: {
          escalated = true;

          await updateAutomationState({
            conversationId: doc._id,
            organizationId,
            aiAutomationEnabled: false,
            aiAutomationPausedReason: result.escalation_reason || 'Escalated by the AI.',
            session,
          });

          await createActivity({
            organizationId,
            whatsappAccountId: conversation.whatsappAccountId,
            conversationId: conversation._id,
            eventType: ACTIVITY_EVENTS.AI_BRAIN_ESCALATED,
            summary: `AI paused automation for this conversation: ${result.escalation_reason || 'needs a human'}.`,
            metadata: { escalationReason: result.escalation_reason },
            session,
          });

          await enqueueConversationChanged({
            organizationId,
            conversationId: conversation._id,
            assignedTo: conversation.assignedTo,
            reason: REALTIME_REASONS.AI_PENDING,
            session,
          });
          return null;
        }

        default:
          return null;
      }
    });

    // EVERYTHING the AI just learned goes onto the conversation, not only the date in it.
    //
    // A venue or a budget given in chat used to be thrown away here - `Conversation.aiFacts` was
    // only ever written by the two form-import routes - so the AI re-asked next turn, the lead
    // score never saw it, and the owner's lead panel stayed blank. One merge fixes all three.
    //
    // NEW_ANSWERS precedence, not the form routes' gap-filling: this is the newest thing anyone
    // knows about the lead, so a real answer overwrites a stored "not decided yet" (and a stale
    // answer the lead has since corrected), while an incoming non-answer never erases an answer.
    // See AI_FACTS_PRECEDENCE. The merge also refreshes the typed `eventDate` column from the
    // MERGED blob, which is why the qualifying loop no longer lifts the date out itself.
    //
    // After the transaction, deliberately: the turn's own bookkeeping is what must be atomic,
    // and failure-isolated for the same reason recomputeLeadScore is - the owner's approval card
    // below is worth more than a facts write, and a lost fact comes back on the next turn.
    try {
      await mergeConversationAiContext({
        conversationId: conversation._id,
        organizationId,
        facts: result.facts,
        factsPrecedence: AI_FACTS_PRECEDENCE.NEW_ANSWERS,
      });
    } catch (error: unknown) {
      logger.error(
        { err: error, conversationId: conversation._id.toString() },
        'Could not persist the facts the AI learned this turn; the conversation keeps the facts it had.',
      );
    }

    // Those answers are the score's raw material, and they are on the conversation now - so the
    // score is recomputed from the stored blob rather than being handed a second copy of them.
    // recomputeLeadScore never throws and is guarded by this function's own catch besides; a
    // score is never worth an unhandled AI turn.
    await recomputeLeadScore({
      organizationId,
      conversationId: conversation._id,
      whatsappAccountId: conversation.whatsappAccountId,
    });

    // Fires the owner's WhatsApp approval card once the transaction that created the pending
    // approval has actually committed. sendApprovalCard is internally failure-isolated (never
    // throws), so a WhatsApp send failure here (e.g. no running session yet) never undoes any of
    // the above or stops the dashboard-side approval flow from working.
    if (newlyPendingApproval?.code) {
      await sendApprovalCard({
        organizationId,
        accountId: conversation.whatsappAccountId,
        conversationId: conversation._id,
        approvalId: newlyPendingApproval._id,
        draft: result.message,
        leadDisplayName: conversation.displayName,
        code: newlyPendingApproval.code,
      });
    }

    // An escalation that only switches automation off is a silent one: the lead is sitting there
    // waiting - usually on a question about money - and nobody learns of it until someone happens
    // to open the dashboard. Tell the owner on the phone they actually have on them. Same
    // failure-isolated contract as the approval card above: it never throws, and the pause stands
    // whether or not the message gets out.
    if (escalated) {
      await sendEscalationAlert({
        organizationId,
        accountId: conversation.whatsappAccountId,
        conversationId: conversation._id,
        leadDisplayName: conversation.displayName,
        reason: result.escalation_reason || 'The AI needs a person on this.',
        lastLeadMessage: inboundText,
      });
    }
  } catch (error: unknown) {
    logger.error(
      { err: error, conversationId: conversation._id.toString() },
      'ai-brain-service call failed while handling an inbound message; conversation left unautomated for this turn.',
    );
  }
};

// --------------------------------------------------------------------------
// A human approved / edited / skipped the pending draft.
// --------------------------------------------------------------------------
export interface ResolveApprovalForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actor: HydratedDocument<UserDocument>;
  verdict: AiBrainApprovalResolution;
  instruction?: string;
}

export const resolveApprovalForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
  verdict,
  instruction = '',
}: ResolveApprovalForActorParams) => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const approval = await findPendingApprovalForConversation({ organizationId, conversationId });

  if (!approval) {
    throw new Error('AI_BRAIN_APPROVAL_NOT_FOUND');
  }

  const result = await aiBrainClient.sendOwnerDecision(conversationId.toString(), verdict, instruction);

  if (result.status === AI_BRAIN_RESULT_STATUSES.AWAITING_APPROVAL) {
    // "edit": ai-brain-service raised a fresh interrupt with a revised draft for the same pause.
    const updated = await upsertPendingApproval({
      organizationId,
      conversationId,
      draft: result.message,
      facts: result.facts,
    });

    // A revised draft is a new card either way it's reviewed - re-fire the WhatsApp approval
    // card (with the freshly generated code) exactly like a first-time draft would. Whether this
    // edit itself came from the dashboard or from the owner's own WhatsApp reply, the resulting
    // card always goes out; failure-isolated the same way as the first send.
    if (updated?.code) {
      await sendApprovalCard({
        organizationId,
        accountId: conversation.whatsappAccountId,
        conversationId,
        approvalId: updated._id,
        draft: result.message,
        leadDisplayName: conversation.displayName,
        code: updated.code,
      });
    }

    return { approval: serializeAiBrainApproval(updated), sent: false };
  }

  return runInTransaction(async (session) => {
    if (result.status === AI_BRAIN_RESULT_STATUSES.SENT) {
      await outboundMessageService.enqueueOutboundMessage({
        organizationId,
        conversation,
        actor,
        body: result.message,
        idempotencyKey: `ai-brain-approved:${approval._id.toString()}`,
        authoredBy: MESSAGE_AUTHORS.AI,
      });
    }

    const resolvedApproval = await resolveApproval({
      approvalId: approval._id,
      organizationId,
      resolution: verdict === AI_BRAIN_APPROVAL_RESOLUTIONS.EDIT ? AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE : verdict,
      resolvedBy: actor._id,
      session,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_APPROVAL_RESOLVED,
      summary: `AI draft ${verdict === 'skip' ? 'skipped' : 'approved and sent'}.`,
      metadata: { verdict },
      session,
    });

    return { approval: serializeAiBrainApproval(resolvedApproval), sent: result.status === AI_BRAIN_RESULT_STATUSES.SENT };
  });
};

// --------------------------------------------------------------------------
// Toggle automation on/off for one conversation.
// --------------------------------------------------------------------------
export const setAutomationForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
  enabled,
}: {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actor: HydratedDocument<UserDocument>;
  enabled: boolean;
}) => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const updated = await runInTransaction(async (session) => {
    const updated = await updateAutomationState({
      conversationId,
      organizationId,
      aiAutomationEnabled: enabled,
      aiAutomationPausedReason: null,
      session,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_AUTOMATION_TOGGLED,
      summary: `AI automation turned ${enabled ? 'on' : 'off'} for this conversation.`,
      metadata: { enabled },
      session,
    });

    return updated;
  });

  return updated;
};

// --------------------------------------------------------------------------
// Reading a whole conversation and asking ai-brain-service's classifier what it means. Shared
// by the on-demand "check outcome" action below and the 9am morning handover read
// (handover-read.service.ts) - both need the exact same transcript, silence and business-context
// shape, so there is one implementation of it rather than two that can drift apart.
// --------------------------------------------------------------------------
const OUTCOME_TRANSCRIPT_MESSAGE_LIMIT = 40;
const PROPOSAL_TRANSCRIPT_MESSAGE_LIMIT = 60;

export interface ClassifyConversationOutcomeParams {
  organizationId: ObjectIdLike;
  conversation: Pick<
    ConversationDocument,
    'aiCategory' | 'aiFacts' | 'lastMessageAt'
  > & { _id: ObjectIdLike };
  now?: Date;
}

/**
 * Builds the transcript + facts + business context for one conversation and asks the Python
 * `/outcome` classifier to read it. Returns the verdict verbatim; every side effect (stage
 * changes, approval cards, activity entries) is the caller's business.
 */
export const classifyConversationOutcome = async ({
  organizationId,
  conversation,
  now = new Date(),
}: ClassifyConversationOutcomeParams) => {
  const conversationId = conversation._id;

  const recentMessages = await findMessagesByConversationCursor({
    organizationId,
    conversationId,
    limit: OUTCOME_TRANSCRIPT_MESSAGE_LIMIT,
  });

  const transcript = buildTranscript(recentMessages);

  const lastMessage = recentMessages[0];
  const daysSilent = conversation.lastMessageAt
    ? Math.max(
        0,
        Math.floor((now.getTime() - conversation.lastMessageAt.getTime()) / (24 * 60 * 60 * 1000)),
      )
    : 0;

  const context = await buildAiBrainContext({ organizationId, category: conversation.aiCategory });

  return aiBrainClient.getOutcome(conversationId.toString(), {
    facts: conversation.aiFacts ?? {},
    transcript,
    knowledgeText: context.knowledgeText,
    styleExamples: context.styleExamples,
    daysSilent,
    whoSpokeLast: lastMessage ? (lastMessage.direction === MESSAGE_DIRECTIONS.IN ? 'lead' : 'us') : 'unknown',
  });
};

// --------------------------------------------------------------------------
// Ask ai-brain-service's classifier what stage this conversation is really in.
// --------------------------------------------------------------------------
export const checkOutcomeForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
}: {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actor: HydratedDocument<UserDocument>;
}) => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const outcome = await classifyConversationOutcome({ organizationId, conversation });

  await runInTransaction(async (session) => {
    if (outcome.decision === 'won' || outcome.decision === 'lost') {
      await updateConversationStage({
        conversationId,
        organizationId,
        stage: outcome.decision === 'won' ? CONVERSATION_STAGES.WON : CONVERSATION_STAGES.LOST,
        session,
      });

      await enqueueConversationChanged({
        organizationId,
        conversationId,
        assignedTo: conversation.assignedTo,
        reason: REALTIME_REASONS.STAGE,
        session,
      });
    } else if ((outcome.decision === 'answer' || outcome.decision === 'reopen') && outcome.message) {
      await upsertPendingApproval({
        organizationId,
        conversationId,
        draft: outcome.message,
        facts: conversation.aiFacts ?? {},
        session,
      });

      await enqueueConversationChanged({
        organizationId,
        conversationId,
        assignedTo: conversation.assignedTo,
        reason: REALTIME_REASONS.AI_PENDING,
        session,
      });
    }

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_STAGE_SUGGESTED,
      summary: `AI read this conversation as "${outcome.decision}": ${outcome.reasoning || 'no reasoning given'}.`,
      metadata: { decision: outcome.decision, reasoning: outcome.reasoning },
      session,
    });
  });

  return outcome;
};

// --------------------------------------------------------------------------
// The one pending draft (if any) for a single conversation - what the conversation view polls
// to decide whether to show the "AI drafted a reply" review card.
// --------------------------------------------------------------------------
export const getPendingApprovalForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actorId,
}: {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actorId: ObjectIdLike;
}) => {
  await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId,
  });

  const approval = await findPendingApprovalForConversation({ organizationId, conversationId });

  return serializeAiBrainApproval(approval);
};

// --------------------------------------------------------------------------
// Pending drafts waiting on a human, across the whole organization (for a "needs your review"
// list). Visibility mirrors conversations: someone who can only read their assigned threads
// only sees approvals for those; someone with org-wide read sees all of them.
// --------------------------------------------------------------------------
export const listPendingApprovalsForActor = async ({
  organizationId,
  actorId,
  permissions,
  limit,
  skip,
}: {
  organizationId: ObjectIdLike;
  actorId: ObjectIdLike;
  permissions: readonly Permission[];
  limit?: number;
  skip?: number;
}) => {
  const approvals = await listPendingApprovals({ organizationId, limit, skip });

  const canReadAll = permissions.includes(PERMISSIONS.CONVERSATIONS_READ_ALL);

  if (canReadAll) {
    return approvals.map((approval) => serializeAiBrainApproval(approval));
  }

  const withVisibility = await Promise.all(
    approvals.map(async (approval) => {
      const conversation = await findConversationById({
        conversationId: approval.conversationId,
        organizationId,
      });

      const visible = Boolean(
        conversation?.assignedTo && conversation.assignedTo.toString() === actorId.toString(),
      );

      return visible ? approval : null;
    }),
  );

  return withVisibility.filter(Boolean).map((approval) => serializeAiBrainApproval(approval));
};

// --------------------------------------------------------------------------
// Proposal generation - ai-brain-service writes the content, this repo renders it (it holds the
// .docx templates) and hands back downloadable files. There is no proposal history store yet:
// this pass treats a proposal as a document a human reviews, edits by instruction, and downloads
// to send manually - the same "approve before it leaves the building" spirit as chat replies.
// --------------------------------------------------------------------------
export const generateProposalForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
  clientName,
}: {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actor: HydratedDocument<UserDocument>;
  clientName?: string;
}): Promise<AiBrainProposalContent> => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const recentMessages = await findMessagesByConversationCursor({
    organizationId,
    conversationId,
    limit: PROPOSAL_TRANSCRIPT_MESSAGE_LIMIT,
  });

  const transcript = buildTranscript(recentMessages);

  const context = await buildAiBrainContext({ organizationId, category: conversation.aiCategory });

  const content = await aiBrainClient.generateProposal({
    category: conversation.aiCategory,
    facts: conversation.aiFacts ?? {},
    transcript,
    pricingJson: context.catalogText,
    clientName: clientName ?? conversation.displayName,
  });

  await createActivity({
    organizationId,
    whatsappAccountId: conversation.whatsappAccountId,
    conversationId,
    actorId: actor._id,
    eventType: ACTIVITY_EVENTS.AI_BRAIN_PROPOSAL_DRAFTED,
    summary: 'AI drafted a proposal for this conversation.',
    metadata: { category: conversation.aiCategory },
  });

  return content;
};

export const reviseProposalForActor = async ({
  content,
  instruction,
}: {
  content: AiBrainProposalContent;
  instruction: string;
}): Promise<AiBrainProposalContent> => aiBrainClient.reviseProposal(content, instruction);

export const renderProposalForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
  content,
  version,
}: {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actor: HydratedDocument<UserDocument>;
  content: AiBrainProposalContent;
  version?: number;
}) => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const templateBase64 = loadTemplateBase64ForCategory(conversation.aiCategory);

  const rendered = await aiBrainClient.renderProposal({ content, templateBase64, version });

  await createActivity({
    organizationId,
    whatsappAccountId: conversation.whatsappAccountId,
    conversationId,
    actorId: actor._id,
    eventType: ACTIVITY_EVENTS.AI_BRAIN_PROPOSAL_RENDERED,
    summary: 'A proposal document was generated for this conversation.',
    metadata: { category: conversation.aiCategory, version: version ?? 1 },
  });

  return rendered;
};

export { aiBrainClient };
