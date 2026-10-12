/**
 * Fires reminders when they come due.
 *
 * The CRM has had a task model with a `dueAt` since long before this file: what it never had
 * was anything that READ it. A follow-up could be created, listed and completed, and the hour
 * it was due for would pass in silence. This is that missing half.
 *
 * WHY A DATABASE SWEEP AND NOT A TIMER. `setTimeout` would be simpler and is wrong for the one
 * thing reminders have to survive: a deploy. Every redeploy of this backend would silently
 * forget every pending timer, and the owner would never know which reminders were lost. The
 * due time lives in Mongo, the sweep asks for it on an interval, and a restart costs at most
 * one interval of lateness.
 *
 * DELIVERY IS TWO INDEPENDENT CHANNELS. WhatsApp is sent from here. The Android alarm is NOT -
 * the handset armed that itself when it last synced, and it will ring whether or not this
 * process is even running. The two are recorded separately and neither failure contaminates
 * the other, which is why `recordReminderDelivery` takes a channel.
 *
 * CATCH-UP POLICY, stated rather than implied: an overdue reminder is still sent, however late,
 * and the message says the time it was FOR. The alternative - dropping anything older than some
 * window - loses the one reminder an owner most wants after their server was down overnight.
 * The only thing that stops a reminder being re-sent is `lastNotificationAt`.
 */
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { FOLLOWUP_STATUSES } from '../../constants/followup-statuses.js';
import {
  REMINDER_CHANNELS,
  REMINDER_DELIVERY_STATUSES,
  REMINDER_MAX_DELIVERY_ATTEMPTS,
} from '../../constants/reminder-channels.js';
import {
  createOwnerNotifyService,
  type OwnerNotifyServiceHandle,
} from '../whatsapp/automation/owner-notify.service.js';
import {
  claimDueReminder as defaultClaimDueReminder,
  finishReminderDelivery as defaultFinishReminderDelivery,
  recordReminderDelivery as defaultRecordReminderDelivery,
  releaseReminderClaim as defaultReleaseReminderClaim,
} from './followup-task.repository.js';
import { type FollowUpTaskDocument } from './followup-task.model.js';
import { buildReminderMessage } from './reminder-message.js';

let ownerNotifySingleton: OwnerNotifyServiceHandle | null = null;
const getOwnerNotifyService = (): OwnerNotifyServiceHandle => {
  ownerNotifySingleton ??= createOwnerNotifyService();
  return ownerNotifySingleton;
};

type Logger = { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };

export interface CreateReminderSweepOptions {
  config?: Env;
  claimDueReminder?: typeof defaultClaimDueReminder;
  releaseReminderClaim?: typeof defaultReleaseReminderClaim;
  recordReminderDelivery?: typeof defaultRecordReminderDelivery;
  finishReminderDelivery?: typeof defaultFinishReminderDelivery;
  notifyOwner?: OwnerNotifyServiceHandle['notifyOwner'];
  /** Injected so tests can drive the clock instead of waiting for one. */
  now?: () => Date;
  logger?: Logger;
}

/** A terminal verdict closes the reminder out; 'retry' leaves it for the next sweep. */
type DeliveryOutcome = 'sent' | 'skipped' | 'failed' | 'retry';

export interface ReminderSweepResult {
  claimed: number;
  whatsappSent: number;
  whatsappFailed: number;
  /** Failed this pass but still inside its attempt budget. */
  whatsappRetrying: number;
}

