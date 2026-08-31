import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const booleanString = z.preprocess((value: unknown) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === 'true') {
    return true;
  }

  if (normalizedValue === 'false') {
    return false;
  }

  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().positive().default(5001),

  // Accepts one origin or a comma-separated list, so a dev frontend that lands on a fallback
  // Vite port (5174 when 5173 is taken) still passes CORS without editing the backend.
  FRONTEND_ORIGIN: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .refine((origins) => origins.length > 0, { message: 'At least one origin is required.' })
    .refine((origins) => origins.every((origin) => z.string().url().safeParse(origin).success), {
      message: 'Every origin must be a valid URL.',
    }),

  MONGODB_URI: z.string().min(1),

  REDIS_URL: z.string().min(1),

  LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),

  // Number of reverse proxies in front of the app. Express only derives `req.ip`
  // from X-Forwarded-For once this is set, and IP-keyed rate limits depend on it.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  // Per-IP ceiling across the whole API. 0 disables the limiter.
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(10000).default(300),

  REALTIME_OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),

  REALTIME_OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),

  BCRYPT_ROUNDS: z.coerce.number().int().min(12).max(15).default(12),

  JWT_ACCESS_SECRET: z.string().min(32),

  JWT_ACCESS_EXPIRES_IN: z.string().min(2).default('15m'),

  REFRESH_TOKEN_BYTES: z.coerce.number().int().min(32).max(128).default(64),

  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

  ENCRYPTION_KEY_CURRENT_VERSION: z
    .string()
    .regex(/^[1-9]\d*$/)
    .optional(),

  ENCRYPTION_KEY_V1: z.string().optional(),

  ENCRYPTION_KEY_V2: z.string().optional(),

  ENCRYPTION_KEY_V3: z.string().optional(),

  CONTACT_LOOKUP_HMAC_KEY: z.string().optional(),

  WHATSAPP_PROVIDER: z.enum(['baileys']).default('baileys'),

  WHATSAPP_ENABLED: booleanString.default(false),

  WHATSAPP_POC_ACCOUNT_ID: z.string().optional(),

  WHATSAPP_QR_OUTPUT: z.enum(['terminal']).default('terminal'),

  WHATSAPP_ALLOW_DISPOSABLE_POC_ONLY: booleanString.default(true),

  WHATSAPP_SEND_TEXT_POC_ENABLED: booleanString.default(false),

  WHATSAPP_MAX_OUTBOUND_PER_MINUTE: z.coerce.number().int().min(1).max(20).default(5),

  WHATSAPP_PERSIST_INBOUND_ENABLED: booleanString.default(false),

  WHATSAPP_OUTBOUND_DELIVERY_ENABLED: booleanString.default(false),

  WHATSAPP_OUTBOUND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  WHATSAPP_OUTBOUND_LEASE_MS: z.coerce.number().int().min(30_000).max(900_000).default(120_000),

  WHATSAPP_OUTBOUND_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),

  // Test-phase safety net: CSV of digits-only phone numbers. Empty = unrestricted. When
  // non-empty, every outbound send on every account (AI or human-authored) must match.
  WHATSAPP_TEST_ALLOWED_NUMBERS: z.string().default(''),

  // The owner's own phone - a DIFFERENT number from the one the agent is connected as. Every
  // owner-facing message (new-lead alerts, approval cards, escalations, the daily digest) goes
  // here, and messages arriving FROM here are read as the owner's decisions rather than as a
  // lead talking, so the owner never appears in the pipeline as a lead.
  //
  // Leave empty to keep the older single-phone behaviour, where the agent messages its own
  // "message yourself" chat. Digits only; the country code is optional, matched on trailing
  // digits, so 8183003081 and 918183003081 both work.
  //
  // This is only the default now: an organization can set its own number from the dashboard
  // (Settings), which wins over this. See modules/organizations/organization-settings.service.ts
  // for the DB -> env -> self-chat resolution order.
  WHATSAPP_OWNER_NUMBER: z.string().default(''),

  // Human-like delay window applied before an AI-authored message is eligible to send.
  WHATSAPP_HUMAN_DELAY_MIN_MS: z.coerce.number().int().min(0).default(60000),

  WHATSAPP_HUMAN_DELAY_MAX_MS: z.coerce.number().int().min(0).default(120000),

  // AI-authored sends are held back during this local-hour window. start === end (default
  // 0/0) disables quiet hours (24/7 sending allowed).
  WHATSAPP_QUIET_HOURS_START: z.coerce.number().int().min(0).max(23).default(0),

  WHATSAPP_QUIET_HOURS_END: z.coerce.number().int().min(0).max(23).default(0),

  WHATSAPP_BUSINESS_TIMEZONE: z.string().default('Asia/Kolkata'),

  // Off until an admin has actually connected a sheet; the runner does nothing while false.
  LEAD_IMPORT_ENABLED: booleanString.default(false),

  LEAD_IMPORT_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(3_600_000)
    .default(600_000),

  // Ceiling per source per tick, so a first sync of a large sheet cannot monopolise the loop.
  LEAD_IMPORT_MAX_ROWS_PER_TICK: z.coerce.number().int().min(1).max(2000).default(200),

  // Pulling leads straight off the Meta Graph API instead of a spreadsheet. Off until the client
  // has an app with `leads_retrieval` and a Page access token to paste in — with it false the
  // dashboard refuses to create or test a Meta source and the importer skips them, so nothing
  // here can reach out to Meta by accident. See the Meta Lead Ads section of the root README.
  META_LEAD_ADS_ENABLED: booleanString.default(false),

  // Per-request ceiling for a Graph call. A hung fetch must never wedge the import tick.
  META_GRAPH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),

  // Cursor pages one source may walk in one tick, the Graph-API twin of
  // LEAD_IMPORT_MAX_ROWS_PER_TICK: a form with a year of history is drained over several ticks
  // rather than holding the loop open.
  META_GRAPH_MAX_PAGES_PER_TICK: z.coerce.number().int().min(1).max(100).default(10),

  // ADR-005's disable switch: AI features stay off until explicitly enabled.
  AI_ENABLED: booleanString.default(false),

  AI_PROVIDER: z.enum(['anthropic', 'grok', 'groq']).default('anthropic'),

  ANTHROPIC_API_KEY: z.string().optional(),

  XAI_API_KEY: z.string().optional(),

  GROQ_API_KEY: z.string().optional(),

  // No default here — each provider adapter supplies its own sensible default model when unset.
  AI_MODEL: z.string().min(1).optional(),

  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(50).max(2000).default(300),

  AI_DRAFT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(500).default(30),

  AI_DRAFT_CONTEXT_MESSAGE_COUNT: z.coerce.number().int().min(1).max(100).default(20),

  // ai-brain-service: the pulled-out vistaar-agent "brain" (qualifying chat, drafting,
  // proposals, the won/lost classifier). Off until an admin has it running and reachable.
  AI_BRAIN_ENABLED: booleanString.default(false),

  AI_BRAIN_SERVICE_URL: z.string().url().optional(),

  // Shared secret sent as X-Service-Key on every call to ai-brain-service.
  AI_BRAIN_SERVICE_KEY: z.string().optional(),

  AI_BRAIN_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),

  // Nurture sweep: the day-2/5/9/15 "still there?" cadence, cold-at-20. Off by default - tests
  // and the plain API server never run it, same gating style as WHATSAPP_OUTBOUND_DELIVERY_ENABLED.
  NURTURE_ENABLED: booleanString.default(false),

  NURTURE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).default(1_800_000),

  // CSV of day thresholds, parsed by nurture-sweep.service.ts's parseNurtureFollowupDays.
  NURTURE_FOLLOWUP_DAYS: z.string().default('2,5,9,15'),

  NURTURE_COLD_AFTER_DAYS: z.coerce.number().int().default(20),

  // Also doubles as the general "an AI-authored send is too late to go out" guard in
  // outbound-delivery.service.ts's deliverNext - reused rather than duplicated.
  NURTURE_STALE_AFTER_MS: z.coerce.number().int().default(1_800_000),

  // The two owner-facing daily jobs - the morning handover read and the digest (see
  // ai-brain/daily-jobs-runner.ts). Off by default, same gating style as NURTURE_ENABLED.
  DAILY_JOBS_ENABLED: booleanString.default(false),

  // Local hour in WHATSAPP_BUSINESS_TIMEZONE that both daily jobs hang off: the morning
  // handover read fires at DIGEST_HOUR:00 and the digest at DIGEST_HOUR:10. The ten-minute gap
  // is deliberate - cards the morning read raises land in that same morning's digest.
  DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(9),

  // The pre-event owner reminder (see ai-brain/event-reminder.service.ts): one WhatsApp message
  // the day before a WON conversation's event. Off by default, same gating style as
  // NURTURE_ENABLED / DAILY_JOBS_ENABLED - tests and a plain API server never fire reminders.
  EVENT_REMINDERS_ENABLED: booleanString.default(false),

  // How often the reminder sweep looks for events falling inside the next 24 hours. Several
  // times a day rather than once, so a restart cannot cost a booking its only chance to fire;
  // the atomic claim (Conversation.eventReminderSentAt) is what keeps it to one message.
  EVENT_REMINDER_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).default(14_400_000),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('Invalid environment configuration.');
  console.error(result.error.flatten().fieldErrors);
  process.exit(1);
}

export type Env = z.infer<typeof envSchema>;

export const env: Env = result.data;
