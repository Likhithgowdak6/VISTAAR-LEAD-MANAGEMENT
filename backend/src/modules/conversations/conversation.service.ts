import { type HydratedDocument } from 'mongoose';

import { ACCOUNT_STATUSES } from '../../constants/account-statuses.js';
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { type ConversationStatus } from '../../constants/conversation-statuses.js';
import { PERMISSIONS, type Permission } from '../../constants/permissions.js';
import { runInTransaction } from '../../config/database.js';
import { type ObjectIdLike } from '../../types/common.js';
import { canUserAccessAccount } from '../auth/account-access.service.js';
import { getSessionManager } from '../whatsapp/sessions/session-manager.instance.js';
import {
  createActivity,
  findActivityForConversation,
} from '../activity/activity-log.repository.js';
import { serializeActivityLog } from '../activity/activity-log.serializer.js';
import { findContactById } from '../contacts/contact.repository.js';
import { serializeContact } from '../contacts/contact.serializer.js';
import { findLeadSubmissionsForConversation } from '../lead-sources/lead-submission.repository.js';
import { serializeLeadSubmission } from '../lead-sources/lead-submission.serializer.js';
import { createOutboundMessageService } from '../messages/outbound-message.service.js';
import { findMessagesByConversationCursor } from '../messages/message.repository.js';
import { serializeMessage } from '../messages/message.serializer.js';
import { REALTIME_REASONS } from '../realtime/realtime.events.js';
import { enqueueConversationChanged } from '../realtime/realtime-outbox.repository.js';
import { resolveUsableStageValue } from '../stages/stage.service.js';
import { type UserDocument } from '../users/user.model.js';
import { findAccountById } from '../whatsapp-accounts/whatsapp-account.repository.js';
import { CATEGORY_PLAYBOOKS } from '../ai-brain/category-playbooks.js';
import { cancelQueuedMessagesForConversation } from '../messages/message.repository.js';
import { AUDIT_EVENTS } from '../../constants/audit-events.js';
import { createAuditLog } from '../audit/audit.repository.js';
import {
  findConversationByAccountAndContact,
  findConversationById,
  findConversationByIdIncludingDeleted,
  listConversations,
  markConversationRead,
  restoreConversation,
  setAiCategory,
  softDeleteConversation,
  updateAssignment,
  updateConversationAccount,
  updateStage,
} from './conversation.repository.js';
import { type ConversationDocument } from './conversation.model.js';
import { serializeConversation } from './conversation.serializer.js';

const outboundMessageService = createOutboundMessageService();

const canReadAll = (permissions: readonly Permission[] = []): boolean =>
  permissions.includes(PERMISSIONS.CONVERSATIONS_READ_ALL);

export interface AssertConversationVisibleParams {
  conversation: ConversationDocument;
  permissions: readonly Permission[];
  actorId: ObjectIdLike;
}

const assertConversationVisible = ({
  conversation,
  permissions,
  actorId,
}: AssertConversationVisibleParams): void => {
  if (canReadAll(permissions)) {
    return;
  }

  if (!conversation.assignedTo || conversation.assignedTo.toString() !== actorId.toString()) {
    throw new Error('CONVERSATION_ACCESS_DENIED');
  }
};

export interface LoadVisibleConversationForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actorId: ObjectIdLike;
}

export const loadVisibleConversationForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actorId,
}: LoadVisibleConversationForActorParams) => {
  const conversation = await findConversationById({
    conversationId,
    organizationId,
  });

  if (!conversation) {
    throw new Error('CONVERSATION_NOT_FOUND');
  }

  assertConversationVisible({
    conversation,
    permissions,
    actorId,
  });

  return conversation;
};

const loadVisibleConversation = loadVisibleConversationForActor;

