import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedContact {
  id: string | null;
  organizationId: string | null;
  leadId: unknown;
  displayName: unknown;
  profileName: unknown;
  source: unknown;
  status: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeContact = (contact: unknown): SerializedContact | null => {
  const value = toPlainObject(contact);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    leadId: value.leadId,
    displayName: value.displayName,
    profileName: value.profileName,
    source: value.source,
    status: value.status,
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
