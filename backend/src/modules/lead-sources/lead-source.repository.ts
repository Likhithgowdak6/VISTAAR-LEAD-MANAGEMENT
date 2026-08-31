import { type QueryFilter, type UpdateQuery } from 'mongoose';

import {
  LEAD_SOURCE_KINDS,
  type LeadSourceKind,
} from '../../constants/lead-source-kinds.js';
import {
  LEAD_SOURCE_STATUSES,
  type LeadSourceStatus,
  type LeadSourceSyncStatus,
} from '../../constants/lead-source-statuses.js';
import { type ObjectIdLike, toObjectId } from '../../types/common.js';
import { type EncryptedField } from '../security/encrypted-field.schema.js';
import {
  LeadSource,
  type LeadSourceColumnMapping,
  type LeadSourceDocument,
  type LeadSourceMetaConfig,
  type LeadSourceSyncCounts,
} from './lead-source.model.js';
import {
  encryptMetaAccessTokenForStorage,
  metaAccessTokenLast4,
} from './meta-credentials.service.js';

/**
 * `encryptedMetaAccessToken` is `select: false`, so only the queries that feed the importer ask
 * for it. Every other read — the list endpoint, the lead panel's source lookup — never loads the
 * ciphertext at all, which is a stronger guarantee than remembering to strip it later.
 */
const WITH_SECRETS = '+encryptedMetaAccessToken';

export interface CreateLeadSourceParams {
  organizationId: ObjectIdLike;
  name: string;
  kind?: LeadSourceKind;
  /** Google Sheet sources only. */
  sheetUrl?: string | null;
  sheetId?: string | null;
  gid?: string | null;
  /** Meta Lead Ads sources only. The token is passed in the clear here and encrypted below. */
  meta?: {
    pageId: string;
    pageName?: string | null;
    formId?: string | null;
    formName?: string | null;
    accessToken: string;
  };
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
  kind = LEAD_SOURCE_KINDS.GOOGLE_SHEET,
  sheetUrl = null,
  sheetId = null,
  gid = null,
  meta,
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
    kind,
    sheetUrl,
    sheetId,
    gid,
    meta: meta
      ? ({
          pageId: meta.pageId,
          pageName: meta.pageName ?? null,
          formId: meta.formId ?? null,
          formName: meta.formName ?? null,
          accessTokenLast4: metaAccessTokenLast4(meta.accessToken),
          accessTokenSetAt: new Date(),
          lastLeadCreatedAt: null,
        } satisfies LeadSourceMetaConfig)
      : undefined,
    // The one place a plaintext Meta token is written, and it is encrypted on the way in.
    encryptedMetaAccessToken: meta
      ? (encryptMetaAccessTokenForStorage(meta.accessToken) as EncryptedField | null)
      : null,
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
 * The same lookup, but with the encrypted Meta token loaded. Only the importer and the manual
 * "sync now" call it; anything that will be serialized back to a client uses the plain one above.
 */
export const findLeadSourceByIdWithSecrets = ({
  leadSourceId,
  organizationId,
}: FindLeadSourceByIdParams = {}) =>
  LeadSource.findOne({
    _id: leadSourceId,
    organizationId,
  })
    .select(WITH_SECRETS)
    .exec();

/**
 * Every source the import runner should poll this tick. Not organization-scoped: the runner is
 * a process-wide worker, the same way the delivery runner drains every account it holds.
 */
export const findActiveLeadSources = ({ limit = 50 }: { limit?: number } = {}) =>
  LeadSource.find({
    status: LEAD_SOURCE_STATUSES.ACTIVE,
  })
    .select(WITH_SECRETS)
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
  /** Meta sources: rotate the token. Plaintext in, ciphertext out; never stored as given. */
  metaAccessToken?: string;
  /** Meta sources: repoint at a different form on the same page. `null` = every form. */
  metaFormId?: string | null;
  metaFormName?: string | null;
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
  metaAccessToken,
  metaFormId,
  metaFormName,
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

  if (metaAccessToken !== undefined) {
    update.encryptedMetaAccessToken = encryptMetaAccessTokenForStorage(
      metaAccessToken,
    ) as EncryptedField | null;
    update['meta.accessTokenLast4'] = metaAccessTokenLast4(metaAccessToken);
    update['meta.accessTokenSetAt'] = new Date();
  }

  if (metaFormId !== undefined) {
    update['meta.formId'] = metaFormId;
    // A different form is a different stream of leads: the old form's watermark would skip
    // everything the new one submitted before now.
    update['meta.lastLeadCreatedAt'] = null;
  }

  if (metaFormName !== undefined) {
    update['meta.formName'] = metaFormName;
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

export interface RecordMetaLeadWatermarkParams {
  leadSourceId?: ObjectIdLike;
  lastLeadCreatedAt: Date;
}

/**
 * Advances the "newest lead we have seen" mark for a Meta source.
 *
 * `$max` rather than `$set`: two ticks overlapping (a manual "sync now" landing on top of the
 * scheduled poll) must never move the watermark backwards, which would re-fetch leads the other
 * tick already imported.
 */
export const recordMetaLeadWatermark = ({
  leadSourceId,
  lastLeadCreatedAt,
}: RecordMetaLeadWatermarkParams) =>
  LeadSource.findOneAndUpdate(
    { _id: leadSourceId },
    { $max: { 'meta.lastLeadCreatedAt': lastLeadCreatedAt } } as UpdateQuery<LeadSourceDocument>,
    {
      returnDocument: 'after',
    },
  ).exec();

export interface DeleteLeadSourceParams {
  leadSourceId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const deleteLeadSource = ({ leadSourceId, organizationId }: DeleteLeadSourceParams = {}) =>
  LeadSource.findOneAndDelete({
    _id: leadSourceId,
    organizationId,
  }).exec();
