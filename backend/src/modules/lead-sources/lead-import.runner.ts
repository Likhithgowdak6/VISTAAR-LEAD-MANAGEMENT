import { env, type Env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { createLeadImportService, type LeadImportService } from './lead-import.service.js';

export interface CreateLeadImportRunnerOptions {
  config?: Env;
  service?: LeadImportService;
}

/**
 * Polls every active lead source on an interval. Same shape as the realtime outbox and delivery
 * runners: re-entrancy guarded so a slow sheet fetch cannot overlap itself, timer `unref`ed so
 * it never holds the process open, and tick errors logged rather than thrown.
 */
export const createLeadImportRunner = ({
  config = env,
  service = createLeadImportService(),
}: CreateLeadImportRunnerOptions = {}) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const intervalMs = Number(config.LEAD_IMPORT_POLL_INTERVAL_MS ?? 600_000);
  const enabled = config.LEAD_IMPORT_ENABLED === true;

  const tick = async () => {
    if (running || !enabled) {
      return;
    }
    running = true;

    try {
      await service.drain();
    } catch (error: unknown) {
      const errorRecord =
        error && typeof error === 'object' ? (error as { code?: unknown; name?: unknown }) : {};
      logger.error(
        { code: errorRecord.code, name: errorRecord.name },
        'Lead import tick failed safely.',
      );
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (timer || !enabled) {
      return false;
    }

    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
    void tick();
    return true;
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, stop, tick };
};

export type LeadImportRunner = ReturnType<typeof createLeadImportRunner>;
