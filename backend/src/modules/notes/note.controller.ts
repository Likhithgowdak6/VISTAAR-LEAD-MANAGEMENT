import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { createNoteForActor, deleteNoteForActor, listNotesForActor } from './note.service.js';
import {
  conversationIdParamsSchema,
  createNoteBodySchema,
  listNotesQuerySchema,
  noteParamsSchema,
} from './note.validation.js';

const noteErrorMap = {
  CONVERSATION_NOT_FOUND: { statusCode: 404, message: 'Conversation not found.' },
  CONVERSATION_ACCESS_DENIED: {
    statusCode: 403,
    message: 'You do not have access to this conversation.',
  },
  NOTE_NOT_FOUND: { statusCode: 404, message: 'Note not found.' },
  NOTE_VISIBILITY_FORBIDDEN: {
    statusCode: 403,
    message: 'You cannot create a note with that visibility.',
  },
  NOTE_DELETE_FORBIDDEN: { statusCode: 403, message: 'You cannot delete this note.' },
} as const;

type NoteErrorCode = keyof typeof noteErrorMap;

const mapNoteError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : '';
  const mapped = message in noteErrorMap ? noteErrorMap[message as NoteErrorCode] : undefined;

  if (!mapped) {
    throw error;
  }

  throw createHttpError({
    statusCode: mapped.statusCode,
    code: message,
    message: mapped.message,
  });
};

export const listNotes = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const query = parseWithSchema({
    schema: listNotesQuerySchema,
    value: req.query,
    source: 'Query',
  });

  try {
    const notes = await listNotesForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      actor: auth.user,
      permissions: auth.permissions,
      limit: query.limit,
      skip: query.skip,
    });

    res.status(200).json({
      data: notes,
      meta: { limit: query.limit, skip: query.skip, count: notes.length },
    });
  } catch (error: unknown) {
    mapNoteError(error);
  }
});

export const createNote = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: createNoteBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const note = await createNoteForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      actor: auth.user,
      permissions: auth.permissions,
      body: body.body,
      visibility: body.visibility,
    });

    res.status(201).json({ data: note });
  } catch (error: unknown) {
    mapNoteError(error);
  }
});

export const deleteNote = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: noteParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const note = await deleteNoteForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      noteId: params.noteId,
      actor: auth.user,
      permissions: auth.permissions,
    });

    res.status(200).json({ data: note });
  } catch (error: unknown) {
    mapNoteError(error);
  }
});