export interface ListConversationsForActorParams {
  organizationId: ObjectIdLike;
  actorId: ObjectIdLike;
  permissions: readonly Permission[];
  whatsappAccountId?: ObjectIdLike;
  stage?: string;
  tagIds?: readonly ObjectIdLike[];
  status?: ConversationStatus;
  limit?: number;
  skip?: number;
}

export const listConversationsForActor = async ({
  organizationId,
  actorId,
  permissions,
  whatsappAccountId,
  stage,
  tagIds,
  status,
  limit,
  skip,
}: ListConversationsForActorParams) => {
  const conversations = await listConversations({
    organizationId,
    whatsappAccountId,
    assignedTo: canReadAll(permissions) ? undefined : actorId,
    stage,
    tagIds,
    status,
    limit,
    skip,
  });

  return conversations.map((conversation) => serializeConversation(conversation));
};

export interface GetConversationForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actorId: ObjectIdLike;
}

export const getConversationForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actorId,
}: GetConversationForActorParams) => {
  const conversation = await loadVisibleConversation({
    organizationId,
    conversationId,
    permissions,
    actorId,
  });

  // Opening the conversation is how an agent "sees" it — clear the unread badge so it
  // doesn't linger after the thread has already been read.
  let viewedConversation = conversation;
  if (conversation.unreadCount > 0) {
    viewedConversation = await runInTransaction(async (session) => {
      const updated =
        (await markConversationRead({
          conversationId: conversation._id,
          organizationId,
          session,
        })) ?? conversation;

      await enqueueConversationChanged({
        organizationId,
        conversationId: conversation._id,
        assignedTo: conversation.assignedTo,
        reason: REALTIME_REASONS.READ,
        session,
      });

      return updated;
    });
  }

  const [contact, whatsappAccount] = await Promise.all([
    findContactById({
      contactId: conversation.contactId,
      organizationId,
    }),
    findAccountById({
      accountId: conversation.whatsappAccountId,
      organizationId,
    }),
  ]);

  return {
    conversation: serializeConversation(viewedConversation),
    contact: serializeContact(contact),
    // Only the labelling fields — every role that can see the thread may see which number it
    // arrived on, but not the account's settings or connection detail.
    whatsappAccount: whatsappAccount
      ? {
          id: whatsappAccount._id.toString(),
          name: whatsappAccount.name,
          brandKey: whatsappAccount.brandKey,
          status: whatsappAccount.status,
        }
      : null,
  };
};

export interface GetConversationMessagesForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actorId: ObjectIdLike;
  beforeSentAt?: Date;
  beforeId?: ObjectIdLike;
  limit?: number;
}

export const getConversationMessagesForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actorId,
  beforeSentAt,
  beforeId,
  limit,
}: GetConversationMessagesForActorParams) => {
  await loadVisibleConversation({
    organizationId,
    conversationId,
    permissions,
    actorId,
  });

  const messages = await findMessagesByConversationCursor({
    organizationId,
    conversationId,
    beforeSentAt,
    beforeId,
    limit,
  });

  return messages.map((message) => serializeMessage(message));
};

export interface AssignConversationForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  assignedTo?: ObjectIdLike | null;
  assignedTeam?: string | null;
}

export const assignConversationForActor = async ({
  organizationId,
  conversationId,
  actor,
  assignedTo,
  assignedTeam,
}: AssignConversationForActorParams) => {
  const conversation = await findConversationById({
    conversationId,
    organizationId,
  });

  if (!conversation) {
    throw new Error('CONVERSATION_NOT_FOUND');
  }

  const updated = await runInTransaction(async (session) => {
    const updated = await updateAssignment({
      conversationId: conversation._id,
      organizationId,
      assignedTo,
      assignedTeam,
      lastHandledBy: actor._id,
      session,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.CONVERSATION_ASSIGNED,
      summary: assignedTo ? 'Conversation assigned to a team member.' : 'Conversation unassigned.',
      metadata: {
        assigned: Boolean(assignedTo),
      },
      session,
    });

    await enqueueConversationChanged({
      organizationId,
      conversationId: conversation._id,
      assignedTo: updated?.assignedTo ?? assignedTo ?? null,
      reason: REALTIME_REASONS.ASSIGNMENT,
      session,
    });

    return updated;
  });

  return serializeConversation(updated);
};

