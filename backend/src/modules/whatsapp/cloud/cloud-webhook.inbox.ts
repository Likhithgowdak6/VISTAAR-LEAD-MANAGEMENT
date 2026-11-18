import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { encryptString, decryptString } from '../../security/encryption.service.js';
import { encryptedFieldSchema, type EncryptedField } from '../../security/encrypted-field.schema.js';
import { createCloudWebhookService } from './cloud-webhook.service.js';

const PURPOSE = 'wam-crm-ai:v1:cloudWebhook.payload';
const LEASE_MS = 5 * 60_000;
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  payload: { type: encryptedFieldSchema, select: false },
  state: { type: String, enum: ['pending', 'processing', 'done'], default: 'pending' },
  dueAt: { type: Date, default: Date.now },
  leaseUntil: Date,
  leaseToken: String,
  attempts: { type: Number, default: 0 },
  completedAt: Date,
  expiresAt: Date,
}, { timestamps: true, collection: 'whatsappcloudwebhookinbox' });
schema.index({ state: 1, dueAt: 1, leaseUntil: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const CloudWebhookInbox = mongoose.models.CloudWebhookInbox ?? mongoose.model('CloudWebhookInbox', schema);

export interface InboxEvent { _id: string; payload?: EncryptedField; leaseToken?: string; attempts?: number }
export interface InboxStore {
  persist: (id: string, payload: EncryptedField) => Promise<unknown>;
  claim: (now: Date, token: string) => Promise<InboxEvent | null>;
  extend: (id: string, token: string, now: Date) => Promise<unknown>;
  finish: (id: string, token: string, now: Date) => Promise<unknown>;
  retry: (id: string, token: string, now: Date, attempts: number) => Promise<unknown>;
}

const store: InboxStore = {
  persist: async (id, payload) => {
    try {
      return await CloudWebhookInbox.updateOne({ _id: id }, { $setOnInsert: { payload, state: 'pending', dueAt: new Date(), attempts: 0 } }, { upsert: true, writeConcern: { w: 'majority' } }).exec();
    } catch (error) {
      // Concurrent redeliveries may race on the inbox's unique event id.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  },
  claim: async (now, token) => CloudWebhookInbox.findOneAndUpdate({ $or: [
    { state: 'pending', dueAt: { $lte: now } },
    { state: 'processing', leaseUntil: { $lte: now } },
  ] }, { $set: { state: 'processing', leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } }, { new: true, sort: { createdAt: 1 } }).select('+payload').lean().exec() as Promise<InboxEvent | null>,
  extend: async (id, token, now) => CloudWebhookInbox.updateOne({ _id: id, state: 'processing', leaseToken: token }, { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) } }).exec(),
  finish: async (id, token, now) => CloudWebhookInbox.updateOne({ _id: id, state: 'processing', leaseToken: token }, {
    $set: { state: 'done', completedAt: now, expiresAt: new Date(now.getTime() + 7 * 86_400_000) },
    $unset: { payload: 1, leaseToken: 1, leaseUntil: 1 },
  }).exec(),
  retry: async (id, token, now, attempts) => CloudWebhookInbox.updateOne({ _id: id, state: 'processing', leaseToken: token }, {
    $set: { state: 'pending', dueAt: new Date(now.getTime() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8))) },
    $unset: { leaseToken: 1, leaseUntil: 1 },
  }).exec(),
};

export const createCloudWebhookInbox = ({
  repository = store,
  handle = (body: unknown) => createCloudWebhookService().handleWebhookBody(body),
  now = () => new Date(),
} = {}) => {
  let running = false;
  const persist = async (raw: Buffer, body: unknown) => {
    const id = createHash('sha256').update(raw).digest('hex');
    const encrypted = encryptString(JSON.stringify(body), PURPOSE);
    if (!encrypted) throw new Error('WEBHOOK_ENCRYPTION_REQUIRED');
    await repository.persist(id, encrypted);
    return id;
  };
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      for (let count = 0; count < 10; count += 1) {
        const token = randomUUID();
        const event = await repository.claim(now(), token);
        if (!event) break;
        const heartbeat = setInterval(() => {
          void repository.extend(event._id, token, now()).catch(() => logger.error({}, 'Cloud webhook lease renewal failed.'));
        }, 30_000);
        heartbeat.unref();
        try {
          const payload = decryptString(event.payload, PURPOSE);
          if (!payload) throw new Error('WEBHOOK_PAYLOAD_MISSING');
          const result = await handle(JSON.parse(payload));
          if (result.failed) throw new Error('WEBHOOK_PROCESSING_FAILED');
          await repository.finish(event._id, token, now());
        } catch {
          await repository.retry(event._id, token, now(), event.attempts ?? 1);
          logger.warn({}, 'Cloud webhook retained for retry after processing failed.');
        } finally { clearInterval(heartbeat); }
      }
    } finally { running = false; }
  };
  return { persist, drain };
};

export const cloudWebhookInbox = createCloudWebhookInbox();
export const createCloudWebhookInboxRunner = () => {
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => { void cloudWebhookInbox.drain().catch(() => logger.error({}, 'Cloud webhook inbox worker failed; events remain queued.')); };
  return {
    start: () => {
      if (!env.WHATSAPP_CLOUD_ENABLED || timer) return false;
      timer = setInterval(tick, 5000);
      timer.unref();
      tick();
      return true;
    },
    stop: () => { if (timer) clearInterval(timer); timer = null; },
  };
};
