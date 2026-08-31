import { type QueryFilter } from 'mongoose';

import { TAG_STATUSES, type TagStatus } from '../../constants/tag-statuses.js';
import { type ObjectIdLike, type PaginationParams, toObjectId } from '../../types/common.js';
import { Tag, type TagDocument } from './tag.model.js';

export const normalizeTagSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export interface CreateTagParams {
  organizationId: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike | null;
  name: string;
  slug?: string;
  color?: string;
  description?: string;
  createdBy?: ObjectIdLike | null;
}

export const createTag = ({
  organizationId,
  whatsappAccountId = null,
  name,
  slug,
  color,
  description,
  createdBy = null,
}: CreateTagParams) =>
  Tag.create({
    organizationId: toObjectId(organizationId),
    whatsappAccountId: whatsappAccountId ? toObjectId(whatsappAccountId) : null,
    name,
    slug: normalizeTagSlug(slug ?? name),
    color,
    description,
    createdBy: createdBy ? toObjectId(createdBy) : null,
  });

export interface FindTagsByOrganizationParams extends PaginationParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike | null;
  includeGlobal?: boolean;
  status?: TagStatus;
}

export const findTagsByOrganization = ({
  organizationId,
  whatsappAccountId,
  includeGlobal = true,
  status,
  limit = 100,
  skip = 0,
}: FindTagsByOrganizationParams = {}) => {
  const filter: QueryFilter<TagDocument> = {
    organizationId,
  };

  if (status) {
    filter.status = status;
  }

  if (whatsappAccountId) {
    filter.whatsappAccountId = includeGlobal
      ? {
          $in: [null, whatsappAccountId],
        }
      : whatsappAccountId;
  }

  return Tag.find(filter)
    .sort({
      name: 1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface FindTagBySlugInScopeParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike | null;
  slug?: string;
}

export const findTagBySlugInScope = ({
  organizationId,
  whatsappAccountId = null,
  slug,
}: FindTagBySlugInScopeParams = {}) =>
  Tag.findOne({
    organizationId,
    whatsappAccountId,
    slug: normalizeTagSlug(slug as string),
  }).exec();

export interface FindTagByIdParams {
  tagId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const findTagById = ({ tagId, organizationId }: FindTagByIdParams = {}) =>
  Tag.findOne({
    _id: tagId,
    organizationId,
  }).exec();

export interface ArchiveTagParams {
  tagId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  actorId?: ObjectIdLike;
}

export const archiveTag = ({ tagId, organizationId, actorId }: ArchiveTagParams = {}) =>
  Tag.findOneAndUpdate(
    {
      _id: tagId,
      organizationId,
    },
    {
      $set: {
        status: TAG_STATUSES.ARCHIVED,
        updatedBy: actorId,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