export interface ChangeConversationStageForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actor: HydratedDocument<UserDocument>;
  stage: string;
}

export const changeConversationStageForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
  stage,
}: ChangeConversationStageForActorParams) => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  // The Mongoose schema no longer enforces a fixed enum (custom stages can't be one), so the
  // service is the safety net: the value must be a built-in or an active custom stage for this
  // org. Returns the canonical stored form (e.g. normalized casing for a custom stage's key).
  const resolvedStage = await resolveUsableStageValue({ organizationId, stage });

  const updated = await runInTransaction(async (session) => {
    const updated = await updateStage({
      conversationId: conversation._id,
      organizationId,
      stage: resolvedStage,
      lastHandledBy: actor._id,
      session,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.CONVERSATION_STAGE_CHANGED,
      summary: `Conversation stage changed to ${resolvedStage}.`,
      metadata: {
        stage: resolvedStage,
      },
      session,
    });

    await enqueueConversationChanged({
      organizationId,
      conversationId: conversation._id,
      assignedTo: conversation.assignedTo,
      reason: REALTIME_REASONS.STAGE,
      session,
    });

    return updated;
  });

  return serializeConversation(updated);
};

/**
 * Every category an owner may pick, sorted. Derived from CATEGORY_PLAYBOOKS rather than written
 * out again, so a playbook added to that table is immediately selectable with no second edit.
 */
export const SELECTABLE_AI_CATEGORIES: readonly string[] = Object.freeze(
  Object.keys(CATEGORY_PLAYBOOKS).sort(),
);

export interface ChangeConversationCategoryForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actor: HydratedDocument<UserDocument>;
  aiCategory: string;
}

/**
 * The owner correcting which service playbook a lead is handled under.
 *
 * This is the ONLY way a classification can be changed once set: the model gets one shot
 * (nodes.py refuses to reclassify a conversation it has already categorised, and
 * mergeConversationAiContext refuses to write over a non-empty value). Both of those guard against
 * the model flip-flopping mid-conversation; neither should stand in a person's way.
 *
 * Takes effect on the next AI turn, because the playbook is read fresh per call in
 * ai-brain-context.service.ts - there is nothing cached to invalidate.
 */
export const changeConversationCategoryForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
  aiCategory,
}: ChangeConversationCategoryForActorParams) => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  // A key with no playbook would silently fall back to the generic `unknown` brief, which looks
  // exactly like a successful save and behaves nothing like one.
  if (!Object.hasOwn(CATEGORY_PLAYBOOKS, aiCategory)) {
    throw new Error('INVALID_AI_CATEGORY');
  }

  const previous = conversation.aiCategory ?? 'unknown';

  const updated = await runInTransaction(async (session) => {
    const updated = await setAiCategory({
      conversationId: conversation._id,
      organizationId,
      aiCategory,
      lastHandledBy: actor._id,
      session,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.CONVERSATION_CATEGORY_CHANGED,
      summary: `Service changed from ${previous.replace(/_/g, ' ')} to ${aiCategory.replace(/_/g, ' ')}.`,
      metadata: {
        aiCategory,
        previousAiCategory: previous,
      },
      session,
    });

    await enqueueConversationChanged({
      organizationId,
      conversationId: conversation._id,
      assignedTo: conversation.assignedTo,
      reason: REALTIME_REASONS.CATEGORY,
      session,
    });

    return updated;
  });

  return serializeConversation(updated);
};

export interface DeleteConversationForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actor: HydratedDocument<UserDocument>;
}

