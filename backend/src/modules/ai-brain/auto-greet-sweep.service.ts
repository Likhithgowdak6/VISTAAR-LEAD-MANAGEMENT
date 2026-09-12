/**
 * Sends the opening message to imported leads whose pause has elapsed.
 *
 * The import books the moment (`autoGreetDueAt`); this decides that the moment has come and
 * actually speaks. Split that way because the import poll runs on a ten-minute tick: greeting
 * inline would message someone thirty seconds after they filled the form if the timing landed
 * that way, which reads as being watched rather than being served, and a pause held only in
 * memory would be lost on the next restart along with the greeting.
 *
 * This is the one place the system speaks first, so the pacing lives here:
 *
 *   - A hard budget per sweep, far below anything the importer does. Importing two hundred rows
 *     is free; messaging two hundred strangers is the shape of a spam run, and on an unofficial
 *     WhatsApp connection that is how the number - and every conversation on it - is lost.
 *   - A pause between sends, because five messages in five seconds reads as a bot to WhatsApp's
 *     own heuristics as much as to the people receiving them.
 *   - A backlog stays a backlog. Everything is still imported and the owner is still alerted about
 *     all of it; the greetings simply continue on later sweeps.
 *
 * A failed send hands the claim back, so this is at-least-once. That is the right way round here:
 * a duplicate greeting is embarrassing, but an unsent one is a lead who heard nothing while the
 * owner was told the AI had it.
 */
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import {
  claimAutoGreet as defaultClaimAutoGreet,
  findConversationsDueForAutoGreet as defaultFindConversationsDueForAutoGreet,
  releaseAutoGreetClaim as defaultReleaseAutoGreetClaim,
} from '../conversations/conversation.repository.js';
import { findLeadSourceById as defaultFindLeadSourceById } from '../lead-sources/lead-source.repository.js';
import { createImportedLeadGreetingService } from './imported-lead-greeting.service.js';

type Logger = { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };

export interface CreateAutoGreetSweepOptions {
  config?: Env;
  findConversationsDueForAutoGreet?: typeof defaultFindConversationsDueForAutoGreet;
  claimAutoGreet?: typeof defaultClaimAutoGreet;
  releaseAutoGreetClaim?: typeof defaultReleaseAutoGreetClaim;
  findLeadSourceById?: typeof defaultFindLeadSourceById;
  greetImportedLead?: ReturnType<typeof createImportedLeadGreetingService>['greetImportedLead'];
  /** Injectable so tests do not wait out the real spacing. */
  delay?: (ms: number) => Promise<void>;
  logger?: Logger;
  now?: () => Date;
}

export const createAutoGreetSweepService = ({
  config = env,
  findConversationsDueForAutoGreet = defaultFindConversationsDueForAutoGreet,
  claimAutoGreet = defaultClaimAutoGreet,
  releaseAutoGreetClaim = defaultReleaseAutoGreetClaim,
  findLeadSourceById = defaultFindLeadSourceById,
  greetImportedLead = createImportedLeadGreetingService().greetImportedLead,
  delay = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  logger = defaultLogger,
  now = () => new Date(),
}: CreateAutoGreetSweepOptions = {}) => {
  const maxPerSweep = Number(config.LEAD_AUTO_GREET_MAX_PER_TICK ?? 5);
  const spacingMs = Number(config.LEAD_AUTO_GREET_SPACING_MS ?? 20000);

  const run = async (): Promise<void> => {
    const due = await findConversationsDueForAutoGreet({
      dueBefore: now(),
      limit: maxPerSweep,
    });

    if (due.length === 0) {
      return;
    }

    let sent = 0;

    for (const conversation of due) {
      const claimed = await claimAutoGreet({
        conversationId: conversation._id,
        organizationId: conversation.organizationId,
      });

      if (!claimed) {
        continue;
      }

      try {
        // Re-read the source at send time, not at import time. The owner may have switched the
        // greeting off, or paused the form entirely, in the minutes since - and the whole point
        // of a pause is that it is a window in which he can still change his mind.
        const leadSource = conversation.leadSourceId
          ? await findLeadSourceById({
              leadSourceId: conversation.leadSourceId,
              organizationId: conversation.organizationId,
            })
          : null;

        if (leadSource && leadSource.autoGreetEnabled !== true) {
          logger.info?.(
            { conversationId: conversation._id.toString() },
            'Auto-greet skipped: the source was switched off during the pause.',
          );
          continue;
        }

        await greetImportedLead({
          organizationId: conversation.organizationId,
          conversation,
          sourceLabel: leadSource?.name ?? 'our enquiry form',
          category: conversation.aiCategory,
        });

        sent += 1;

        if (sent < due.length) {
          await delay(spacingMs);
        }
      } catch (error: unknown) {
        await releaseAutoGreetClaim({
          conversationId: conversation._id,
          organizationId: conversation.organizationId,
        }).catch(() => {});

        const err = error as { name?: unknown; message?: unknown };
        logger.error?.(
          { conversationId: conversation._id.toString(), name: err?.name, message: err?.message },
          'Auto-greet failed; claim released so the next sweep retries.',
        );
      }
    }

    if (sent > 0) {
      logger.info?.({ sent }, 'Auto-greet sweep opened conversations with imported leads.');
    }
  };

  return { run };
};

export type AutoGreetSweepService = ReturnType<typeof createAutoGreetSweepService>;
