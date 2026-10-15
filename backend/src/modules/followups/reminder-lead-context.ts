/**
 * Who the reminder is about, so the owner can act on it without opening anything.
 *
 * THE PROBLEM THIS SOLVES. A reminder used to arrive saying "Check if they messaged you back" -
 * true, and useless an hour later, because it never said WHO. The owner had to open the CRM,
 * find the thread, and remember what the person wanted before they could do anything. Three
 * facts fix that, and all three already exist in the database: the lead's name, their number,
 * and one line about what they are after.
 *
 * NO NEW LLM CALL. The requirement is read from what has already been written about this
 * thread, in descending order of how much a human trusted it (see `describeRequirement`). A
 * model call per notification would add cost and latency to a path whose whole job is to be
 * punctual, and would invent a requirement on a thread that does not have one yet.
 *
 * FAILURE IS NOT FATAL. Every lookup here is best-effort: if the conversation or the contact
 * cannot be read, the reminder still goes out with whatever was found. A reminder that fires
 * late or thin beats one that does not fire because a join failed.
 *
 * PHONE NUMBERS ARE ENCRYPTED AT REST and are read through
 * `findContactPrivatePiiForInternalUse`, the same accessor the outbound sender uses. The number
 * is put into a message addressed to the OWNER and is never logged - see the sweep, which logs
 * counts only.
 */
import { type ObjectIdLike } from '../../types/common.js';
import { findContactPrivatePiiForInternalUse as defaultFindContactPii } from '../contacts/contact.repository.js';
import { findConversationById as defaultFindConversationById } from '../conversations/conversation.repository.js';
import { type FollowUpTaskDocument } from './followup-task.model.js';

/** Long enough to be useful on a phone screen, short enough not to be swiped away. */
export const REQUIREMENT_MAX_LENGTH = 180;

export interface ReminderLeadContext {
  /** The lead's name, or null when the thread has none. */
  displayName: string | null;
  /** Their number in `+<digits>` form, or null when there is none stored. */
  phone: string | null;
  /** One line on what they want, or null when nothing has been recorded yet. */
  requirement: string | null;
}

const EMPTY: ReminderLeadContext = Object.freeze({
  displayName: null,
  phone: null,
  requirement: null,
});

/** Collapses whitespace and trims to `max`, ending on a word where it can. */
export const truncate = (value: string, max: number): string => {
  const clean = value.replace(/\s+/g, ' ').trim();

  if (clean.length <= max) {
    return clean;
  }

  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');

  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};

/**
 * `+919876543210` from whatever shape the number is stored in.
 *
 * Returns null rather than a half-formatted string for anything that is not a plausible
 * number - the owner taps this to call someone, and a mangled one wastes that tap.
 */
export const formatPhone = (phone: unknown): string | null => {
  if (typeof phone !== 'string') {
    return null;
  }

  const digits = phone.replace(/\D/g, '');

  // Shorter than a national number anywhere; almost certainly junk or a partial record.
  if (digits.length < 8 || digits.length > 15) {
    return null;
  }

  return `+${digits}`;
};

type ConversationLike = {
  displayName?: string | null;
  contactId?: ObjectIdLike | null;
  summary?: string | null;
  aiSummary?: { headline?: string | null } | null;
  aiCategory?: string | null;
  aiFacts?: Record<string, unknown> | null;
};

/** Reads better in a sentence than the raw playbook key. */
const humanise = (value: string): string => value.replace(/[_-]+/g, ' ').trim();

/**
 * One line describing what this lead wants, from what is already known about them.
 *
 * ORDERED BY HOW MUCH A HUMAN TRUSTED IT, which is the only defensible ordering when several
 * sources disagree:
 *
 *   1. the CRM note someone typed by hand - a person decided this was worth writing down;
 *   2. the AI's catch-up headline, which is literally defined as "who this is and what they
 *      want" and was generated when somebody asked for it;
 *   3. the structured facts - the event, when, where. This is what an imported lead-ad
 *      submission carries, and it is the common case for a form lead nobody has chatted to.
 *
 * `lastMessagePreview` IS NOT A FOURTH SOURCE, and it is worth saying why it looks like one.
 * That field holds the last message in EITHER direction - outbound-message.service.ts writes it
 * on every send - and it carries no flag saying which. Using it would print our own AI's last
 * line back at the owner under the heading "Requirement", attributing our words to the customer:
 *
 *     📌 Requirement: Yes, we do wedding shoots - which date is it?
 *
 * Reading the latest INBOUND message instead would be accurate but costs a third query per
 * reminder to quote one raw line - often "ok" - and for a lead follow-up the customer's own
 * words are already on the Reason line directly beneath. So this stops at the facts.
 *
 * Returns null when none of those exist. The caller renders "Requirement not yet clear" rather
 * than this file guessing - a reminder that invents what someone wants is worse than one that
 * admits it does not know.
 */
