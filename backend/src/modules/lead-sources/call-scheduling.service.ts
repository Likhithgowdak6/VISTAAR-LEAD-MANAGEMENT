/**
 * Starting the one-hour clock, and stopping it when the customer answers.
 *
 * WHERE THE CLOCK STARTS, and why it is not anywhere earlier. The greeting is generated, queued,
 * claimed by the delivery runner and only then sent; quiet hours can hold it overnight and a
 * dead socket can hold it indefinitely. Starting an hour's countdown at any of those earlier
 * points would chase a customer who had not yet been asked anything. So registration hangs off
 * the one event that means the message actually reached WhatsApp - the same successful-send hook
 * the lead-qualification confirmation uses.
 *
 * ELIGIBILITY IS PROVED, NOT ASSUMED. Three independent facts have to line up, and each one is
 * read from persisted state rather than inferred:
 *
 *   1. the message is the AI's auto-greet for this conversation, identified by the idempotency
 *      key the greeting path already builds;
 *   2. the conversation has a LeadSubmission - an actual Meta form submission row, unique per
 *      (organization, source, Meta lead id);
 *   3. that submission's source is a `meta_lead_ads` source with the workflow switched on.
 *
 * A phone number, a contact name, a message body or a "looks like a lead" flag prove none of
 * this, and none of them are consulted. A manual lead has no submission. A Google Sheet lead has
 * a submission but the wrong source kind. An ordinary WhatsApp conversation has neither.
 */
import { type HydratedDocument } from 'mongoose';

import { LEAD_SOURCE_KINDS } from '../../constants/lead-source-kinds.js';
import { MESSAGE_AUTHORS } from '../../constants/message-authors.js';
import { type ObjectIdLike } from '../../types/common.js';
import { type MessageDocument } from '../messages/message.model.js';
import { findLeadSourceById as defaultFindLeadSourceById } from './lead-source.repository.js';
import { findLeadSubmissionsForConversation as defaultFindSubmissions } from './lead-submission.repository.js';
import {
  markCallSchedulingReplied as defaultMarkReplied,
  registerCallSchedulingAttempt as defaultRegisterAttempt,
} from './call-scheduling-attempt.repository.js';

type Logger = { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };

/**
 * `console`, not the configured pino logger, and deliberately.
 *
 * This module is imported by outbound-delivery.service.ts, which defaults its own logger the
 * same way for the same reason: importing config/logger drags the logging configuration into
 * every module that merely touches the delivery path, and its tests then fail at import time
 * rather than on anything they assert. Callers that have the real logger inject it.
 */
const defaultLogger: Logger = console;

/**
 * The idempotency key the AI greeting is queued under.
 *
 * ai-brain.service.ts builds `ai-brain-asked:<inboundMessageId>`, and the greeting path passes
 * `auto-greet:<conversationId>` as that id. Matching on the prefix is what keeps this off the
 * hot path: an ordinary AI reply fails this check in a string comparison and never touches the
 * database.
 */
export const AUTO_GREET_KEY_PREFIX = 'ai-brain-asked:auto-greet:';

export const isAutoGreetMessage = (message: {
  authoredBy?: unknown;
  idempotencyKey?: unknown;
}): boolean =>
  message.authoredBy === MESSAGE_AUTHORS.AI &&
  typeof message.idempotencyKey === 'string' &&
  message.idempotencyKey.startsWith(AUTO_GREET_KEY_PREFIX);

export interface CreateCallSchedulingServiceOptions {
  findLeadSubmissionsForConversation?: typeof defaultFindSubmissions;
  findLeadSourceById?: typeof defaultFindLeadSourceById;
  registerCallSchedulingAttempt?: typeof defaultRegisterAttempt;
  markCallSchedulingReplied?: typeof defaultMarkReplied;
  logger?: Logger;
}

