import { type RequestHandler } from 'express';
import multer from 'multer';

import { env } from '../../config/env.js';
import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';
import { findCallAnalysis } from './call-analysis.repository.js';
import { serializeCallAnalysis } from './call-analysis.serializer.js';
import {
  deleteCallAnalysisForActor,
  deleteCallRecordingForActor,
  RecordingDeletionFailedError,
} from './call-deletion.service.js';
import { previewRetention } from './call-retention.service.js';
import {
  CallRecordingError,
  CallRecordingUnavailableError,
  openCallRecordingForActor,
  uploadCallRecordingForActor,
} from './call-recording.service.js';
import {
  confirmSuggestionForActor,
  dismissSuggestionForActor,
  SuggestionNeedsDueDateError,
  SuggestionNotFoundError,
} from './call-suggestion.service.js';

import {
  getCallForActor,
  listConversationCallsForActor,
  recordCallOutcomeForActor,
  startCallForActor,
} from './call-record.service.js';
import {
  callIdParamsSchema,
  confirmSuggestionBodySchema,
  conversationIdParamsSchema,
  listConversationCallsQuerySchema,
  recordCallOutcomeBodySchema,
  startCallBodySchema,
  suggestionParamsSchema,
  uploadCallRecordingBodySchema,
} from './call-record.validation.js';
import { serializeCallRecord } from './call-record.serializer.js';

/**
 * NOT FOUND RATHER THAN FORBIDDEN for a call id, matching how reminders already behave: a 403
 * confirms the id exists, which is a small leak across organisations that costs nothing to
 * avoid. The conversation errors keep their own meanings, because by then the caller has
 * already proved they know a conversation.
 */
const callErrorMap = {
  CALL_NOT_FOUND: { statusCode: 404, message: 'Call not found.' },
  SUGGESTION_NOT_FOUND: {
    statusCode: 404,
    message: 'That suggestion is no longer open — it may already have been actioned.',
  },
  SUGGESTION_NEEDS_DUE_DATE: {
    statusCode: 422,
    message: 'This follow-up has no agreed date. Pick one before confirming it.',
  },
  RECORDING_UNAVAILABLE: { statusCode: 404, message: 'No recording is stored for this call.' },
  // 500, deliberately: the recording is STILL THERE and the caller must not believe otherwise.
  RECORDING_DELETE_FAILED: {
    statusCode: 500,
    message: 'The recording could not be deleted. It has not been removed — please try again.',
  },
  EMPTY_FILE: { statusCode: 400, message: 'That file is empty.' },
  UNSUPPORTED_TYPE: { statusCode: 415, message: 'That file type is not supported.' },
  CONTENT_MISMATCH: {
    statusCode: 415,
    message: "That file's contents do not match its type.",
  },
  NOT_AUDIO: { statusCode: 415, message: 'A call recording has to be an audio file.' },
  CONVERSATION_NOT_FOUND: { statusCode: 404, message: 'Conversation not found.' },
  CONVERSATION_ACCESS_DENIED: {
    statusCode: 403,
    message: 'You do not have access to this conversation.',
  },
} as const;

type CallErrorCode = keyof typeof callErrorMap;

const mapCallError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : '';
  const mapped = message in callErrorMap ? callErrorMap[message as CallErrorCode] : undefined;

  if (!mapped) {
    throw error;
  }

  throw createHttpError({ statusCode: mapped.statusCode, code: message, message: mapped.message });
};

/** POST /conversations/:conversationId/calls - the dialler was opened. */
export const startCall = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: startCallBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });

  try {
    const call = await startCallForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      actor: auth.user,
      permissions: auth.permissions,
      idempotencyKey: body.idempotencyKey ?? null,
    });

    res.status(201).json({ data: call });
  } catch (error: unknown) {
    mapCallError(error);
  }
});

/** GET /conversations/:conversationId/calls */
export const listConversationCalls = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const query = parseWithSchema({
    schema: listConversationCallsQuerySchema,
    value: req.query,
    source: 'Query',
  });

  try {
    const calls = await listConversationCallsForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      actor: auth.user,
      permissions: auth.permissions,
      limit: query.limit,
      skip: query.skip,
    });

    res.status(200).json({
      data: calls,
      meta: { limit: query.limit, skip: query.skip, count: calls.length },
    });
  } catch (error: unknown) {
    mapCallError(error);
  }
});

