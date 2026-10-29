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

/**
 * One row of the centralised Tasks list: the task, plus just enough of its lead to draw a card.
 *
 * A SEPARATE SHAPE RATHER THAN A WIDER SerializedFollowUpTask. Every other consumer of that
 * type - the lead panel, the device sync, the reminder dialog - already knows which
 * conversation it is looking at, so a lead block would be dead weight they all have to ignore.
 * This one does not: the whole point of the screen is tasks from many leads side by side, and
 * a card with no customer name on it is unreadable.
 *
 * THREE FIELDS OF THE LEAD, AND NO MORE. A display name and the lead reference are what the
 * card shows. Notably absent: the phone number. It is not needed to render a row, revealing it
 * is a permissioned action of its own (client_pii.reveal, see RevealPhone), and a list endpoint
 * is exactly the wrong place to hand it out in bulk.
 */
export interface SerializedTaskListItem extends SerializedFollowUpTask {
  lead: {
    conversationId: string | null;
    displayName: string | null;
    leadId: string | null;
  } | null;
}

export const serializeTaskListItem = (task: unknown): SerializedTaskListItem | null => {
  const base = serializeFollowUpTask(task);

  if (!base) {
    return null;
  }

  const value = toPlainObject(task);
  const conversation = toPlainObject(value?.conversation);

  return {
    ...base,
    // Null for a personal reminder, deliberately - the card then shows no customer line at all
    // rather than an empty one, which would read as a lead whose name we failed to load.
    lead: conversation
      ? {
          conversationId: serializeId(conversation._id) ?? base.conversationId,
          displayName: (conversation.displayName as string | undefined) ?? null,
          leadId: (conversation.leadId as string | undefined) ?? null,
        }
      : null,
  };
};