export const createCallSchedulingService = ({
  findLeadSubmissionsForConversation = defaultFindSubmissions,
  findLeadSourceById = defaultFindLeadSourceById,
  registerCallSchedulingAttempt = defaultRegisterAttempt,
  markCallSchedulingReplied = defaultMarkReplied,
  logger = defaultLogger,
}: CreateCallSchedulingServiceOptions = {}) => {
  /**
   * Called for every outbound message that reaches WhatsApp. Does nothing for almost all of them.
   *
   * Never throws: this runs inside the delivery service's success path, and a message that WAS
   * delivered must not be turned into a failure - that would resend it.
   */
  const onOutboundMessageSent = async ({
    message,
    organizationId,
    sentAt,
  }: {
    message: HydratedDocument<MessageDocument> | MessageDocument;
    organizationId: ObjectIdLike;
    sentAt: Date;
  }): Promise<void> => {
    if (!isAutoGreetMessage(message)) {
      return;
    }

    try {
      const submissions = await findLeadSubmissionsForConversation({
        organizationId,
        conversationId: message.conversationId,
      });

      // The repository already sorts newest first, so a lead who enquired twice starts a clock
      // for the submission that actually prompted this greeting rather than one from last
      // month. The decrypted payload it also returns is deliberately not read here - this
      // decision needs provenance, not the customer's answers.
      const submission = (submissions ?? [])[0]?.submission;

      if (!submission) {
        // No form submission behind this conversation - a manual lead, or one the owner
        // approved for outreach by hand. Greeted, but never chased.
        return;
      }

      const leadSource = await findLeadSourceById({
        leadSourceId: submission.leadSourceId,
        organizationId,
      });

      if (
        leadSource?.kind !== LEAD_SOURCE_KINDS.META_LEAD_ADS ||
        leadSource?.callSchedulingEnabled !== true
      ) {
        return;
      }

      await registerCallSchedulingAttempt({
        organizationId,
        leadSubmissionId: submission._id,
        conversationId: message.conversationId,
        whatsappAccountId: message.whatsappAccountId ?? null,
        initialMessageId: message._id,
        sentAt,
      });

      logger?.info?.(
        {
          conversationId: String(message.conversationId),
          leadSubmissionId: String(submission._id),
        },
        'CALL_SCHEDULING: asked for a call time; chasing in one hour if they do not reply.',
      );
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      // RECOVERABLE, NOT SILENT. The greeting went out either way; what is lost is the chase.
      // Logged with the conversation so an operator can see which lead has no clock running.
      logger?.error?.(
        { code: err?.code, name: err?.name, conversationId: String(message.conversationId) },
        'CALL_SCHEDULING: could not register the follow-up clock for a delivered greeting.',
      );
    }
  };

  /**
   * Called for every inbound customer message. Stops the chase for that thread.
   *
   * DELIBERATELY ANY MESSAGE. "Okay", "I'm busy", a thumbs-up - all of them mean the person is
   * there and has seen it, which is the only question the one-hour chase was asking. Whether
   * they named a time is a separate matter handled by commitment extraction, which runs on its
   * own and is untouched by this.
   *
   * Uses the message's own timestamp, so a reply that arrived before the deadline still counts
   * as timely even when the webhook reaches us late.
   */
  const onInboundMessage = async ({
    organizationId,
    conversationId,
    receivedAt,
  }: {
    organizationId: ObjectIdLike;
    conversationId: ObjectIdLike;
    receivedAt?: Date;
  }): Promise<void> => {
    try {
      const cancelled = await markCallSchedulingReplied({
        organizationId,
        conversationId,
        repliedAt: receivedAt ?? new Date(),
      });

      if (cancelled) {
        logger?.info?.(
          { conversationId: String(conversationId) },
          'CALL_SCHEDULING: customer replied; the one-hour chase is cancelled.',
        );
      }
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      // Failing here means the chase may still fire. That is the safer direction than letting
      // an exception escape into ingestion and cost the lead their message.
      logger?.error?.(
        { code: err?.code, name: err?.name },
        'CALL_SCHEDULING: could not cancel the chase after an inbound message.',
      );
    }
  };

  return { onOutboundMessageSent, onInboundMessage };
};

export type CallSchedulingService = ReturnType<typeof createCallSchedulingService>;
