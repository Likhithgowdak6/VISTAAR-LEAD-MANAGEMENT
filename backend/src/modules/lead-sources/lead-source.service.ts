import { type HydratedDocument } from 'mongoose';

import { ACCOUNT_STATUSES } from '../../constants/account-statuses.js';
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
  findLeadSourcesByOrganization,
  updateLeadSource,
} from './lead-source.repository.js';
import { serializeLeadSource, type SerializedLeadSource } from './lead-source.serializer.js';

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
}: UpdateLeadSourceForActorParams): Promise<SerializedLeadSource | null> => {
  const leadSource = await findLeadSourceById({ leadSourceId, organizationId });

  if (!leadSource) {
    throw new Error('LEAD_SOURCE_NOT_FOUND');
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
  const leadSource = await findLeadSourceById({ leadSourceId, organizationId });

  if (!leadSource) {
    throw new Error('LEAD_SOURCE_NOT_FOUND');
  }

  await leadImportService.syncSource(leadSource);

  const refreshed = await findLeadSourceById({ leadSourceId, organizationId });

  return serializeLeadSource(refreshed);
};
