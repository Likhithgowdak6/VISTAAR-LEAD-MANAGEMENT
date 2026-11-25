/**
 * Turning an Instagram webhook delivery into inbox threads and messages.
 *
 * ROUTING IS BY `entry[].id`, which is the Instagram account the DM was sent to. That id is
 * unique across the whole installation (see the unique index on `InstagramAccount`), so a
 * delivery resolves to exactly one workspace or to none — never to a guess. A delivery naming an
 * account nobody has connected is DROPPED, not stored against some default tenant: an inbound
 * message with no owner belongs to no inbox.
 *
 * DEDUPLICATION IS THE DATABASE'S JOB, TWICE OVER. The inbox collection collides on the raw
 * body's hash, and the messages collection collides on
 * `(organizationId, whatsappAccountId, providerMessageId)` — with Instagram messages all carrying
 * a null account id, that reads as one message per Meta message id per workspace. A prior read
 * ("have I seen this mid?") would lose the race between two concurrent redeliveries; an index
 * cannot.
 *
 * ECHOES ARE IGNORED. Meta delivers our own outbound sends back with `message.is_echo`, and
 * filing those as inbound would make the AI answer itself.
 */
import { type Types } from 'mongoose';

import { logger } from '../../config/logger.js';
import { CONVERSATION_CHANNELS } from '../../constants/channels.js';
import { MESSAGE_DIRECTIONS } from '../../constants/message-directions.js';
import { MESSAGE_STATUSES } from '../../constants/message-statuses.js';
import { MESSAGE_TYPES } from '../../constants/message-types.js';
import { createUniqueLeadId } from '../../services/lead-id.service.js';
import { Contact } from '../contacts/contact.model.js';
import { Conversation } from '../conversations/conversation.model.js';
import { Message } from '../messages/message.model.js';
import { InstagramAccount, type InstagramAccountDocument } from './instagram-account.model.js';

export interface InstagramInboundMessage {
  /** Meta's message id. The dedupe key. */
  mid: string;
  /** The Instagram-scoped id of the person who wrote. Only ever valid from a real delivery. */
  senderId: string;
  /** The Instagram account they wrote to. */
  recipientId: string;
  text: string | null;
  sentAt: Date;
  isEcho: boolean;
}

/**
 * Pulls the messages out of a webhook body, tolerating everything Meta might add later.
 *
 * DEFENSIVE BY DESIGN. This parses a payload from the public internet that has already proved its
 * signature but not its shape, and an unexpected field must not throw away the whole delivery —
 * which would mean dropping the other messages in the same batch.
 */
export const parseInstagramWebhookBody = (body: unknown): InstagramInboundMessage[] => {
  const entries = (body as { entry?: unknown[] })?.entry;

  if (!Array.isArray(entries)) {
    return [];
  }

  const messages: InstagramInboundMessage[] = [];

  for (const entry of entries) {
    const recipientFromEntry = String((entry as { id?: unknown })?.id ?? '');
    const events = (entry as { messaging?: unknown[] })?.messaging;

    if (!Array.isArray(events)) {
      continue;
    }

    for (const event of events) {
      const typed = event as {
        sender?: { id?: unknown };
        recipient?: { id?: unknown };
        timestamp?: unknown;
        message?: { mid?: unknown; text?: unknown; is_echo?: unknown };
      };

      const mid = typed.message?.mid;

      // No message id means nothing can be deduplicated, and a read receipt or a reaction has
      // none. Skipped rather than stored.
      if (typeof mid !== 'string' || mid === '') {
        continue;
      }

      const senderId = String(typed.sender?.id ?? '');
      const recipientId = String(typed.recipient?.id ?? '') || recipientFromEntry;

      if (senderId === '' || recipientId === '') {
        continue;
      }

      const timestamp = Number(typed.timestamp);

      messages.push({
        mid,
        senderId,
        recipientId,
        text: typeof typed.message?.text === 'string' ? typed.message.text : null,
        sentAt: Number.isFinite(timestamp) ? new Date(timestamp) : new Date(),
        isEcho: typed.message?.is_echo === true,
      });
    }
  }

  return messages;
};