/**
 * The owner deleting a chat from the inbox.
 *
 * ORDER MATTERS. The queued-message cancellation runs INSIDE the same transaction as the hide, and
 * the hide happens first: if the cancel throws, the whole thing rolls back and the conversation
 * stays visible rather than becoming a hidden thread with a live message still on its way out. A
 * half-applied delete here is the one outcome that is worse than no delete at all.
 *
 * Audited, unlike most soft deletes in this codebase, because the usual argument ("the surviving
 * document records it") does not hold: the ActivityLog rows that would show what happened hang off
 * the conversation that has just been hidden, so the audit log is the only place this is legible
 * afterwards.
 */
export const deleteConversationForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
}: DeleteConversationForActorParams) => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const updated = await runInTransaction(async (session) => {
    const updated = await softDeleteConversation({
      conversationId: conversation._id,
      organizationId,
      session,
    });

    await cancelQueuedMessagesForConversation({
      conversationId: conversation._id,
      organizationId,
      session,
    });

    await enqueueConversationChanged({
      organizationId,
      conversationId: conversation._id,
      assignedTo: conversation.assignedTo,
      reason: REALTIME_REASONS.DELETED,
      session,
    });

    return updated;
  });

  await createAuditLog({
    organizationId,
    eventType: AUDIT_EVENTS.CONVERSATION_DELETED,
    actorId: actor._id,
    metadata: {
      conversationId: conversation._id.toString(),
      leadId: conversation.leadId,
      displayName: conversation.displayName,
      stage: conversation.stage,
    },
  });

  return serializeConversation(updated);
};

export interface RestoreConversationForActorParams extends DeleteConversationForActorParams {}

/** Brings a deleted chat back. Automation stays off - see restoreConversation on why. */
export const restoreConversationForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
}: RestoreConversationForActorParams) => {
  // The one place that must see deleted rows: `loadVisibleConversationForActor` goes through
  // findConversationById, which filters them out, so a restore would 404 on its own target.
  const conversation = await findConversationByIdIncludingDeleted({
    conversationId,
    organizationId,
  });

  if (!conversation) {
    throw new Error('CONVERSATION_NOT_FOUND');
  }

  assertConversationVisible({ conversation, permissions, actorId: actor._id });

  const updated = await runInTransaction(async (session) => {
    const updated = await restoreConversation({
      conversationId: conversation._id,
      organizationId,
      session,
    });

    await enqueueConversationChanged({
      organizationId,
      conversationId: conversation._id,
      assignedTo: conversation.assignedTo,
      reason: REALTIME_REASONS.DELETED,
      session,
    });

    return updated;
  });

  await createAuditLog({
    organizationId,
    eventType: AUDIT_EVENTS.CONVERSATION_RESTORED,
    actorId: actor._id,
    metadata: {
      conversationId: conversation._id.toString(),
      leadId: conversation.leadId,
    },
  });

  return serializeConversation(updated);
};

export interface GetConversationActivityForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actorId: ObjectIdLike;
  limit?: number;
  skip?: number;
}

export const getConversationActivityForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actorId,
  limit,
  skip,
}: GetConversationActivityForActorParams) => {
  await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId,
  });

  const activity = await findActivityForConversation({
    organizationId,
    conversationId,
    limit,
    skip,
  });

  return activity.map((entry) => serializeActivityLog(entry));
};

export interface GetLeadSubmissionsForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actor: Pick<UserDocument, '_id'> | HydratedDocument<UserDocument>;
  limit?: number;
}

/**
 * The lead's form submissions, for the lead panel. Gated on ordinary conversation visibility,
 * not on a PII permission: the serializer already withholds the name, email, phone and inbox
 * URL, leaving the answers that make the lead workable.
 */
