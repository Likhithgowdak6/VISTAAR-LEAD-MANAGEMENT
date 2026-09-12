import mongoose, { type Model, type Types } from 'mongoose';

/**
 * A message the owner has approved for sending, kept so he does not have to write it again.
 *
 * Today every one of these is a price quote - the owner types what he charges, the AI writes it
 * up four ways, he keeps the one that reads best. `kind` exists so the next sort of template
 * (a follow-up nudge, a booking confirmation) does not need a migration to sit alongside them.
 *
 * `body` is stored exactly as it will be sent. No placeholders, no interpolation: a saved quote
 * whose numbers get rewritten on the way out is a quote nobody approved.
 */
export const MESSAGE_TEMPLATE_KINDS = Object.freeze({
  PRICING: 'pricing',
} as const);

export type MessageTemplateKind =
  (typeof MESSAGE_TEMPLATE_KINDS)[keyof typeof MESSAGE_TEMPLATE_KINDS];

export const MESSAGE_TEMPLATE_KIND_VALUES = Object.freeze(
  Object.values(MESSAGE_TEMPLATE_KINDS),
) as readonly [MessageTemplateKind, ...MessageTemplateKind[]];

export interface MessageTemplateDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  title: string;
  body: string;
  kind: MessageTemplateKind;
  /** What the owner typed to get this. Kept so he can regenerate from it later. */
  sourceDetails: string;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const messageTemplateSchema = new mongoose.Schema<MessageTemplateDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 120,
    },

    body: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      // Longer than a knowledge entry: a quote covering three packages with inclusions runs to a
      // few hundred characters, and the generator is told to stay well under this anyway.
      maxlength: 4000,
    },

    kind: {
      type: String,
      required: true,
      enum: MESSAGE_TEMPLATE_KIND_VALUES,
      default: MESSAGE_TEMPLATE_KINDS.PRICING,
    },

    sourceDetails: {
      type: String,
      trim: true,
      default: '',
      maxlength: 2000,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Newest first within an organization, which is the order the picker shows them in.
messageTemplateSchema.index({
  organizationId: 1,
  kind: 1,
  createdAt: -1,
});

export const MessageTemplate: Model<MessageTemplateDocument> =
  (mongoose.models.MessageTemplate as Model<MessageTemplateDocument> | undefined) ??
  mongoose.model<MessageTemplateDocument>('MessageTemplate', messageTemplateSchema);
