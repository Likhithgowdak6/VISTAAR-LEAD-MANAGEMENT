import { z } from 'zod';

import { PUSH_PLATFORM_VALUES } from '../../constants/push.js';

/**
 * A device registration.
 *
 * NEITHER `userId` NOR `organizationId` IS ACCEPTED FROM THE CLIENT, and that is the security
 * property of this endpoint rather than an omission. Both are taken from the authenticated
 * session; a body that could name its owner would let any signed-in user point another
 * organisation's reminders at their own handset.
 */
export const registerPushDeviceBodySchema = z.object({
  token: z.string().trim().min(10).max(4096),
  platform: z.enum(PUSH_PLATFORM_VALUES).default('android'),
});

export const removePushDeviceBodySchema = z.object({
  token: z.string().trim().min(10).max(4096),
});
