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
  /**
   * A recorded voice note rather than an attached audio file. Persisted because it is not
   * recoverable from the mimetype - the same Ogg/Opus bytes are a voice note or a music clip
   * depending only on this - and both the delivery path (WhatsApp's `ptt` flag) and the thread
   * ("🎤 Voice note" versus "🎵 Audio") need to know which one it is.
   */
  isVoiceNote: boolean;
}

/**
 * Which approved template to send, and what to fill into it.
 *
 * NOT the wording. Meta holds the approved text; a send names the template and supplies the
 * placeholder values, and Meta performs the substitution. `body` on the message holds a rendered
 * preview so the thread reads correctly in the inbox, but that preview is never what travels.
 */
export interface MessageCloudTemplate {
  name: string;
  language: string;
  /** Values for the body's `{{1}}`, `{{2}}`, ... in declaration order. */
  bodyParameters: string[];
  /** Values for a text header's placeholders, which Meta counts as a separate component. */
  headerParameters: string[];
}

const messageCloudTemplateSchema = new mongoose.Schema<MessageCloudTemplate>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 512,
    },

    language: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
    },

    bodyParameters: {
      type: [String],
      default: () => [],
    },

    headerParameters: {
      type: [String],
      default: () => [],
    },
  },
  {
    _id: false,
  },
);

export interface MessageDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  /**
   * Required for WhatsApp, null for Instagram.
   *
   * Left null rather than relaxed away because the unique index on
   * (organizationId, whatsappAccountId, providerMessageId) is what stops a redelivered webhook
   * writing a message twice. With every Instagram message sharing a null here, that index still
   * reads as "one message per provider id per workspace" - which is exactly the guarantee
   * Instagram needs. Dropping the field from the key would have cost that for both channels.
   */
  whatsappAccountId: Types.ObjectId | null;
  /** Set only on Instagram messages. */
  instagramAccountId?: Types.ObjectId | null;
  conversationId: Types.ObjectId;
  contactId: Types.ObjectId;
  channel?: 'whatsapp' | 'instagram';
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
  /**
   * Set when this outbound message must go as an approved WhatsApp template rather than free text.
   *
   * Carried on the MESSAGE rather than decided at send time on purpose. The 24-hour service window
   * can close between an agent pressing send and the queue reaching the row - quiet hours alone
   * can hold a message for hours - and a message queued as a template must still be that template
   * when it finally goes out. Deciding at send time would mean the queue silently choosing
   * different words than the agent approved.
   *
   * Null on every Baileys message and on any Cloud message sent inside the window.
   */
  cloudTemplate: MessageCloudTemplate | null;
  paymentContext?: { invoiceId: Types.ObjectId | string; generation: string; amountDuePaise: number; commitmentKey?: string | null; providerLinkId?: string | null } | null;
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

    isVoiceNote: {
      type: Boolean,
      default: false,
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
      // Conditionally required, matching the Conversation model: a WhatsApp message without an
      // account is still the bug it always was, while an Instagram message legitimately has none.
      required(this: { channel?: unknown }) {
        return this.channel !== 'instagram';
      },
      default: null,
      index: true,
    },

    channel: {
      type: String,
      enum: ['whatsapp', 'instagram'],
      // No default, for the same reason as the Conversation model: absent is the historical
      // state and `channelOf()` is the one place that decides what absent means.
      index: true,
    },

    instagramAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InstagramAccount',
      default: null,
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

    cloudTemplate: {
      type: messageCloudTemplateSchema,
      default: null,
    },
    paymentContext: { type: mongoose.Schema.Types.Mixed, default: null },
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
