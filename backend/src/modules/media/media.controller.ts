/**
 * The two ends of an attachment's life over HTTP: it is uploaded to a conversation, and later
 * read back from a message.
 *
 * UPLOAD IS NOT SEND. This route stores bytes and returns a key; no message row exists yet and
 * nothing reaches WhatsApp. The send that follows carries the key and is idempotent in the way
 * every send already was. Splitting them means a 12 MB video uploads once, under its own
 * progress bar, and a double-tap on Send cannot upload it twice.
 *
 * THE KEY IS SCOPED, AND RE-CHECKED. A key is minted under `<organizationId>/<conversationId>/`
 * and the send path proves it still matches the thread being sent to, so a key observed in one
 * conversation cannot be replayed into another - or into another tenant's.
 *
 * DOWNLOAD IS AUTHENTICATED, ALWAYS. There is no static mount and no signed public URL. Every
 * byte leaves through this handler, after the caller's session has been checked against the
 * message's organization and then against their visibility of the conversation it belongs to.
 */
import { type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';

import { env } from '../../config/env.js';
import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';
import { loadVisibleConversationForActor } from '../conversations/conversation.service.js';
import { findMessageByIdForOrganization } from '../messages/message.repository.js';
import { conversationIdParamsSchema } from '../conversations/conversation.validation.js';
import { isInlineSafeMediaType, resolveMediaFormat } from './media-kinds.js';
import { mediaObjectKeyParamsSchema, uploadMediaBodySchema } from './media.validation.js';
import { buildMediaObjectKey, mediaStorage } from './media-storage.service.js';
import { prepareVoiceNote } from './voice-note.js';

/**
 * Memory, not disk: the buffer is validated, possibly transcoded, and only then written, so a
 * rejected upload never touches the filesystem at all. Bounded by the same limit the handler
 * reports, and one file per request.
 */
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MEDIA_MAX_UPLOAD_BYTES,
    files: 1,
    fields: 4,
  },
});

