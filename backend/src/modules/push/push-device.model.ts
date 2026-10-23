/**
 * One handset that has asked to be told about reminders.
 *
 * WHY A COLLECTION AND NOT A FIELD ON THE USER. One person has a phone and a tablet, replaces
 * the phone, and reinstalls the app - each of which is a different token for the same user. A
 * single field would silently mean "the last device that logged in", and the owner would stop
 * being notified on the handset they actually carry.
 *
 * THE TOKEN IS THE IDENTITY. FCM reissues it on reinstall, on restore to a new device, and
 * occasionally on its own, so it is unique on its own and the upsert is keyed on it. A token
 * that moves from one user to another - the same phone, a different login - must follow the
 * new user rather than keep delivering that organisation's reminders to the old one, which is
 * why the upsert overwrites `userId` and `organizationId` rather than refusing.
 *
 * NOTHING ABOUT A LEAD LIVES HERE. No phone number, no name, no message. A device row is the
 * address of a handset and the identity of who is signed into it.
 */
import mongoose, { type Model, type Types } from 'mongoose';

import { PUSH_PLATFORMS, PUSH_PLATFORM_VALUES, type PushPlatform } from '../../constants/push.js';

export interface PushDeviceDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  /** The FCM registration token. Unique across the whole collection. */
  token: string;
  platform: PushPlatform;
  /**
   * Refreshed on every registration ping, so a device nobody has opened for months is
   * identifiable without asking FCM. Not used to expire anything automatically - a quiet
   * handset is still the owner's handset.
   */
  lastSeenAt: Date;
  /**
   * Set when FCM tells us the token is dead (`UNREGISTERED` / `INVALID_ARGUMENT`). The row is
   * kept rather than deleted so a later registration of the same token is an update rather
   * than a resurrection with no history, and so "why did this phone stop ringing" has an
   * answer.
   */
  disabledAt: Date | null;
  disabledReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const pushDeviceSchema = new mongoose.Schema<PushDeviceDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    token: {
      type: String,
      required: true,
      trim: true,
      // FCM tokens are ~160 chars today and have grown before. Generous, but bounded: an
      // unbounded string from a client is a way to write megabytes into the database.
      maxlength: 4096,
    },

    platform: {
      type: String,
      required: true,
      enum: PUSH_PLATFORM_VALUES,
      default: PUSH_PLATFORMS.ANDROID,
    },

    lastSeenAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },

    disabledAt: {
      type: Date,
      default: null,
    },

    disabledReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },
  },
  { timestamps: true },
);

// THE TOKEN IS UNIQUE GLOBALLY, not per organization. FCM issues one token per app install, so
// the same string appearing under two organisations would mean one handset receiving another
// tenant's reminders - the isolation failure that matters most here.
pushDeviceSchema.index({ token: 1 }, { unique: true });

// The dispatch query: every live device belonging to one user.
pushDeviceSchema.index({ organizationId: 1, userId: 1, disabledAt: 1 });

export const PushDevice: Model<PushDeviceDocument> =
  (mongoose.models.PushDevice as Model<PushDeviceDocument> | undefined) ??
  mongoose.model<PushDeviceDocument>('PushDevice', pushDeviceSchema);
