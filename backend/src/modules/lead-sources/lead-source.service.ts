import { type HydratedDocument } from 'mongoose';

import { env, type Env } from '../../config/env.js';
import { ACCOUNT_STATUSES } from '../../constants/account-statuses.js';
import { LEAD_SOURCE_KINDS } from '../../constants/lead-source-kinds.js';
import { type LeadSourceStatus } from '../../constants/lead-source-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import { type UserDocument } from '../users/user.model.js';
import { findAccountById } from '../whatsapp-accounts/whatsapp-account.repository.js';
import { createLeadImportService } from './lead-import.service.js';
import { parseGoogleSheetUrl } from './google-sheet.client.js';
import { type LeadSourceColumnMapping } from './lead-source.model.js';
import {
  createLeadSource,
  deleteLeadSource,
  findLeadSourceById,
  findLeadSourceByIdWithSecrets,
  findLeadSourcesByOrganization,
  updateLeadSource,
} from './lead-source.repository.js';
import { serializeLeadSource, type SerializedLeadSource } from './lead-source.serializer.js';
import {
  listMetaLeadForms as defaultListMetaLeadForms,
  testMetaConnection as defaultTestMetaConnection,
  type MetaConnectionTest,
  type MetaLeadFormSummary,
} from './meta-graph.client.js';

type Actor = Pick<UserDocument, '_id'> | HydratedDocument<UserDocument>;

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);

/** Epoch, i.e. "import everything the sheet has ever held". */
const BEGINNING_OF_TIME = new Date(0);

export interface ListLeadSourcesForOrganizationParams {
  organizationId: ObjectIdLike;
  status?: LeadSourceStatus;
  limit?: number;
  skip?: number;
}

export const listLeadSourcesForOrganization = async ({
  organizationId,
  status,
  limit,
  skip,
}: ListLeadSourcesForOrganizationParams): Promise<(SerializedLeadSource | null)[]> => {
  const leadSources = await findLeadSourcesByOrganization({
    organizationId,
    status,
    limit,
    skip,
  });

  return leadSources.map((leadSource) => serializeLeadSource(leadSource));
};

const assertAccountUsable = async ({
  organizationId,
  whatsappAccountId,
}: {
  organizationId: ObjectIdLike;
  whatsappAccountId: ObjectIdLike;
}): Promise<void> => {
  const account = await findAccountById({
    accountId: whatsappAccountId,
    organizationId,
  });

  // A removed account would leave every imported lead stranded on a number that can never send.
  if (!account || account.status === ACCOUNT_STATUSES.REMOVED) {
    throw new Error('LEAD_SOURCE_ACCOUNT_NOT_FOUND');
  }
};

export interface CreateLeadSourceForActorParams {
  organizationId: ObjectIdLike;
  actor: Actor;
  name: string;
  sheetUrl: string;
  whatsappAccountId: ObjectIdLike;
  defaultCountryCode: string;
  aiContextEnabled: boolean;
  columnMapping?: Partial<LeadSourceColumnMapping>;
  importExisting: boolean;
  now?: Date;
}

export const createLeadSourceForActor = async ({
  organizationId,
  actor,
  name,
  sheetUrl,
  whatsappAccountId,
  defaultCountryCode,
  aiContextEnabled,
  columnMapping,
  importExisting,
  now = new Date(),
}: CreateLeadSourceForActorParams): Promise<SerializedLeadSource | null> => {
  const sheetRef = parseGoogleSheetUrl(sheetUrl);

  if (!sheetRef) {
    throw new Error('LEAD_SOURCE_INVALID_SHEET_URL');
  }

  await assertAccountUsable({ organizationId, whatsappAccountId });

  try {
    const leadSource = await createLeadSource({
      organizationId,
      name,
      sheetUrl,
      sheetId: sheetRef.sheetId,
      gid: sheetRef.gid,
      whatsappAccountId,
      defaultCountryCode,
      aiContextEnabled,
      columnMapping,
      importFromTime: importExisting ? BEGINNING_OF_TIME : now,
      createdBy: actor._id,
    });

    return serializeLeadSource(leadSource);
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      throw new Error('LEAD_SOURCE_ALREADY_EXISTS', { cause: error });
    }

    throw error;
  }
};