export const describeRequirement = (conversation: ConversationLike | null): string | null => {
  if (!conversation) {
    return null;
  }

  const note = (conversation.summary ?? '').trim();

  if (note !== '') {
    return truncate(note, REQUIREMENT_MAX_LENGTH);
  }

  const headline = (conversation.aiSummary?.headline ?? '').trim();

  if (headline !== '') {
    return truncate(headline, REQUIREMENT_MAX_LENGTH);
  }

  // The facts, in the order someone would say them out loud. Only ones with a real value: an
  // imported form leaves blanks and "not answered" markers all over the place.
  const facts = conversation.aiFacts ?? {};
  const readFact = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = facts[key];

      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim();
      }
    }

    return null;
  };

  const category = (conversation.aiCategory ?? '').trim();
  const service = readFact('event_type', 'service', 'photo_or_video');
  const when = readFact('event_date', 'shoot_date', 'date');
  const where = readFact('city', 'venue', 'location');

  const head = service ?? (category !== '' && category !== 'unknown' ? humanise(category) : null);
  const detail = [when, where].filter(Boolean).join(', ');

  if (head && detail) {
    return truncate(`${humanise(head)} — ${detail}`, REQUIREMENT_MAX_LENGTH);
  }

  if (head) {
    return truncate(humanise(head), REQUIREMENT_MAX_LENGTH);
  }

  return detail ? truncate(detail, REQUIREMENT_MAX_LENGTH) : null;
};

export interface LoadReminderLeadContextOptions {
  findConversationById?: typeof defaultFindConversationById;
  findContactPii?: typeof defaultFindContactPii;
  logger?: { error?: (...args: unknown[]) => void };
}

/**
 * Everything the notification needs about the lead behind one reminder.
 *
 * SCOPED TO THE TASK'S OWN ORGANIZATION on both reads, and keyed on the conversation id the
 * reminder was created with - never on a name. Looking a customer up by name is how one
 * owner's reminder ends up carrying another customer's phone number, and two leads called
 * "Rahul" is not a hypothetical.
 *
 * Returns empty context for a personal reminder, which has no conversation and must not be
 * given invented lead details.
 */
export const loadReminderLeadContext = async (
  task: Pick<FollowUpTaskDocument, 'organizationId' | 'conversationId'>,
  {
    findConversationById = defaultFindConversationById,
    findContactPii = defaultFindContactPii,
    logger,
  }: LoadReminderLeadContextOptions = {},
): Promise<ReminderLeadContext> => {
  if (!task.conversationId) {
    return EMPTY;
  }

  try {
    const conversation = (await findConversationById({
      conversationId: task.conversationId,
      organizationId: task.organizationId,
    })) as ConversationLike | null;

    if (!conversation) {
      return EMPTY;
    }

    const displayName = (conversation.displayName ?? '').trim() || null;
    const requirement = describeRequirement(conversation);

    let phone: string | null = null;

    if (conversation.contactId) {
      // Separate try: a contact row that cannot be decrypted must not cost the owner the name
      // and the requirement too.
      try {
        const pii = await findContactPii({
          contactId: conversation.contactId,
          organizationId: task.organizationId,
        });

        phone = formatPhone(pii?.phone);
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown };
        logger?.error?.(
          { code: err?.code, name: err?.name },
          'Reminder lead phone lookup failed safely; the reminder will go without a number.',
        );
      }
    }

    return { displayName, phone, requirement };
  } catch (error: unknown) {
    const err = error as { code?: unknown; name?: unknown };
    logger?.error?.(
      { code: err?.code, name: err?.name },
      'Reminder lead context lookup failed safely; sending the reminder without it.',
    );

    return EMPTY;
  }
};
