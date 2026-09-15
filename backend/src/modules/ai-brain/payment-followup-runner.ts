import { env, type Env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { createDailyScheduler, type DailyScheduler } from './daily-scheduler.js';
import {
  getPaymentFollowUpService,
  type PaymentFollowUpService,
} from './payment-followup.service.js';

export interface CreatePaymentFollowUpRunnerOptions {
  config?: Env;
  service?: PaymentFollowUpService;
}

/** Minutes past DIGEST_HOUR. After the countdown, so the morning reads: needs you, coming up, money. */
export const PAYMENT_FOLLOWUP_MINUTE = 30;

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

/**
 * Daily runner for the post-event payment question.
 *
 * Once a day rather than on an interval: it asks about shoots that finished yesterday, and that
 * set only changes when the date does.
 *
 * Gated with the other owner-facing daily jobs - every one of its outputs is a WhatsApp message,
 * so without a live connection there is nothing for it to do. Note that the REPLY path is not
 * gated by this: if the question went out yesterday and the job is switched off today, his answer
 * is still read and acted on.
 */
export const createPaymentFollowUpRunner = ({
  config = env,
  service = getPaymentFollowUpService(),
}: CreatePaymentFollowUpRunnerOptions = {}): DailyScheduler =>
  createDailyScheduler({
    hour: Number(config.DIGEST_HOUR ?? 9),
    minute: PAYMENT_FOLLOWUP_MINUTE,
    timeZone: config.WHATSAPP_BUSINESS_TIMEZONE ?? 'Asia/Kolkata',
    enabled: asBoolean(config.DAILY_JOBS_ENABLED) && asBoolean(config.WHATSAPP_ENABLED),
    run: () => service.run(),
    logger,
    name: 'Payment follow-up',
  });
