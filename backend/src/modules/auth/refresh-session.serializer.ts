import { type RefreshSessionStatus } from '../../constants/refresh-session-statuses.js';
import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface RefreshSessionDto {
  id: string | null;
  organizationId: string | null;
  userId: string | null;
  familyId: string | null;
  status: RefreshSessionStatus | unknown;
  expiresAt: string | null;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
  revokeReason: unknown;
  replacedBySessionId: string | null;
  createdByIp: unknown;
  lastUsedByIp: unknown;
  userAgent: unknown;
  reuseDetectedAt: string | null;
  createdAt: string | null;
}

export const serializeRefreshSession = (session: unknown): RefreshSessionDto | null => {
  const value = toPlainObject(session);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    userId: serializeId(value.userId),
    familyId: serializeId(value.familyId),
    status: value.status,
    expiresAt: serializeDate(value.expiresAt),
    lastUsedAt: serializeDate(value.lastUsedAt),
    rotatedAt: serializeDate(value.rotatedAt),
    revokedAt: serializeDate(value.revokedAt),
    revokeReason: value.revokeReason,
    replacedBySessionId: serializeId(value.replacedBySessionId),
    createdByIp: value.createdByIp,
    lastUsedByIp: value.lastUsedByIp,
    userAgent: value.userAgent,
    reuseDetectedAt: serializeDate(value.reuseDetectedAt),
    createdAt: serializeDate(value.createdAt),
  };
};