const MULTER_ERROR_MESSAGES: Readonly<Record<string, { statusCode: number; message: string }>> =
  Object.freeze({
    LIMIT_FILE_SIZE: {
      statusCode: 413,
      message: `That file is too large. The limit is ${Math.round(env.MEDIA_MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    },
    LIMIT_FILE_COUNT: { statusCode: 400, message: 'Only one file can be sent at a time.' },
    LIMIT_UNEXPECTED_FILE: { statusCode: 400, message: 'Unexpected file field.' },
  });

/**
 * Parses the upload and turns multer's own errors into ones the owner can act on.
 *
 * WITHOUT THIS, an oversized file is a 500. A MulterError carries a `code` but no `statusCode`,
 * so the shared error handler defaults it to 500 - and in production that is rendered as
 * "Internal server error.", which tells someone trying to send a long video precisely nothing.
 */
export const receiveMediaFile: RequestHandler = (req, res, next) => {
  mediaUpload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    const code = (error as { code?: string })?.code ?? '';
    const mapped = MULTER_ERROR_MESSAGES[code];

    next(
      mapped
        ? createHttpError({ statusCode: mapped.statusCode, code, message: mapped.message })
        : createHttpError({
            statusCode: 400,
            code: 'UPLOAD_FAILED',
            message: 'That file could not be uploaded.',
          }),
    );
  });
};

const UPLOAD_ERROR_MESSAGES: Readonly<Record<string, { statusCode: number; message: string }>> =
  Object.freeze({
    empty_file: { statusCode: 400, message: 'That file is empty.' },
    unsupported_type: {
      statusCode: 415,
      message: 'That file type cannot be sent on WhatsApp.',
    },
    content_mismatch: {
      statusCode: 415,
      message: "That file's contents do not match its type.",
    },
    transcode_unavailable: {
      statusCode: 503,
      message:
        'Voice notes need ffmpeg installed on the server. Send it as an audio file instead, or ask your administrator to install ffmpeg.',
    },
    transcode_failed: {
      statusCode: 422,
      message: 'That recording could not be converted into a voice note.',
    },
  });

// A function declaration rather than a const arrow: TypeScript only treats a `never`-returning
// call as unreachable-after when it can see the declaration this way, and the narrowing is what
// lets the code below use the validated format without re-checking `ok`.
function failUpload(reason: keyof typeof UPLOAD_ERROR_MESSAGES): never {
  const mapped = UPLOAD_ERROR_MESSAGES[reason]!;

  throw createHttpError({
    statusCode: mapped.statusCode,
    code: reason.toUpperCase(),
    message: mapped.message,
  });
}

export const uploadConversationMedia = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: uploadMediaBodySchema,
    value: req.body,
    source: 'Body',
  });

  const file = req.file;

  if (!file) {
    throw createHttpError({
      statusCode: 400,
      code: 'NO_FILE',
      message: 'No file was uploaded.',
    });
  }

  // Authorization before anything else is done with the bytes: the same visibility rule the
  // thread itself uses, so a staff member who cannot open a conversation cannot stage an
  // attachment against it either.
  const conversation = await loadVisibleConversationForActor({
    organizationId: auth.organization._id,
    conversationId: params.conversationId,
    permissions: auth.permissions,
    actorId: auth.user._id,
  });

  const format = resolveMediaFormat({
    declaredMimeType: file.mimetype,
    fileName: file.originalname,
    bytes: file.buffer,
  });

  if (!format.ok) {
    failUpload(format.reason);
  }

  const { messageType } = format;
  let bytes = file.buffer;
  let { mimeType, fileName } = format;
  let extension = fileName.slice(fileName.lastIndexOf('.'));
  let isVoiceNote = false;

  // A voice note is a different thing from an audio file, not a flag on one. See voice-note.ts:
  // the container has to be Ogg/Opus or WhatsApp shows an unplayable bubble.
  if (body.kind === 'voice') {
    if (messageType !== 'audio') {
      failUpload('unsupported_type');
    }

    const prepared = await prepareVoiceNote({ bytes, mimeType });

    if (!prepared.ok) {
      failUpload(prepared.reason);
      return;
    }

    bytes = prepared.bytes;
    mimeType = prepared.mimeType;
    extension = prepared.extension;
    fileName = `voice-note${prepared.extension}`;
    isVoiceNote = true;
  }

  const objectKey = buildMediaObjectKey({
    organizationId: auth.organization._id.toString(),
    conversationId: conversation._id.toString(),
    extension,
  });

  await mediaStorage.writeMediaObject({ objectKey, bytes });

  res.status(201).json({
    data: {
      objectKey,
      type: messageType,
      mimeType,
      fileName,
      sizeBytes: bytes.length,
      isVoiceNote,
    },
  });
});

export const downloadMessageMedia = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: mediaObjectKeyParamsSchema,
    value: req.params,
    source: 'Params',
  });

  const message = await findMessageByIdForOrganization({
    organizationId: auth.organization._id,
    messageId: params.messageId,
  });

  if (!message) {
    throw createHttpError({
      statusCode: 404,
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found.',
    });
  }

  // Organization scoping came from the query above; this is the second half - can THIS user see
  // THIS thread. It throws the conversation module's own access errors, which the router's error
  // handler already renders.
  await loadVisibleConversationForActor({
    organizationId: auth.organization._id,
    conversationId: message.conversationId,
    permissions: auth.permissions,
    actorId: auth.user._id,
  });

  if (!message.mediaObjectKey || message.media?.storageStatus !== 'stored') {
    throw createHttpError({
      statusCode: 404,
      code: 'MEDIA_NOT_AVAILABLE',
      message: 'This attachment is not available.',
    });
  }

  const stats = await mediaStorage.statMediaObject(message.mediaObjectKey);

  // Stored according to the row, gone from the disk: a restored database, a pruned volume, a
  // half-finished write. The thread falls back to its label rather than showing a broken frame.
  if (!stats.exists) {
    throw createHttpError({
      statusCode: 404,
      code: 'MEDIA_NOT_AVAILABLE',
      message: 'This attachment is no longer stored.',
    });
  }

  const mimeType = message.media?.mimeType ?? 'application/octet-stream';
  const fileName = message.media?.fileName ?? 'attachment';
  const disposition = isInlineSafeMediaType(mimeType) ? 'inline' : 'attachment';

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', stats.sizeBytes);
  // Without nosniff a document could be sniffed as HTML and run on the API's own origin.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${fileName.replace(/["\\]/g, '')}"`,
  );
  // Private: the bytes are one tenant's. Immutable: the key contains a uuid and never changes.
  res.setHeader('Cache-Control', 'private, max-age=3600, immutable');

  const stream = mediaStorage.openMediaObjectStream(message.mediaObjectKey);

  stream.on('error', () => {
    // Headers are already out by the time a read can fail, so the only honest move is to drop
    // the connection rather than append an error body to a half-sent file.
    res.destroy();
  });

  stream.pipe(res);
});
