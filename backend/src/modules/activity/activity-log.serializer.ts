import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedActivityLog {
  id: string | null;
  organizationId: string | null;
  whatsappAccountId: string | null;
  conversationId: string | null;
  actorId: string | null;
  eventType: unknown;
  summary: unknown;
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

export const serializeActivityLog = (activity: unknown): SerializedActivityLog | null => {
  const value = toPlainObject(activity);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    whatsappAccountId: serializeId(value.whatsappAccountId),
    conversationId: serializeId(value.conversationId),
    actorId: serializeId(value.actorId),
    eventType: value.eventType,
    summary: value.summary,
    metadata: (value.metadata as Record<string, unknown> | undefined) ?? {},
    createdAt: serializeDate(value.createdAt),
  };
};