/** Finds the workspace that owns the Instagram account a DM was sent to. */
const resolveAccount = async (
  recipientId: string,
): Promise<InstagramAccountDocument | null> =>
  InstagramAccount.findOne({
    instagramAccountId: recipientId,
    // A disconnected account keeps its row so reconnecting is possible, but stops receiving.
    status: { $ne: 'disconnected' },
  }).lean<InstagramAccountDocument | null>();

/**
 * The contact behind an Instagram-scoped id.
 *
 * KEYED ON `providerContactKey`, the field contacts already use for a provider's own identifier,
 * prefixed so an IGSID can never collide with a WhatsApp JID. An IGSID is scoped to one app and
 * one account, so the same human messaging two connected accounts is two contacts — which is
 * correct, because there is no way to know they are the same person.
 */
const resolveContact = async ({
  organizationId,
  senderId,
}: {
  organizationId: Types.ObjectId;
  senderId: string;
}) => {
  const providerContactKey = `ig:${senderId}`;

  const existing = await Contact.findOne({ organizationId, providerContactKey }).exec();

  if (existing) {
    return existing;
  }

  try {
    return await Contact.create({
      organizationId,
      providerContactKey,
      // No phone, no email and no display name: Instagram gives none of them on a webhook, and a
      // handle needs a Graph call this path deliberately does not make — ingestion must not
      // depend on a second request that can fail.
    });
  } catch (error) {
    // Two deliveries from one new sender arriving together. Whoever lost the race re-reads.
    if ((error as { code?: number })?.code === 11000) {
      return Contact.findOne({ organizationId, providerContactKey }).exec();
    }

    throw error;
  }
};

/** Finds or creates the thread for one person on one Instagram account. */
const resolveConversation = async ({
  account,
  contactId,
  sentAt,
}: {
  account: InstagramAccountDocument;
  contactId: Types.ObjectId;
  sentAt: Date;
}) => {
  const existing = await Conversation.findOne({
    organizationId: account.organizationId,
    instagramAccountId: account._id,
    contactId,
  }).exec();

  if (existing) {
    return existing;
  }

  const leadId = await createUniqueLeadId({
    exists: async (candidate: string) =>
      (await Conversation.countDocuments({
        organizationId: account.organizationId,
        leadId: candidate,
      }).exec()) > 0,
  });

  try {
    return await Conversation.create({
      organizationId: account.organizationId,
      channel: CONVERSATION_CHANNELS.INSTAGRAM,
      instagramAccountId: account._id,
      // Deliberately absent, not null-and-required: the conditional `required` on the Conversation
      // model exempts Instagram, and leaving it unset keeps every WhatsApp query from matching it.
      contactId,
      leadId,
      status: 'open',
      stage: 'new',
      unreadCount: 0,
      // AUTOMATION STARTS ON, GATED BY THE ACCOUNT. This flag is the per-thread takeover switch;
      // whether anything is actually sent depends on `account.automationEnabled`, which is off by
      // default. Starting it false would make "resume" the first thing staff had to do.
      aiAutomationEnabled: true,
      lastInboundAt: sentAt,
    });
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) {
      return Conversation.findOne({
        organizationId: account.organizationId,
        instagramAccountId: account._id,
        contactId,
      }).exec();
    }

    throw error;
  }
};

/**
 * Files one inbound DM, or reports that it was already filed.
 *
 * Returns whether this delivery is NEW, because only a new message should trigger an automatic
 * reply — a redelivery must not send the welcome message a second time.
 */
