import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';
import {
  type LeadSourceStatus,
  type LeadSourceSyncStatus,
} from '../../constants/lead-source-statuses.js';

export interface SerializedLeadSource {
  id: string | null;
  organizationId: string | null;
  name: unknown;
  sheetUrl: unknown;
  gid: unknown;
  whatsappAccountId: string | null;
  defaultCountryCode: unknown;
  status: LeadSourceStatus | unknown;
  aiContextEnabled: boolean;
  columnMapping: {
    externalId: unknown;
    createdTime: unknown;
    fullName: unknown;
    phone: unknown;
    email: unknown;
  };
  importFromTime: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: LeadSourceSyncStatus | unknown;
  lastError: unknown;
  lastSyncCounts: {
    imported: unknown;
    duplicates: unknown;
    skipped: unknown;
    failed: unknown;
  };
  totalImported: unknown;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeLeadSource = (leadSource: unknown): SerializedLeadSource | null => {
  const value = toPlainObject(leadSource);

  if (!value) {
    return null;
  }

  const columnMapping = (value.columnMapping ?? {}) as Record<string, unknown>;
  const counts = (value.lastSyncCounts ?? {}) as Record<string, unknown>;

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    name: value.name,
    // `sheetId` is intentionally absent: `sheetUrl` already carries it for the UI link, and
    // there is no reason to hand out a second copy of the spreadsheet handle.
    sheetUrl: value.sheetUrl,
    gid: value.gid,
    whatsappAccountId: serializeId(value.whatsappAccountId),
    defaultCountryCode: value.defaultCountryCode,
    status: value.status,
    aiContextEnabled: Boolean(value.aiContextEnabled),
    columnMapping: {
      externalId: columnMapping.externalId ?? null,
      createdTime: columnMapping.createdTime ?? null,
      fullName: columnMapping.fullName ?? null,
      phone: columnMapping.phone ?? null,
      email: columnMapping.email ?? null,
    },
    importFromTime: serializeDate(value.importFromTime),
    lastSyncedAt: serializeDate(value.lastSyncedAt),
    lastSyncStatus: value.lastSyncStatus,
    lastError: value.lastError,
    lastSyncCounts: {
      imported: counts.imported ?? 0,
      duplicates: counts.duplicates ?? 0,
      skipped: counts.skipped ?? 0,
      failed: counts.failed ?? 0,
    },
    totalImported: value.totalImported,
    createdBy: serializeId(value.createdBy),
    updatedBy: serializeId(value.updatedBy),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