/**
 * The Meta Lead Ads twin of the function above.
 *
 * Kept separate rather than folded in behind a flag: the two kinds share no required field except
 * a name and a destination number, and a single function taking "either a sheet URL, or a page
 * id, a form id and a credential" would be a union pretending to be a signature.
 */
export interface CreateMetaLeadSourceForActorParams {
  organizationId: ObjectIdLike;
  actor: Actor;
  name: string;
  accessToken: string;
  pageId: string;
  pageName?: string | null;
  /** `null`/omitted means every lead form on the page, resolved fresh on every poll. */
  formId?: string | null;
  formName?: string | null;
  whatsappAccountId: ObjectIdLike;
  defaultCountryCode: string;
  aiContextEnabled: boolean;
  columnMapping?: Partial<LeadSourceColumnMapping>;
  importExisting: boolean;
  config?: Env;
  now?: Date;
}

const assertMetaLeadAdsEnabled = (config: Env): void => {
  if (config.META_LEAD_ADS_ENABLED !== true) {
    throw new Error('META_LEAD_ADS_DISABLED');
  }
};

/**
 * A page-wide source and a single-form source on the same page would both import that form's
 * leads, each against its own ledger. The unique index catches an exact repeat; this catches the
 * overlap, which a partial index cannot express.
 */
const assertNoOverlappingMetaSource = async ({
  organizationId,
  pageId,
  formId,
}: {
  organizationId: ObjectIdLike;
  pageId: string;
  formId: string | null;
}): Promise<void> => {
  const existing = await findLeadSourcesByOrganization({ organizationId, limit: 200 });

  const overlaps = existing.some((leadSource) => {
    if (leadSource.kind !== LEAD_SOURCE_KINDS.META_LEAD_ADS) {
      return false;
    }

    if (leadSource.meta?.pageId !== pageId) {
      return false;
    }

    const existingFormId = leadSource.meta?.formId ?? null;

    // Either side covering the whole page swallows the other.
    return existingFormId === null || formId === null || existingFormId === formId;
  });

  if (overlaps) {
    throw new Error('LEAD_SOURCE_ALREADY_EXISTS');
  }
};

export const createMetaLeadSourceForActor = async ({
  organizationId,
  actor,
  name,
  accessToken,
  pageId,
  pageName = null,
  formId = null,
  formName = null,
  whatsappAccountId,
  defaultCountryCode,
  aiContextEnabled,
  columnMapping,
  importExisting,
  config = env,
  now = new Date(),
}: CreateMetaLeadSourceForActorParams): Promise<SerializedLeadSource | null> => {
  assertMetaLeadAdsEnabled(config);
  await assertAccountUsable({ organizationId, whatsappAccountId });
  await assertNoOverlappingMetaSource({ organizationId, pageId, formId });

  try {
    const leadSource = await createLeadSource({
      organizationId,
      name,
      kind: LEAD_SOURCE_KINDS.META_LEAD_ADS,
      meta: { pageId, pageName, formId, formName, accessToken },
      whatsappAccountId,
      defaultCountryCode,
      aiContextEnabled,
      columnMapping,
      importFromTime: importExisting ? BEGINNING_OF_TIME : now,
      createdBy: actor._id,
    });

    return serializeLeadSource(leadSource);
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      throw new Error('LEAD_SOURCE_ALREADY_EXISTS', { cause: error });
    }

    throw error;
  }
};

export interface TestMetaConnectionParams {
  accessToken: string;
  config?: Env;
  testMetaConnection?: typeof defaultTestMetaConnection;
}

/**
 * Checks a token the moment it is pasted, before anything is stored. The token arrives in the
 * request body, is spent on one Graph call and is dropped — this path writes nothing at all.
 */
export const testMetaConnectionForActor = async ({
  accessToken,
  config = env,
  testMetaConnection = defaultTestMetaConnection,
}: TestMetaConnectionParams): Promise<MetaConnectionTest> => {
  assertMetaLeadAdsEnabled(config);

  return testMetaConnection({
    accessToken,
    timeoutMs: Number(config.META_GRAPH_TIMEOUT_MS ?? 15_000),
  });
};

export interface ListMetaFormsParams {
  accessToken: string;
  pageId: string;
  config?: Env;
  listMetaLeadForms?: typeof defaultListMetaLeadForms;
}

