import { type HydratedDocument } from 'mongoose';

import { AI_DRAFT_OUTCOME_VALUES, type AiDraftOutcome } from '../../constants/ai-draft-outcomes.js';
import { type Permission } from '../../constants/permissions.js';
import { env } from '../../config/env.js';
import { type ObjectIdLike } from '../../types/common.js';
import { type UserDocument } from '../users/user.model.js';
import { loadVisibleConversationForActor } from '../conversations/conversation.service.js';

import { AiDisabledError, AiProviderError, AiRateLimitedError } from './ai.errors.js';
import { buildReplyDraftContext } from './ai-context.service.js';
import { checkAiDraftRateLimit } from './ai-rate-limit.service.js';
import { createAiDraft, findAiDraftById, updateAiDraftOutcome } from './ai-draft.repository.js';
import { getAiProvider } from './ai-provider.instance.js';
import { serializeAiDraft, type SerializedAiDraft } from './ai-draft.serializer.js';

export interface GenerateReplyDraftForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actor: Pick<UserDocument, '_id'> | HydratedDocument<UserDocument>;
}

export const generateReplyDraftForActor = async ({
  organizationId,
  conversationId,
  permissions,
  actor,
}: GenerateReplyDraftForActorParams): Promise<SerializedAiDraft | null> => {
  if (!env.AI_ENABLED) {
    throw new AiDisabledError();
  }

  const rateLimit = await checkAiDraftRateLimit({
    userId: actor._id,
    limitPerHour: env.AI_DRAFT_RATE_LIMIT_PER_HOUR,
  });

  if (rateLimit.limited) {
    throw new AiRateLimitedError();
  }

  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const { systemPrompt, threadText, contextMessageCount } = await buildReplyDraftContext({
    organizationId,
    conversation,
    contextMessageCount: env.AI_DRAFT_CONTEXT_MESSAGE_COUNT,
  });

  const provider = getAiProvider();
  const { draftText } = await provider.generateReplyDraft({ systemPrompt, threadText });

  if (!draftText) {
    throw new AiProviderError('AI provider returned an empty draft.');
  }

  const draft = await createAiDraft({
    organizationId,
    conversationId: conversation._id,
    contactId: conversation.contactId,
    requestedBy: actor._id,
    draftText,
    contextMessageCount,
  });

  return serializeAiDraft(draft);
};

export interface RecordDraftOutcomeForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  draftId: ObjectIdLike;
  outcome: AiDraftOutcome;
  permissions: readonly Permission[];
  actor: Pick<UserDocument, '_id'> | HydratedDocument<UserDocument>;
}

export const recordDraftOutcomeForActor = async ({
  organizationId,
  conversationId,
  draftId,
  outcome,
  permissions,
  actor,
}: RecordDraftOutcomeForActorParams): Promise<SerializedAiDraft | null> => {
  if (!AI_DRAFT_OUTCOME_VALUES.includes(outcome)) {
    throw new Error('AI_DRAFT_INVALID_OUTCOME');
  }

  await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const draft = await findAiDraftById({ draftId, organizationId });

  if (!draft || draft.conversationId.toString() !== conversationId.toString()) {
    throw new Error('AI_DRAFT_NOT_FOUND');
  }

  const updated = await updateAiDraftOutcome({ draftId, organizationId, outcome });

  return serializeAiDraft(updated);
};
