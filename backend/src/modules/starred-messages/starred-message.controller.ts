import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import {
  editStarredMessageForUser,
  listStarredMessagesForUser,
  removeStarredMessageForUser,
  saveStarredMessageForUser,
  STARRED_MESSAGE_NOT_FOUND,
} from './starred-message.service.js';
import {
  createStarredMessageBodySchema,
  listStarredMessagesQuerySchema,
  starredMessageIdParamsSchema,
  updateStarredMessageBodySchema,
} from './starred-message.validation.js';

/**
 * THE USER ID COMES FROM THE TOKEN, NEVER FROM THE REQUEST. There is no route here that accepts
 * a userId, and the serializer does not return one - so there is no shape in which a client can
 * ask for, or be handed, somebody else's saved messages.
 */

const notFound = () =>
  createHttpError({
    statusCode: 404,
    code: STARRED_MESSAGE_NOT_FOUND,
    message: 'Starred message not found.',
  });

export const listStarredMessages = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: listStarredMessagesQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const starred = await listStarredMessagesForUser({
    organizationId: auth.organization._id,
    userId: auth.user._id,
    search: query.search,
  });

  res.status(200).json({ data: starred, meta: { count: starred.length } });
});

export const createStarredMessage = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: createStarredMessageBodySchema,
    value: req.body,
    source: 'Body',
  });

  const starred = await saveStarredMessageForUser({
    organizationId: auth.organization._id,
    userId: auth.user._id,
    title: body.title,
    body: body.body,
    sourceMessageId: body.sourceMessageId ?? null,
    sourceConversationId: body.sourceConversationId ?? null,
  });

  res.status(201).json({ data: starred });
});

export const updateStarredMessageById = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: starredMessageIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: updateStarredMessageBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const starred = await editStarredMessageForUser({
      organizationId: auth.organization._id,
      userId: auth.user._id,
      starredMessageId: params.starredMessageId,
      title: body.title,
      body: body.body,
    });

    res.status(200).json({ data: starred });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === STARRED_MESSAGE_NOT_FOUND) {
      throw notFound();
    }

    throw error;
  }
});

export const deleteStarredMessageById = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: starredMessageIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const starred = await removeStarredMessageForUser({
      organizationId: auth.organization._id,
      userId: auth.user._id,
      starredMessageId: params.starredMessageId,
    });

    res.status(200).json({ data: starred });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === STARRED_MESSAGE_NOT_FOUND) {
      throw notFound();
    }

    throw error;
  }
});
