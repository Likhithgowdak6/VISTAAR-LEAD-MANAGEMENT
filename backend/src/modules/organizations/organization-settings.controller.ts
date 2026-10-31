import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { getOrganizationSettingsService } from './organization-settings.service.js';
import {
  updateCallRetentionBodySchema,
  updateOrganizationSettingsBodySchema,
} from './organization-settings.validation.js';

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

/**
 * PATCH /settings/call-retention - how long this studio keeps call data.
 *
 * ITS OWN ROUTE rather than a field on the settings PATCH above. That handler `$set`s the
 * owner's phone number unconditionally, so a retention save sent through it would rewrite the
 * phone too - and omitting it would clear it. Two settings with different lifetimes, two
 * endpoints, one permission.
 *
 * THE ORGANISATION COMES FROM THE SESSION, never the body. There is no field here a caller
 * could use to point the write at another studio's policy.
 */
export const updateCallRetentionSettings = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: updateCallRetentionBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const settings = await getOrganizationSettingsService().setCallRetention({
      organizationId: auth.organization._id,
      recordingDays: body.recordingDays,
      transcriptDays: body.transcriptDays,
      summaryDays: body.summaryDays,
    });

    res.status(200).json({ data: settings });
  } catch (error: unknown) {
    mapOrganizationSettingsError(error);
  }
});
