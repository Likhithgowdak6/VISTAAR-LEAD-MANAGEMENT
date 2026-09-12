/**
 * After the shoot: did the money come in?
 *
 * The day after an event the owner is asked, by code, about that one booking. He answers and the
 * booking is either closed out or - only if he says it is still outstanding - the client gets one
 * polite nudge and the conversation is handed to him to finish.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: the AI never messages a client about money unless the
 * owner has explicitly said it is outstanding. Not if he is slow to answer, not if the event was
 * weeks ago, not if it can see no payment recorded - because it cannot see payments at all. The
 * failure this prevents is asking someone who has already paid to pay again, which is not an
 * annoyance but a real accusation, and it lands on a customer who just spent money with him.
 * Silence is therefore never read as "unpaid"; he is simply asked again tomorrow.
 *
 * AND EXACTLY ONE NUDGE. Chasing is a relationship, not a retry loop. After one message it is
 * assigned to the owner with a follow-up task, because the second thing you say to someone about
 * money should come from a person.
 *
 * Why a code. Two shoots finishing the same weekend make a bare "collected" ambiguous, and
 * crediting the wrong booking leaves real money uncollected while the system believes it arrived.
 * The code is the same A-Z/1-9 shape as the approval cards, but a payment reply must carry a
 * keyword, so it can never be parsed as an approval choice like "A7 1".
 */
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { ORGANIZATION_STATUSES } from '../../constants/organization-statuses.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import {
  claimPaymentChase as defaultClaimPaymentChase,
  claimPaymentPrompt as defaultClaimPaymentPrompt,
  findBookingsAwaitingPaymentPrompt as defaultFindBookingsAwaitingPaymentPrompt,
  findConversationByPaymentCode as defaultFindConversationByPaymentCode,
  recordPaymentSettled as defaultRecordPaymentSettled,
  releasePaymentPromptClaim as defaultReleasePaymentPromptClaim,
} from '../conversations/conversation.repository.js';
import { formatEventDate } from '../conversations/event-date.js';
import { listOrganizations as defaultListOrganizations } from '../organizations/organization.repository.js';
import {
  createOwnerNotifyService,
  type NotifyOwnerParams,
  type NotifyOwnerResult,
} from '../whatsapp/automation/owner-notify.service.js';
import { generateApprovalCode } from './approval-code.js';

