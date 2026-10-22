import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedFollowUpTask {
  id: string | null;
  organizationId: string | null;
  whatsappAccountId: string | null;
  conversationId: string | null;
  assignedTo: string | null;
  createdBy: string | null;
  /** What the reminder is about. Null on older rows written before titles existed. */
  title: unknown;
  type: unknown;
  note: unknown;
  /** manual | lead_commitment | owner_command - who or what created this. */
  source: unknown;
  /** The customer's own words that produced a lead_commitment reminder, when there were any. */
  sourceQuote: unknown;
  dueAt: string | null;
  priority: unknown;
  status: unknown;
  completedAt: string | null;
  cancelledAt: string | null;
  missedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeFollowUpTask = (task: unknown): SerializedFollowUpTask | null => {
  const value = toPlainObject(task);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    whatsappAccountId: serializeId(value.whatsappAccountId),
    conversationId: serializeId(value.conversationId),
    assignedTo: serializeId(value.assignedTo),
    createdBy: serializeId(value.createdBy),
    title: value.title ?? null,
    type: value.type,
    note: value.note,
    // Additive: existing consumers ignore unknown fields, so no client has to change in step.
    source: value.source ?? null,
    sourceQuote: value.sourceQuote ?? null,
    dueAt: serializeDate(value.dueAt),
    priority: value.priority,
    status: value.status,
    completedAt: serializeDate(value.completedAt),
    cancelledAt: serializeDate(value.cancelledAt),
    missedAt: serializeDate(value.missedAt),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
