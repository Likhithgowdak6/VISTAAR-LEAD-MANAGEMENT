import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedNote {
  id: string | null;
  organizationId: string | null;
  whatsappAccountId: string | null;
  conversationId: string | null;
  body: unknown;
  visibility: unknown;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeNote = (note: unknown): SerializedNote | null => {
  const value = toPlainObject(note);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    whatsappAccountId: serializeId(value.whatsappAccountId),
    conversationId: serializeId(value.conversationId),
    body: value.body,
    visibility: value.visibility,
    createdBy: serializeId(value.createdBy),
    updatedBy: serializeId(value.updatedBy),
    deletedAt: serializeDate(value.deletedAt),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
