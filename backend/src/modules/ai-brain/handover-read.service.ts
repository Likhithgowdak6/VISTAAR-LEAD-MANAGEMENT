/**
 * The 9am morning handover read (Phase 5). Once a day, every conversation the owner took over
 * by typing into the lead's chat from their own phone (Phase 1's markOwnerTookOver: automation
 * off + `ownerLastTypedAt` set) - and has not come back to since an earlier day - gets read end
 * to end by ai-brain-service's outcome classifier, and the verdict is acted on:
 *
 *   won / lost  -> a HANDOVER confirmation card. The stage is NOT changed here: a mis-read on a
 *                  closed deal is expensive, so the owner confirms it (see
 *                  owner-approval-card.service.ts's applyHandoverDecision for what 1/2/3 do).
 *   answer      -> the AI drafted the reply the lead is waiting on -> normal reply-approval card.
 *   reopen      -> same as answer in this port. The reference auto-sends a re-opening message;
 *                  this project's binding rule is that every lead-facing sales message needs
 *                  human approval (only qualifying questions auto-send), so it raises a card.
 *   wait        -> nothing leaves the building. The reason is recorded on the conversation and
 *                  logged; it stays owner-handled.
 *   unclear     -> a HANDOVER card asking the owner what is actually happening.
 *
 * Conversations that already have a pending approval open are skipped entirely - one open
 * question per lead, which is also what the approval model's partial unique index enforces.
 *
 * Conversations are processed strictly sequentially with a pause between them: each verdict can
 * fire a WhatsApp card at the owner, and a parallel sweep would burst those into WhatsApp's
 * rate limiter.
 */
import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import {
  AI_BRAIN_APPROVAL_KINDS,
  AI_BRAIN_OUTCOME_DECISIONS,
} from '../../constants/ai-brain-statuses.js';
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import { type ConversationDocument } from '../conversations/conversation.model.js';
import {
  findConversationsDueForHandoverRead as defaultFindConversationsDueForHandoverRead,
  updateAutomationState as defaultUpdateAutomationState,
} from '../conversations/conversation.repository.js';
import { REALTIME_REASONS } from '../realtime/realtime.events.js';
import { enqueueConversationChanged as defaultEnqueueConversationChanged } from '../realtime/realtime-outbox.repository.js';
import { startOfLocalDay } from '../whatsapp/automation/quiet-hours.js';
import {
  findPendingApprovalForConversation as defaultFindPendingApprovalForConversation,
  upsertPendingApproval as defaultUpsertPendingApproval,
} from './ai-brain-approval.repository.js';
import { classifyConversationOutcome as defaultClassifyConversationOutcome } from './ai-brain.service.js';
import {
  sendApprovalCard as defaultSendApprovalCard,
  sendHandoverCard as defaultSendHandoverCard,
} from './owner-approval-card.service.js';

const DUE_BATCH_SIZE = 200;

/**
 * Pause between two conversations' reads. Each one can end in a WhatsApp card to the owner, and
 * WhatsApp rate-limits bursts; the reference implementation deliberately avoids parallelism here
 * for the same reason.
 */
export const HANDOVER_READ_DELAY_MS = 2000;

const WAIT_PAUSED_REASON_FALLBACK = 'Waiting on the lead to come back.';

export interface HandoverConversationRepositoryLike {
  findConversationsDueForHandoverRead: typeof defaultFindConversationsDueForHandoverRead;
  updateAutomationState: typeof defaultUpdateAutomationState;
}

export interface HandoverApprovalRepositoryLike {
  findPendingApprovalForConversation: typeof defaultFindPendingApprovalForConversation;
  upsertPendingApproval: typeof defaultUpsertPendingApproval;
}

