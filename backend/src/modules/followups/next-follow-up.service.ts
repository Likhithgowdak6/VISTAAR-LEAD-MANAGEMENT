/**
 * Keeping `Conversation.nextFollowUpAt` honest.
 *
 * WHAT THE FIELD MEANS, now that something finally writes it: the earliest due time among a
 * conversation's ACTIONABLE reminders - that is, its pending ones. Completed and cancelled
 * reminders are not work, so they do not count. An OVERDUE reminder very much is still work, so
 * a due time in the past is a perfectly good value here; "overdue" is a reading of this field,
 * not a reason to clear it. When a conversation has no pending reminders left the field goes
 * back to null.
 *
 * WHY IT IS RECOMPUTED RATHER THAN ADJUSTED. Every call re-derives the answer from the
 * FollowUpTask collection instead of nudging the stored value. That costs one indexed query -
 * the `{organizationId, conversationId, status, dueAt}` index already exists and answers it by
 * reading a single entry - and buys three things that an incremental update cannot:
 *
 *   - IT IS IDEMPOTENT. Running it twice is the same as running it once, so a retry is free.
 *   - IT CANNOT DRIFT. An incremental "is this sooner than what is stored?" is wrong the moment
 *     two reminders change close together, or a write is lost. This reads the truth each time,
 *     which also means it SELF-HEALS: the next mutation on that conversation repairs whatever
 *     the last one got wrong.
 *   - IT NEEDS NO LOCK. Two concurrent recomputes race to write the same derived value.
 *
 * DELIVERY DOES NOT DEPEND ON THIS. The reminder runner claims due tasks straight from
 * FollowUpTask; nothing about ringing a reminder reads `nextFollowUpAt`. So a failed sync
 * degrades an inbox hint, never a delivery - which is why the callers below log and continue
 * rather than failing a reminder that was saved successfully.
 *
 * PERSONAL REMINDERS NEVER REACH HERE. A reminder with no conversationId has no conversation
 * field to maintain, and the callers check before calling.
 */
import { FOLLOWUP_STATUSES } from '../../constants/followup-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import { setConversationNextFollowUpAt as defaultSetConversationNextFollowUpAt } from '../conversations/conversation.repository.js';
import { findEarliestPendingDueAt as defaultFindEarliestPendingDueAt } from './followup-task.repository.js';

export interface SyncNextFollowUpParams {
  organizationId?: ObjectIdLike | null;
  conversationId?: ObjectIdLike | null;
}

export interface CreateNextFollowUpSyncDeps {
  findEarliestPendingDueAt?: typeof defaultFindEarliestPendingDueAt;
  setConversationNextFollowUpAt?: typeof defaultSetConversationNextFollowUpAt;
  logger?: { error?: (...args: unknown[]) => void };
}

export const createNextFollowUpSync = ({
  findEarliestPendingDueAt = defaultFindEarliestPendingDueAt,
  setConversationNextFollowUpAt = defaultSetConversationNextFollowUpAt,
  logger = console,
}: CreateNextFollowUpSyncDeps = {}) => {
  /**
   * Recomputes and stores the conversation's next actionable due time.
   *
   * Returns what it wrote, or null when there is nothing pending. Callers that do not care about
   * the value should prefer `syncQuietly` below.
   */
  const syncNextFollowUpAt = async ({
    organizationId,
    conversationId,
  }: SyncNextFollowUpParams): Promise<Date | null> => {
    // A personal reminder, or a caller that does not know its organization. Either way there is
    // no conversation field to maintain and guessing one would be the bug this exists to avoid.
    if (!conversationId || !organizationId) {
      return null;
    }

    const nextFollowUpAt = await findEarliestPendingDueAt({
      organizationId,
      conversationId,
      status: FOLLOWUP_STATUSES.PENDING,
    });

    await setConversationNextFollowUpAt({
      organizationId,
      conversationId,
      nextFollowUpAt,
    });

    return nextFollowUpAt;
  };

  /**
   * The form every reminder mutation uses: sync, and never let a failure here turn a reminder
   * that WAS saved into an error the caller has to handle.
   *
   * Silent only in the sense that it does not throw - the failure is logged with the ids and no
   * customer data, and the stale value is temporary by construction: the next create, reschedule,
   * complete or cancel on that conversation recomputes it, and the backfill script
   * (`npm run backfill:next-follow-up`) repairs anything that never sees another mutation.
   */
  const syncQuietly = async (params: SyncNextFollowUpParams): Promise<void> => {
    try {
      await syncNextFollowUpAt(params);
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.('Could not refresh nextFollowUpAt for a conversation.', {
        code: err?.code,
        name: err?.name,
        conversationId: String(params.conversationId ?? ''),
      });
    }
  };

  return { syncNextFollowUpAt, syncQuietly };
};

export type NextFollowUpSync = ReturnType<typeof createNextFollowUpSync>;

let instance: NextFollowUpSync | null = null;

/** Lazily constructed so importing this module does not pull in the repositories at load time. */
export const getNextFollowUpSync = (): NextFollowUpSync => {
  instance ??= createNextFollowUpSync();

  return instance;
};