type NotifyOwnerFn = (params?: NotifyOwnerParams) => Promise<NotifyOwnerResult>;
type Logger = { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ORGANIZATION_LIMIT = 200;

/**
 * Matches a payment answer and nothing else.
 *
 * The keyword is mandatory. "B4" alone is an approval-card reply and must keep meaning that;
 * "B4 collected" cannot be anything but this.
 */
const PAYMENT_REPLY_PATTERN =
  /^\s*([A-Z][1-9])\s+((?:not\s*)?(?:collected|received|paid|done)|pending|no)\s*$/i;

/**
 * Positive answers, listed exhaustively - the check is "is this explicitly a yes", never "is this
 * not a no".
 *
 * Inverted deliberately after "B4 notcollected" parsed as collected: the negative list held the
 * spaced form, the unspaced form missed it, and the fallthrough was to yes. The safe direction is
 * the other way round. A yes it fails to recognise costs one unnecessary reminder the owner can
 * see and correct; a no it misreads as yes writes real money off as received and tells nobody.
 */
const POSITIVE_ANSWERS = new Set(['collected', 'received', 'paid', 'done']);

export interface ParsedPaymentReply {
  code: string;
  collected: boolean;
}

/** Pure, so the one piece of money-related parsing in this system is trivially testable. */
export const parsePaymentReply = (text: unknown): ParsedPaymentReply | null => {
  if (typeof text !== 'string') {
    return null;
  }

  const match = PAYMENT_REPLY_PATTERN.exec(text);

  if (!match) {
    return null;
  }

  // Whitespace removed entirely, so "not collected" and "notcollected" are the same answer.
  const answer = (match[2] ?? '').toLowerCase().replace(/\s+/g, '');

  return {
    code: (match[1] ?? '').toUpperCase(),
    collected: POSITIVE_ANSWERS.has(answer),
  };
};

export const buildPaymentPrompt = ({
  displayName,
  eventDate,
  code,
}: {
  displayName: string;
  eventDate: Date | null;
  code: string;
}): string => {
  const when = eventDate ? ` (${formatEventDate(eventDate)})` : '';

  return [
    `💰 ${displayName}${when} — shoot done. Payment collected?`,
    '',
    `Reply *${code} collected* or *${code} pending*.`,
  ].join('\n');
};

/** What the client gets, once, and only on the owner's word. */
export const buildPaymentChaseMessage = (displayName: string): string =>
  `Hi ${displayName}, hope you loved the photos! Just a gentle reminder that the payment for ` +
  `the shoot is still pending. Let us know if you need any details from our side 😊`;

export interface CreatePaymentFollowUpServiceOptions {
  findBookingsAwaitingPaymentPrompt?: typeof defaultFindBookingsAwaitingPaymentPrompt;
  claimPaymentPrompt?: typeof defaultClaimPaymentPrompt;
  releasePaymentPromptClaim?: typeof defaultReleasePaymentPromptClaim;
  findConversationByPaymentCode?: typeof defaultFindConversationByPaymentCode;
  recordPaymentSettled?: typeof defaultRecordPaymentSettled;
  claimPaymentChase?: typeof defaultClaimPaymentChase;
  listOrganizations?: typeof defaultListOrganizations;
  createActivity?: typeof defaultCreateActivity;
  /** Sends to the CLIENT. Injected rather than imported so the one outbound path here is visible. */
  sendToClient: (params: { conversationId: ObjectIdLike; organizationId: ObjectIdLike; text: string }) => Promise<unknown>;
  createFollowUp?: (params: {
    conversationId: ObjectIdLike;
    organizationId: ObjectIdLike;
    note: string;
  }) => Promise<unknown>;
  notifyOwner?: NotifyOwnerFn;
  logger?: Logger;
  now?: () => Date;
}

export const createPaymentFollowUpService = ({
  findBookingsAwaitingPaymentPrompt = defaultFindBookingsAwaitingPaymentPrompt,
  claimPaymentPrompt = defaultClaimPaymentPrompt,
  releasePaymentPromptClaim = defaultReleasePaymentPromptClaim,
  findConversationByPaymentCode = defaultFindConversationByPaymentCode,
  recordPaymentSettled = defaultRecordPaymentSettled,
  claimPaymentChase = defaultClaimPaymentChase,
  listOrganizations = defaultListOrganizations,
  createActivity = defaultCreateActivity,
  sendToClient,
  createFollowUp,
  notifyOwner,
  logger = defaultLogger,
  now = () => new Date(),
}: CreatePaymentFollowUpServiceOptions) => {
  const notify: NotifyOwnerFn =
    notifyOwner ?? ((params) => getOwnerNotifyService().notifyOwner(params));

  /** Asks the owner about every finished booking he has not been asked about yet. */
  const runForOrganization = async (organizationId: ObjectIdLike): Promise<void> => {
    const bookings = await findBookingsAwaitingPaymentPrompt({
      organizationId,
      // A day's grace. Asking the same evening reads as chasing him rather than helping him.
      endedBefore: new Date(now().getTime() - MS_PER_DAY),
    });

    for (const booking of bookings) {
      const code = generateApprovalCode();

      const claimed = await claimPaymentPrompt({
        conversationId: booking._id,
        organizationId,
        code,
      });

      if (!claimed) {
        continue;
      }

      try {
        await notify({
          organizationId,
          text: buildPaymentPrompt({
            displayName: booking.displayName ?? 'This booking',
            eventDate: booking.eventDate ?? null,
            code,
          }),
        });
      } catch (error: unknown) {
        // Same at-least-once shape as the pre-event reminder: hand the claim back so the next
        // sweep asks again. An unasked question is money quietly forgotten.
        await releasePaymentPromptClaim({ conversationId: booking._id, organizationId }).catch(
          () => {},
        );

        const err = error as { name?: unknown; message?: unknown };
        logger?.error?.(
          { name: err?.name, message: err?.message },
          'Payment prompt could not be delivered; claim released for the next sweep.',
        );
      }
    }
  };

  const run = async (): Promise<void> => {
    const organizations = await listOrganizations({
      status: ORGANIZATION_STATUSES.ACTIVE,
      limit: ORGANIZATION_LIMIT,
    });

    for (const organization of organizations) {
      try {
        await runForOrganization(organization._id);
      } catch (error: unknown) {
        const err = error as { name?: unknown; message?: unknown };
        logger?.error?.(
          { organizationId: organization._id?.toString?.(), name: err?.name, message: err?.message },
          'Payment follow-up failed for one organization.',
        );
      }
    }
  };

  /**
   * Acts on "B4 collected" / "B4 pending". Returns false when the text was not a payment reply at
   * all, so the caller can carry on with its own parsing.
   */
  const handleOwnerReply = async ({
    organizationId,
    text,
  }: {
    organizationId: ObjectIdLike;
    text: string;
  }): Promise<boolean> => {
    const parsed = parsePaymentReply(text);

    if (!parsed) {
      return false;
    }

    const conversation = await findConversationByPaymentCode({
      organizationId,
      code: parsed.code,
    });

    if (!conversation) {
      await notify({
        organizationId,
        text: `I don't have an open payment question for code ${parsed.code}.`,
      });
      return true;
    }

    if (parsed.collected) {
      await recordPaymentSettled({ conversationId: conversation._id, organizationId });
      await createActivity({
        organizationId,
        whatsappAccountId: conversation.whatsappAccountId,
        conversationId: conversation._id,
        eventType: ACTIVITY_EVENTS.AI_BRAIN_PAYMENT_SETTLED,
        summary: 'Owner confirmed the payment was collected.',
      }).catch(() => {});

      // Deliberately silent back to him. He told us; repeating it is noise.
      logger?.info?.({ code: parsed.code }, 'Payment marked collected by the owner.');
      return true;
    }

    // He said it is outstanding. This is the ONLY path that messages a client about money.
    const claimed = await claimPaymentChase({
      conversationId: conversation._id,
      organizationId,
    });

    if (!claimed) {
      await notify({
        organizationId,
        text: `Already sent ${conversation.displayName} one reminder about that. It's with you now.`,
      });
      return true;
    }

    await sendToClient({
      conversationId: conversation._id,
      organizationId,
      text: buildPaymentChaseMessage(conversation.displayName ?? 'there'),
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_PAYMENT_CHASED,
      summary: 'Sent the client one payment reminder, on the owner’s word.',
    }).catch(() => {});

    await createFollowUp?.({
      conversationId: conversation._id,
      organizationId,
      note: `Payment outstanding for ${conversation.displayName ?? 'this booking'}.`,
    }).catch(() => {});

    await notify({
      organizationId,
      text:
        `Sent ${conversation.displayName} one polite reminder. ` +
        `That's the only one I'll send — it's assigned to you from here.`,
    });

    return true;
  };

  return { run, runForOrganization, handleOwnerReply };
};

export type PaymentFollowUpService = ReturnType<typeof createPaymentFollowUpService>;

const getOwnerNotifyService = (() => {
  let cached: ReturnType<typeof createOwnerNotifyService> | null = null;

  return () => {
    cached ??= createOwnerNotifyService();
    return cached;
  };
})();
