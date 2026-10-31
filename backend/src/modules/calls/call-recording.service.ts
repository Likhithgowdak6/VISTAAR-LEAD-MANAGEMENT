import { type HydratedDocument } from 'mongoose';

import { MESSAGE_TYPES } from '../../constants/message-types.js';
import { type Permission } from '../../constants/permissions.js';
import { type ObjectIdLike } from '../../types/common.js';
import { resolveMediaFormat } from '../media/media-kinds.js';
import {
  buildMediaObjectKey,
  isValidMediaObjectKey,
  mediaStorage as defaultMediaStorage,
  type MediaStorage,
} from '../media/media-storage.service.js';
import { type UserDocument } from '../users/user.model.js';
import { attachRecordingForActor, getCallForActor } from './call-record.service.js';

/**
 * Putting a call recording on disk and pointing the call at it.
 *
 * WHERE THE BYTES COME FROM, PRECISELY: a human chose a file and sent it. Nothing in Vistaar
 * records a cellular call, scans device storage, or discovers an OEM recording folder - Android
 * does not permit the first and this app does not do the other two. Automatic import from the
 * phone's own recorder is later work and plugs in HERE, by calling this with bytes it has
 * already been granted access to.
 *
 * THE STORAGE KEY IS REUSED, NOT REINVENTED. `<orgId>/<conversationId>/<uuid>.<ext>` already
 * encodes the two scopes that matter and is pattern-validated on every read and write, so a
 * call recording gets the same guarantees a message attachment has: no `..` can escape the
 * root, and a key minted for one conversation cannot be replayed against another.
 */

export class CallRecordingError extends Error {
  readonly reason: 'empty_file' | 'unsupported_type' | 'content_mismatch' | 'not_audio';

  constructor(reason: CallRecordingError['reason']) {
    super(reason.toUpperCase());
    this.name = 'CallRecordingError';
    this.reason = reason;
  }
}

export interface UploadCallRecordingParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  bytes: Buffer;
  declaredMimeType: string | null | undefined;
  fileName: string | null | undefined;
  storage?: MediaStorage;
}

export const uploadCallRecordingForActor = async ({
  organizationId,
  callId,
  actor,
  permissions,
  bytes,
  declaredMimeType,
  fileName,
  storage = defaultMediaStorage,
}: UploadCallRecordingParams) => {
  // AUTHORISE BEFORE TOUCHING THE DISK. Writing first and checking after would let anybody who
  // can reach the route fill the server's storage with files for calls they cannot see.
  const call = await getCallForActor({ organizationId, callId, actor, permissions });

  const format = resolveMediaFormat({ declaredMimeType, fileName, bytes });

  if (!format.ok) {
    throw new CallRecordingError(format.reason);
  }

  // AUDIO ONLY, checked against the SNIFFED type rather than the declared one. The existing
  // resolver already refuses a file whose magic bytes contradict its content-type, so this is
  // the second half of the same question: a PDF renamed to .m4a fails the first check, and an
  // image that really is an image fails this one.
  if (format.messageType !== MESSAGE_TYPES.AUDIO) {
    throw new CallRecordingError('not_audio');
  }

  const objectKey = buildMediaObjectKey({
    organizationId: String(call.organizationId),
    conversationId: String(call.conversationId),
    extension: format.fileName.slice(format.fileName.lastIndexOf('.') + 1),
  });

  await storage.writeMediaObject({ objectKey, bytes });

  try {
    return await attachRecordingForActor({
      organizationId,
      callId: call._id,
      actor,
      permissions,
      objectKey,
      mimeType: format.mimeType,
      sizeBytes: bytes.length,
    });
  } catch (error: unknown) {
    /*
     * CLEAN UP THE ORPHAN. The bytes are on disk and the row does not point at them, so nothing
     * will ever read or delete them again - they would sit in storage forever, holding a
     * customer's recorded conversation that the CRM does not even know it has. Deleting is
     * best-effort and must not mask the real failure, which is re-thrown.
     */
    await storage.deleteMediaObject(objectKey).catch(() => undefined);
    throw error;
  }
};

export interface OpenCallRecordingParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  storage?: MediaStorage;
}

export class CallRecordingUnavailableError extends Error {
  constructor() {
    super('RECORDING_UNAVAILABLE');
    this.name = 'CallRecordingUnavailableError';
  }
}

/**
 * Resolves a call to playable bytes, for the authenticated download route.
 *
 * THE CLIENT NEVER SEES A KEY OR A URL. It asks for a CALL id - which it is already authorised
 * to read - and the server looks up where that call's audio lives. There is no signed link, no
 * public path and nothing guessable: every byte goes out through a request that carried a
 * session, and the authorisation is the same conversation gate as everything else on this lead.
 */
export const openCallRecordingForActor = async ({
  organizationId,
  callId,
  actor,
  permissions,
  storage = defaultMediaStorage,
}: OpenCallRecordingParams) => {
  const call = await getCallForActor({ organizationId, callId, actor, permissions });
  const objectKey = call.recordingObjectKey;

  // Re-validated on the way out as well as in. A key is only ever minted by this service, but
  // a corrupted or hand-edited row must not be able to point the reader at an arbitrary path.
  if (!objectKey || !isValidMediaObjectKey(objectKey)) {
    throw new CallRecordingUnavailableError();
  }

  const { exists, sizeBytes } = await storage.statMediaObject(objectKey);

  if (!exists) {
    // The row says there is audio and the disk disagrees. Reported as unavailable rather than
    // as a server error: from the agent's side the recording is simply not there.
    throw new CallRecordingUnavailableError();
  }

  return {
    stream: storage.openMediaObjectStream(objectKey),
    sizeBytes,
    mimeType: call.recordingMimeType ?? 'application/octet-stream',
  };
};
