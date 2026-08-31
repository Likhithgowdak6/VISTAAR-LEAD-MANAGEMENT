import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import {
  archiveTagForActor,
  attachTagToConversationForActor,
  createTagForActor,
  detachTagFromConversationForActor,
  listTagsForOrganization,
} from './tag.service.js';
import {
  attachTagBodySchema,
  conversationIdParamsSchema,
  conversationTagParamsSchema,
  createTagBodySchema,
  listTagsQuerySchema,
  tagIdParamsSchema,
} from './tag.validation.js';

const tagErrorMap = {
  CONVERSATION_NOT_FOUND: { statusCode: 404, message: 'Conversation not found.' },
  CONVERSATION_ACCESS_DENIED: {
    statusCode: 403,
    message: 'You do not have access to this conversation.',
  },
  TAG_NOT_FOUND: { statusCode: 404, message: 'Tag not found.' },
  TAG_SLUG_EXISTS: { statusCode: 409, message: 'A tag with this slug already exists.' },
} as const;

type TagErrorCode = keyof typeof tagErrorMap;

const mapTagError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : '';
  const mapped = message in tagErrorMap ? tagErrorMap[message as TagErrorCode] : undefined;

  if (!mapped) {
    throw error;
  }

  throw createHttpError({
    statusCode: mapped.statusCode,
    code: message,
    message: mapped.message,
  });
};

export const listTags = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: listTagsQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const tags = await listTagsForOrganization({
    organizationId: auth.organization._id,
    whatsappAccountId: query.whatsappAccountId,
    status: query.status,
    limit: query.limit,
    skip: query.skip,
  });

  res.status(200).json({
    data: tags,
    meta: { limit: query.limit, skip: query.skip, count: tags.length },
  });
});

export const createTag = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: createTagBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const tag = await createTagForActor({
      organizationId: auth.organization._id,
      actor: auth.user,
      name: body.name,
      slug: body.slug,
      color: body.color,
      description: body.description,
      whatsappAccountId: body.whatsappAccountId,
    });

    res.status(201).json({ data: tag });
  } catch (error: unknown) {
    mapTagError(error);
  }
});

export const archiveTag = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: tagIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const tag = await archiveTagForActor({
      organizationId: auth.organization._id,
      tagId: params.tagId,
      actor: auth.user,
    });

    res.status(200).json({ data: tag });
  } catch (error: unknown) {
    mapTagError(error);
  }
});

export const attachTag = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: attachTagBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const result = await attachTagToConversationForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      tagId: body.tagId,
      actor: auth.user,
      permissions: auth.permissions,
    });

    res.status(200).json({ data: result });
  } catch (error: unknown) {
    mapTagError(error);
  }
});

export const detachTag = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationTagParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const result = await detachTagFromConversationForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      tagId: params.tagId,
      actor: auth.user,
      permissions: auth.permissions,
    });

    res.status(200).json({ data: result });
  } catch (error: unknown) {
    mapTagError(error);
  }
});
