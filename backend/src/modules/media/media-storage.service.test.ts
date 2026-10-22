/**
 * The object key, which is the whole of the isolation story for stored media.
 *
 * Two separate properties are being defended here and they fail in different ways:
 *
 *   - PATH SAFETY. A key becomes a filesystem path. If a crafted key can escape the storage
 *     root, an attacker reads or writes anywhere the process can.
 *   - TENANCY. A key names the organization and conversation it was minted for, and the send
 *     path refuses one that does not match the thread being sent to. Without that check, a key
 *     seen in one conversation could be replayed to attach somebody else's photo to a message
 *     going to a different lead - or a different company's.
 *
 * The round-trip through a real temporary directory is deliberate: the traversal guard has to
 * hold against the actual `path.resolve`, not a model of it.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildMediaObjectKey,
  createMediaStorage,
  InvalidMediaObjectKeyError,
  isValidMediaObjectKey,
  mediaObjectKeyBelongsTo,
} from './media-storage.service.js';
import { type Env } from '../../config/env.js';

const ORG = '507f1f77bcf86cd799439011';
const CONVERSATION = '507f191e810c19729de860ea';
const OTHER_CONVERSATION = '507f191e810c19729de860eb';

let root: string;

const storage = () =>
  createMediaStorage({ config: { MEDIA_STORAGE_DIR: root } as unknown as Env });

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vistaar-media-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildMediaObjectKey', () => {
  it('mints a key under the organization and the conversation', () => {
    const key = buildMediaObjectKey({
      organizationId: ORG,
      conversationId: CONVERSATION,
      extension: '.jpg',
    });

    expect(key.startsWith(`${ORG}/${CONVERSATION}/`)).toBe(true);
    expect(isValidMediaObjectKey(key)).toBe(true);
  });

  it('never puts the caller-supplied filename in the path', () => {
    // The display name lives in the database. Keeping it out of the path is what makes the
    // strict key pattern possible in the first place.
    const key = buildMediaObjectKey({
      organizationId: ORG,
      conversationId: CONVERSATION,
      extension: '.pdf',
    });

    expect(key).not.toContain('..');
    expect(key.split('/')).toHaveLength(3);
  });
});

describe('isValidMediaObjectKey', () => {
  it.each([
    ['a traversal', `${ORG}/../../etc/passwd`],
    ['an absolute path', '/etc/passwd'],
    ['a windows path', `${ORG}\\${CONVERSATION}\\x.jpg`],
    ['a missing segment', `${ORG}/x.jpg`],
    ['a non-uuid name', `${ORG}/${CONVERSATION}/secret.jpg`],
    ['an empty string', ''],
    ['a null byte', `${ORG}/${CONVERSATION}/00000000-0000-0000-0000-000000000000.jpg\u0000`],
  ])('refuses %s', (_label, key) => {
    expect(isValidMediaObjectKey(key)).toBe(false);
  });
});

describe('mediaObjectKeyBelongsTo', () => {
  const key = buildMediaObjectKey({
    organizationId: ORG,
    conversationId: CONVERSATION,
    extension: '.jpg',
  });

  it('accepts the thread it was minted for', () => {
    expect(
      mediaObjectKeyBelongsTo({ objectKey: key, organizationId: ORG, conversationId: CONVERSATION }),
    ).toBe(true);
  });

  it('REFUSES the same organization but a different conversation', () => {
    // The replay this exists to stop: a key the client already holds, pointed at another lead.
    expect(
      mediaObjectKeyBelongsTo({
        objectKey: key,
        organizationId: ORG,
        conversationId: OTHER_CONVERSATION,
      }),
    ).toBe(false);
  });

  it('REFUSES another organization', () => {
    expect(
      mediaObjectKeyBelongsTo({
        objectKey: key,
        organizationId: '507f1f77bcf86cd799439099',
        conversationId: CONVERSATION,
      }),
    ).toBe(false);
  });
});

describe('reading and writing', () => {
  it('round-trips a file and reports its size', async () => {
    const store = storage();
    const key = buildMediaObjectKey({
      organizationId: ORG,
      conversationId: CONVERSATION,
      extension: '.bin',
    });
    const payload = Buffer.from('attachment bytes');

    await store.writeMediaObject({ objectKey: key, bytes: payload });

    await expect(store.readMediaObject(key)).resolves.toEqual(payload);
    await expect(store.statMediaObject(key)).resolves.toEqual({
      sizeBytes: payload.length,
      exists: true,
    });

    // And it is genuinely inside the root, not merely reported as such.
    await expect(readFile(path.join(root, key))).resolves.toEqual(payload);
  });

  it('reports a missing object rather than throwing', async () => {
    const store = storage();
    const key = buildMediaObjectKey({
      organizationId: ORG,
      conversationId: CONVERSATION,
      extension: '.bin',
    });

    // The download route turns this into a 404 and the thread falls back to its label; an
    // exception here would be a 500 for a file somebody simply pruned.
    await expect(store.statMediaObject(key)).resolves.toEqual({ sizeBytes: 0, exists: false });
  });

  it('refuses to write outside the root', async () => {
    const store = storage();

    await expect(
      store.writeMediaObject({ objectKey: '../escaped.bin', bytes: Buffer.from('x') }),
    ).rejects.toBeInstanceOf(InvalidMediaObjectKeyError);
  });

  it('refuses to read outside the root', async () => {
    const store = storage();

    await expect(store.readMediaObject(`${ORG}/../../../etc/passwd`)).rejects.toBeInstanceOf(
      InvalidMediaObjectKeyError,
    );
  });

  it('refuses to overwrite an existing object', async () => {
    // A key collision means a uuid collision. Silently overwriting would destroy one
    // conversation's attachment and serve it to another.
    const store = storage();
    const key = buildMediaObjectKey({
      organizationId: ORG,
      conversationId: CONVERSATION,
      extension: '.bin',
    });

    await store.writeMediaObject({ objectKey: key, bytes: Buffer.from('first') });

    await expect(
      store.writeMediaObject({ objectKey: key, bytes: Buffer.from('second') }),
    ).rejects.toThrow();

    await expect(store.readMediaObject(key)).resolves.toEqual(Buffer.from('first'));
  });

  it('deletes without complaining about an object that is already gone', async () => {
    const store = storage();
    const key = buildMediaObjectKey({
      organizationId: ORG,
      conversationId: CONVERSATION,
      extension: '.bin',
    });

    await expect(store.deleteMediaObject(key)).resolves.toBeUndefined();
  });
});
