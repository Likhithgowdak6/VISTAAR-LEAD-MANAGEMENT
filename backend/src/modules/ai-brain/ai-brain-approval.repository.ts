import { type QueryFilter, type UpdateQuery } from 'mongoose';

import {
  AI_BRAIN_APPROVAL_KINDS,
  AI_BRAIN_APPROVAL_STATUSES,
  type AiBrainApprovalKind,
  type AiBrainApprovalResolution,
} from '../../constants/ai-brain-statuses.js';
import { type DatabaseSession } from '../../config/database.js';
import { type ObjectIdLike, type PaginationParams, toObjectId } from '../../types/common.js';
import { generateApprovalCode } from './approval-code.js';
import { AiBrainApproval, type AiBrainApprovalDocument } from './ai-brain-approval.model.js';

const MAX_CODE_GENERATION_ATTEMPTS = 20;

export interface GenerateUniqueApprovalCodeParams {
  organizationId: ObjectIdLike;
  /**
   * Excludes this conversation's own currently-pending record from the collision check - the
   * record being (re)assigned a fresh code is always for this conversation, so its own current
   * code (about to be replaced) must not count as a collision with itself.
   */
  excludeConversationId?: ObjectIdLike;
  session?: DatabaseSession;
  maxAttempts?: number;
}

/**
 * Generates an `[A-Z][1-9]` code that is not already in use by another PENDING approval in this
 * organization. At 234 possible codes, a collision is astronomically unlikely at any realistic
 * pending-approval count, but this still checks and retries a few times rather than trusting
 * that.
 */
export const generateUniqueApprovalCode = async ({
  organizationId,
  excludeConversationId,
  session,
  maxAttempts = MAX_CODE_GENERATION_ATTEMPTS,
}: GenerateUniqueApprovalCodeParams): Promise<string> => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateApprovalCode();

    const filter: QueryFilter<AiBrainApprovalDocument> = {
      organizationId,
      status: AI_BRAIN_APPROVAL_STATUSES.PENDING,
      code: candidate,
    };

    if (excludeConversationId) {
      filter.conversationId = { $ne: excludeConversationId };
    }

    const existsQuery = AiBrainApproval.exists(filter);
    if (session) {
      existsQuery.session(session);
    }
    const collision = await existsQuery;

    if (!collision) {
      return candidate;
    }
  }

  throw new Error('AI_BRAIN_APPROVAL_CODE_EXHAUSTED');
};

export interface UpsertPendingApprovalParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  draft: string;
  facts: Record<string, unknown>;
  /** Defaults to `reply`, so every existing caller keeps writing reply-draft cards unchanged. */
  kind?: AiBrainApprovalKind;
  /** Only meaningful on a `handover` card: which reading (`won`/`lost`/`unclear`) raised it. */
  handoverVerdict?: string | null;
  session?: DatabaseSession;
}

/**
 * Creates the pending-approval record, or updates it in place if one is already open for this
 * conversation - which happens on an "edit" loop, where ai-brain-service raises a fresh
 * interrupt with a revised draft for the same pause. Either way this is a new card for the
 * owner to review, on the dashboard and on WhatsApp, so it always gets a freshly generated
 * approval code.
 */
export const upsertPendingApproval = async ({
  organizationId,
  conversationId,
  draft,
  facts,
  kind = AI_BRAIN_APPROVAL_KINDS.REPLY,
  handoverVerdict = null,
  session,
}: UpsertPendingApprovalParams): Promise<AiBrainApprovalDocument | null> => {
  const code = await generateUniqueApprovalCode({
    organizationId,
    excludeConversationId: conversationId,
    session,
  });

  return AiBrainApproval.findOneAndUpdate(
    {
      organizationId,
      conversationId,
      status: AI_BRAIN_APPROVAL_STATUSES.PENDING,
    },
    {
      $set: { draft, facts, code, kind, handoverVerdict },
      $setOnInsert: {
        organizationId: toObjectId(organizationId),
        conversationId: toObjectId(conversationId),
        status: AI_BRAIN_APPROVAL_STATUSES.PENDING,
      },
    } as UpdateQuery<AiBrainApprovalDocument>,
    { upsert: true, returnDocument: 'after', runValidators: true, session },
  ).exec();
};

export interface FindPendingApprovalParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
}

export const findPendingApprovalForConversation = ({
  organizationId,
  conversationId,
}: FindPendingApprovalParams = {}) =>
  AiBrainApproval.findOne({
    organizationId,
    conversationId,
    status: AI_BRAIN_APPROVAL_STATUSES.PENDING,
  }).exec();

export interface ListPendingApprovalsParams extends PaginationParams {
  organizationId?: ObjectIdLike;
}

export const listPendingApprovals = ({
  organizationId,
  limit = 100,
  skip = 0,
}: ListPendingApprovalsParams = {}) =>
  AiBrainApproval.find({ organizationId, status: AI_BRAIN_APPROVAL_STATUSES.PENDING })
    .sort({ createdAt: 1 })
    .skip(skip)
    .limit(limit)
    .exec();

export interface ResolveApprovalParams {
  approvalId: ObjectIdLike;
  organizationId?: ObjectIdLike;
  resolution: AiBrainApprovalResolution;
  resolvedBy: ObjectIdLike;
  now?: Date;
  session?: DatabaseSession;
}

export const resolveApproval = ({
  approvalId,
  organizationId,
  resolution,
  resolvedBy,
  now = new Date(),
  session,
}: ResolveApprovalParams) =>
  AiBrainApproval.findOneAndUpdate(
    { _id: approvalId, organizationId },
    {
      $set: {
        status: AI_BRAIN_APPROVAL_STATUSES.RESOLVED,
        resolution,
        resolvedBy,
        resolvedAt: now,
      },
    } as UpdateQuery<AiBrainApprovalDocument>,
    { returnDocument: 'after', runValidators: true, session },
  ).exec();

export const findApprovalById = ({
  approvalId,
  organizationId,
}: {
  approvalId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}) => AiBrainApproval.findOne({ _id: approvalId, organizationId }).exec();
