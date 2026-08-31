import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';
import {
  type AiKnowledgeCategory,
  type AiKnowledgeStatus,
} from '../../constants/ai-knowledge-statuses.js';

export interface SerializedKnowledge {
  id: string | null;
  organizationId: string | null;
  label: unknown;
  content: unknown;
  category: AiKnowledgeCategory | unknown;
  status: AiKnowledgeStatus | unknown;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeKnowledge = (knowledge: unknown): SerializedKnowledge | null => {
  const value = toPlainObject(knowledge);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    label: value.label,
    content: value.content,
    category: value.category,
    status: value.status,
    createdBy: serializeId(value.createdBy),
    updatedBy: serializeId(value.updatedBy),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