export const recordInstagramMessage = async ({
  account,
  inbound,
}: {
  account: InstagramAccountDocument;
  inbound: InstagramInboundMessage;
}): Promise<{ isNew: boolean; conversationId: Types.ObjectId; contactId: Types.ObjectId }> => {
  const contact = await resolveContact({
    organizationId: account.organizationId,
    senderId: inbound.senderId,
  });

  if (!contact) {
    throw new Error('INSTAGRAM_CONTACT_UNRESOLVED');
  }

  const conversation = await resolveConversation({
    account,
    contactId: contact._id,
    sentAt: inbound.sentAt,
  });

  if (!conversation) {
    throw new Error('INSTAGRAM_CONVERSATION_UNRESOLVED');
  }

  let isNew = true;

  try {
    await Message.create({
      organizationId: account.organizationId,
      channel: CONVERSATION_CHANNELS.INSTAGRAM,
      instagramAccountId: account._id,
      whatsappAccountId: null,
      conversationId: conversation._id,
      contactId: contact._id,
      providerMessageId: inbound.mid,
      direction: MESSAGE_DIRECTIONS.IN,
      type: MESSAGE_TYPES.TEXT,
      body: inbound.text,
      status: MESSAGE_STATUSES.DELIVERED,
      sentAt: inbound.sentAt,
      providerTimestamp: inbound.sentAt,
    });
  } catch (error) {
    // THE DEDUPE. A redelivery of a message already filed collides on the unique index, which is
    // the whole guarantee — and `isNew: false` is what stops it triggering a second reply.
    if ((error as { code?: number })?.code === 11000) {
      isNew = false;
    } else {
      throw error;
    }
  }

  if (isNew) {
    await Conversation.updateOne(
      { _id: conversation._id, organizationId: account.organizationId },
      {
        $set: { lastInboundAt: inbound.sentAt, updatedAt: new Date() },
        $inc: { unreadCount: 1 },
      },
    ).exec();

    await InstagramAccount.updateOne(
      { _id: account._id },
      { $set: { lastInboundAt: inbound.sentAt } },
    ).exec();
  }

  return { isNew, conversationId: conversation._id, contactId: contact._id };
};

/**
 * Handles one webhook body end to end.
 *
 * NEVER THROWS PER MESSAGE. One malformed or unroutable event must not cost the others in the
 * same batch — but a failure that could be transient returns `failed: true` so the inbox retries
 * the whole delivery, which is safe precisely because every write in it deduplicates.
 */
export const handleInstagramWebhookBody = async (
  body: unknown,
): Promise<{ failed: boolean; handled: number; skipped: number }> => {
  const messages = parseInstagramWebhookBody(body);

  let handled = 0;
  let skipped = 0;
  let failed = false;

  for (const inbound of messages) {
    // Our own outbound send, reflected back. Filing it as inbound would make the AI answer itself.
    if (inbound.isEcho) {
      skipped += 1;
      continue;
    }

    try {
      const account = await resolveAccount(inbound.recipientId);

      if (!account) {
        // Nobody has connected this account. There is no inbox this belongs to, and storing it
        // against a default workspace would put a stranger's DM in somebody's CRM.
        skipped += 1;
        logger.warn({}, 'Instagram delivery for an account no workspace has connected; dropped.');
        continue;
      }

      const { isNew, conversationId, contactId } = await recordInstagramMessage({
        account,
        inbound,
      });

      handled += 1;

      if (isNew) {
        const { runInstagramAutomation } = await import('./instagram-automation.service.js');

        // Failure-isolated: an inbound message must be filed whether or not a reply can be sent.
        await runInstagramAutomation({
          account,
          conversationId,
          contactId,
          senderId: inbound.senderId,
          text: inbound.text,
        }).catch((error: unknown) => {
          logger.error(
            { name: (error as { name?: string })?.name },
            'Instagram automation threw after the message was filed.',
          );
        });
      }
    } catch (error) {
      failed = true;
      logger.error(
        { name: (error as { name?: string })?.name },
        'Instagram delivery failed; retained for retry.',
      );
    }
  }

  return { failed, handled, skipped };
};
