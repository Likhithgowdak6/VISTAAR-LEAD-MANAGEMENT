import { type HydratedDocument } from 'mongoose';

import {
  AI_KNOWLEDGE_CATEGORIES,
  AI_KNOWLEDGE_CATEGORY_VALUES,
  type AiKnowledgeCategory,
  type AiKnowledgeStatus,
} from '../../constants/ai-knowledge-statuses.js';
import { optimizeKnowledge } from '../ai-brain/ai-brain.client.js';
import { type ObjectIdLike } from '../../types/common.js';
import { type UserDocument } from '../users/user.model.js';
import {
  archiveKnowledge,
  createKnowledge,
  deleteKnowledge,
  findKnowledgeById,
  findKnowledgeByOrganization,
  updateKnowledge,
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

export interface OptimizeKnowledgeDraftParams {
  rawText: string;
}

export interface OptimizedKnowledgeDraft {
  label: string;
  content: string;
  category: AiKnowledgeCategory;
  notes: string;
  /** What the owner typed, echoed back so the UI can offer "keep mine" without re-storing it. */
  rawText: string;
}

/**
 * Rewrites the owner's note into something the agent will follow, and saves nothing.
 *
 * Returning a draft rather than persisting is the point: whatever ends up in the knowledge base
 * is read into every future conversation, so a rewrite the owner never saw is a change to the
 * agent's behaviour that nobody approved.
 *
 * The category the brain picks is validated against this repo's own list before it is handed to
 * the UI - an invented one would only fail the enum later, on save, where the owner could not
 * tell what he had done wrong.
 */
export const optimizeKnowledgeDraft = async ({
  rawText,
}: OptimizeKnowledgeDraftParams): Promise<OptimizedKnowledgeDraft> => {
  const optimized = await optimizeKnowledge({
    rawText,
    categoryOptions: AI_KNOWLEDGE_CATEGORY_VALUES,
  });

  const category = (AI_KNOWLEDGE_CATEGORY_VALUES as readonly string[]).includes(optimized.category)
    ? (optimized.category as AiKnowledgeCategory)
    : AI_KNOWLEDGE_CATEGORIES.RULES;

  return {
    label: optimized.label,
    content: optimized.content,
    category,
    notes: optimized.notes,
    rawText,
  };
};

export interface UpdateKnowledgeForActorParams {
  organizationId: ObjectIdLike;
  knowledgeId: ObjectIdLike;
  actor: Pick<UserDocument, '_id'> | HydratedDocument<UserDocument>;
  label?: string;
  content?: string;
  category?: AiKnowledgeCategory;
}

export const updateKnowledgeForActor = async ({
  organizationId,
  knowledgeId,
  actor,
  label,
  content,
  category,
}: UpdateKnowledgeForActorParams): Promise<SerializedKnowledge | null> => {
  // Read first so a wrong id or another organization's entry is a 404 rather than a silent
  // no-match write, matching how archive behaves.
  const existing = await findKnowledgeById({
    knowledgeId,
    organizationId,
  });

  if (!existing) {
    throw new Error('AI_KNOWLEDGE_NOT_FOUND');
  }

  const updated = await updateKnowledge({
    knowledgeId: existing._id,
    organizationId,
    label,
    content,
    category,
    actorId: actor._id,
  });

  return serializeKnowledge(updated);
};

export interface DeleteKnowledgeForActorParams {
  organizationId: ObjectIdLike;
  knowledgeId: ObjectIdLike;
}

/**
 * Removes an entry for good. Returns the entry as it was, so the caller can report what went.
 *
 * Read-then-delete rather than delete-and-check-the-result, for the same reason archive does it:
 * a wrong id or another organization's entry has to be a 404, not a silent success.
 */
export const deleteKnowledgeForActor = async ({
  organizationId,
  knowledgeId,
}: DeleteKnowledgeForActorParams): Promise<SerializedKnowledge | null> => {
  const existing = await findKnowledgeById({
    knowledgeId,
    organizationId,
  });

  if (!existing) {
    throw new Error('AI_KNOWLEDGE_NOT_FOUND');
  }

  const removed = await deleteKnowledge({
    knowledgeId: existing._id,
    organizationId,
  });

  return serializeKnowledge(removed ?? existing);
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
