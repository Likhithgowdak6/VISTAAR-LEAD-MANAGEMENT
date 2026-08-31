import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedAuditLog {
  id: string | null;
  organizationId: string | null;
  eventType: unknown;
  actorId: string | null;
  targetUserId: string | null;
  sessionId: string | null;
  outcome: unknown;
  reasonCode: unknown;
  requestId: unknown;
  ipAddress: unknown;
  userAgent: unknown;
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

export const serializeAuditLog = (auditLog: unknown): SerializedAuditLog | null => {
  const value = toPlainObject(auditLog);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    eventType: value.eventType,
    actorId: serializeId(value.actorId),
    targetUserId: serializeId(value.targetUserId),
    sessionId: serializeId(value.sessionId),
    outcome: value.outcome,
    reasonCode: value.reasonCode,
    requestId: value.requestId,
    ipAddress: value.ipAddress,
    userAgent: value.userAgent,
    metadata: (value.metadata as Record<string, unknown> | undefined) ?? {},
    createdAt: serializeDate(value.createdAt),
  };
};
