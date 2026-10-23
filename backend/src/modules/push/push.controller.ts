/**
 * Device registration, from a signed-in app.
 *
 * THE OWNER OF A DEVICE IS THE SESSION, NEVER THE BODY. Both handlers take `organizationId`
 * and `userId` from `requireAuthContext` and ignore anything the client sends about identity -
 * the validation schema does not even have those fields. Without that, any signed-in user
 * could register their own handset against another organisation and receive its reminders.
 */
import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { registerPushDevice, removePushDevice } from './push-device.repository.js';
import { createPushSender } from './push-sender.service.js';
import {
  registerPushDeviceBodySchema,
  removePushDeviceBodySchema,
} from './push.validation.js';

export const registerDevice = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: registerPushDeviceBodySchema,
    value: req.body,
    source: 'Body',
  });

  const device = await registerPushDevice({
    organizationId: auth.organization._id,
    userId: auth.user._id,
    token: body.token,
    platform: body.platform,
  });

  // THE TOKEN IS NOT ECHOED BACK. It is a credential for addressing this handset; a response
  // that repeats it puts it in logs, proxies and error trackers for no benefit - the client
  // already has it.
  res.status(201).json({
    registered: true,
    platform: device?.platform ?? body.platform,
  });
});

export const removeDevice = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: removePushDeviceBodySchema,
    value: req.body,
    source: 'Body',
  });

  // Scoped to the caller's own organization AND user, so knowing somebody else's token is not
  // enough to silence their phone.
  const result = await removePushDevice({
    organizationId: auth.organization._id,
    userId: auth.user._id,
    token: body.token,
  });

  // Deliberately 200 whether or not a row matched. "This token is not registered for you" and
  // "it was, and now is not" are the same state from the caller's point of view, and
  // distinguishing them would turn this into an oracle for whether a token exists.
  res.json({ removed: (result?.deletedCount ?? 0) > 0 });
});

/**
 * Whether push is configured, for the dashboard to explain itself with.
 *
 * Names of missing variables only - never values, never the private key. Behind
 * authentication because the shape of a deployment's configuration is not public.
 */
export const getPushStatus = asyncHandler(async (req, res) => {
  requireAuthContext(req);

  const { report } = createPushSender();

  res.json({ enabled: report.enabled, configured: report.configured, missing: report.missing });
});
