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
export type GreetingOrigin = 'form' | 'manual' | 'form_call_scheduling';

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
/**
 * THE FORM'S NAME IS NOT AN ANSWER THEY GAVE.
 *
 * Observed in a real model call: a lead with no service answer, on a form the owner had called
 * "Wedding Sept-Dec", was greeted with "thanks for filling in the wedding form" - the studio
 * telling a stranger what they want, based on the owner's own filing system. A form named for
 * weddings collects birthday and corporate enquiries too, and the first message is exactly where
 * getting that wrong costs the lead.
 *
 * Applies to BOTH form variants. The label is the owner's filing, whichever opening is being
 * written, and the ordinary variant's "confirm we do the thing they asked about" is if anything
 * the stronger invitation to invent an occasion.
 */
const doNotInferTheServiceFromTheFormName = (sourceLabel: string): string[] => [
  'YOU DO NOT KNOW WHAT THEY WANT. The form is called',
  `"${sourceLabel}", and that is OUR name for it, not something they told us -`,
  'it is not evidence of their occasion and you must not infer one from it.',
  'Do not call it "the wedding form" or name any service they did not ask for.',
  'Acknowledge the enquiry in neutral terms, say briefly what we do, and ASK what',
  'they are looking for. Keep the warmth general rather than about "the day".',
];

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
  // "We know" means THEY told us, on the form. Anything else - the form's name, the campaign,
  // what this source usually brings in - is our inference, and inference is what produced a
  // message telling a stranger they wanted a wedding shoot.
  const hasVerifiedService = Boolean(category && category !== 'unknown');

  const about = hasVerifiedService
    ? `They enquired about ${category!.replace(/_/g, ' ')}.`
    : 'They did not say which service.';

  if (origin === 'manual') {
    const context = originNote?.trim()
      ? `How we know them, in the owner's own words: "${originNote.trim()}". Work that into your first line so they can place us.`
      : 'You do NOT know how we got their number. Do not invent a reason, do not mention a form, an ad or an enquiry, and do not imply they contacted us. Just open with who we are and what they need.';

    return [
      'This is your FIRST message to this person and they have never messaged us.',
      `${about} ${context}`,
      'They did NOT fill in a form - never say or imply that they did.',
      // The failure this exists to stop: "Himanshu asked me to get in touch" - which casts the
      // message as a middleman relaying an errand. The studio is one or two people; the client
      // expects to be talking to them, and a WhatsApp from "their assistant" is both stranger
      // and colder than one from the studio itself. Say "we", never "the owner" or "he".
      'WRITE AS THE STUDIO ITSELF, IN THE FIRST PERSON. Never mention the owner by name or',
      'by title, never say anyone asked or told you to make contact, and never present yourself',
      'as passing on someone else\'s message. There is no third party in this conversation.',
      'Then follow the normal opening: confirm we do the thing they need,',
      'and ask your opening questions. Keep it short and do not apologise for messaging them.',
    ].join(' ');
  }

  if (origin === 'form_call_scheduling') {
    // THE GOAL IS DESCRIBED, NOT DICTATED. The brief this came from contained a specific
    // sentence about "the people, emotions and little moments". Putting that sentence here as
    // required output would make every lead receive the identical paragraph - which is the
    // definition of a mass campaign, and reads as one by the third person who compares notes.
    // So the INTENT is stated and the wording is the model's, which is also how every other
    // message this agent sends already works.
    return [
      'This is your FIRST message to this person and they have never messaged us.',
      `They filled in our "${sourceLabel}" enquiry form. ${about}`,
      'Open by referring to the form so they instantly recognise why we are messaging -',
      'they filled it in on an ad and may not remember the studio name.',
      'Use their name if you have it; if you do not, greet them without one rather than',
      'leaving a gap. Mention their occasion and date ONLY where you actually have them -',
      'never guess either, and do not repeat the occasion more than once.',
      ...(hasVerifiedService ? [] : doNotInferTheServiceFromTheFormName(sourceLabel)),
      'Convey, IN YOUR OWN WORDS AND DIFFERENTLY EACH TIME, that what matters to us is not just',
      'covering the event but capturing the people, the feeling and the small moments they will',
      'want back later. Do not reuse a stock sentence for this - say it the way it fits THIS',
      "person's occasion.",
      'Then ask, naturally, whether they have a time today for a short call.',
      'ONE clear ask: the call. Do not also ask your usual qualifying questions in this message.',
      'No prices, no packages, no availability, no deliverables, no discounts and no urgency -',
      'you have been given none of those and must not imply any.',
      'Keep it short, warm and human, and do not apologise for messaging them.',
    ].join(' ');
  }

  return [
    'This is your FIRST message to this person and they have never messaged us.',
    `They filled in our "${sourceLabel}" enquiry form. ${about}`,
    'Open by referring to the form so they instantly recognise why we are messaging -',
    'they filled it in on an ad and may not remember the studio name.',
    ...(hasVerifiedService
      ? ['Then follow the normal opening: say what we do, confirm we do the thing they asked about,']
      : [
          ...doNotInferTheServiceFromTheFormName(sourceLabel),
          'Then follow the normal opening: say what we do,',
        ]),
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