/** GET /calls/:callId */
export const getCall = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: callIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const call = await getCallForActor({
      organizationId: auth.organization._id,
      callId: params.callId,
      actor: auth.user,
      permissions: auth.permissions,
    });

    res.status(200).json({ data: serializeCallRecord(call) });
  } catch (error: unknown) {
    mapCallError(error);
  }
});

/** PATCH /calls/:callId/outcome - the agent's account of what happened. */
export const recordCallOutcome = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: callIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: recordCallOutcomeBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });

  try {
    const call = await recordCallOutcomeForActor({
      organizationId: auth.organization._id,
      callId: params.callId,
      actor: auth.user,
      permissions: auth.permissions,
      status: body.status,
      durationSeconds: body.durationSeconds ?? null,
      awaySeconds: body.awaySeconds ?? null,
    });

    res.status(200).json({ data: call });
  } catch (error: unknown) {
    mapCallError(error);
  }
});

/**
 * Recording uploads, bounded before a byte is read.
 *
 * Memory storage with the SAME ceiling message attachments use, so a rejected upload never
 * touches the filesystem. One file, and only the consent field alongside it.
 */
const recordingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MEDIA_MAX_UPLOAD_BYTES, files: 1, fields: 2 },
});

const UPLOAD_LIMIT_MESSAGES: Readonly<Record<string, { statusCode: number; message: string }>> =
  Object.freeze({
    LIMIT_FILE_SIZE: {
      statusCode: 413,
      message: `That recording is too large. The limit is ${Math.round(env.MEDIA_MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    },
    LIMIT_FILE_COUNT: { statusCode: 400, message: 'Only one file can be sent at a time.' },
    LIMIT_UNEXPECTED_FILE: { statusCode: 400, message: 'Unexpected file field.' },
  });

/**
 * Turns multer's own errors into ones an agent can act on.
 *
 * Without this an oversized file is a 500 rendered as "Internal server error.", which tells
 * somebody trying to upload a long call precisely nothing.
 */
export const receiveCallRecordingFile: RequestHandler = (req, res, next) => {
  recordingUpload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    const code = (error as { code?: string })?.code ?? '';
    const mapped = UPLOAD_LIMIT_MESSAGES[code];

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

/** POST /calls/:callId/recording - a human attaching audio their phone recorded. */
export const uploadCallRecording = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: callIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  // Parsed BEFORE the bytes are stored: an upload with no consent acknowledgement must be
  // refused, not stored and then refused.
  parseWithSchema({
    schema: uploadCallRecordingBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });

  const file = (req as { file?: { buffer: Buffer; mimetype: string; originalname: string } }).file;

  if (!file) {
    throw createHttpError({
      statusCode: 400,
      code: 'NO_FILE',
      message: 'No file was uploaded.',
    });
  }

  try {
    const call = await uploadCallRecordingForActor({
      organizationId: auth.organization._id,
      callId: params.callId,
      actor: auth.user,
      permissions: auth.permissions,
      bytes: file.buffer,
      declaredMimeType: file.mimetype,
      fileName: file.originalname,
    });

    res.status(201).json({ data: call });
  } catch (error: unknown) {
    if (error instanceof CallRecordingError) {
      mapCallError(new Error(error.reason.toUpperCase()));
    }

    mapCallError(error);
  }
});

/**
 * GET /calls/:callId/recording - the audio, streamed to an authorised caller.
 *
 * NO SIGNED URL AND NOTHING GUESSABLE. The client asks by call id, which it is already
 * authorised to read; the server resolves the storage key itself and streams the bytes over the
 * same authenticated request. `Content-Disposition: attachment` and `nosniff` so the browser
 * can never be talked into rendering a stored file as a page on the API's own origin.
 */
export const downloadCallRecording = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: callIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const { stream, sizeBytes, mimeType } = await openCallRecordingForActor({
      organizationId: auth.organization._id,
      callId: params.callId,
      actor: auth.user,
      permissions: auth.permissions,
    });

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Private: a recording must never sit in a shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'attachment; filename="call-recording"');

    stream.pipe(res);
  } catch (error: unknown) {
    if (error instanceof CallRecordingUnavailableError) {
      mapCallError(new Error('RECORDING_UNAVAILABLE'));
    }

    mapCallError(error);
  }
});

/** GET /calls/:callId/analysis - transcript, summary and suggestions. */
export const getCallAnalysis = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: callIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    // Authorises through the call, which authorises through the conversation. The analysis
    // lookup below is org-scoped as well, so neither layer is load-bearing alone.
    const call = await getCallForActor({
      organizationId: auth.organization._id,
      callId: params.callId,
      actor: auth.user,
      permissions: auth.permissions,
    });

    const analysis = await findCallAnalysis({
      organizationId: auth.organization._id,
      callId: call._id,
    });

    // `null` is a correct, expected answer: nothing has been transcribed. The client renders
    // that as "no transcript yet" rather than as an error.
    res.status(200).json({ data: analysis ? serializeCallAnalysis(analysis) : null });
  } catch (error: unknown) {
    mapCallError(error);
  }
});

/** POST /calls/:callId/suggestions/:commitmentId/confirm - creates the follow-up task. */
export const confirmCallSuggestion = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: suggestionParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: confirmSuggestionBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });

  try {
    const task = await confirmSuggestionForActor({
      organizationId: auth.organization._id,
      callId: params.callId,
      commitmentId: params.commitmentId,
      actor: auth.user,
      permissions: auth.permissions,
      dueAt: body.dueAt ?? null,
    });

    res.status(201).json({ data: task });
  } catch (error: unknown) {
    if (error instanceof SuggestionNotFoundError || error instanceof SuggestionNeedsDueDateError) {
      mapCallError(new Error(error.message));
    }

    mapCallError(error);
  }
});

/** POST /calls/:callId/suggestions/:commitmentId/dismiss - creates nothing. */
export const dismissCallSuggestion = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: suggestionParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const analysis = await dismissSuggestionForActor({
      organizationId: auth.organization._id,
      callId: params.callId,
      commitmentId: params.commitmentId,
      actor: auth.user,
      permissions: auth.permissions,
    });

    res.status(200).json({ data: serializeCallAnalysis(analysis) });
  } catch (error: unknown) {
    if (error instanceof SuggestionNotFoundError) {
      mapCallError(new Error(error.message));
    }

    mapCallError(error);
  }
});

/**
 * DELETE /calls/:callId/recording - destroys the audio, keeps the call.
 *
 * Gated on conversations.delete at the route, on top of the conversation gate in the service:
 * reading a lead and destroying evidence of a customer conversation are different privileges,
 * and `staff` deliberately holds the first without the second.
 */
export const deleteCallRecording = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: callIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const call = await deleteCallRecordingForActor({
      organizationId: auth.organization._id,
      callId: params.callId,
      actor: auth.user,
      permissions: auth.permissions,
    });

    res.status(200).json({ data: call });
  } catch (error: unknown) {
    if (error instanceof RecordingDeletionFailedError) {
      mapCallError(new Error('RECORDING_DELETE_FAILED'));
    }

    mapCallError(error);
  }
});

/** DELETE /calls/:callId/analysis - destroys the transcript and summary, keeps confirmed tasks. */
export const deleteCallAnalysisHandler = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: callIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const result = await deleteCallAnalysisForActor({
      organizationId: auth.organization._id,
      callId: params.callId,
      actor: auth.user,
      permissions: auth.permissions,
    });

    res.status(200).json({ data: result });
  } catch (error: unknown) {
    mapCallError(error);
  }
});

/**
 * GET /calls/retention/preview - what the retention sweep WOULD delete.
 *
 * Counts and cutoffs only. A preview that listed transcripts would be a new way to read the
 * very data it is about to destroy.
 */
export const getRetentionPreview = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);

  const preview = await previewRetention({ organizationId: auth.organization._id });

  res.status(200).json({ data: preview });
});
