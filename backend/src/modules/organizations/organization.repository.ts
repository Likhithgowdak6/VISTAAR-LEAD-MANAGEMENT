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
