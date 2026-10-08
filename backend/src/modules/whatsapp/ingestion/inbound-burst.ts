/**
 * Groups a customer's rapid-fire messages into ONE logical turn.
 *
 * People do not write one tidy paragraph on WhatsApp. They write:
 *
 *     "Hi"  /  "I need a photographer"  /  "For my wedding"  /  "December 15"
 *
 * Judged one at a time, "Hi" is a greeting to ignore and the rest are four separate enquiries
 * that earn four separate replies - a bot talking over someone who is still typing. Judged
 * together, it is one person asking one thing, and it deserves one answer.
 *
 * SO: the first message opens a short window, every message from the same conversation inside
 * that window extends it, and when it closes the texts are joined and handed on as a single
 * turn. One intent call, one decision, at most one reply.
 *
 * WHY THE WINDOW RESETS rather than running from the first message: someone typing a fifth
 * line should not have it arrive after the decision was already made on the first four. The
 * window closes when they stop typing, not on a fixed deadline from when they started.
 *
 * STATE IS IN MEMORY, DELIBERATELY. It holds at most a few seconds of half-finished turns, and
 * the alternative - another collection, another writer, another thing to reconcile - is a
 * second conversation state system for data with a three-second lifetime. A restart mid-window
 * loses the turn, which fails in the safe direction: the AI says nothing and the owner still
 * has every message in the inbox. The backend runs as one process (systemd `vistaar`); a second
 * instance would need this moved to Redis, which is a note for that day and not before.
 *
 * SERIALISED PER CONVERSATION. A flush that is still running holds the next one behind it, so
 * two bursts can never generate two replies in parallel for the same person.
 */
import { type ObjectIdLike } from '../../../types/common.js';

export interface InboundBurstTurn {
  /** Every message in the burst, oldest first, joined for the classifier and the brain. */
  text: string;
  /** How many inbound messages this turn represents. Logged; never a message body. */
  messageCount: number;
  /** The last message in the burst - the turn's identity for idempotency downstream. */
  lastMessageId: string;
}

export interface CreateInboundBurstCollectorOptions {
  debounceMs: number;
  /** Injected so tests do not wait out real time. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  logger?: { error?: (...args: unknown[]) => void };
}

interface PendingBurst {
  texts: string[];
  lastMessageId: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** Captured from the most recent message, so the turn carries the freshest state. */
  flush: (turn: InboundBurstTurn) => Promise<void>;
}

export interface CollectInboundMessageParams {
  conversationId: ObjectIdLike;
  messageId: ObjectIdLike;
  text: string;
  /** Runs once, when the window closes, with the whole burst. */
  flush: (turn: InboundBurstTurn) => Promise<void>;
}

/**
 * Joins a burst into the text the classifier sees.
 *
 * Plain spaces, not newlines or bullets: the result is read by a model being asked "is this
 * person enquiring about the business", and inventing structure the customer did not type
 * risks it reading a list of four fragments as a form rather than a sentence.
 */
export const joinBurstTexts = (texts: readonly string[]): string =>
  texts
    .map((text) => String(text ?? '').trim())
    .filter((text) => text !== '')
    .join(' ');

export const createInboundBurstCollector = ({
  debounceMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger,
}: CreateInboundBurstCollectorOptions) => {
  const pending = new Map<string, PendingBurst>();
  /** One promise chain per conversation, so flushes for the same person never overlap. */
  const running = new Map<string, Promise<void>>();

  const fire = (key: string) => {
    const burst = pending.get(key);

    if (!burst) {
      return;
    }

    pending.delete(key);

    const turn: InboundBurstTurn = {
      text: joinBurstTexts(burst.texts),
      messageCount: burst.texts.length,
      lastMessageId: burst.lastMessageId,
    };

    // Chained, not awaited: ingestion has long since returned. The chain is what guarantees a
    // second burst waits for the first rather than racing it into a duplicate reply.
    const previous = running.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => burst.flush(turn))
      .catch((error: unknown) => {
        logger?.error?.({ err: error }, 'Inbound burst flush failed; the turn is dropped.');
      })
      .finally(() => {
        // Only clear if nothing has queued behind us in the meantime.
        if (running.get(key) === next) {
          running.delete(key);
        }
      });

    running.set(key, next);
  };

  /**
   * Adds a message to its conversation's open window, opening one if needed.
   *
   * Returns immediately - the caller is in the middle of ingesting and must not be held for
   * three seconds while the window runs.
   */
  const collect = ({ conversationId, messageId, text, flush }: CollectInboundMessageParams) => {
    const key = String(conversationId);
    const existing = pending.get(key);

    if (existing) {
      existing.texts.push(text);
      existing.lastMessageId = String(messageId);
      // The freshest closure wins: it carries the newest conversation document.
      existing.flush = flush;

      if (existing.timer) {
        clearTimer(existing.timer);
      }

      existing.timer = setTimer(() => fire(key), debounceMs);
      return;
    }

    const burst: PendingBurst = {
      texts: [text],
      lastMessageId: String(messageId),
      timer: null,
      flush,
    };

    pending.set(key, burst);

    // A window of zero means "no batching" - used by tests, and a legitimate configuration for
    // anyone who would rather answer instantly than wait for a second line.
    if (debounceMs <= 0) {
      fire(key);
      return;
    }

    burst.timer = setTimer(() => fire(key), debounceMs);
  };

  /** Closes every open window now. For tests and for a graceful shutdown. */
  const flushAll = async () => {
    for (const [key, burst] of [...pending.entries()]) {
      if (burst.timer) {
        clearTimer(burst.timer);
      }

      fire(key);
    }

    await Promise.allSettled([...running.values()]);
  };

  /** True while a conversation has an open window. Test seam. */
  const isPending = (conversationId: ObjectIdLike) => pending.has(String(conversationId));

  return { collect, flushAll, isPending };
};

export type InboundBurstCollector = ReturnType<typeof createInboundBurstCollector>;
