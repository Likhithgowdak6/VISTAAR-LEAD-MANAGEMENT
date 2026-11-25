/**
 * Automatic replies to Instagram DMs, and the takeover that stops them.
 *
 * FOUR GATES, EVERY ONE OF WHICH MUST PASS before a single character reaches a customer. They are
 * checked in this order because each is cheaper than the last:
 *
 *   1. `account.automationEnabled` — off by default, per account. A workspace that connects
 *      Instagram and writes no replies sends nothing, ever.
 *   2. `conversation.aiAutomationEnabled` — the PER-THREAD takeover. Staff flip this off and the
 *      thread goes quiet until they flip it back. Already the mechanism WhatsApp uses, so a
 *      handover means the same thing on both channels.
 *   3. A reply must actually be configured. An empty welcome is not a blank message.
 *   4. The 24-hour window must be open, which for a reply to an inbound message it always is —
 *      checked anyway, because a retry of an old delivery could arrive outside it.
 *
 * REPLIES ARE DEDUPLICATED BY THE SAME INDEX AS INBOUND MESSAGES. Each automatic reply is written
 * with a derived `providerMessageId`-shaped idempotency key before it is sent, so a retried
 * webhook cannot send the welcome twice even if the inbound dedupe were somehow bypassed. The
 * send happens only if that write was new.
 *
 * THE HUMAN_AGENT TAG IS NEVER USED HERE. It declares to Meta that a person is replying, and
 * using it for a bot would be a false statement about who is on the other end — with the
 * account's messaging access as the penalty. Staff replies use it; automation does not.
 */
import { type Types } from 'mongoose';

import { logger } from '../../config/logger.js';
import { CONVERSATION_CHANNELS, isInstagramWindowOpen } from '../../constants/channels.js';
import { MESSAGE_DIRECTIONS } from '../../constants/message-directions.js';
import { MESSAGE_STATUSES } from '../../constants/message-statuses.js';
import { MESSAGE_TYPES } from '../../constants/message-types.js';
import { Conversation } from '../conversations/conversation.model.js';
import { Message } from '../messages/message.model.js';
import { InstagramAccount, type InstagramAccountDocument } from './instagram-account.model.js';
import { decryptInstagramPageTokenFromStorage } from './instagram-credentials.service.js';
import { InstagramSendError, sendInstagramText } from './instagram.client.js';

/** Why automation did nothing, for tests and for the thread's own history. */
export type InstagramAutomationOutcome =
  | 'sent'
  | 'account_disabled'
  | 'thread_taken_over'
  | 'no_reply_configured'
  | 'already_replied'
  | 'window_closed'
  | 'send_failed';

/**
 * The first keyword whose trigger appears in the message.
 *
 * SUBSTRING, CASE-INSENSITIVE, FIRST MATCH WINS. A customer writing "whats the price?" should hit
 * a `price` rule; requiring an exact match would make keyword replies useless in practice. First
 * match rather than best match so the order in the settings list is the priority, which is
 * something an admin can see and reorder — unlike "longest match", which they cannot.
 */
export const matchKeywordReply = (
  text: string | null,
  rules: { keyword: string; reply: string }[] | undefined,
): string | null => {
  if (!text || !Array.isArray(rules)) {
    return null;
  }

  const haystack = text.toLowerCase();

  for (const rule of rules) {
    const needle = String(rule?.keyword ?? '').trim().toLowerCase();

    if (needle !== '' && haystack.includes(needle)) {
      return String(rule.reply ?? '').trim() || null;
    }
  }

  return null;
};

/**
 * Chooses the reply for one inbound message.
 *
 * A KEYWORD BEATS THE WELCOME. Somebody whose first message is "what do you charge?" wants the
 * price, not "thanks for getting in touch" — answering the question is strictly better, and the
 * welcome has no second chance to be useful anyway.
 */
export const chooseInstagramReply = ({
  account,
  text,
  isFirstMessage,
}: {
  account: Pick<InstagramAccountDocument, 'welcomeReply' | 'keywordReplies'>;
  text: string | null;
  isFirstMessage: boolean;
}): { reply: string; kind: 'keyword' | 'welcome' } | null => {
  const keyword = matchKeywordReply(text, account.keywordReplies);

  if (keyword) {
    return { reply: keyword, kind: 'keyword' };
  }

  const welcome = String(account.welcomeReply ?? '').trim();

  if (isFirstMessage && welcome !== '') {
    return { reply: welcome, kind: 'welcome' };
  }

  return null;
};

