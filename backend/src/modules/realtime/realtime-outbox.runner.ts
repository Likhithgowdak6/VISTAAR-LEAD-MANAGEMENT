import { env, type Env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  createRealtimeOutboxService,
  type RealtimeOutboxService,
} from './realtime-outbox.service.js';

export interface CreateRealtimeOutboxRunnerOptions {
  config?: Env;
  service?: RealtimeOutboxService;
}

export const createRealtimeOutboxRunner = ({
  config = env,
  service = createRealtimeOutboxService(),
}: CreateRealtimeOutboxRunnerOptions = {}) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const intervalMs = Number(config.REALTIME_OUTBOX_POLL_INTERVAL_MS ?? 1000);
  const batchSize = Number(config.REALTIME_OUTBOX_BATCH_SIZE ?? 100);

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;

    try {
      await service.drain(batchSize);
    } catch (error: unknown) {
      const errorRecord =
        error && typeof error === 'object' ? (error as { code?: unknown; name?: unknown }) : {};
      logger.error(
        { code: errorRecord.code, name: errorRecord.name },
        'Realtime outbox tick failed safely.',
      );
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (timer) {
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

export type RealtimeOutboxRunner = ReturnType<typeof createRealtimeOutboxRunner>;
