/**
 * The AI's opening message to a lead who came from an ad form rather than from WhatsApp.
 *
 * Everything else this agent sends is a reply. This is the one place it speaks first, to someone
 * who has never messaged the studio, over an unofficial WhatsApp connection, on the number the
 * whole business runs on. That is precisely what WhatsApp bans numbers for, so the guardrails are
 * not decoration:
 *
 *   - Off unless the lead source opts in (`autoGreetEnabled`, default false).
 *   - Only leads that arrived after the source was connected - enforced upstream by the import
 *     floor, because a message about a wedding that already happened is the worst version of this.
 *   - A hard per-tick budget and a pause between sends, so a backlog can never become a burst.
 *   - The first line names the form. A stranger who cannot immediately place why you are in their
 *     WhatsApp is a stranger who reports you.
 *
 * NO NEW PROMPT. The opening is produced by the same qualifying graph that handles every other
 * turn - same voice, same rules, same knowledge base, same refusal to quote a price it was not
 * given - by running it with no inbound text and a one-turn directive. Writing a separate
 * "first contact" prompt would have created a second place for the agent's voice and its
 * constraints to live, and the two would drift.
 */
import { type HydratedDocument } from 'mongoose';

import { type ObjectIdLike } from '../../types/common.js';
import { type ConversationDocument } from '../conversations/conversation.model.js';
import { handleInboundMessageForAutomation as defaultHandleInboundMessageForAutomation } from './ai-brain.service.js';

export interface GreetImportedLeadParams {
  organizationId: ObjectIdLike;
  conversation: HydratedDocument<ConversationDocument>;
  /** The form's name, so the opening can say where this came from. */
  sourceLabel: string;
  category?: string | null;
}

/**
 * The one-turn directive that shapes the opening.
 *
 * Written as an instruction from the owner because that is exactly what it is - "this is your
 * first message, here is why you are in their chat" - and because that channel already exists,
 * is already cleared after a single turn, and is already framed to the model as an order rather
 * than as a fact it may mention.
 */
export const buildGreetingDirective = ({
  sourceLabel,
  category,
}: {
  sourceLabel: string;
  category?: string | null;
}): string => {
  const about =
    category && category !== 'unknown'
      ? `They enquired about ${category.replace(/_/g, ' ')}.`
      : 'They did not say which service.';

  return [
    'This is your FIRST message to this person and they have never messaged us.',
    `They filled in our "${sourceLabel}" enquiry form. ${about}`,
    'Open by referring to the form so they instantly recognise why we are messaging -',
    'they filled it in on an ad and may not remember the studio name.',
    'Then follow the normal opening: say what we do, confirm we do the thing they asked about,',
    'and ask your opening questions. Keep it short and do not apologise for messaging them.',
  ].join(' ');
};

export interface CreateImportedLeadGreetingOptions {
  handleInboundMessageForAutomation?: typeof defaultHandleInboundMessageForAutomation;
}

export const createImportedLeadGreetingService = ({
  handleInboundMessageForAutomation = defaultHandleInboundMessageForAutomation,
}: CreateImportedLeadGreetingOptions = {}) => {
  const greetImportedLead = async ({
    organizationId,
    conversation,
    sourceLabel,
    category,
  }: GreetImportedLeadParams): Promise<void> => {
    await handleInboundMessageForAutomation({
      organizationId,
      conversation,
      // Synthetic, and distinct per conversation: there is no inbound message to attribute this
      // to, and the automation path needs something stable to key its own idempotency on.
      inboundMessageId: `auto-greet:${conversation._id.toString()}`,
      inboundText: '',
      ownerInstruction: buildGreetingDirective({ sourceLabel, category }),
    });
  };

  return { greetImportedLead };
};

export type ImportedLeadGreetingService = ReturnType<typeof createImportedLeadGreetingService>;