/**
 * Pauses or resumes automation on one thread.
 *
 * THE SAME FLAG WHATSAPP USES, so a handover means one thing across the CRM rather than two.
 * `aiAutomationPausedReason` records who stopped it, which is what makes "why is this thread
 * quiet?" answerable six weeks later.
 */
export const setInstagramThreadAutomation = async ({
  organizationId,
  conversationId,
  enabled,
  reason,
}: {
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  enabled: boolean;
  reason: string | null;
}) =>
  Conversation.findOneAndUpdate(
    { _id: conversationId, organizationId },
    {
      $set: {
        aiAutomationEnabled: enabled,
        aiAutomationPausedReason: enabled ? null : reason,
        updatedAt: new Date(),
      },
    },
    { new: true },
  ).exec();

/**
 * Records an automatic reply and sends it, in that order.
 *
 * WRITTEN BEFORE IT IS SENT, which looks backwards and is not. The write carries a derived
 * idempotency key, so a duplicated webhook collides on the unique index and the send is skipped.
 * Sending first and recording after would mean a retry sends again and only then discovers it
 * was a duplicate — and a second "thanks for getting in touch" is the most visible possible bug.
 *
 * The cost of this order is that a send which fails leaves a recorded message marked `failed`,
 * which is exactly what the thread should show.
 */
const recordAndSend = async ({
  account,
  conversationId,
  contactId,
  senderId,
  reply,
  kind,
}: {
  account: InstagramAccountDocument;
  conversationId: Types.ObjectId;
  contactId: Types.ObjectId;
  senderId: string;
  reply: string;
  kind: 'keyword' | 'welcome';
}): Promise<InstagramAutomationOutcome> => {
  // Derived, never random: the same thread and the same kind of automatic reply must produce the
  // same key on a retry. A welcome is once per thread by construction.
  const idempotencyKey = `ig-auto:${String(conversationId)}:${kind}:${
    kind === 'welcome' ? 'once' : reply.slice(0, 40)
  }`;

  let message;

  try {
    message = await Message.create({
      organizationId: account.organizationId,
      channel: CONVERSATION_CHANNELS.INSTAGRAM,
      instagramAccountId: account._id,
      whatsappAccountId: null,
      conversationId,
      contactId,
      idempotencyKey,
      direction: MESSAGE_DIRECTIONS.OUT,
      type: MESSAGE_TYPES.TEXT,
      body: reply,
      status: MESSAGE_STATUSES.QUEUED,
      sentAt: new Date(),
    });
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) {
      return 'already_replied';
    }

    throw error;
  }

  /**
   * THE SECOND TAKEOVER CHECK, and the one that actually matters.
   *
   * The first check happened before this reply was composed. Between then and now there is a
   * window - a Graph call's worth, or a retry's worth after a restart - in which staff can press
   * Take over. Without re-checking, a human who grabs a thread still watches the bot answer over
   * them, which is precisely the thing the control exists to prevent.
   *
   * The message is CLAIMED atomically in the same breath: `queued` -> `sending` only if it is
   * still queued. That also stops two concurrent drains sending the same reply twice, which the
   * idempotency key alone cannot - the key stops a second ROW, not a second send of one row.
   */
  const stillAutomated = await Conversation.findOne({
    _id: conversationId,
    organizationId: account.organizationId,
    aiAutomationEnabled: { $ne: false },
  })
    .select('_id')
    .lean()
    .exec();

  if (!stillAutomated) {
    await Message.updateOne(
      { _id: message._id, status: MESSAGE_STATUSES.QUEUED },
      {
        $set: {
          // `failed_permanent`, not a new `cancelled` status, and the reason carries the nuance.
          //
          // A dedicated status would read better here, but the status vocabulary is mirrored in
          // Python's analytics and the React thread view - adding one means a three-service
          // change for an edge case, and an unknown status reaching the analytics pipeline. This
          // value already means "will not be sent", which is true, and the thread renders the
          // REASON rather than the status so a takeover reads as a takeover and not an error.
          status: MESSAGE_STATUSES.FAILED_PERMANENT,
          lastDeliveryError: 'HUMAN_TAKEOVER',
        },
      },
    ).exec();

    return 'thread_taken_over';
  }

  const claimed = await Message.findOneAndUpdate(
    { _id: message._id, status: MESSAGE_STATUSES.QUEUED },
    { $set: { status: MESSAGE_STATUSES.SENDING } },
    { new: true },
  ).exec();

  if (!claimed) {
    // Somebody else is already sending this exact reply.
    return 'already_replied';
  }

  const token = decryptInstagramPageTokenFromStorage(account.encryptedPageAccessToken);

  if (!token) {
    await Message.updateOne(
      { _id: message._id },
      { $set: { status: MESSAGE_STATUSES.FAILED, lastDeliveryError: 'INSTAGRAM_NOT_CONNECTED' } },
    ).exec();

    return 'send_failed';
  }

  try {
    const result = await sendInstagramText({
      pageId: account.pageId,
      pageAccessToken: token,
      recipientId: senderId,
      text: reply,
      // Never for automation. See the module docstring.
      humanAgent: false,
    });

    await Message.updateOne(
      { _id: message._id },
      { $set: { status: MESSAGE_STATUSES.SENT, providerMessageId: result.messageId } },
    ).exec();

    return 'sent';
  } catch (error) {
    const sendError = error instanceof InstagramSendError ? error : null;

    await Message.updateOne(
      { _id: message._id },
      {
        $set: {
          status: MESSAGE_STATUSES.FAILED,
          lastDeliveryError: sendError?.code ?? 'INSTAGRAM_SEND_FAILED',
        },
      },
    ).exec();

    // A credential problem is recorded on the ACCOUNT, not just the message, because it affects
    // every future send and is the thing an admin has to act on.
    if (sendError?.failureKind === 'needs_attention') {
      await InstagramAccount.updateOne(
        { _id: account._id },
        {
          $set: {
            status:
              sendError.code === 'INSTAGRAM_TOKEN_EXPIRED' ||
              sendError.code === 'INSTAGRAM_PERMISSION_DENIED'
                ? 'needs_attention'
                : account.status,
            lastError: sendError.message,
            lastErrorAt: new Date(),
          },
        },
      ).exec();
    }

    logger.warn(
      { code: sendError?.code },
      'Instagram automatic reply failed; recorded against the thread.',
    );

    return 'send_failed';
  }
};

