import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedStarredMessage {
  id: string | null;
  title: unknown;
  body: unknown;
  sourceMessageId: string | null;
  sourceConversationId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * `userId` is deliberately NOT serialized. Every one of these belongs to the caller - the
 * repository filters on it - so returning it would be noise at best, and at worst an id the
 * client might be tempted to send back and have the server trust.
 */
export const serializeStarredMessage = (
  starred: unknown,
): SerializedStarredMessage | null => {
  const value = toPlainObject(starred);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    title: value.title,
    body: value.body,
    sourceMessageId: serializeId(value.sourceMessageId),
    sourceConversationId: serializeId(value.sourceConversationId),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
