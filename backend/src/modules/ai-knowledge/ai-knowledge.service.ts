import { type HydratedDocument } from 'mongoose';

import {
  type AiKnowledgeCategory,
  type AiKnowledgeStatus,
} from '../../constants/ai-knowledge-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import { type UserDocument } from '../users/user.model.js';
import {
  archiveKnowledge,
  createKnowledge,
  findKnowledgeById,
  findKnowledgeByOrganization,
} from './ai-knowledge.repository.js';
import { serializeKnowledge, type SerializedKnowledge } from './ai-knowledge.serializer.js';

export interface ListKnowledgeForOrganizationParams {
  organizationId: ObjectIdLike;
  status?: AiKnowledgeStatus;
  limit?: number;
  skip?: number;
}

export const listKnowledgeForOrganization = async ({
  organizationId,
  status,
  limit,
  skip,
}: ListKnowledgeForOrganizationParams): Promise<(SerializedKnowledge | null)[]> => {
  const knowledge = await findKnowledgeByOrganization({
    organizationId,
    status,
    limit,
    skip,
  });

  return knowledge.map((item) => serializeKnowledge(item));
};

export interface CreateKnowledgeForActorParams {
  organizationId: ObjectIdLike;
  actor: Pick<UserDocument, '_id'> | HydratedDocument<UserDocument>;
  label: string;
  content: string;
  category?: AiKnowledgeCategory;
}

export const createKnowledgeForActor = async ({
  organizationId,
  actor,
  label,
  content,
  category,
}: CreateKnowledgeForActorParams): Promise<SerializedKnowledge | null> => {
  const knowledge = await createKnowledge({
    organizationId,
    label,
    content,
    category,
    createdBy: actor._id,
  });

  return serializeKnowledge(knowledge);
};

export interface ArchiveKnowledgeForActorParams {
  organizationId: ObjectIdLike;
  knowledgeId: ObjectIdLike;
  actor: Pick<UserDocument, '_id'> | HydratedDocument<UserDocument>;
}

export const archiveKnowledgeForActor = async ({
  organizationId,
  knowledgeId,
  actor,
}: ArchiveKnowledgeForActorParams): Promise<SerializedKnowledge | null> => {
  const knowledge = await findKnowledgeById({
    knowledgeId,
    organizationId,
  });

  if (!knowledge) {
    throw new Error('AI_KNOWLEDGE_NOT_FOUND');
  }

  const archived = await archiveKnowledge({
    knowledgeId: knowledge._id,
    organizationId,
    actorId: actor._id,
  });

  return serializeKnowledge(archived);
};