export interface CreateHandoverReadServiceOptions {
  config?: Env;
  conversationRepository?: HandoverConversationRepositoryLike;
  approvalRepository?: HandoverApprovalRepositoryLike;
  classifyConversationOutcome?: typeof defaultClassifyConversationOutcome;
  sendApprovalCard?: typeof defaultSendApprovalCard;
  sendHandoverCard?: typeof defaultSendHandoverCard;
  createActivity?: typeof defaultCreateActivity;
  enqueueConversationChanged?: typeof defaultEnqueueConversationChanged;
  logger?: { error?: (...args: unknown[]) => void };
  now?: () => Date;
  /** Overridable so tests do not actually wait out HANDOVER_READ_DELAY_MS between reads. */
  delay?: (ms: number) => Promise<void>;
}

export interface RunMorningReadParams {
  organizationId?: ObjectIdLike;
}

export interface RunMorningReadResult {
  scanned: number;
  /** Handover confirmation cards raised (won / lost / unclear). */
  handoverCards: number;
  /** Reply-draft cards raised (answer / reopen). */
  replyCards: number;
  /** Left alone with a recorded reason (wait). */
  waiting: number;
  /** Skipped without asking the AI anything - a card was already open for that lead. */
  skipped: number;
  failed: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const createHandoverReadService = ({
  config = env,
  conversationRepository = {
    findConversationsDueForHandoverRead: defaultFindConversationsDueForHandoverRead,
    updateAutomationState: defaultUpdateAutomationState,
  },
  approvalRepository = {
    findPendingApprovalForConversation: defaultFindPendingApprovalForConversation,
    upsertPendingApproval: defaultUpsertPendingApproval,
  },
  classifyConversationOutcome = defaultClassifyConversationOutcome,
  sendApprovalCard = defaultSendApprovalCard,
  sendHandoverCard = defaultSendHandoverCard,
  createActivity = defaultCreateActivity,
  enqueueConversationChanged = defaultEnqueueConversationChanged,
  logger = defaultLogger,
  now = () => new Date(),
  delay = sleep,
}: CreateHandoverReadServiceOptions = {}) => {
  const timeZone = config.WHATSAPP_BUSINESS_TIMEZONE ?? 'Asia/Kolkata';

  type DueConversation = HydratedDocument<ConversationDocument>;

  type Outcome = 'handover' | 'reply' | 'waiting' | 'skipped';

  const raiseHandoverCard = async (
    conversation: DueConversation,
    verdict: string,
    reasoning: string,
  ): Promise<void> => {
    const organizationId = conversation.organizationId;

    const approval = await approvalRepository.upsertPendingApproval({
      organizationId,
      conversationId: conversation._id,
      // The card's own WhatsApp text is composed at send time (it needs the freshly generated
      // code); what is stored is the reading itself, which is what the dashboard shows.
      draft: `Morning read: this looks ${verdict}. ${reasoning || 'No reasoning given.'}`,
      facts: conversation.aiFacts ?? {},
      kind: AI_BRAIN_APPROVAL_KINDS.HANDOVER,
      handoverVerdict: verdict,
    });

    await enqueueConversationChanged({
      organizationId,
      conversationId: conversation._id,
      assignedTo: conversation.assignedTo,
      reason: REALTIME_REASONS.AI_PENDING,
    });

    if (approval?.code) {
      await sendHandoverCard({
        organizationId,
        accountId: conversation.whatsappAccountId,
        conversationId: conversation._id,
        approvalId: approval._id,
        leadDisplayName: conversation.displayName,
        verdict,
        code: approval.code,
      });
    }
  };

  const raiseReplyCard = async (
    conversation: DueConversation,
    draft: string,
  ): Promise<void> => {
    const organizationId = conversation.organizationId;

    const approval = await approvalRepository.upsertPendingApproval({
      organizationId,
      conversationId: conversation._id,
      draft,
      facts: conversation.aiFacts ?? {},
    });

    await enqueueConversationChanged({
      organizationId,
      conversationId: conversation._id,
      assignedTo: conversation.assignedTo,
      reason: REALTIME_REASONS.AI_PENDING,
    });

    if (approval?.code) {
      await sendApprovalCard({
        organizationId,
        accountId: conversation.whatsappAccountId,
        conversationId: conversation._id,
        approvalId: approval._id,
        draft,
        leadDisplayName: conversation.displayName,
        code: approval.code,
      });
    }
  };

  const processConversation = async (conversation: DueConversation): Promise<Outcome> => {
    const organizationId = conversation.organizationId;

    // Never pile a second question on the owner for the same lead.
    const alreadyPending = await approvalRepository.findPendingApprovalForConversation({
      organizationId,
      conversationId: conversation._id,
    });

    if (alreadyPending) {
      return 'skipped';
    }

    const outcome = await classifyConversationOutcome({ organizationId, conversation });
    const decision = outcome.decision;
    let result: Outcome = 'skipped';

    switch (decision) {
      case AI_BRAIN_OUTCOME_DECISIONS.WON:
      case AI_BRAIN_OUTCOME_DECISIONS.LOST:
      case AI_BRAIN_OUTCOME_DECISIONS.UNCLEAR: {
        await raiseHandoverCard(conversation, decision, outcome.reasoning);
        result = 'handover';
        break;
      }

      case AI_BRAIN_OUTCOME_DECISIONS.ANSWER:
      case AI_BRAIN_OUTCOME_DECISIONS.REOPEN: {
        if (outcome.message) {
          await raiseReplyCard(conversation, outcome.message);
          result = 'reply';
        }
        break;
      }

      case AI_BRAIN_OUTCOME_DECISIONS.WAIT: {
        await conversationRepository.updateAutomationState({
          conversationId: conversation._id,
          organizationId,
          aiAutomationEnabled: false,
          aiAutomationPausedReason: outcome.reasoning || WAIT_PAUSED_REASON_FALLBACK,
        });
        result = 'waiting';
        break;
      }

      default:
        break;
    }

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_HANDOVER_READ,
      summary: `Morning handover read: "${decision}" — ${outcome.reasoning || 'no reasoning given'}.`,
      metadata: { decision, reasoning: outcome.reasoning },
    });

