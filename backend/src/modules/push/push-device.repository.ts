/**
 * Device rows. Every query here is scoped to an organization, with no exceptions.
 */
import { type DatabaseSession } from '../../config/database.js';
import { type PushPlatform } from '../../constants/push.js';
import { type ObjectIdLike } from '../../types/common.js';
import { PushDevice, type PushDeviceDocument } from './push-device.model.js';

export interface RegisterPushDeviceParams {
  organizationId: ObjectIdLike;
  userId: ObjectIdLike;
  token: string;
  platform: PushPlatform;
  now?: Date;
  session?: DatabaseSession;
}

/**
 * Records a handset, or re-records one that already exists.
 *
 * UPSERT KEYED ON THE TOKEN ALONE, and the owner fields are overwritten rather than matched.
 * FCM issues one token per app install, so the same token arriving with a different `userId`
 * means somebody signed into this phone as somebody else - and the reminders that follow must
 * be theirs, not the previous user's. Matching on `{token, userId}` instead would leave the
 * old row live and deliver one organisation's reminders to a handset that has moved on.
 *
 * Re-registering also clears `disabledAt`: a token FCM rejected yesterday and the app
 * presented again today is, by definition, alive.
 */
export const registerPushDevice = ({
  organizationId,
  userId,
  token,
  platform,
  now = new Date(),
  session,
}: RegisterPushDeviceParams) =>
  PushDevice.findOneAndUpdate(
    { token },
    {
      $set: {
        organizationId,
        userId,
        platform,
        lastSeenAt: now,
        disabledAt: null,
        disabledReason: null,
      },
    },
    { upsert: true, returnDocument: 'after', runValidators: true, session },
  ).exec();

export interface FindPushDevicesForUserParams {
  organizationId: ObjectIdLike;
  userId: ObjectIdLike;
  limit?: number;
}

/** Every live handset for one user. Disabled rows are excluded, never deleted. */
export const findPushDevicesForUser = ({
  organizationId,
  userId,
  limit = 20,
}: FindPushDevicesForUserParams): Promise<PushDeviceDocument[]> =>
  PushDevice.find({ organizationId, userId, disabledAt: null })
    .sort({ lastSeenAt: -1 })
    .limit(limit)
    .lean<PushDeviceDocument[]>()
    .exec();

export interface RemovePushDeviceParams {
  organizationId: ObjectIdLike;
  userId: ObjectIdLike;
  token: string;
}

/**
 * Sign-out, or the owner removing a handset.
 *
 * SCOPED TO THE CALLER, which is the whole security property: the filter pairs the token with
 * the organization AND the user, so knowing somebody else's token is not enough to silence
 * their phone. A genuine delete rather than a disable - the user asked to be forgotten by this
 * device, and keeping the row would be keeping a record they asked us to drop.
 */
export const removePushDevice = ({ organizationId, userId, token }: RemovePushDeviceParams) =>
  PushDevice.deleteOne({ organizationId, userId, token }).exec();

export interface DisablePushDeviceParams {
  token: string;
  reason: string;
  now?: Date;
}

/**
 * Retires a token FCM has told us is dead.
 *
 * Keyed on the token alone and deliberately NOT organization-scoped: this is the delivery path
 * reacting to the transport, not a user acting on their own data, and the token is globally
 * unique. Scoping it would mean a dead token surviving because the caller happened to be
 * sweeping a different organisation.
 */
export const disablePushDevice = ({ token, reason, now = new Date() }: DisablePushDeviceParams) =>
  PushDevice.findOneAndUpdate(
    { token },
    { $set: { disabledAt: now, disabledReason: reason.slice(0, 300) } },
    { returnDocument: 'after' },
  ).exec();
