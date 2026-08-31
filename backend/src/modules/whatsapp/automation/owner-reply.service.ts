import { logger } from '../../../config/logger.js';
import { type ObjectIdLike } from '../../../types/common.js';
import { handleOwnerApprovalReply as defaultHandleOwnerApprovalReply } from '../../ai-brain/owner-approval-card.service.js';

export interface HandleOwnerSelfChatReplyParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  text?: string;
  messageId?: string | null;
  handleOwnerApprovalReply?: typeof defaultHandleOwnerApprovalReply;
}

/**
 * The owner's "message yourself" chat is the approval channel - a typed reply like "A7 1" (or
 * just "1" when only one draft is open) acts on a pending AI draft exactly like the dashboard's
 * Approve/Revise/Skip buttons. The actual parsing/classification/resolution lives in
 * owner-approval-card.service.ts; this is just the routed call site, wrapped so a malformed or
 * unexpected owner reply can never crash the inbound WhatsApp message pipeline.
 */
export const handleOwnerSelfChatReply = async ({
  organizationId,
  whatsappAccountId,
  text,
  messageId,
  handleOwnerApprovalReply = defaultHandleOwnerApprovalReply,
}: HandleOwnerSelfChatReplyParams = {}): Promise<void> => {
  try {
    await handleOwnerApprovalReply({ organizationId, whatsappAccountId, text, messageId });
  } catch (error: unknown) {
    const err = error as { code?: unknown; name?: unknown };
    logger.error(
      { code: err?.code, name: err?.name },
      'Owner self-chat approval-reply handling failed safely.',
    );
  }
};
