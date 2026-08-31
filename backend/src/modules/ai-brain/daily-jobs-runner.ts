/**
 * The two owner-facing daily jobs, wired onto the shared daily scheduler:
 *
 *   DIGEST_HOUR:00 -> the morning handover read (handover-read.service.ts)
 *   DIGEST_HOUR:10 -> the owner digest (digest.service.ts)
 *
 * The ten-minute gap is deliberate: cards the morning read raises appear in that same morning's
 * digest. Both are gated off by default behind DAILY_JOBS_ENABLED, and additionally on
 * WHATSAPP_ENABLED - each job's entire output is a WhatsApp message to the owner, so without a
 * live connection there is nothing for them to do. Same gating style as the nurture runner.
 */
import { env, type Env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { createDailyScheduler, type DailyScheduler } from './daily-scheduler.js';
import { createDigestService, type DigestService } from './digest.service.js';
import { createHandoverReadService, type HandoverReadService } from './handover-read.service.js';

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

/** Minutes past DIGEST_HOUR at which each job fires. */
export const MORNING_READ_MINUTE = 0;
export const DIGEST_MINUTE = 10;

const dailyJobsEnabled = (config: Env): boolean =>
  asBoolean(config.DAILY_JOBS_ENABLED) && asBoolean(config.WHATSAPP_ENABLED);

export interface CreateMorningReadRunnerOptions {
  config?: Env;
  service?: HandoverReadService;
}

export const createMorningReadRunner = ({
  config = env,
  service = createHandoverReadService({ config }),
}: CreateMorningReadRunnerOptions = {}): DailyScheduler =>
  createDailyScheduler({
    hour: Number(config.DIGEST_HOUR ?? 9),
    minute: MORNING_READ_MINUTE,
    timeZone: config.WHATSAPP_BUSINESS_TIMEZONE ?? 'Asia/Kolkata',
    enabled: dailyJobsEnabled(config),
    run: () => service.runMorningRead({}),
    logger,
    name: 'Morning handover read',
  });

export interface CreateDigestRunnerOptions {
  config?: Env;
  service?: DigestService;
}

export const createDigestRunner = ({
  config = env,
  service = createDigestService(),
}: CreateDigestRunnerOptions = {}): DailyScheduler =>
  createDailyScheduler({
    hour: Number(config.DIGEST_HOUR ?? 9),
    minute: DIGEST_MINUTE,
    timeZone: config.WHATSAPP_BUSINESS_TIMEZONE ?? 'Asia/Kolkata',
    enabled: dailyJobsEnabled(config),
    run: () => service.sendDigest({}),
    logger,
    name: 'Owner digest',
  });
