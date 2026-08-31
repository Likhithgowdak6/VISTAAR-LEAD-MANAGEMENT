import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { getContactForActor, revealContactPhoneForActor } from './contact.service.js';
import { contactIdParamsSchema } from './contact.validation.js';

const mapContactError = (error: unknown): never => {
  if (error instanceof Error && error.message === 'CONTACT_NOT_FOUND') {
    throw createHttpError({
      statusCode: 404,
      code: 'CONTACT_NOT_FOUND',
      message: 'Contact not found.',
    });
  }

  throw error;
};

export const getContact = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: contactIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const contact = await getContactForActor({
      organizationId: auth.organization._id,
      contactId: params.contactId,
    });

    res.status(200).json({
      data: contact,
    });
  } catch (error: unknown) {
    mapContactError(error);
  }
});

export const revealContactPhone = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: contactIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const revealed = await revealContactPhoneForActor({
      organizationId: auth.organization._id,
      contactId: params.contactId,
      actor: auth.user,
      session: auth.session,
      requestContext: req.context,
    });

    res.status(200).json({
      data: revealed,
    });
  } catch (error: unknown) {
    mapContactError(error);
  }
});
