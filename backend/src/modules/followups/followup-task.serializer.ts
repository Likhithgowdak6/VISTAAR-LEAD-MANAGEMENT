import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedFollowUpTask {
  id: string | null;
  organizationId: string | null;
  whatsappAccountId: string | null;
  conversationId: string | null;
  assignedTo: string | null;
  createdBy: string | null;
  type: unknown;
  note: unknown;
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
    type: value.type,
    note: value.note,
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
