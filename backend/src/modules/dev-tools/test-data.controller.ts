import { z } from 'zod';

import { env } from '../../config/env.js';
import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import {
  clearOrganizationTestData,
  isTestModeActive,
  placeTestOwnerCall,
  readTestOwnerCallOutcome,
  TestDataToolError,
} from './test-data.service.js';

const testDataErrorMap = {
  TEST_MODE_NOT_ACTIVE: {
    statusCode: 403,
    message: 'Test mode is off (WHATSAPP_TEST_ALLOWED_NUMBERS is empty). Refusing to run.',
  },
  OWNER_NUMBER_NOT_SET: {
    statusCode: 400,
    message: 'No owner WhatsApp number is saved, so there is nobody to call.',
  },
} as const;

type TestDataErrorCode = keyof typeof testDataErrorMap;

const mapTestDataError = (error: unknown): never => {
  if (!(error instanceof TestDataToolError) || !(error.message in testDataErrorMap)) {
    throw error;
  }

  const code = error.message as TestDataErrorCode;
  const mapped = testDataErrorMap[code];

  throw createHttpError({ statusCode: mapped.statusCode, code, message: mapped.message });
};

export const getTestModeStatus = asyncHandler(async (_req, res) => {
  res.status(200).json({
    data: {
      active: isTestModeActive(env),
      allowedNumbers: env.WHATSAPP_TEST_ALLOWED_NUMBERS.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    },
  });
});

export const clearTestData = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);

  try {
    const result = await clearOrganizationTestData({ organizationId: auth.organization._id });

    res.status(200).json({ data: result });
  } catch (error: unknown) {
    mapTestDataError(error);
  }
});

export const callOwnerForTest = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);

  try {
    const result = await placeTestOwnerCall({ organizationId: auth.organization._id });

    res.status(200).json({ data: result });
  } catch (error: unknown) {
    mapTestDataError(error);
  }
});

const callIdParamSchema = z.object({ callId: z.string().trim().min(1).max(120) });

export const readTestCallOutcome = asyncHandler(async (req, res) => {
  requireAuthContext(req);

  const { callId } = parseWithSchema({
    schema: callIdParamSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const result = await readTestOwnerCallOutcome({ callId });

    res.status(200).json({ data: result });
  } catch (error: unknown) {
    mapTestDataError(error);
  }
});
