import { type QueryFilter } from 'mongoose';

import { STAGE_STATUSES, type StageStatus } from '../../constants/stage-statuses.js';
import { type ObjectIdLike, type PaginationParams, toObjectId } from '../../types/common.js';
import { Stage, type StageDocument } from './stage.model.js';

export const normalizeStageKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export interface CreateStageParams {
  organizationId: ObjectIdLike;
  key?: string;
  label: string;
  color?: string;
  createdBy?: ObjectIdLike | null;
}

export const createStage = ({
  organizationId,
  key,
  label,
  color,
  createdBy = null,
}: CreateStageParams) =>
  Stage.create({
    organizationId: toObjectId(organizationId),
    key: normalizeStageKey(key ?? label),
    label,
    color,
    createdBy: createdBy ? toObjectId(createdBy) : null,
  });

export interface FindStagesByOrganizationParams extends PaginationParams {
  organizationId?: ObjectIdLike;
  status?: StageStatus;
}

export const findStagesByOrganization = ({
  organizationId,
  status,
  limit = 100,
  skip = 0,
}: FindStagesByOrganizationParams = {}) => {
  const filter: QueryFilter<StageDocument> = {
    organizationId,
  };

  if (status) {
    filter.status = status;
  }

  return Stage.find(filter)
    .sort({
      label: 1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface FindStageByKeyInOrgParams {
  organizationId?: ObjectIdLike;
  key?: string;
}

export const findStageByKeyInOrg = ({ organizationId, key }: FindStageByKeyInOrgParams = {}) =>
  Stage.findOne({
    organizationId,
    key: normalizeStageKey(key as string),
  }).exec();

export interface FindStageByIdParams {
  stageId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const findStageById = ({ stageId, organizationId }: FindStageByIdParams = {}) =>
  Stage.findOne({
    _id: stageId,
    organizationId,
  }).exec();

export interface DeleteStageParams {
  stageId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const deleteStage = ({ stageId, organizationId }: DeleteStageParams = {}) =>
  Stage.findOneAndDelete({
    _id: stageId,
    organizationId,
  }).exec();

export interface ArchiveStageParams {
  stageId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  actorId?: ObjectIdLike;
}

export const archiveStage = ({ stageId, organizationId, actorId }: ArchiveStageParams = {}) =>
  Stage.findOneAndUpdate(
    {
      _id: stageId,
      organizationId,
    },
    {
      $set: {
        status: STAGE_STATUSES.ARCHIVED,
        updatedBy: actorId,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
