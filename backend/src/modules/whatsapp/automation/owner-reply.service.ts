import { logger } from '../../../config/logger.js';
import { type ObjectIdLike } from '../../../types/common.js';
import { handleOwnerApprovalReply as defaultHandleOwnerApprovalReply } from '../../ai-brain/owner-approval-card.service.js';
import { createOwnerReminderCommandService } from '../../followups/owner-reminder-command.service.js';

export interface HandleOwnerSelfChatReplyParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  text?: string;
  messageId?: string | null;
  handleOwnerApprovalReply?: typeof defaultHandleOwnerApprovalReply;
  handleOwnerReminderCommand?: ReturnType<
    typeof createOwnerReminderCommandService
  >['handleOwnerReminderCommand'];
}

/**
 * The owner's "message yourself" chat is the approval channel - a typed reply like "A7 1" (or
 * just "1" when only one draft is open) acts on a pending AI draft exactly like the dashboard's
 * Approve/Revise/Skip buttons. The actual parsing/classification/resolution lives in
 * owner-approval-card.service.ts; this is just the routed call site, wrapped so a malformed or
 * unexpected owner reply can never crash the inbound WhatsApp message pipeline.
 */
let reminderCommandSingleton: ReturnType<typeof createOwnerReminderCommandService> | null = null;
const getReminderCommandService = () => {
  reminderCommandSingleton ??= createOwnerReminderCommandService();
  return reminderCommandSingleton;
};

export const handleOwnerSelfChatReply = async ({
  organizationId,
  whatsappAccountId,
  text,
  messageId,
  handleOwnerApprovalReply = defaultHandleOwnerApprovalReply,
  handleOwnerReminderCommand = (params) =>
    getReminderCommandService().handleOwnerReminderCommand(params),
}: HandleOwnerSelfChatReplyParams = {}): Promise<void> => {
  try {
    // Reminders are offered the message FIRST, behind a strict prefilter that cannot match an
    // approval code like "A7 1" or a payment reply like "VX12 collected". Anything it does not
    // claim falls through untouched, so every existing owner workflow behaves exactly as before
    // - which is the whole reason the service returns `handled` instead of a boolean guess.
    const reminder = await handleOwnerReminderCommand({
      organizationId,
      whatsappAccountId,
      text,
      messageId,
    });

    // The service sends its own acknowledgement - owner-notify is deliberately NOT imported
    // here, because this module already sits inside the cycle that file's header describes and
    // pulling it in collapses type inference across half the ai-brain module.
    if (reminder?.handled) {
      return;
    }

    await handleOwnerApprovalReply({ organizationId, whatsappAccountId, text, messageId });
  } catch (error: unknown) {
    const err = error as { code?: unknown; name?: unknown };
    logger.error(
      { code: err?.code, name: err?.name },
      'Owner self-chat approval-reply handling failed safely.',
    );
  }
};
