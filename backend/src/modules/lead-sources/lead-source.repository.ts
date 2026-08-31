import { type QueryFilter, type UpdateQuery } from 'mongoose';

import {
  LEAD_SOURCE_STATUSES,
  type LeadSourceStatus,
  type LeadSourceSyncStatus,
} from '../../constants/lead-source-statuses.js';
import { type ObjectIdLike, toObjectId } from '../../types/common.js';
import {
  LeadSource,
  type LeadSourceColumnMapping,
  type LeadSourceDocument,
  type LeadSourceSyncCounts,
} from './lead-source.model.js';

export interface CreateLeadSourceParams {
  organizationId: ObjectIdLike;
  name: string;
  sheetUrl: string;
  sheetId: string;
  gid: string;
  whatsappAccountId: ObjectIdLike;
  defaultCountryCode: string;
  aiContextEnabled?: boolean;
  columnMapping?: Partial<LeadSourceColumnMapping>;
  importFromTime?: Date;
  createdBy?: ObjectIdLike | null;
}

export const createLeadSource = ({
  organizationId,
  name,
  sheetUrl,
  sheetId,
  gid,
  whatsappAccountId,
  defaultCountryCode,
  aiContextEnabled = false,
  columnMapping,
  importFromTime = new Date(),
  createdBy = null,
}: CreateLeadSourceParams) =>
  LeadSource.create({
    organizationId: toObjectId(organizationId),
    name,
    sheetUrl,
    sheetId,
    gid,
    whatsappAccountId: toObjectId(whatsappAccountId),
    defaultCountryCode,
    aiContextEnabled,
    columnMapping,
    importFromTime,
    createdBy: createdBy ? toObjectId(createdBy) : null,
  });

export interface FindLeadSourcesByOrganizationParams {
  organizationId?: ObjectIdLike;
  status?: LeadSourceStatus;
  limit?: number;
  skip?: number;
}

export const findLeadSourcesByOrganization = ({
  organizationId,
  status,
  limit = 100,
  skip = 0,
}: FindLeadSourcesByOrganizationParams = {}) => {
  const filter: QueryFilter<LeadSourceDocument> = {
    organizationId,
  };

  if (status) {
    filter.status = status;
  }

  return LeadSource.find(filter)
    .sort({
      name: 1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface FindLeadSourceByIdParams {
  leadSourceId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const findLeadSourceById = ({
  leadSourceId,
  organizationId,
}: FindLeadSourceByIdParams = {}) =>
  LeadSource.findOne({
    _id: leadSourceId,
    organizationId,
  }).exec();

/**
 * Every source the import runner should poll this tick. Not organization-scoped: the runner is
 * a process-wide worker, the same way the delivery runner drains every account it holds.
 */
export const findActiveLeadSources = ({ limit = 50 }: { limit?: number } = {}) =>
  LeadSource.find({
    status: LEAD_SOURCE_STATUSES.ACTIVE,
  })
    .sort({
      lastSyncedAt: 1,
    })
    .limit(limit)
    .exec();

export interface UpdateLeadSourceParams {
  leadSourceId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  name?: string;
  whatsappAccountId?: ObjectIdLike;
  defaultCountryCode?: string;
  aiContextEnabled?: boolean;
  status?: LeadSourceStatus;
  columnMapping?: Partial<LeadSourceColumnMapping>;
  actorId?: ObjectIdLike | null;
}

export const updateLeadSource = ({
  leadSourceId,
  organizationId,
  name,
  whatsappAccountId,
  defaultCountryCode,
  aiContextEnabled,
  status,
  columnMapping,
  actorId = null,
}: UpdateLeadSourceParams = {}) => {
  const update: Record<string, unknown> = {};

  if (name !== undefined) {
    update.name = name;
  }

  if (whatsappAccountId !== undefined) {
    update.whatsappAccountId = toObjectId(whatsappAccountId);
  }

  if (defaultCountryCode !== undefined) {
    update.defaultCountryCode = defaultCountryCode;
  }

  if (aiContextEnabled !== undefined) {
    update.aiContextEnabled = aiContextEnabled;
  }

  if (status !== undefined) {
    update.status = status;
  }

  if (columnMapping !== undefined) {
    update.columnMapping = columnMapping;
  }

  if (actorId) {
    update.updatedBy = toObjectId(actorId);
  }

  return LeadSource.findOneAndUpdate(
    {
      _id: leadSourceId,
      organizationId,
    },
    {
      $set: update,
    } as UpdateQuery<LeadSourceDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
};

export interface RecordLeadSourceSyncParams {
  leadSourceId?: ObjectIdLike;
  syncStatus: LeadSourceSyncStatus;
  lastError?: string | null;
  counts?: Partial<LeadSourceSyncCounts>;
  importedIncrement?: number;
  syncedAt?: Date;
}

export const recordLeadSourceSync = ({
  leadSourceId,
  syncStatus,
  lastError = null,
  counts,
  importedIncrement = 0,
  syncedAt = new Date(),
}: RecordLeadSourceSyncParams) => {
  const update: UpdateQuery<LeadSourceDocument> = {
    $set: {
      lastSyncedAt: syncedAt,
      lastSyncStatus: syncStatus,
      lastError,
      lastSyncCounts: {
        imported: counts?.imported ?? 0,
        duplicates: counts?.duplicates ?? 0,
        skipped: counts?.skipped ?? 0,
        failed: counts?.failed ?? 0,
      },
    },
  };

  if (importedIncrement > 0) {
    update.$inc = { totalImported: importedIncrement };
  }

  return LeadSource.findOneAndUpdate({ _id: leadSourceId }, update, {
    returnDocument: 'after',
    runValidators: true,
  }).exec();
};

export interface DeleteLeadSourceParams {
  leadSourceId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const deleteLeadSource = ({ leadSourceId, organizationId }: DeleteLeadSourceParams = {}) =>
  LeadSource.findOneAndDelete({
    _id: leadSourceId,
    organizationId,
  }).exec();
