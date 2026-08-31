import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';
import { type AiDraftOutcome } from '../../constants/ai-draft-outcomes.js';

export interface SerializedAiDraft {
  id: string | null;
  conversationId: string | null;
  draftText: unknown;
  contextMessageCount: unknown;
  outcome: AiDraftOutcome | null | unknown;
  createdAt: string | null;
}

export const serializeAiDraft = (draft: unknown): SerializedAiDraft | null => {
  const value = toPlainObject(draft);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    conversationId: serializeId(value.conversationId),
    draftText: value.draftText,
    contextMessageCount: value.contextMessageCount,
    outcome: value.outcome,
    createdAt: serializeDate(value.createdAt),
  };
};
