import { env } from '../../config/env.js';
import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';

import { clearOrganizationTestData, isTestModeActive, TestDataToolError } from './test-data.service.js';

const testDataErrorMap = {
  TEST_MODE_NOT_ACTIVE: {
    statusCode: 403,
    message: 'Test mode is off (WHATSAPP_TEST_ALLOWED_NUMBERS is empty). Refusing to run.',
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
