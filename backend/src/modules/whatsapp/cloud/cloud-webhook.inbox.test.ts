import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudWebhookInbox, CloudWebhookInbox, type InboxEvent, type InboxStore } from './cloud-webhook.inbox.js';

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY_V1', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('ENCRYPTION_KEY_CURRENT_VERSION', '1');
});
afterEach(() => vi.unstubAllEnvs());

const repository = () => ({
  persist: vi.fn().mockResolvedValue(undefined), claim: vi.fn().mockResolvedValue(null),
  extend: vi.fn().mockResolvedValue(undefined), finish: vi.fn().mockResolvedValue(undefined), retry: vi.fn().mockResolvedValue(undefined),
});

describe('durable Cloud webhook inbox', () => {
  it('stores encrypted payloads with repeatable event ids before processing', async () => {
    const store = repository(); const handle = vi.fn();
    const queue = createCloudWebhookInbox({ repository: store as InboxStore, handle });
    const body = { text: 'synthetic private message', object: 'whatsapp_business_account' };
    const raw = Buffer.from(JSON.stringify(body));
    const id = await queue.persist(raw, body);
    expect(await queue.persist(raw, body)).toBe(id);
    expect(handle).not.toHaveBeenCalled();
    expect(JSON.stringify(store.persist.mock.calls[0][1])).not.toContain(body.text);
    store.claim.mockResolvedValueOnce({ _id: id, payload: store.persist.mock.calls[0][1], attempts: 1 });
    handle.mockResolvedValue({ received: 1, statuses: 0, unknownNumbers: 0 });
    await queue.drain();
    expect(handle).toHaveBeenCalledWith(body);
    expect(store.finish).toHaveBeenCalledTimes(1);
    expect(store.retry).not.toHaveBeenCalled();
  });

  it('propagates persistence errors so the controller cannot acknowledge lost data', async () => {
    const store = repository(); store.persist.mockRejectedValue(new Error('database unavailable'));
    const queue = createCloudWebhookInbox({ repository: store, handle: vi.fn() });
    await expect(queue.persist(Buffer.from('{}'), {})).rejects.toThrow('database unavailable');
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('retries partial failures after a worker restart rather than marking them done', async () => {
    const store = repository();
    const handle = vi.fn().mockResolvedValueOnce({ received: 1, statuses: 0, unknownNumbers: 0, failed: 1 }).mockResolvedValue({ received: 2, statuses: 0, unknownNumbers: 0 });
    const first = createCloudWebhookInbox({ repository: store, handle });
    const id = await first.persist(Buffer.from('{}'), {});
    const event: InboxEvent = { _id: id, payload: store.persist.mock.calls[0][1], attempts: 1 };
    store.claim.mockResolvedValueOnce(event);
    await first.drain();
    expect(store.retry).toHaveBeenCalledTimes(1);
    expect(store.finish).not.toHaveBeenCalled();
    const restarted = createCloudWebhookInbox({ repository: store, handle });
    store.claim.mockResolvedValueOnce({ ...event, attempts: 2 });
    await restarted.drain();
    expect(handle).toHaveBeenCalledTimes(2);
    expect(store.finish).toHaveBeenCalledTimes(1);
  });

  it('retains unreadable encrypted events for retry and never passes garbage to ingestion', async () => {
    const store = repository(); const handle = vi.fn();
    store.claim.mockResolvedValueOnce({ _id: 'broken', payload: null, attempts: 1 });
    await createCloudWebhookInbox({ repository: store, handle }).drain();
    expect(handle).not.toHaveBeenCalled();
    expect(store.retry).toHaveBeenCalledTimes(1);
  });

  it('expires only completed records; pending customer events have no TTL deadline', () => {
    expect(CloudWebhookInbox.schema.path('expiresAt').options.default).toBeUndefined();
    expect(CloudWebhookInbox.schema.indexes()).toContainEqual([{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })]);
  });
});
