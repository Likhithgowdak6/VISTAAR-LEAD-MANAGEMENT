import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedTag {
  id: string | null;
  organizationId: string | null;
  whatsappAccountId: string | null;
  name: unknown;
  slug: unknown;
  color: unknown;
  description: unknown;
  status: unknown;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeTag = (tag: unknown): SerializedTag | null => {
  const value = toPlainObject(tag);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    whatsappAccountId: serializeId(value.whatsappAccountId),
    name: value.name,
    slug: value.slug,
    color: value.color,
    description: value.description,
    status: value.status,
    createdBy: serializeId(value.createdBy),
    updatedBy: serializeId(value.updatedBy),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