    return result;
  };

  const runMorningRead = async ({
    organizationId,
  }: RunMorningReadParams = {}): Promise<RunMorningReadResult> => {
    const before = startOfLocalDay(now(), timeZone);

    const result: RunMorningReadResult = {
      scanned: 0,
      handoverCards: 0,
      replyCards: 0,
      waiting: 0,
      skipped: 0,
      failed: 0,
    };

    let afterId: ObjectIdLike | undefined;

    for (;;) {
      const batch = (await conversationRepository.findConversationsDueForHandoverRead({
        organizationId,
        before,
        afterId,
        limit: DUE_BATCH_SIZE,
      })) as DueConversation[];

      if (batch.length === 0) {
        break;
      }

      for (const conversation of batch) {
        if (result.scanned > 0) {
          await delay(HANDOVER_READ_DELAY_MS);
        }

        result.scanned += 1;

        try {
          const outcome = await processConversation(conversation);

          if (outcome === 'handover') {
            result.handoverCards += 1;
          } else if (outcome === 'reply') {
            result.replyCards += 1;
          } else if (outcome === 'waiting') {
            result.waiting += 1;
          } else {
            result.skipped += 1;
          }
        } catch (error: unknown) {
          // One unreadable conversation must not end the run - same per-conversation isolation
          // as the nurture sweep.
          result.failed += 1;
          const err = error as { code?: unknown; name?: unknown };
          logger.error?.(
            { code: err?.code, name: err?.name, conversationId: conversation._id.toString() },
            'Morning handover read failed to process a conversation safely.',
          );
        }
      }

      afterId = batch[batch.length - 1]!._id;
    }

    return result;
  };

  return { runMorningRead };
};

export type HandoverReadService = ReturnType<typeof createHandoverReadService>;
