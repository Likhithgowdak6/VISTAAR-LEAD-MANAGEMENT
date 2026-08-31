import mongoose, { type Model, type Types } from 'mongoose';

import {
  MESSAGE_AUTHOR_VALUES,
  MESSAGE_AUTHORS,
  type MessageAuthor,
} from '../../constants/message-authors.js';
import {
  MESSAGE_DIRECTION_VALUES,
  MESSAGE_DIRECTIONS,
  type MessageDirection,
} from '../../constants/message-directions.js';
import {
  MESSAGE_STATUSES,
  MESSAGE_STATUS_VALUES,
  type MessageStatus,
} from '../../constants/message-statuses.js';
import {
  MESSAGE_TYPE_VALUES,
  MESSAGE_TYPES,
  type MessageType,
} from '../../constants/message-types.js';

export type MediaStorageStatus = 'not_applicable' | 'pending' | 'stored' | 'failed' | 'deleted';

export interface MessageMedia {
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  storageStatus: MediaStorageStatus;
}

export interface MessageDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId;
  conversationId: Types.ObjectId;
  contactId: Types.ObjectId;
  providerMessageId: string | null;
  idempotencyKey: string | null;
  direction: MessageDirection;
  type: MessageType;
  body: string | null;
  mediaObjectKey: string | null;
  media: MessageMedia;
  sentByUserId: Types.ObjectId | null;
  status: MessageStatus;
  sentAt: Date | null;
  receivedAt: Date | null;
  providerTimestamp: Date | null;
  statusUpdatedAt: Date | null;
  deliveryAttempts: number;
  lastDeliveryError: string | null;
  nextAttemptAt: Date | null;
  /** Who authored this outbound message's content - the AI automation, or a human. */
  authoredBy: MessageAuthor;
  /** Not claimable for delivery before this time; null means eligible as soon as claimed. */
  scheduledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const messageMediaSchema = new mongoose.Schema<MessageMedia>(
  {
    mimeType: {
      type: String,
      trim: true,
      maxlength: 160,
      default: null,
    },

    fileName: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
    },

    sizeBytes: {
      type: Number,
      min: 0,
      default: null,
    },

    storageStatus: {
      type: String,
      enum: ['not_applicable', 'pending', 'stored', 'failed', 'deleted'],
      default: 'not_applicable',
    },
  },
  {
    _id: false,
  },
);

const messageSchema = new mongoose.Schema<MessageDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    whatsappAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppAccount',
      required: true,
      index: true,
    },

    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },

    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      required: true,
      index: true,
    },

    providerMessageId: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
    },

    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
    },

    direction: {
      type: String,
      required: true,
      enum: MESSAGE_DIRECTION_VALUES,
    },

    type: {
      type: String,
      required: true,
      enum: MESSAGE_TYPE_VALUES,
      default: MESSAGE_TYPES.TEXT,
    },

    body: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: null,
    },

    mediaObjectKey: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    media: {
      type: messageMediaSchema,
      default: () => ({
        storageStatus: 'not_applicable',
      }),
    },

    sentByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    status: {
      type: String,
      required: true,
      enum: MESSAGE_STATUS_VALUES,
      default: MESSAGE_STATUSES.CREATED,
    },

    sentAt: {
      type: Date,
      default: null,
    },

    receivedAt: {
      type: Date,
      default: null,
    },

    providerTimestamp: {
      type: Date,
      default: null,
    },

    statusUpdatedAt: {
      type: Date,
      default: null,
    },

    deliveryAttempts: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    lastDeliveryError: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    nextAttemptAt: {
      type: Date,
      default: null,
    },

    authoredBy: {
      type: String,
      required: true,
      enum: MESSAGE_AUTHOR_VALUES,
      default: MESSAGE_AUTHORS.HUMAN,
    },

    scheduledAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

messageSchema.index(
  {
    organizationId: 1,
    whatsappAccountId: 1,
    providerMessageId: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      providerMessageId: {
        $type: 'string',
      },
    },
  },
);

messageSchema.index({
  organizationId: 1,
  conversationId: 1,
  sentAt: -1,
  _id: -1,
});

messageSchema.index(
  {
    organizationId: 1,
    whatsappAccountId: 1,
    idempotencyKey: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: {
        $type: 'string',
      },
    },
  },
);

messageSchema.index({
  organizationId: 1,
  status: 1,
  createdAt: -1,
});

messageSchema.index({
  organizationId: 1,
  whatsappAccountId: 1,
  status: 1,
  statusUpdatedAt: 1,
});

export const Message: Model<MessageDocument> =
  (mongoose.models.Message as Model<MessageDocument> | undefined) ??
  mongoose.model<MessageDocument>('Message', messageSchema);

export { MESSAGE_DIRECTIONS };
