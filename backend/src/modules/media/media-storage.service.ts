/**
 * Where attachment bytes actually live.
 *
 * WHY THE FILESYSTEM. The project had no binary storage of any kind before this: no S3 client,
 * no GridFS, no bucket. Mongo holds the metadata it always held (`mediaObjectKey`, `media.*` on
 * the message row) and the bytes sit beside it on disk, which keeps the database the size it has
 * always been and keeps `mongodump` - the one backup this deployment actually runs - fast.
 *
 * THE KEY IS THE AUTHORIZATION. A key is `<organizationId>/<conversationId>/<uuid><ext>` and is
 * validated against that exact shape on every read and write. Two consequences, both load-bearing:
 * no sequence of `..` can escape the storage root because the shape forbids the characters, and
 * a key carries the organization and conversation it belongs to, so the send path can refuse one
 * that was minted for a different thread instead of trusting the client to send back its own.
 *
 * NOTHING HERE IS SERVED STATICALLY. There is no express.static over this directory and it must
 * never be inside the web root; media leaves only through the authenticated download route.
 */
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { env, type Env } from '../../config/env.js';

/**
 * `<24 hex>/<24 hex>/<uuid>.<ext>` and nothing else. Anchored, no optional parts: a key either
 * looks exactly like one this service minted or it is refused unread.
 */
const MEDIA_OBJECT_KEY_PATTERN =
  /^[0-9a-f]{24}\/[0-9a-f]{24}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/;

export class InvalidMediaObjectKeyError extends Error {
  constructor(message = 'Media object key is not well-formed.') {
    super(message);
    this.name = 'InvalidMediaObjectKeyError';
  }
}

export const isValidMediaObjectKey = (objectKey: string | null | undefined): boolean =>
  typeof objectKey === 'string' && MEDIA_OBJECT_KEY_PATTERN.test(objectKey);

export interface BuildMediaObjectKeyParams {
  organizationId: string;
  conversationId: string;
  extension: string;
}

/**
 * Mints a key for a new object. The uuid is the only unguessable part and the only part that
 * matters for secrecy - but secrecy is not the control here, the download route's auth check is.
 */
export const buildMediaObjectKey = ({
  organizationId,
  conversationId,
  extension,
}: BuildMediaObjectKeyParams): string => {
  const normalizedExtension = extension.startsWith('.') ? extension.slice(1) : extension;

  return `${organizationId.toLowerCase()}/${conversationId.toLowerCase()}/${randomUUID()}.${normalizedExtension.toLowerCase()}`;
};

/** True when the key belongs to this organization AND this conversation. */
export const mediaObjectKeyBelongsTo = ({
  objectKey,
  organizationId,
  conversationId,
}: {
  objectKey: string;
  organizationId: string;
  conversationId: string;
}): boolean =>
  isValidMediaObjectKey(objectKey) &&
  objectKey.startsWith(`${organizationId.toLowerCase()}/${conversationId.toLowerCase()}/`);

export interface MediaStorageDeps {
  config?: Env;
}

const resolveRoot = (config: Env): string => path.resolve(config.MEDIA_STORAGE_DIR);

/**
 * Absolute path for a key, after proving the key is well-formed AND that the path it resolves to
 * is still inside the storage root. The second check is redundant given the first and is kept
 * anyway: it is the one that still holds if the pattern is ever loosened.
 */
const resolveObjectPath = (objectKey: string, config: Env): string => {
  if (!isValidMediaObjectKey(objectKey)) {
    throw new InvalidMediaObjectKeyError();
  }

  const root = resolveRoot(config);
  const absolute = path.resolve(root, objectKey);

  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new InvalidMediaObjectKeyError('Media object key escapes the storage root.');
  }

  return absolute;
};

export const createMediaStorage = ({ config = env }: MediaStorageDeps = {}) => {
  const writeMediaObject = async ({
    objectKey,
    bytes,
  }: {
    objectKey: string;
    bytes: Buffer;
  }): Promise<{ objectKey: string; sizeBytes: number }> => {
    const absolute = resolveObjectPath(objectKey, config);

    await mkdir(path.dirname(absolute), { recursive: true });
    // `wx` rather than `w`: a key collision means a uuid collision, which should surface as an
    // error rather than silently overwrite another conversation's attachment.
    await writeFile(absolute, bytes, { flag: 'wx' });

    return { objectKey, sizeBytes: bytes.length };
  };

  const readMediaObject = async (objectKey: string): Promise<Buffer> =>
    readFile(resolveObjectPath(objectKey, config));

  const statMediaObject = async (
    objectKey: string,
  ): Promise<{ sizeBytes: number; exists: boolean }> => {
    try {
      const stats = await stat(resolveObjectPath(objectKey, config));

      return { sizeBytes: stats.size, exists: stats.isFile() };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { sizeBytes: 0, exists: false };
      }

      throw error;
    }
  };

  const openMediaObjectStream = (objectKey: string): ReadStream =>
    createReadStream(resolveObjectPath(objectKey, config));

  /** Used when a send is abandoned, so a failed upload does not leave bytes behind forever. */
  const deleteMediaObject = async (objectKey: string): Promise<void> => {
    await rm(resolveObjectPath(objectKey, config), { force: true });
  };

  return {
    writeMediaObject,
    readMediaObject,
    statMediaObject,
    openMediaObjectStream,
    deleteMediaObject,
    get root() {
      return resolveRoot(config);
    },
  };
};

export type MediaStorage = ReturnType<typeof createMediaStorage>;

export const mediaStorage = createMediaStorage();
