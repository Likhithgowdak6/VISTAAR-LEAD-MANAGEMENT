import { type AiDraftOutcome } from '../../constants/ai-draft-outcomes.js';
import { type ObjectIdLike, toObjectId } from '../../types/common.js';
import { AiDraft } from './ai-draft.model.js';

export interface CreateAiDraftParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  contactId: ObjectIdLike;
  requestedBy: ObjectIdLike;
  draftText: string;
  contextMessageCount: number;
}

export const createAiDraft = ({
  organizationId,
  conversationId,
  contactId,
  requestedBy,
  draftText,
  contextMessageCount,
}: CreateAiDraftParams) =>
  AiDraft.create({
    organizationId: toObjectId(organizationId),
    conversationId: toObjectId(conversationId),
    contactId: toObjectId(contactId),
    requestedBy: toObjectId(requestedBy),
    draftText,
    contextMessageCount,
  });

export interface FindAiDraftByIdParams {
  draftId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const findAiDraftById = ({ draftId, organizationId }: FindAiDraftByIdParams = {}) =>
  AiDraft.findOne({
    _id: draftId,
    organizationId,
  }).exec();

export interface UpdateAiDraftOutcomeParams {
  draftId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  outcome?: AiDraftOutcome;
}

export const updateAiDraftOutcome = ({
  draftId,
  organizationId,
  outcome,
}: UpdateAiDraftOutcomeParams = {}) =>
  AiDraft.findOneAndUpdate(
    {
      _id: draftId,
      organizationId,
    },
    {
      $set: {
        outcome,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