/**
 * Runs automation for one newly-filed inbound message.
 *
 * Returns the outcome rather than throwing, so the caller can log it without a try/catch and a
 * test can assert exactly which gate stopped it.
 */
export const runInstagramAutomation = async ({
  account,
  conversationId,
  contactId,
  senderId,
  text,
}: {
  account: InstagramAccountDocument;
  conversationId: Types.ObjectId;
  contactId: Types.ObjectId;
  senderId: string;
  text: string | null;
}): Promise<InstagramAutomationOutcome> => {
  if (!account.automationEnabled) {
    return 'account_disabled';
  }

  const conversation = await Conversation.findOne({
    _id: conversationId,
    organizationId: account.organizationId,
  })
    .select('aiAutomationEnabled lastInboundAt')
    .lean<{ aiAutomationEnabled?: boolean; lastInboundAt?: Date } | null>();

  // THE TAKEOVER GATE. Staff have this thread; automation stays out of it until they hand it back.
  if (!conversation || conversation.aiAutomationEnabled === false) {
    return 'thread_taken_over';
  }

  // A thread's first message is the one where the inbound count is one. Counted rather than
  // inferred from a flag, so a welcome cannot fire twice after a replay.
  const inboundCount = await Message.countDocuments({
    organizationId: account.organizationId,
    conversationId,
    direction: MESSAGE_DIRECTIONS.IN,
  }).exec();

  const choice = chooseInstagramReply({
    account,
    text,
    isFirstMessage: inboundCount <= 1,
  });

  if (!choice) {
    return 'no_reply_configured';
  }

  if (!isInstagramWindowOpen({ lastInboundAt: conversation.lastInboundAt ?? null })) {
    // Replying to an inbound message is normally inside the window by definition; a retry of a
    // day-old delivery is not, and Meta would refuse it.
    return 'window_closed';
  }

  return recordAndSend({
    account,
    conversationId,
    contactId,
    senderId,
    reply: choice.reply,
    kind: choice.kind,
  });
};
