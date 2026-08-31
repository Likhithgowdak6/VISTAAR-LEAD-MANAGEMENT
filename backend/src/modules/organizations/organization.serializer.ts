import { type OrganizationStatus } from '../../constants/organization-statuses.js';
import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface OrganizationDto {
  id: string | null;
  name: unknown;
  slug: unknown;
  status: OrganizationStatus | unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeOrganization = (organization: unknown): OrganizationDto | null => {
  const value = toPlainObject(organization);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    name: value.name,
    slug: value.slug,
    status: value.status,
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
