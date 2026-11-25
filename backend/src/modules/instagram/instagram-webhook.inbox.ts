/**
 * A durable, encrypted inbox for Instagram webhook deliveries.
 *
 * SAME SHAPE AS THE WHATSAPP CLOUD INBOX, deliberately — and a separate collection, deliberately.
 * The pattern earns its keep twice over: acknowledge Meta fast, then process with leases and
 * retries that survive a restart. Sharing one collection would mean a backlog of Instagram events
 * delaying WhatsApp messages, and a poison event in one channel stalling the other.
 *
 * THE DOCUMENT ID IS THE SHA-256 OF THE RAW BODY, which is the first of two dedupe layers:
 * a byte-identical redelivery collides on insert and is dropped. Meta also redelivers with
 * different envelope timestamps for the same message, so the SECOND layer — the unique index on
 * (organizationId, whatsappAccountId, providerMessageId) over messages — is what actually
 * guarantees one inbox row per DM. Both are needed; neither alone is enough.
 */
import { createHash, randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import { encryptedFieldSchema, type EncryptedField } from '../security/encrypted-field.schema.js';
import { decryptString, encryptString } from '../security/encryption.service.js';

const PURPOSE = 'wam-crm-ai:v1:instagramWebhook.payload';

/** Long enough for a Graph call and an inbox write; short enough that a crash frees it fast. */
const LEASE_MS = 5 * 60_000;

/** Deliveries are kept briefly for diagnosis, then expire themselves. */
const RETENTION_MS = 7 * 24 * 60 * 60_000;

const schema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    payload: { type: encryptedFieldSchema, select: false },
    state: { type: String, enum: ['pending', 'processing', 'done'], default: 'pending' },
    dueAt: { type: Date, default: Date.now },
    leaseUntil: Date,
    leaseToken: String,
    attempts: { type: Number, default: 0 },
    completedAt: Date,
    expiresAt: Date,
  },
  { timestamps: true, collection: 'instagramwebhookinbox' },
);

schema.index({ state: 1, dueAt: 1, leaseUntil: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const InstagramWebhookInbox =
  mongoose.models.InstagramWebhookInbox ??
  mongoose.model('InstagramWebhookInbox', schema);

export interface InstagramInboxEvent {
  _id: string;
  payload?: EncryptedField;
  leaseToken?: string;
  attempts?: number;
}

export interface InstagramInboxStore {
  persist: (id: string, payload: EncryptedField) => Promise<unknown>;
  claim: (now: Date, token: string) => Promise<InstagramInboxEvent | null>;
  extend: (id: string, token: string, now: Date) => Promise<unknown>;
  finish: (id: string, token: string, now: Date) => Promise<unknown>;
  retry: (id: string, token: string, now: Date, attempts: number) => Promise<unknown>;
}

const store: InstagramInboxStore = {
  persist: async (id, payload) => {
    try {
      return await InstagramWebhookInbox.create({ _id: id, payload });
    } catch (error) {
      // A concurrent redelivery racing on the same body hash. Not an error: the first write wins
      // and the second has nothing to add.
      if ((error as { code?: number })?.code === 11000) {
        return null;
      }

      throw error;
    }
  },

  claim: async (now, token) =>
    InstagramWebhookInbox.findOneAndUpdate(
      {
        $or: [
          { state: 'pending', dueAt: { $lte: now } },
          // Reclaims anything whose lease expired mid-processing, which is how a crashed worker's
          // events get picked up rather than sitting claimed forever.
          { state: 'processing', leaseUntil: { $lte: now } },
        ],
      },
      { $set: { state: 'processing', leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS) } },
      { new: true, sort: { dueAt: 1 } },
    )
      .select('+payload')
      .exec() as Promise<InstagramInboxEvent | null>,

  extend: async (id, token, now) =>
    InstagramWebhookInbox.updateOne(
      { _id: id, state: 'processing', leaseToken: token },
      { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) } },
    ).exec(),

  finish: async (id, token, now) =>
    InstagramWebhookInbox.updateOne(
      { _id: id, state: 'processing', leaseToken: token },
      {
        $set: { state: 'done', completedAt: now, expiresAt: new Date(now.getTime() + RETENTION_MS) },
        // The payload is dropped once handled: there is no reason to keep a customer's message
        // text in a queue after it has reached the inbox.
        $unset: { payload: '', leaseToken: '', leaseUntil: '' },
      },
    ).exec(),

  retry: async (id, token, now, attempts) =>
    InstagramWebhookInbox.updateOne(
      { _id: id, state: 'processing', leaseToken: token },
      {
        $set: {
          state: 'pending',
          // Backs off so a persistently failing event does not spin: a minute, then four, then
          // nine, capped by the loop's own attempt limit.
          dueAt: new Date(now.getTime() + Math.min(attempts * attempts, 30) * 60_000),
          attempts,
        },
        $unset: { leaseToken: '', leaseUntil: '' },
      },
    ).exec(),
};

export const createInstagramWebhookInbox = ({
  repository = store,
  handle = async (body: unknown): Promise<{ failed: boolean }> => {
    const { handleInstagramWebhookBody } = await import('./instagram-webhook.service.js');

    return handleInstagramWebhookBody(body);
  },
  now = () => new Date(),
} = {}) => {
  let running = false;

  const persist = async (raw: Buffer, body: unknown) => {
    const id = createHash('sha256').update(raw).digest('hex');
    const encrypted = encryptString(JSON.stringify(body), PURPOSE);

    // Refuses rather than storing a customer's DM in clear. The caller turns this into a non-200
    // so Meta retries once encryption is configured.
    if (!encrypted) {
      throw new Error('WEBHOOK_ENCRYPTION_REQUIRED');
    }

    await repository.persist(id, encrypted);

    return id;
  };

  const drain = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      for (let count = 0; count < 10; count += 1) {
        const token = randomUUID();
        const event = await repository.claim(now(), token);

        if (!event) {
          break;
        }

        const heartbeat = setInterval(() => {
          void repository
            .extend(event._id, token, now())
            .catch(() => logger.error({}, 'Instagram webhook lease renewal failed.'));
        }, 30_000);

        heartbeat.unref();

        try {
          const payload = decryptString(event.payload, PURPOSE);

          if (!payload) {
            throw new Error('WEBHOOK_PAYLOAD_MISSING');
          }

          const result = await handle(JSON.parse(payload));

          if (result.failed) {
            throw new Error('WEBHOOK_PROCESSING_FAILED');
          }

          await repository.finish(event._id, token, now());
        } catch {
          await repository.retry(event._id, token, now(), (event.attempts ?? 0) + 1);
          logger.warn({}, 'Instagram webhook retained for retry after processing failed.');
        } finally {
          clearInterval(heartbeat);
        }
      }
    } finally {
      running = false;
    }
  };

  return { persist, drain };
};

export const instagramWebhookInbox = createInstagramWebhookInbox();
