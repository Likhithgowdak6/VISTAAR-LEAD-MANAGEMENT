import { type HydratedDocument } from 'mongoose';

import {
  CONVERSATION_STAGE_VALUES,
  type ConversationStage,
} from '../../constants/conversation-stages.js';
import { STAGE_STATUSES, type StageStatus } from '../../constants/stage-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import { type UserDocument } from '../users/user.model.js';
import {
  archiveStage,
  createStage,
  deleteStage,
  findStageByKeyInOrg,
  findStageById,
  findStagesByOrganization,
  normalizeStageKey,
} from './stage.repository.js';
import { serializeStage } from './stage.serializer.js';

export interface ListStagesForOrganizationParams {
  organizationId: ObjectIdLike;
  status?: StageStatus;
  limit?: number;
  skip?: number;
}

export const listStagesForOrganization = async ({
  organizationId,
  status,
  limit,
  skip,
}: ListStagesForOrganizationParams) => {
  const stages = await findStagesByOrganization({
    organizationId,
    status,
    limit,
    skip,
  });

  return stages.map((stage) => serializeStage(stage));
};

export interface CreateStageForActorParams {
  organizationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  label: string;
  key?: string;
  color?: string;
}

export const createStageForActor = async ({
  organizationId,
  actor,
  label,
  key,
  color,
}: CreateStageForActorParams) => {
  const resolvedKey = normalizeStageKey(key ?? label);

  if ((CONVERSATION_STAGE_VALUES as readonly string[]).includes(resolvedKey)) {
    throw new Error('STAGE_KEY_RESERVED');
  }

  const existing = await findStageByKeyInOrg({
    organizationId,
    key: resolvedKey,
  });

  if (existing) {
    throw new Error('STAGE_KEY_EXISTS');
  }

  const stage = await createStage({
    organizationId,
    key: resolvedKey,
    label,
    color,
    createdBy: actor._id,
  });

  return serializeStage(stage);
};

export interface ArchiveStageForActorParams {
  organizationId: ObjectIdLike;
  stageId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
}

export const archiveStageForActor = async ({
  organizationId,
  stageId,
  actor,
}: ArchiveStageForActorParams) => {
  const stage = await findStageById({
    stageId,
    organizationId,
  });

  if (!stage) {
    throw new Error('STAGE_NOT_FOUND');
  }

  const archived = await archiveStage({
    stageId: stage._id,
    organizationId,
    actorId: actor._id,
  });

  return serializeStage(archived);
};

/**
 * Permanently removes a custom stage (not the same as archiving: this drops the row entirely,
 * not just hides it from future selection). Any conversation already sitting on this stage keeps
 * its plain-string value — there's no foreign key to cascade — so it just displays as a raw key
 * with no known label/color from then on (StageBadge already falls back to that gracefully).
 */
export interface DeleteStageForActorParams {
  organizationId: ObjectIdLike;
  stageId: ObjectIdLike;
}

export const deleteStageForActor = async ({
  organizationId,
  stageId,
}: DeleteStageForActorParams) => {
  const deleted = await deleteStage({
    stageId,
    organizationId,
  });

  if (!deleted) {
    throw new Error('STAGE_NOT_FOUND');
  }

  return serializeStage(deleted);
};

/**
 * Every conversation stage value must be either a permanent built-in (the fixed 7-value enum) or
 * an active, org-defined custom stage. Called before a conversation's stage is changed, since the
 * Mongoose schema no longer enforces this at the database layer (custom values can't be a fixed
 * `enum`). Returns the canonical value to store — the built-in as-is, or the custom stage's
 * normalized `key` — so a differently-cased/spaced input still lands on the exact stored key.
 */
export interface ResolveUsableStageValueParams {
  organizationId: ObjectIdLike;
  stage: string;
}

export const resolveUsableStageValue = async ({
  organizationId,
  stage,
}: ResolveUsableStageValueParams): Promise<string> => {
  if ((CONVERSATION_STAGE_VALUES as readonly string[]).includes(stage)) {
    return stage as ConversationStage;
  }

  const custom = await findStageByKeyInOrg({
    organizationId,
    key: stage,
  });

  if (!custom || custom.status !== STAGE_STATUSES.ACTIVE) {
    throw new Error('INVALID_STAGE');
  }

  return custom.key;
};
