import { AI_BRAIN_APPROVAL_KINDS } from '../../constants/ai-brain-statuses.js';
import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedAiBrainApproval {
  id: string | null;
  conversationId: string | null;
  kind: unknown;
  handoverVerdict: unknown;
  draft: unknown;
  facts: unknown;
  status: unknown;
  resolution: unknown;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeAiBrainApproval = (
  approval: unknown,
): SerializedAiBrainApproval | null => {
  const value = toPlainObject(approval);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    conversationId: serializeId(value.conversationId),
    // Defaulted here as well as in the schema so a record written before handover cards existed
    // still serializes as the reply card it is, without a backfill.
    kind: value.kind ?? AI_BRAIN_APPROVAL_KINDS.REPLY,
    handoverVerdict: value.handoverVerdict ?? null,
    draft: value.draft,
    facts: value.facts ?? {},
    status: value.status,
    resolution: value.resolution,
    resolvedBy: serializeId(value.resolvedBy),
    resolvedAt: serializeDate(value.resolvedAt),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