/** The page's lead forms, so an admin picks one from a list instead of typing an id. */
export const listMetaFormsForActor = async ({
  accessToken,
  pageId,
  config = env,
  listMetaLeadForms = defaultListMetaLeadForms,
}: ListMetaFormsParams): Promise<MetaLeadFormSummary[]> => {
  assertMetaLeadAdsEnabled(config);

  return listMetaLeadForms({
    accessToken,
    pageId,
    timeoutMs: Number(config.META_GRAPH_TIMEOUT_MS ?? 15_000),
  });
};

export interface UpdateLeadSourceForActorParams {
  organizationId: ObjectIdLike;
  leadSourceId: ObjectIdLike;
  actor: Actor;
  name?: string;
  whatsappAccountId?: ObjectIdLike;
  defaultCountryCode?: string;
  aiContextEnabled?: boolean;
  status?: LeadSourceStatus;
  columnMapping?: Partial<LeadSourceColumnMapping>;
  /** Meta sources only: rotate the stored token. Never echoed back. */
  accessToken?: string;
  formId?: string | null;
  formName?: string | null;
}

export const updateLeadSourceForActor = async ({
  organizationId,
  leadSourceId,
  actor,
  name,
  whatsappAccountId,
  defaultCountryCode,
  aiContextEnabled,
  status,
  columnMapping,
  accessToken,
  formId,
  formName,
}: UpdateLeadSourceForActorParams): Promise<SerializedLeadSource | null> => {
  const leadSource = await findLeadSourceById({ leadSourceId, organizationId });

  if (!leadSource) {
    throw new Error('LEAD_SOURCE_NOT_FOUND');
  }

  const isMeta = leadSource.kind === LEAD_SOURCE_KINDS.META_LEAD_ADS;

  // Storing a Meta credential against a sheet source would be a token nothing ever spends.
  if (!isMeta && (accessToken !== undefined || formId !== undefined || formName !== undefined)) {
    throw new Error('LEAD_SOURCE_NOT_META');
  }

  if (whatsappAccountId !== undefined) {
    await assertAccountUsable({ organizationId, whatsappAccountId });
  }

  const updated = await updateLeadSource({
    leadSourceId: leadSource._id,
    organizationId,
    name,
    whatsappAccountId,
    defaultCountryCode,
    aiContextEnabled,
    status,
    columnMapping,
    metaAccessToken: accessToken,
    metaFormId: formId,
    metaFormName: formName,
    actorId: actor._id,
  });

  return serializeLeadSource(updated);
};

export interface LeadSourceActorParams {
  organizationId: ObjectIdLike;
  leadSourceId: ObjectIdLike;
}

/**
 * Removes the source only. The leads it already produced are real CRM records with real
 * conversations, so they stay; their submission ledger rows stay too, which means re-adding the
 * same sheet later does not re-import everything.
 */
export const deleteLeadSourceForActor = async ({
  organizationId,
  leadSourceId,
}: LeadSourceActorParams): Promise<void> => {
  const deleted = await deleteLeadSource({ leadSourceId, organizationId });

  if (!deleted) {
    throw new Error('LEAD_SOURCE_NOT_FOUND');
  }
};

export interface SyncLeadSourceNowParams extends LeadSourceActorParams {
  leadImportService?: ReturnType<typeof createLeadImportService>;
}

/**
 * Runs one import pass immediately, so an admin who just pasted a link gets an answer now
 * instead of waiting out the poll interval. Errors are recorded on the source by `syncSource`
 * and rethrown so the caller sees why.
 */
export const syncLeadSourceNowForActor = async ({
  organizationId,
  leadSourceId,
  leadImportService = createLeadImportService(),
}: SyncLeadSourceNowParams): Promise<SerializedLeadSource | null> => {
  // With secrets: a Meta source cannot be polled without its (encrypted) access token, and the
  // plain lookup deliberately does not load it.
  const leadSource = await findLeadSourceByIdWithSecrets({ leadSourceId, organizationId });

  if (!leadSource) {
    throw new Error('LEAD_SOURCE_NOT_FOUND');
  }

  await leadImportService.syncSource(leadSource);

  const refreshed = await findLeadSourceById({ leadSourceId, organizationId });

  return serializeLeadSource(refreshed);
};
