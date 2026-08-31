import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { getOrganizationSettingsService } from './organization-settings.service.js';
import { updateOrganizationSettingsBodySchema } from './organization-settings.validation.js';

const organizationSettingsErrorMap = {
  ORGANIZATION_NOT_FOUND: { statusCode: 404, message: 'Organization not found.' },
} as const;

type OrganizationSettingsErrorCode = keyof typeof organizationSettingsErrorMap;

const mapOrganizationSettingsError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : '';
  const mapped =
    message in organizationSettingsErrorMap
      ? organizationSettingsErrorMap[message as OrganizationSettingsErrorCode]
      : undefined;

  if (!mapped) {
    throw error;
  }

  throw createHttpError({
    statusCode: mapped.statusCode,
    code: message,
    message: mapped.message,
  });
};

export const getSettings = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);

  const settings = await getOrganizationSettingsService().getOrganizationSettings({
    organizationId: auth.organization._id,
  });

  res.status(200).json({ data: settings });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: updateOrganizationSettingsBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const settings = await getOrganizationSettingsService().setOwnerNumber({
      organizationId: auth.organization._id,
      ownerWhatsappNumber: body.ownerWhatsappNumber,
    });

    res.status(200).json({ data: settings });
  } catch (error: unknown) {
    mapOrganizationSettingsError(error);
  }
});
