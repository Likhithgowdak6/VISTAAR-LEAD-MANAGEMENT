import { type QueryFilter } from 'mongoose';

import { type AuditEvent } from '../../constants/audit-events.js';
import { AUDIT_OUTCOMES, type AuditOutcome } from '../../constants/audit-outcomes.js';
import { type DatabaseSession } from '../../config/database.js';
import { type ObjectIdLike, type PaginationParams, toObjectId } from '../../types/common.js';
import { AuditLog, type AuditLogDocument } from './audit.model.js';

export interface CreateAuditLogParams {
  organizationId: ObjectIdLike;
  eventType: AuditEvent;
  actorId?: ObjectIdLike | null;
  targetUserId?: ObjectIdLike | null;
  sessionId?: ObjectIdLike | null;
  outcome?: AuditOutcome;
  reasonCode?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
  session?: DatabaseSession;
}

export const createAuditLog = async ({
  organizationId,
  eventType,
  actorId = null,
  targetUserId = null,
  sessionId = null,
  outcome = AUDIT_OUTCOMES.SUCCESS,
  reasonCode = null,
  requestId = null,
  ipAddress = null,
  userAgent = null,
  metadata = {},
  session,
}: CreateAuditLogParams) => {
  const [auditLog] = await AuditLog.create(
    [
      {
        organizationId: toObjectId(organizationId),
        eventType,
        actorId: actorId ? toObjectId(actorId) : null,
        targetUserId: targetUserId ? toObjectId(targetUserId) : null,
        sessionId: sessionId ? toObjectId(sessionId) : null,
        outcome,
        reasonCode,
        requestId,
        ipAddress,
        userAgent,
        metadata,
      },
    ],
    { session },
  );

  return auditLog!;
};

export const findAuditLogById = (auditLogId: ObjectIdLike) => AuditLog.findById(auditLogId).exec();

export interface ListAuditLogsByOrganizationParams extends PaginationParams {
  organizationId?: ObjectIdLike;
  eventType?: AuditEvent;
  actorId?: ObjectIdLike;
  targetUserId?: ObjectIdLike;
}

export const listAuditLogsByOrganization = ({
  organizationId,
  eventType,
  actorId,
  targetUserId,
  limit = 50,
  skip = 0,
}: ListAuditLogsByOrganizationParams) => {
  const filter: QueryFilter<AuditLogDocument> = {
    organizationId,
  };

  if (eventType) {
    filter.eventType = eventType;
  }

  if (actorId) {
    filter.actorId = actorId;
  }

  if (targetUserId) {
    filter.targetUserId = targetUserId;
  }

  return AuditLog.find(filter)
    .sort({
      createdAt: -1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};
