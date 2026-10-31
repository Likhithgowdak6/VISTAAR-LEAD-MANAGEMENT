import { logger } from '../../config/logger.js';
import { ORGANIZATION_STATUSES } from '../../constants/organization-statuses.js';
import { Organization } from '../organizations/organization.model.js';
import { runRetentionForOrganization } from './call-retention.service.js';

/**
 * The scheduled half of retention.
 *
 * HOURLY, NOT EVERY FIVE SECONDS. Nothing here is time-critical - a recording deleted at 14:00
 * instead of 13:05 satisfies a 90-day policy identically - and every pass does irreversible
 * work. A slow cadence also means a mistake in a policy has hours of visible warning rather
 * than minutes.
 *
 * IT FINDS NOTHING BY DEFAULT. Every organisation starts with a null policy and the service
 * returns immediately for those, so on a database full of existing customer calls this runner
 * can tick for months and delete exactly nothing until somebody sets a number. That is the
 * intended behaviour, not an oversight.
 *
 * ORGANISATION BY ORGANISATION, because retention is a per-studio setting. A cross-tenant query
 * would apply one studio's policy to another's recordings.
 */

const DEFAULT_INTERVAL_MS = 3_600_000;

export interface CallRetentionRunner {
  start: () => boolean;
  stop: () => void;
  /** One pass, now. The seam tests use instead of waiting an hour. */
  runOnce: () => Promise<void>;
}

export interface CreateCallRetentionRunnerOptions {
  intervalMs?: number;
  runForOrganization?: typeof runRetentionForOrganization;
  /** Injected so a test never needs a database. */
  listOrganizations?: () => Promise<{ _id: unknown }[]>;
}

const activeOrganizations = async (): Promise<{ _id: unknown }[]> =>
  Organization.find({ status: ORGANIZATION_STATUSES.ACTIVE }).select({ _id: 1 }).lean();

export const createCallRetentionRunner = ({
  intervalMs = DEFAULT_INTERVAL_MS,
  runForOrganization = runRetentionForOrganization,
  listOrganizations = activeOrganizations,
}: CreateCallRetentionRunnerOptions = {}): CallRetentionRunner => {
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Stops a slow pass overlapping the next tick and processing the same rows twice. */
  let running = false;

  const runOnce = async (): Promise<void> => {
    if (running) {
      return;
    }

    running = true;

    try {
      const organizations = await listOrganizations();

      for (const organization of organizations) {
        try {
          await runForOrganization({ organizationId: organization._id as string });
        } catch (error: unknown) {
          // ONE STUDIO'S FAILURE MUST NOT STOP THE OTHERS. Logged without detail and skipped;
          // the next pass retries, and nothing has been marked as deleted.
          logger.warn(
            {
              organizationId: String(organization._id),
              code: error instanceof Error ? error.name : 'UNKNOWN',
            },
            'Call retention failed for an organization.',
          );
        }
      }
    } catch (error: unknown) {
      logger.warn(
        { code: error instanceof Error ? error.name : 'UNKNOWN' },
        'Call retention pass failed.',
      );
    } finally {
      running = false;
    }
  };

  return {
    start: () => {
      if (timer) {
        return false;
      }

      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);

      timer.unref?.();

      logger.info({ intervalMs }, 'Call retention runner started.');

      return true;
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce,
  };
};
