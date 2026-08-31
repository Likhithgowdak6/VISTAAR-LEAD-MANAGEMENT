import mongoose, { type Model, type Types } from 'mongoose';

import {
  ACCOUNT_ACCESS_MODES,
  ACCOUNT_ACCESS_MODE_VALUES,
  type AccountAccessMode,
} from '../../constants/account-access-modes.js';
import { PERMISSION_VALUES, type Permission } from '../../constants/permissions.js';
import { ROLE_VALUES, ROLES, type Role } from '../../constants/roles.js';
import {
  USER_STATUSES,
  USER_STATUS_VALUES,
  type UserStatus,
} from '../../constants/user-statuses.js';

/** Per-user grants layered on top of the role's default permission set. */
export interface PermissionOverrides {
  allow: Permission[];
  deny: Permission[];
}

export interface UserDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  name: string;
  email: string;
  /** `select: false` on the schema, so absent unless a query opts in. */
  passwordHash: string;
  role: Role;
  permissionOverrides: PermissionOverrides;
  accountAccessMode: AccountAccessMode;
  accountAccess: Types.ObjectId[];
  status: UserStatus;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const permissionOverridesSchema = new mongoose.Schema<PermissionOverrides>(
  {
    allow: {
      type: [
        {
          type: String,
          enum: PERMISSION_VALUES,
        },
      ],
      default: [],
    },

    deny: {
      type: [
        {
          type: String,
          enum: PERMISSION_VALUES,
        },
      ],
      default: [],
    },
  },
  {
    _id: false,
  },
);

const userSchema = new mongoose.Schema<UserDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 320,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },

    passwordHash: {
      type: String,
      required: true,
      select: false,
    },

    role: {
      type: String,
      required: true,
      enum: ROLE_VALUES,
      default: ROLES.STAFF,
    },

    permissionOverrides: {
      type: permissionOverridesSchema,
      default: () => ({
        allow: [],
        deny: [],
      }),
    },

    accountAccessMode: {
      type: String,
      required: true,
      enum: ACCOUNT_ACCESS_MODE_VALUES,
      default: ACCOUNT_ACCESS_MODES.SELECTED,
    },

    accountAccess: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
        },
      ],
      default: [],
    },

    status: {
      type: String,
      required: true,
      enum: USER_STATUS_VALUES,
      default: USER_STATUSES.ACTIVE,
    },

    mustChangePassword: {
      type: Boolean,
      required: true,
      default: true,
    },

    passwordChangedAt: {
      type: Date,
      default: null,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

userSchema.index(
  {
    organizationId: 1,
    email: 1,
  },
  {
    unique: true,
  },
);

userSchema.index({
  organizationId: 1,
  role: 1,
  status: 1,
});

export const User: Model<UserDocument> =
  (mongoose.models.User as Model<UserDocument> | undefined) ??
  mongoose.model<UserDocument>('User', userSchema);