export const createReminderSweepService = ({
  config = env,
  claimDueReminder = defaultClaimDueReminder,
  releaseReminderClaim = defaultReleaseReminderClaim,
  recordReminderDelivery = defaultRecordReminderDelivery,
  finishReminderDelivery = defaultFinishReminderDelivery,
  // Built lazily and shared, the same way every other caller of this sink does it: constructing
  // it at import time would pull the WhatsApp session manager into any module that merely
  // imports this one.
  notifyOwner = ((params) => getOwnerNotifyService().notifyOwner(params)) as OwnerNotifyServiceHandle['notifyOwner'],
  now = () => new Date(),
  logger = defaultLogger,
}: CreateReminderSweepOptions = {}) => {
  /**
   * Delivers one reminder on WhatsApp.
   *
   * Returns a TERMINAL/RETRY verdict rather than a boolean, and that distinction is the whole
   * retry mechanism: 'retry' means this attempt failed but the budget is not spent, so the
   * caller must leave the reminder un-stamped for the next sweep to pick up. Returning a plain
   * false here is what previously retired a reminder after one failed attempt.
   *
   * Never throws. A reminder that cannot be delivered must not take the sweep down with it,
   * because the next reminder in the queue probably can be.
   */
  const deliverWhatsApp = async (task: FollowUpTaskDocument): Promise<DeliveryOutcome> => {
    const attempts = task.whatsappDelivery?.attempts ?? 0;

    // Out of retries. Recorded as failed and left alone - visible in the task list and in the
    // API, rather than retried forever against whatever is actually broken.
    if (attempts >= REMINDER_MAX_DELIVERY_ATTEMPTS) {
      await recordReminderDelivery({
        taskId: task._id,
        channel: REMINDER_CHANNELS.WHATSAPP,
        status: REMINDER_DELIVERY_STATUSES.FAILED,
        // KEEPS THE LAST REAL CAUSE. Writing only "gave up after N attempts" is true and
        // useless: it overwrites the one field that says WHY, so the record that survives
        // tells an operator nothing they can act on.
        error: `gave up after ${attempts} attempts - last error: ${
          task.whatsappDelivery?.error ?? 'unknown'
        }`.slice(0, 500),
        now: now(),
      });

      return 'failed';
    }

    try {
      const result = await notifyOwner({
        organizationId: task.organizationId,
        accountId: task.whatsappAccountId ?? undefined,
        text: buildReminderMessage(task),
      });

      // notifyOwner resolves with a null id when there is no session or no owner number. That
      // is not an error to retry against - nothing is misconfigured at this end - so it is
      // SKIPPED, and the device alarm remains the owner's path to hearing about this.
      if (!result?.providerMessageId) {
        await recordReminderDelivery({
          taskId: task._id,
          channel: REMINDER_CHANNELS.WHATSAPP,
          status: REMINDER_DELIVERY_STATUSES.SKIPPED,
          error: 'no WhatsApp session or owner number configured',
          now: now(),
        });

        return 'skipped';
      }

      await recordReminderDelivery({
        taskId: task._id,
        channel: REMINDER_CHANNELS.WHATSAPP,
        status: REMINDER_DELIVERY_STATUSES.SENT,
        now: now(),
      });

      return 'sent';
    } catch (error: unknown) {
      const err = error as { message?: unknown; code?: unknown; name?: unknown };

      // PENDING, not FAILED: the attempt counter went up, and the next sweep tries again until
      // REMINDER_MAX_DELIVERY_ATTEMPTS is reached. This is the retry.
      await recordReminderDelivery({
        taskId: task._id,
        channel: REMINDER_CHANNELS.WHATSAPP,
        status: REMINDER_DELIVERY_STATUSES.PENDING,
        error: String(err?.message ?? err?.code ?? 'send failed').slice(0, 500),
        now: now(),
      });

      logger?.error?.(
        { code: err?.code, name: err?.name, taskId: String(task._id) },
        'Reminder WhatsApp delivery failed; it will be retried.',
      );

      return 'retry';
    }
  };

  /**
   * One pass. Claims and delivers up to `limit` reminders, oldest-due first.
   *
   * Bounded per tick on purpose: a backlog after an outage drains over several sweeps instead
   * of firing two hundred WhatsApp messages in one burst, which is how an unofficial WhatsApp
   * connection gets itself banned.
   */
  const sweepOnce = async ({ limit = 25 }: { limit?: number } = {}): Promise<ReminderSweepResult> => {
    const result: ReminderSweepResult = {
      claimed: 0,
      whatsappSent: 0,
      whatsappFailed: 0,
      whatsappRetrying: 0,
    };

    // Belt-and-braces against re-handling one reminder inside a single sweep. The claim/lease
    // should already prevent it; this makes it impossible even if a future change to the
    // release paths reopens that door.
    const handled = new Set<string>();

    for (let processed = 0; processed < limit; processed += 1) {
      const task = await claimDueReminder({ now: now() });

      if (!task) {
        break;
      }

      if (handled.has(String(task._id))) {
        await releaseReminderClaim({ taskId: task._id });
        break;
      }

      handled.add(String(task._id));
      result.claimed += 1;

      // Cancelled or completed between being claimed and being read. Nothing to send; drop the
      // claim and move on. The device learns the same thing from its next sync.
      if (task.status !== FOLLOWUP_STATUSES.PENDING) {
        await releaseReminderClaim({ taskId: task._id });
        continue;
      }

      // Already announced. Belt-and-braces against a lease that expired under a slow send -
      // without it, the reclaim path is a duplicate-message generator.
      if (task.lastNotificationAt) {
        await releaseReminderClaim({ taskId: task._id });
        continue;
      }

      const outcome = await deliverWhatsApp(task);

      if (outcome === 'sent') {
        result.whatsappSent += 1;
      } else {
        result.whatsappFailed += 1;
      }

      // RETRY IS THE ONLY NON-TERMINAL OUTCOME. Stamping `lastNotificationAt` is what tells
      // every later sweep this reminder is done with, so doing it on a retryable failure
      // retires the reminder after a single attempt and REMINDER_MAX_DELIVERY_ATTEMPTS can
      // never be reached. Hand the claim back instead and let the next sweep try again.
      if (outcome === 'retry') {
        result.whatsappRetrying += 1;

        // THE CLAIM IS DELIBERATELY NOT RELEASED. Releasing it here made the reminder
        // immediately eligible again, so this same loop re-claimed it and spent the entire
        // attempt budget in one tick - three "retries" 27 milliseconds apart, against a
        // WhatsApp socket that was equally down for all of them.
        //
        // Leaving the claim in place makes the LEASE the backoff: nobody can touch this
        // reminder until it expires, which is a couple of sweeps away. That is what "retried
        // on the next sweep" was always supposed to mean.
        continue;
      }

      // Terminal - sent, deliberately skipped, or out of attempts. Closed out either way: a
      // permanent WhatsApp failure must not hold the reminder open, because the owner's
      // handset may well have rung regardless and an un-closed reminder would be re-announced
      // on every sweep forever.
      await finishReminderDelivery({ taskId: task._id, now: now() });
    }

    if (result.claimed > 0) {
      logger?.info?.(
        {
          claimed: result.claimed,
          whatsappSent: result.whatsappSent,
          whatsappFailed: result.whatsappFailed,
          whatsappRetrying: result.whatsappRetrying,
        },
        'REMINDER_SWEEP',
      );
    }

    return result;
  };

  return { sweepOnce, config };
};

export type ReminderSweepService = ReturnType<typeof createReminderSweepService>;
