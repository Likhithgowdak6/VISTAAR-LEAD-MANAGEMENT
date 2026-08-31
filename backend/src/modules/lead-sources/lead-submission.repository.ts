import {
  LEAD_SUBMISSION_STATUSES,
  type LeadSkipReason,
  type LeadSubmissionStatus,
} from '../../constants/lead-submission-statuses.js';
import { type ObjectIdLike, toObjectId } from '../../types/common.js';
import {
  decryptLeadSubmissionPayloadFromStorage,
  encryptLeadSubmissionPayloadForStorage,
} from '../privacy/protected-pii.service.js';
import { type EncryptedField } from '../security/encrypted-field.schema.js';
import {
  LeadSubmission,
  type LeadSubmissionDocument,
  type LeadSubmissionPayload,
} from './lead-submission.model.js';

export interface CreateLeadSubmissionParams {
  organizationId: ObjectIdLike;
  leadSourceId: ObjectIdLike;
  externalId: string;
  status?: LeadSubmissionStatus;
  skipReason?: LeadSkipReason | null;
  contactId?: ObjectIdLike | null;
  conversationId?: ObjectIdLike | null;
  payload?: LeadSubmissionPayload | null;
  submittedAt?: Date | null;
  platform?: string | null;
  isOrganic?: boolean;
  leadStatus?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  adId?: string | null;
  adName?: string | null;
  adsetId?: string | null;
  adsetName?: string | null;
  formId?: string | null;
  formName?: string | null;
}

/**
 * Writes the ledger row for one sheet row. Throws a duplicate-key error when the same
 * `externalId` was already processed for this source — the caller treats that as "already
 * imported", not as a failure.
 */
export const createLeadSubmission = ({
  organizationId,
  leadSourceId,
  externalId,
  status = LEAD_SUBMISSION_STATUSES.IMPORTED,
  skipReason = null,
  contactId = null,
  conversationId = null,
  payload = null,
  submittedAt = null,
  platform = null,
  isOrganic = false,
  leadStatus = null,
  campaignId = null,
  campaignName = null,
  adId = null,
  adName = null,
  adsetId = null,
  adsetName = null,
  formId = null,
  formName = null,
}: CreateLeadSubmissionParams) =>
  LeadSubmission.create({
    organizationId: toObjectId(organizationId),
    leadSourceId: toObjectId(leadSourceId),
    externalId,
    status,
    skipReason,
    contactId: contactId ? toObjectId(contactId) : null,
    conversationId: conversationId ? toObjectId(conversationId) : null,
    encryptedPayload: encryptLeadSubmissionPayloadForStorage(payload) as EncryptedField | null,
    submittedAt,
    platform,
    isOrganic,
    leadStatus,
    campaignId,
    campaignName,
    adId,
    adName,
    adsetId,
    adsetName,
    formId,
    formName,
  });

export interface FindImportedExternalIdsParams {
  organizationId?: ObjectIdLike;
  leadSourceId?: ObjectIdLike;
  externalIds: readonly string[];
}

/**
 * Pre-filters a batch of sheet rows against the ledger. The unique index is still the authority
 * — this only avoids doing the mapping and encryption work for the thousands of rows that were
 * already imported on an earlier poll.
 */
export const findImportedExternalIds = async ({
  organizationId,
  leadSourceId,
  externalIds,
}: FindImportedExternalIdsParams): Promise<Set<string>> => {
  if (externalIds.length === 0) {
    return new Set();
  }

  const existing = await LeadSubmission.find({
    organizationId,
    leadSourceId,
    externalId: { $in: [...externalIds] },
  })
    .select('externalId')
    .lean()
    .exec();

  return new Set(existing.map((submission) => submission.externalId));
};

export interface FindLeadSubmissionsForConversationParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  limit?: number;
}

export interface LeadSubmissionWithPayload {
  submission: LeadSubmissionDocument;
  payload: LeadSubmissionPayload | null;
}

/**
 * Submissions attached to a lead, newest first, with the encrypted blob decrypted at this
 * boundary so no caller above the repository handles ciphertext.
 */
export const findLeadSubmissionsForConversation = async ({
  organizationId,
  conversationId,
  limit = 10,
}: FindLeadSubmissionsForConversationParams = {}): Promise<LeadSubmissionWithPayload[]> => {
  const submissions = await LeadSubmission.find({
    organizationId,
    conversationId,
  })
    .select('+encryptedPayload')
    .sort({
      submittedAt: -1,
      createdAt: -1,
    })
    .limit(limit)
    .exec();

  return submissions.map((submission) => ({
    submission,
    payload: decryptLeadSubmissionPayloadFromStorage(
      submission.encryptedPayload,
    ) as LeadSubmissionPayload | null,
  }));
};

export interface CountLeadSubmissionsForConversationParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
}

/** Distinguishes a first import from a repeat inquiry when the contact already existed. */
export const countLeadSubmissionsForConversation = ({
  organizationId,
  conversationId,
}: CountLeadSubmissionsForConversationParams = {}) =>
  LeadSubmission.countDocuments({
    organizationId,
    conversationId,
  }).exec();
