import { type QueryFilter, type UpdateQuery } from 'mongoose';

import { type OrganizationStatus } from '../../constants/organization-statuses.js';
import { type ObjectIdLike, type PaginationParams } from '../../types/common.js';
import { Organization, type OrganizationDocument } from './organization.model.js';

/**
 * The stored shape of an owner phone: digits only, or null for "not set". Non-digits are
 * stripped rather than rejected so a number typed as "+91 81830 03081" saves cleanly; matching
 * against an inbound JID is done on trailing digits (see whatsapp/automation/allowlist.ts).
 */
export const normalizeOwnerWhatsappNumber = (value: unknown): string | null => {
  const digits = String(value ?? '').replace(/\D/g, '');

  return digits === '' ? null : digits;
};

export const createOrganization = (organizationData: Partial<OrganizationDocument>) =>
  Organization.create(organizationData);

export const findOrganizationById = (organizationId: ObjectIdLike) =>
  Organization.findById(organizationId).exec();

export const findOrganizationBySlug = (slug: string) =>
  Organization.findOne({
    slug,
  }).exec();

export interface ListOrganizationsParams extends PaginationParams {
  status?: OrganizationStatus;
}

export const listOrganizations = ({
  status,
  limit = 50,
  skip = 0,
}: ListOrganizationsParams = {}) => {
  const filter: QueryFilter<OrganizationDocument> = {};

  if (status) {
    filter.status = status;
  }

  return Organization.find(filter)
    .sort({
      createdAt: -1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface TouchOwnerWhatsAppActivityParams {
  organizationId?: ObjectIdLike;
  now?: Date;
}

/**
 * Records "the owner did something on WhatsApp just now" - called from the inbound router
 * wherever it recognizes an owner-authored message (self-chat reply or a direct reply typed into
 * a lead's own chat), best-effort and fire-and-forget. The only reader is
 * ai-brain/owner-call-escalation.service.ts, deciding whether a new-lead alert has genuinely gone
 * unanswered; a failed write here must never affect message handling, so callers do not await
 * this for correctness, only log if it rejects.
 */
export const touchOwnerWhatsAppActivity = ({
  organizationId,
  now = new Date(),
}: TouchOwnerWhatsAppActivityParams = {}) =>
  Organization.updateOne(
    { _id: organizationId },
    { $set: { lastOwnerWhatsAppActivityAt: now } },
  ).exec();

export const updateOrganizationById = (
  organizationId: ObjectIdLike,
  updateData: UpdateQuery<OrganizationDocument>,
) =>
  Organization.findByIdAndUpdate(organizationId, updateData, {
    returnDocument: 'after',
    runValidators: true,
  }).exec();

export interface UpdateOrganizationSettingsParams {
  organizationId?: ObjectIdLike;
  ownerWhatsappNumber?: string | null;
}

export interface UpdateCallRetentionParams {
  organizationId?: ObjectIdLike;
  recordingDays?: number | null;
  transcriptDays?: number | null;
  summaryDays?: number | null;
}

/**
 * Writes one organisation's call-retention policy.
 *
 * SEPARATE FROM `updateOrganizationSettings` on purpose. That one `$set`s the owner number
 * unconditionally, so folding retention into it would mean every retention save also rewrote
 * the phone number - and a request that omitted it would clear it. Two fields with different
 * lifetimes, two writes.
 *
 * All three values are written together, including nulls: null is a real choice here ("keep
 * forever"), not an absent field, so a partial write would make it impossible to turn a policy
 * back off.
 */
export const updateCallRetention = ({
  organizationId,
  recordingDays = null,
  transcriptDays = null,
  summaryDays = null,
}: UpdateCallRetentionParams = {}) =>
  Organization.findByIdAndUpdate(
    organizationId,
    {
      $set: {
        'callRetention.recordingDays': recordingDays,
        'callRetention.transcriptDays': transcriptDays,
        'callRetention.summaryDays': summaryDays,
      },
    },
    { returnDocument: 'after', runValidators: true },
  ).exec();

export const updateOrganizationSettings = ({
  organizationId,
  ownerWhatsappNumber,
}: UpdateOrganizationSettingsParams = {}) =>
  Organization.findByIdAndUpdate(
    organizationId,
    {
      $set: {
        ownerWhatsappNumber: normalizeOwnerWhatsappNumber(ownerWhatsappNumber),
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
