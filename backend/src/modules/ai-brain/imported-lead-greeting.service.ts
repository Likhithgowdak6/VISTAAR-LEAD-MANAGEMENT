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

/** Where the lead came from. Decides what the opening line may truthfully claim. */
export type GreetingOrigin = 'form' | 'manual';

export interface GreetImportedLeadParams {
  organizationId: ObjectIdLike;
  conversation: HydratedDocument<ConversationDocument>;
  /** The form's name, so the opening can say where this came from. Ignored when origin is manual. */
  sourceLabel: string;
  category?: string | null;
  origin?: GreetingOrigin;
  /** For a manual lead: how the owner actually knows them ("met at the wedding expo"). */
  originNote?: string | null;
}

/**
 * The one-turn directive that shapes the opening.
 *
 * Written as an instruction from the owner because that is exactly what it is - "this is your
 * first message, here is why you are in their chat" - and because that channel already exists,
 * is already cleared after a single turn, and is already framed to the model as an order rather
 * than as a fact it may mention.
 *
 * TWO VARIANTS, AND THE SPLIT IS NOT COSMETIC. The form variant instructs the model to open by
 * naming the form. Sent to a lead the owner typed in by hand, that is a fabricated claim about
 * something the person never did - the fastest possible way to be reported by someone who knows
 * perfectly well they filled in no form. The manual variant says only what is actually true, and
 * says it vaguely when the owner gave no context, because a vague honest opening is recoverable
 * and a confident false one is not.
 */
export const buildGreetingDirective = ({
  sourceLabel,
  category,
  origin = 'form',
  originNote,
}: {
  sourceLabel: string;
  category?: string | null;
  origin?: GreetingOrigin;
  originNote?: string | null;
}): string => {
  const about =
    category && category !== 'unknown'
      ? `They enquired about ${category.replace(/_/g, ' ')}.`
      : 'They did not say which service.';

  if (origin === 'manual') {
    const context = originNote?.trim()
      ? `Here is how we know them, in the owner's words: "${originNote.trim()}". Refer to it naturally in your first line so they can place us.`
      : 'You do NOT know how we got their number. Do not invent a reason, do not mention a form, an ad or an enquiry, and do not imply they contacted us. Open by introducing the studio plainly and saying the owner asked you to get in touch about their shoot.';

    return [
      'This is your FIRST message to this person and they have never messaged us.',
      'The owner added them to the system by hand.',
      `${about} ${context}`,
      'They did NOT fill in a form - never say or imply that they did.',
      'Then follow the normal opening: confirm we do the thing they need,',
      'and ask your opening questions. Keep it short and do not apologise for messaging them.',
    ].join(' ');
  }

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
    origin = 'form',
    originNote = null,
  }: GreetImportedLeadParams): Promise<void> => {
    await handleInboundMessageForAutomation({
      organizationId,
      conversation,
      // Synthetic, and distinct per conversation: there is no inbound message to attribute this
      // to, and the automation path needs something stable to key its own idempotency on.
      inboundMessageId: `auto-greet:${conversation._id.toString()}`,
      inboundText: '',
      ownerInstruction: buildGreetingDirective({ sourceLabel, category, origin, originNote }),
    });
  };

  return { greetImportedLead };
};

export type ImportedLeadGreetingService = ReturnType<typeof createImportedLeadGreetingService>;
