import { type ObjectIdLike, toObjectId } from '../../types/common.js';
import { StarredMessage } from './starred-message.model.js';

/**
 * EVERY FUNCTION HERE TAKES BOTH organizationId AND userId, and filters on both.
 *
 * Not defensive duplication: `userId` alone would let a stale id from a user who has moved
 * organisations read across the boundary, and `organizationId` alone would show one colleague's
 * saved messages to another. These are personal, so the pair IS the ownership check, and it is
 * applied in the query rather than after it - a find-then-compare is how an id from elsewhere
 * eventually gets through.
 */

export interface CreateStarredMessageParams {
  organizationId: ObjectIdLike;
  userId: ObjectIdLike;
  title: string;
  body: string;
  sourceMessageId?: ObjectIdLike | null;
  sourceConversationId?: ObjectIdLike | null;
}

export const createStarredMessage = ({
  organizationId,
  userId,
  title,
  body,
  sourceMessageId = null,
  sourceConversationId = null,
}: CreateStarredMessageParams) =>
  StarredMessage.create({
    organizationId: toObjectId(organizationId),
    userId: toObjectId(userId),
    title,
    body,
    sourceMessageId: sourceMessageId ? toObjectId(sourceMessageId) : null,
    sourceConversationId: sourceConversationId ? toObjectId(sourceConversationId) : null,
  });

export interface FindStarredMessagesParams {
  organizationId?: ObjectIdLike;
  userId?: ObjectIdLike;
  /** Case-insensitive substring over title and body. */
  search?: string;
  limit?: number;
}

/**
 * Escapes a user-supplied search term for use inside a RegExp.
 *
 * WITHOUT THIS, a search for "(" throws and a search for ".*" matches everything - and a
 * pathological term becomes a CPU bill. The term is typed into a box by the user, so it is
 * input, not a pattern.
 */
export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const findStarredMessages = ({
  organizationId,
  userId,
  search,
  limit = 200,
}: FindStarredMessagesParams = {}) => {
  const term = (search ?? '').trim();
  const filter: Record<string, unknown> = { organizationId, userId };

  if (term !== '') {
    const pattern = new RegExp(escapeRegExp(term), 'i');

    filter.$or = [{ title: pattern }, { body: pattern }];
  }

  return StarredMessage.find(filter).sort({ createdAt: -1 }).limit(limit).exec();
};

export interface FindStarredMessageByIdParams {
  starredMessageId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  userId?: ObjectIdLike;
}

export const findStarredMessageById = ({
  starredMessageId,
  organizationId,
  userId,
}: FindStarredMessageByIdParams = {}) =>
  StarredMessage.findOne({ _id: starredMessageId, organizationId, userId }).exec();

export interface UpdateStarredMessageParams {
  starredMessageId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  userId?: ObjectIdLike;
  title?: string;
  body?: string;
}

/**
 * Only title and body are writable. `sourceMessageId` is history - rewriting it would let one
 * saved message claim to be a different bubble, and the star on that bubble would follow.
 */
export const updateStarredMessage = ({
  starredMessageId,
  organizationId,
  userId,
  title,
  body,
}: UpdateStarredMessageParams = {}) => {
  const update: Record<string, unknown> = {};

  if (typeof title === 'string') {
    update.title = title;
  }

  if (typeof body === 'string') {
    update.body = body;
  }

  return StarredMessage.findOneAndUpdate(
    { _id: starredMessageId, organizationId, userId },
    { $set: update },
    { returnDocument: 'after', runValidators: true },
  ).exec();
};

export interface DeleteStarredMessageParams {
  starredMessageId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  userId?: ObjectIdLike;
}

export const deleteStarredMessage = ({
  starredMessageId,
  organizationId,
  userId,
}: DeleteStarredMessageParams = {}) =>
  StarredMessage.findOneAndDelete({ _id: starredMessageId, organizationId, userId }).exec();

export interface FindStarredMessageBySourceParams {
  organizationId?: ObjectIdLike;
  userId?: ObjectIdLike;
  sourceMessageId?: ObjectIdLike;
}

/** Backs un-starring: the bubble knows its own message id, not the saved record's. */
export const findStarredMessageBySource = ({
  organizationId,
  userId,
  sourceMessageId,
}: FindStarredMessageBySourceParams = {}) =>
  StarredMessage.findOne({ organizationId, userId, sourceMessageId }).exec();
