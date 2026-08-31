/**
 * The 🔥 hot-lead alert: the moment a lead's score crosses 80, the owner gets a ping in their
 * own WhatsApp self-chat, because a HOT lead is defined by needing a human NOW - someone who has
 * given us their date, their venue and their budget and has asked what it costs is not a lead to
 * leave to an automated nurture cadence.
 *
 * Deliberately, this does NOT switch automation off. The AI keeps doing its job; the owner
 * decides whether to step in. Nothing about a score is certain enough to silence the one thing
 * that is currently answering the lead.
 *
 * The same two properties as new-lead-alert.service.ts next door, for the same reasons:
 *
 *  1. It is IDEMPOTENT, through `claimHotLeadAlert` - a conditional update on
 *     `leadScoreHotAlertSentAt: null` that returns null to everyone who did not win. A score
 *     that oscillates around the 80 boundary therefore buzzes the owner's phone once, ever.
 *  2. It NEVER throws. It is reached from the inbound-ingestion path, where a throw would abort
 *     persisting a lead's message for an entirely unrelated reason.
 */
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import { claimHotLeadAlert as defaultClaimHotLeadAlert } from '../conversations/conversation.repository.js';
import {
  LEAD_SCORE_SIGNAL_LABELS,
  LEAD_SCORE_SIGNAL_ORDER,
  type LeadScoreSignalKey,
} from '../conversations/lead-score.js';
import {
  createOwnerNotifyService,
  type NotifyOwnerParams,
  type NotifyOwnerResult,
} from '../whatsapp/automation/owner-notify.service.js';

type NotifyOwnerFn = (params?: NotifyOwnerParams) => Promise<NotifyOwnerResult>;

// Lazily constructed, exactly like new-lead-alert.service.ts: nothing downstream of
// getSessionManager() may be evaluated at module load.
let ownerNotifyServiceSingleton: { notifyOwner: NotifyOwnerFn } | null = null;
const getOwnerNotifyService = () => {
  ownerNotifyServiceSingleton ??= createOwnerNotifyService();
  return ownerNotifyServiceSingleton;
};

const isSignalKey = (value: unknown): value is LeadScoreSignalKey =>
  LEAD_SCORE_SIGNAL_ORDER.includes(value as LeadScoreSignalKey);

export interface BuildHotLeadAlertTextParams {
  leadDisplayName: string;
  score: number;
  /** The LEAD_SCORE_SIGNALS keys that fired. Rendered in the owner's words, in the client's
   *  order, so the alert says WHY this lead is hot rather than just asserting that it is. */
  signals?: readonly string[];
}

/**
 * One short alert. The owner reads this on a lock screen: name and number first, then the reason
 * in as few words as possible.
 */
export const buildHotLeadAlertText = ({
  leadDisplayName,
  score,
  signals = [],
}: BuildHotLeadAlertTextParams): string => {
  const fired = LEAD_SCORE_SIGNAL_ORDER.filter(
    (key) => signals.filter(isSignalKey).includes(key),
  ).map((key) => LEAD_SCORE_SIGNAL_LABELS[key]);

  const lines = [`🔥 Hot lead — ${leadDisplayName} (${score}/100)`];

  if (fired.length > 0) {
    lines.push('', fired.join(' · '));
  }

  lines.push('', 'Worth calling this one yourself. The AI is still handling the chat.');

  return lines.join('\n');
};

export interface SendHotLeadAlertParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  leadDisplayName?: string;
  score?: number;
  signals?: readonly string[];
  claimHotLeadAlert?: typeof defaultClaimHotLeadAlert;
  notifyOwner?: NotifyOwnerFn;
  createActivity?: typeof defaultCreateActivity;
  logger?: { error?: (...args: unknown[]) => void };
}

export interface SendHotLeadAlertResult {
  sent: boolean;
}

export const sendHotLeadAlert = async ({
  organizationId,
  whatsappAccountId,
  conversationId,
  leadDisplayName = 'A lead',
  score = 0,
  signals = [],
  claimHotLeadAlert = defaultClaimHotLeadAlert,
  notifyOwner,
  createActivity = defaultCreateActivity,
  logger = defaultLogger,
}: SendHotLeadAlertParams = {}): Promise<SendHotLeadAlertResult> => {
  // Without an account there is no self-chat to reach the owner through - and nothing is
  // claimed, so a later well-formed call can still alert.
  if (!organizationId || !conversationId || !whatsappAccountId) {
    return { sent: false };
  }

  try {
    const claimed = await claimHotLeadAlert({ conversationId, organizationId });

    // Already alerted for this conversation (or it no longer exists). The claim is the whole
    // idempotency guarantee, so losing it means staying quiet.
    if (!claimed) {
      return { sent: false };
    }

    const notify: NotifyOwnerFn = notifyOwner ?? getOwnerNotifyService().notifyOwner;

    await notify({
      accountId: whatsappAccountId,
      organizationId,
      text: buildHotLeadAlertText({ leadDisplayName, score, signals }),
    });

    await createActivity({
      organizationId,
      whatsappAccountId,
      conversationId,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_HOT_LEAD_ALERTED,
      summary: `Owner was alerted on WhatsApp: this lead crossed into HOT (${score}/100).`,
      metadata: { score, signals: [...signals] },
    });

    return { sent: true };
  } catch (error: unknown) {
    // Most commonly: no running WhatsApp session yet, so the owner's self-chat is unreachable.
    // The score itself is already written and visible in the dashboard either way.
    const err = error as { code?: unknown; name?: unknown };
    logger.error?.(
      {
        code: err?.code,
        name: err?.name,
        organizationId: organizationId?.toString?.(),
        conversationId: conversationId?.toString?.(),
      },
      'Hot-lead owner alert failed safely; the lead score is unaffected.',
    );

    return { sent: false };
  }
};
