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
  type LeadSourceFieldMapping,
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
  /** The one switch that makes the AI message a stranger. Off unless asked for. */
  autoGreetEnabled?: boolean;
  columnMapping?: Partial<LeadSourceColumnMapping>;
  /** Human overrides of the automatic label mapping. Empty means fully automatic. */
  fieldMappings?: LeadSourceFieldMapping[];
  /** Applied on INSERT only - a returning lead keeps the stage it already earned. */
  defaultStage?: string | null;
  defaultTagIds?: ObjectIdLike[];
  defaultAssigneeId?: ObjectIdLike | null;
  /**
   * `paused` while a webhook subscription is still being confirmed. Activation flips it to
   * `active` only once Meta says the Page is subscribed - see meta-activation.service.ts.
   */
  status?: LeadSourceStatus;
  /** The OAuth connection this was created through, if any. */
  metaConnectionId?: ObjectIdLike | null;
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
  autoGreetEnabled = false,
  columnMapping,
  fieldMappings = [],
  defaultStage = null,
  defaultTagIds = [],
  defaultAssigneeId = null,
  status = LEAD_SOURCE_STATUSES.ACTIVE,
  metaConnectionId = null,
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
          // A source starts poll-only. The webhook subscription is a separate, explicitly
          // requested step, so a failure to subscribe never blocks creating the source.
          webhookSubscribedAt: null,
          webhookError: null,
        } satisfies LeadSourceMetaConfig)
      : undefined,
    // The one place a plaintext Meta token is written, and it is encrypted on the way in.
    encryptedMetaAccessToken: meta
      ? (encryptMetaAccessTokenForStorage(meta.accessToken) as EncryptedField | null)
      : null,
    whatsappAccountId: toObjectId(whatsappAccountId),
    defaultCountryCode,
    aiContextEnabled,
    autoGreetEnabled,
    columnMapping,
    fieldMappings,
    defaultStage,
    defaultTagIds: defaultTagIds.map((id) => toObjectId(id)),
    defaultAssigneeId: defaultAssigneeId ? toObjectId(defaultAssigneeId) : null,
    status,
    metaConnectionId: metaConnectionId ? toObjectId(metaConnectionId) : null,
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

export interface RecordMetaWebhookSubscriptionParams {
  leadSourceId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  subscribed: boolean;
  error?: string | null;
  now?: Date;
}

/**
 * Records whether the Page is subscribed to leadgen, and activates the source when it is.
 *
 * Status and subscription move together on purpose. A source that is `active` but unsubscribed
 * looks healthy in the dashboard while silently depending on the ten-minute poll; a source left
 * `paused` with the error attached is visibly unfinished and retryable, which is what a failed
 * activation actually is.
 */
export const recordMetaWebhookSubscription = ({
  leadSourceId,
  organizationId,
  subscribed,
  error = null,
  now = new Date(),
}: RecordMetaWebhookSubscriptionParams) =>
  LeadSource.findOneAndUpdate(
    { _id: leadSourceId, organizationId },
    {
      $set: {
        'meta.webhookSubscribedAt': subscribed ? now : null,
        'meta.webhookError': error ? String(error).slice(0, 500) : null,
        status: subscribed ? LEAD_SOURCE_STATUSES.ACTIVE : LEAD_SOURCE_STATUSES.PAUSED,
      },
    } as UpdateQuery<LeadSourceDocument>,
    { returnDocument: 'after', runValidators: true },
  ).exec();

export interface FindLeadSourceForMetaFormParams {
  pageId?: string;
  formId?: string | null;
}

/**
 * The source a leadgen webhook belongs to, with its token loaded.
 *
 * NOT organization-scoped, and cannot be: a webhook arrives from Meta with no session and no
 * tenant. The page id IS the tenancy check - it resolves to a source some organisation
 * configured, and everything downstream uses that source's own organizationId. An event for a
 * page nobody configured finds nothing and is dropped, which is what makes a forged webhook body
 * unable to create a lead in someone else's account.
 *
 * A source configured for ALL forms on a page (`meta.formId: null`) matches any form on it, so
 * the exact-form source is preferred and the catch-all is the fallback. Sorting by formId
 * descending puts the non-null one first; `null` sorts last in Mongo's ordering.
 */
export const findLeadSourceForMetaForm = ({
  pageId,
  formId = null,
}: FindLeadSourceForMetaFormParams = {}) =>
  LeadSource.findOne({
    kind: LEAD_SOURCE_KINDS.META_LEAD_ADS,
    status: LEAD_SOURCE_STATUSES.ACTIVE,
    'meta.pageId': pageId,
    // Either the source that names this exact form, or the one that takes every form on the page.
    $or: [{ 'meta.formId': formId }, { 'meta.formId': null }],
  })
    .sort({ 'meta.formId': -1 })
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
  /** Whether the AI opens the conversation itself. The one switch that messages a stranger. */
  autoGreetEnabled?: boolean;
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
  autoGreetEnabled,
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

  // `!== undefined` rather than a truthiness check, for the same reason as every field here:
  // `false` is the value that turns cold outbound OFF, and a truthy test would silently refuse
  // to ever switch it back off.
  if (autoGreetEnabled !== undefined) {
    update.autoGreetEnabled = autoGreetEnabled;
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

export interface CountLeadSourceImportParams {
  leadSourceId?: ObjectIdLike;
  imported?: number;
}

/**
 * Adds to a source's lifetime import count, and touches nothing else.
 *
 * DELIBERATELY NOT `recordLeadSourceSync`. That one also overwrites `lastSyncedAt`,
 * `lastSyncStatus` and `lastSyncCounts`, which describe the last POLL - a webhook delivery is not
 * a poll, and borrowing that function would have a single pushed lead report itself as a complete
 * sync of one, wiping whatever the last real poll found.
 *
 * Needed because the webhook path calls `importLead` directly and so never passed through the
 * poller's bookkeeping: a source could import leads all day and still show "0 leads imported".
 */
export const countLeadSourceImport = ({
  leadSourceId,
  imported = 1,
}: CountLeadSourceImportParams) => {
  if (imported <= 0) {
    return Promise.resolve(null);
  }

  return LeadSource.findOneAndUpdate(
    { _id: leadSourceId },
    { $inc: { totalImported: imported } },
    { returnDocument: 'after' },
  ).exec();
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
