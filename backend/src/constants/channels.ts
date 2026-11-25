/**
 * Which messaging surface a conversation lives on.
 *
 * ABSENT MEANS WHATSAPP, and that is the single most important rule in this file. Every
 * conversation written before this field existed has no `channel` at all, and there are a lot of
 * them. Treating a missing value as "unknown" would hide every historical thread from an inbox
 * that filters by channel; treating it as WhatsApp is both correct - they are all WhatsApp - and
 * the only reading that leaves existing data visible.
 *
 * So: `channelOf()` is the ONLY way to read it. Reading `conversation.channel` directly gives
 * `undefined` for most of the database.
 *
 * Lives in constants/ rather than beside the Instagram code for the same reason
 * `whatsapp-providers.ts` does: it is persisted on the Conversation model, and that model must
 * not import a module that reaches for Graph clients or Baileys sockets.
 */

export const CONVERSATION_CHANNELS = Object.freeze({
  WHATSAPP: 'whatsapp',
  INSTAGRAM: 'instagram',
} as const);

export type ConversationChannel =
  (typeof CONVERSATION_CHANNELS)[keyof typeof CONVERSATION_CHANNELS];

export const CONVERSATION_CHANNEL_VALUES = Object.freeze(
  Object.values(CONVERSATION_CHANNELS),
) as readonly [ConversationChannel, ...ConversationChannel[]];

/**
 * The channel of a conversation that may predate the field.
 *
 * Anything unrecognised also reads as WhatsApp. A value this build does not know about is more
 * likely to be a newer deployment's channel seen during a rolling restart than a corruption, and
 * showing such a thread as WhatsApp is a cosmetic error - hiding it is a lost customer message.
 */
export const channelOf = (conversation: { channel?: unknown } | null | undefined): ConversationChannel =>
  conversation?.channel === CONVERSATION_CHANNELS.INSTAGRAM
    ? CONVERSATION_CHANNELS.INSTAGRAM
    : CONVERSATION_CHANNELS.WHATSAPP;

export const isInstagram = (conversation: { channel?: unknown } | null | undefined): boolean =>
  channelOf(conversation) === CONVERSATION_CHANNELS.INSTAGRAM;

/**
 * A Mongo filter matching WhatsApp conversations INCLUDING the ones with no channel field.
 *
 * `{channel: 'whatsapp'}` alone matches none of the historical data. Every existing query that
 * means "WhatsApp" and newly needs to exclude Instagram must use this, not an equality match.
 */
export const WHATSAPP_CHANNEL_FILTER = Object.freeze({
  channel: { $in: [CONVERSATION_CHANNELS.WHATSAPP, null] },
});

/**
 * Meta's customer service window for Instagram, in milliseconds.
 *
 * Same 24 hours as WhatsApp Cloud, and fixed by Meta's policy rather than configurable - but
 * deliberately its own constant. The two are the same number today and are set by different
 * policies; sharing one constant would mean a change to either silently moving the other.
 *
 * Unlike WhatsApp there is no template mechanism to fall back on: outside the window Instagram
 * accepts only a tagged message, and `HUMAN_AGENT` is the one tag that applies to a human
 * answering a customer, which extends the window to seven days.
 */
export const INSTAGRAM_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long `HUMAN_AGENT` extends it to, once a person is actually replying. */
export const INSTAGRAM_HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const isInstagramWindowOpen = ({
  lastInboundAt,
  now = new Date(),
  humanAgent = false,
}: {
  lastInboundAt: Date | string | null | undefined;
  now?: Date;
  humanAgent?: boolean;
}): boolean => {
  if (!lastInboundAt) {
    return false;
  }

  const last = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
  const lastMs = last.getTime();

  // An unparseable date is not evidence that the window is open. Treating it as closed costs a
  // refused send; treating it as open costs a message the agent believed had gone.
  if (Number.isNaN(lastMs)) {
    return false;
  }

  const window = humanAgent ? INSTAGRAM_HUMAN_AGENT_WINDOW_MS : INSTAGRAM_SERVICE_WINDOW_MS;

  return now.getTime() - lastMs < window;
};
