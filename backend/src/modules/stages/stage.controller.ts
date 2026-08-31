import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import {
  archiveStageForActor,
  createStageForActor,
  deleteStageForActor,
  listStagesForOrganization,
} from './stage.service.js';
import {
  createStageBodySchema,
  listStagesQuerySchema,
  stageIdParamsSchema,
} from './stage.validation.js';

const stageErrorMap = {
  STAGE_NOT_FOUND: { statusCode: 404, message: 'Stage not found.' },
  STAGE_KEY_EXISTS: { statusCode: 409, message: 'A stage with this key already exists.' },
  STAGE_KEY_RESERVED: {
    statusCode: 400,
    message: 'This key is reserved by a built-in stage.',
  },
} as const;

type StageErrorCode = keyof typeof stageErrorMap;

const mapStageError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : '';
  const mapped = message in stageErrorMap ? stageErrorMap[message as StageErrorCode] : undefined;

  if (!mapped) {
    throw error;
  }

  throw createHttpError({
    statusCode: mapped.statusCode,
    code: message,
    message: mapped.message,
  });
};

export const listStages = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: listStagesQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const stages = await listStagesForOrganization({
    organizationId: auth.organization._id,
    status: query.status,
    limit: query.limit,
    skip: query.skip,
  });

  res.status(200).json({
    data: stages,
    meta: { limit: query.limit, skip: query.skip, count: stages.length },
  });
});

export const createStage = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: createStageBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const stage = await createStageForActor({
      organizationId: auth.organization._id,
      actor: auth.user,
      label: body.label,
      key: body.key,
      color: body.color,
    });

    res.status(201).json({ data: stage });
  } catch (error: unknown) {
    mapStageError(error);
  }
});

export const archiveStage = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: stageIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const stage = await archiveStageForActor({
      organizationId: auth.organization._id,
      stageId: params.stageId,
      actor: auth.user,
    });

    res.status(200).json({ data: stage });
  } catch (error: unknown) {
    mapStageError(error);
  }
});

export const deleteStage = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: stageIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const stage = await deleteStageForActor({
      organizationId: auth.organization._id,
      stageId: params.stageId,
    });

    res.status(200).json({ data: stage });
  } catch (error: unknown) {
    mapStageError(error);
  }
});