export const getLeadSubmissionsForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
  limit,
}: GetLeadSubmissionsForActorParams) => {
  await loadVisibleConversation({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const submissions = await findLeadSubmissionsForConversation({
    organizationId,
    conversationId,
    limit,
  });

  return submissions.map((submission) => serializeLeadSubmission(submission));
};

export interface SendMessageForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actor: HydratedDocument<UserDocument>;
  body: string;
  idempotencyKey: string;
  /** Send from a different number than the thread's; omitted means "the one it is already on". */
  whatsappAccountId?: ObjectIdLike;
}

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);

export interface SwitchConversationAccountParams {
  organizationId: ObjectIdLike;
  conversation: ConversationDocument;
  whatsappAccountId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
}

/**
 * Re-homes a lead onto another WhatsApp number before sending from it.
 *
 * The thread moves rather than the message carrying a one-off sender, because the customer will
 * reply to whichever number they were messaged from: leaving the thread behind would land that
 * reply in a second conversation for the same person. The target must be live — a queued
 * message for a dead session would wait indefinitely — and within the user's account access.
 */
const switchConversationAccount = async ({
  organizationId,
  conversation,
  whatsappAccountId,
  actor,
}: SwitchConversationAccountParams): Promise<ConversationDocument> => {
  const account = await findAccountById({ accountId: whatsappAccountId, organizationId });

  if (!account || account.status !== ACCOUNT_STATUSES.ACTIVE) {
    throw new Error('WHATSAPP_ACCOUNT_NOT_SENDABLE');
  }

  if (!canUserAccessAccount({ user: actor, accountId: account._id })) {
    throw new Error('WHATSAPP_ACCOUNT_ACCESS_DENIED');
  }

  if (getSessionManager().getSessionState(account._id).running !== true) {
    throw new Error('WHATSAPP_ACCOUNT_NOT_CONNECTED');
  }

  try {
    return await runInTransaction(async (session) => {
      const updated = await updateConversationAccount({
        conversationId: conversation._id,
        organizationId,
        whatsappAccountId: account._id,
        actorId: actor._id,
        session,
      });

      if (!updated) {
        throw new Error('CONVERSATION_NOT_FOUND');
      }

      await createActivity({
        organizationId,
        whatsappAccountId: account._id,
        conversationId: conversation._id,
        actorId: actor._id,
        eventType: ACTIVITY_EVENTS.CONVERSATION_ACCOUNT_CHANGED,
        summary: `Conversation moved to ${account.name}.`,
        metadata: {
          whatsappAccountId: account._id.toString(),
          accountName: account.name,
        },
        session,
      });

      await enqueueConversationChanged({
        organizationId,
        conversationId: conversation._id,
        assignedTo: conversation.assignedTo,
        reason: REALTIME_REASONS.ACCOUNT,
        session,
      });

      return updated;
    });
  } catch (error: unknown) {
    // The unique (organization, account, contact) index refused the move: this contact already
    // has a thread on the target number. Merging two threads' history is not something to do
    // implicitly, so the caller is pointed at the existing one instead.
    if (isDuplicateKeyError(error)) {
      const existing = await findConversationByAccountAndContact({
        organizationId,
        whatsappAccountId,
        contactId: conversation.contactId,
      });

      const conflictError = new Error('CONVERSATION_ACCOUNT_CONFLICT') as Error & {
        conflictingConversationId?: string;
      };
      conflictError.conflictingConversationId = existing?._id.toString();

      throw conflictError;
    }

    throw error;
  }
};

export const sendMessageForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
  body,
  idempotencyKey,
  whatsappAccountId,
}: SendMessageForActorParams) => {
  const conversation = await loadVisibleConversation({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const isAccountSwitch =
    whatsappAccountId !== undefined &&
    whatsappAccountId.toString() !== conversation.whatsappAccountId.toString();

  const targetConversation = isAccountSwitch
    ? await switchConversationAccount({
        organizationId,
        conversation,
        whatsappAccountId,
        actor,
      })
    : conversation;

  return outboundMessageService.enqueueOutboundMessage({
    organizationId,
    conversation: targetConversation,
    actor,
    body,
    idempotencyKey,
  });
};
