/**
 * Messages a user kept for themselves.
 *
 * THE OWNERSHIP RULE IS THE ONLY INTERESTING THING IN THIS FILE, and it lives in the repository
 * rather than here: every call passes both `organizationId` and `userId` into the query. There
 * is deliberately no "load it, then check who owns it" step anywhere - that shape is how an id
 * from another account eventually slips through, because the check is a separate line somebody
 * can forget to write.
 *
 * STARRING IS IDEMPOTENT. The same bubble starred twice returns the existing record instead of
 * creating a second. The database enforces it too, with a partial unique index; this exists so
 * the normal case is a 200 with the thing the user already has, rather than a duplicate-key
 * error they would have to interpret.
 */
import { type ObjectIdLike } from '../../types/common.js';
import {
  createStarredMessage,
  deleteStarredMessage,
  findStarredMessageById,
  findStarredMessageBySource,
  findStarredMessages,
  updateStarredMessage,
} from './starred-message.repository.js';
import {
  serializeStarredMessage,
  type SerializedStarredMessage,
} from './starred-message.serializer.js';

export const STARRED_MESSAGE_NOT_FOUND = 'STARRED_MESSAGE_NOT_FOUND';

export interface ListStarredMessagesParams {
  organizationId: ObjectIdLike;
  userId: ObjectIdLike;
  search?: string;
}

export const listStarredMessagesForUser = async ({
  organizationId,
  userId,
  search,
}: ListStarredMessagesParams): Promise<(SerializedStarredMessage | null)[]> => {
  const saved = await findStarredMessages({ organizationId, userId, search });

  return saved.map((entry) => serializeStarredMessage(entry));
};

export interface SaveStarredMessageParams {
  organizationId: ObjectIdLike;
  userId: ObjectIdLike;
  title: string;
  body: string;
  sourceMessageId?: ObjectIdLike | null;
  sourceConversationId?: ObjectIdLike | null;
}

export const saveStarredMessageForUser = async ({
  organizationId,
  userId,
  title,
  body,
  sourceMessageId = null,
  sourceConversationId = null,
}: SaveStarredMessageParams): Promise<SerializedStarredMessage | null> => {
  // Starring the same bubble twice - two taps, or two devices - hands back what is already
  // saved. The unique index would otherwise turn an ordinary double-tap into a 500.
  if (sourceMessageId) {
    const existing = await findStarredMessageBySource({
      organizationId,
      userId,
      sourceMessageId,
    });

    if (existing) {
      return serializeStarredMessage(existing);
    }
  }

  const created = await createStarredMessage({
    organizationId,
    userId,
    title,
    body,
    sourceMessageId,
    sourceConversationId,
  });

  return serializeStarredMessage(created);
};

export interface EditStarredMessageParams {
  organizationId: ObjectIdLike;
  userId: ObjectIdLike;
  starredMessageId: ObjectIdLike;
  title?: string;
  body?: string;
}

export const editStarredMessageForUser = async ({
  organizationId,
  userId,
  starredMessageId,
  title,
  body,
}: EditStarredMessageParams): Promise<SerializedStarredMessage | null> => {
  const updated = await updateStarredMessage({
    starredMessageId,
    organizationId,
    userId,
    title,
    body,
  });

  // Null covers both "no such id" and "not yours" - and must stay indistinguishable. Telling
  // the caller which one it was confirms the existence of another user's record.
  if (!updated) {
    throw new Error(STARRED_MESSAGE_NOT_FOUND);
  }

  return serializeStarredMessage(updated);
};

export interface RemoveStarredMessageParams {
  organizationId: ObjectIdLike;
  userId: ObjectIdLike;
  starredMessageId: ObjectIdLike;
}

export const removeStarredMessageForUser = async ({
  organizationId,
  userId,
  starredMessageId,
}: RemoveStarredMessageParams): Promise<SerializedStarredMessage | null> => {
  // Read first so a wrong id is a 404 rather than a silent success, matching the templates and
  // knowledge modules.
  const existing = await findStarredMessageById({ starredMessageId, organizationId, userId });

  if (!existing) {
    throw new Error(STARRED_MESSAGE_NOT_FOUND);
  }

  const removed = await deleteStarredMessage({
    starredMessageId: existing._id,
    organizationId,
    userId,
  });

  return serializeStarredMessage(removed ?? existing);
};
