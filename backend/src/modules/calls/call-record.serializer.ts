import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

/**
 * A call as the client sees it.
 *
 * THE PHONE NUMBER IS DELIBERATELY ABSENT, because it is not on the row in the first place - the
 * contact holds it, encrypted, and revealing it is its own permissioned action. A call list is
 * exactly the wrong place to hand numbers out in bulk.
 */
export interface SerializedCallRecord {
  id: string | null;
  organizationId: string | null;
  conversationId: string | null;
  contactId: string | null;
  initiatedBy: string | null;
  direction: unknown;
  status: unknown;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const serializeCallRecord = (call: unknown): SerializedCallRecord | null => {
  const value = toPlainObject(call);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    conversationId: serializeId(value.conversationId),
    contactId: serializeId(value.contactId),
    initiatedBy: serializeId(value.initiatedBy),
    direction: value.direction,
    status: value.status,
    startedAt: serializeDate(value.startedAt),
    endedAt: serializeDate(value.endedAt),
    durationSeconds: asNumber(value.durationSeconds),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
