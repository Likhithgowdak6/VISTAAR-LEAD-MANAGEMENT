import { type QueryFilter } from 'mongoose';

import {
  type AiKnowledgeCategory,
  AI_KNOWLEDGE_STATUSES,
  type AiKnowledgeStatus,
} from '../../constants/ai-knowledge-statuses.js';
import { type ObjectIdLike, toObjectId } from '../../types/common.js';
import { AiKnowledge, type AiKnowledgeDocument } from './ai-knowledge.model.js';

export interface CreateKnowledgeParams {
  organizationId: ObjectIdLike;
  label: string;
  content: string;
  category?: AiKnowledgeCategory;
  createdBy?: ObjectIdLike | null;
}

export const createKnowledge = ({
  organizationId,
  label,
  content,
  category,
  createdBy = null,
}: CreateKnowledgeParams) =>
  AiKnowledge.create({
    organizationId: toObjectId(organizationId),
    label,
    content,
    category,
    createdBy: createdBy ? toObjectId(createdBy) : null,
  });

export interface FindKnowledgeByOrganizationParams {
  organizationId?: ObjectIdLike;
  status?: AiKnowledgeStatus;
  limit?: number;
  skip?: number;
}

export const findKnowledgeByOrganization = ({
  organizationId,
  status,
  limit = 100,
  skip = 0,
}: FindKnowledgeByOrganizationParams = {}) => {
  const filter: QueryFilter<AiKnowledgeDocument> = {
    organizationId,
  };

  if (status) {
    filter.status = status;
  }

  return AiKnowledge.find(filter)
    .sort({
      label: 1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface FindActiveKnowledgeForOrganizationParams {
  organizationId?: ObjectIdLike;
}

// Used internally by the AI context builder — always active-only, no pagination needed since
// this feeds a prompt, not a paginated UI list.
export const findActiveKnowledgeForOrganization = ({
  organizationId,
}: FindActiveKnowledgeForOrganizationParams = {}) =>
  AiKnowledge.find({
    organizationId,
    status: AI_KNOWLEDGE_STATUSES.ACTIVE,
  })
    .sort({
      label: 1,
    })
    .exec();

export interface FindKnowledgeByIdParams {
  knowledgeId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const findKnowledgeById = ({ knowledgeId, organizationId }: FindKnowledgeByIdParams = {}) =>
  AiKnowledge.findOne({
    _id: knowledgeId,
    organizationId,
  }).exec();

export interface ArchiveKnowledgeParams {
  knowledgeId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  actorId?: ObjectIdLike;
}

export const archiveKnowledge = ({
  knowledgeId,
  organizationId,
  actorId,
}: ArchiveKnowledgeParams = {}) =>
  AiKnowledge.findOneAndUpdate(
    {
      _id: knowledgeId,
      organizationId,
    },
    {
      $set: {
        status: AI_KNOWLEDGE_STATUSES.ARCHIVED,
        updatedBy: actorId ? toObjectId(actorId) : undefined,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
