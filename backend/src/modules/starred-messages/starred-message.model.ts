import mongoose, { type Model, type Types } from 'mongoose';

/**
 * A message one user kept for themselves, to send again without retyping it.
 *
 * NOT A MESSAGE TEMPLATE, and the difference is the whole design. A template is the studio's:
 * org-wide, written once, approved, and gated on TEMPLATES_MANAGE because it goes out verbatim
 * under the business's name with its prices in it. A starred message is one person's scratchpad
 * - "the line I use when someone asks about drone coverage" - and is scoped to the user who
 * saved it. Nobody else sees it, so saving one cannot change what the team sends, which is
 * exactly the risk TEMPLATES_MANAGE exists to control. That is why this needs no new permission
 * and rides on MESSAGES_SEND: staff answer leads, and staff deliberately do not hold
 * TEMPLATES_MANAGE.
 *
 * THE BODY IS A COPY, NOT A REFERENCE. Starring an existing message snapshots its text. A
 * reference would break the moment the conversation is deleted or redacted, and would make
 * "edit this saved message" mean editing history. The saved text is the user's from the moment
 * they keep it.
 *
 * `sourceMessageId` is kept anyway, for two narrow jobs: showing a filled star on the bubble it
 * came from, and letting un-starring find the right record to remove. It is null for messages
 * typed straight into the Starred section, which are the majority after the first week.
 */
export interface StarredMessageDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  /** The owner of this saved message. Every query filters on it. */
  userId: Types.ObjectId;
  title: string;
  body: string;
  /** The message this was starred from, when it was starred rather than typed. */
  sourceMessageId: Types.ObjectId | null;
  /** Where it came from, for context in the list. Not used for routing. */
  sourceConversationId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const starredMessageSchema = new mongoose.Schema<StarredMessageDocument>(
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
      // Matches MessageTemplate. A saved message is destined for the same composer and the same
      // WhatsApp send path, so a different ceiling here would only surface as a confusing
      // validation error on one of the two.
      maxlength: 4000,
    },

    sourceMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },

    sourceConversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/** The list query: everything this user saved, newest first. */
starredMessageSchema.index({
  organizationId: 1,
  userId: 1,
  createdAt: -1,
});

/**
 * One star per message per user.
 *
 * PARTIAL, because `sourceMessageId` is null for every hand-written entry and a plain unique
 * index would let exactly one of those exist per user - the second would collide on null. The
 * filter also makes this the index that answers "is this bubble already starred?".
 */
starredMessageSchema.index(
  { organizationId: 1, userId: 1, sourceMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { sourceMessageId: { $type: 'objectId' } },
  },
);

export const StarredMessage: Model<StarredMessageDocument> =
  (mongoose.models.StarredMessage as Model<StarredMessageDocument> | undefined) ??
  mongoose.model<StarredMessageDocument>('StarredMessage', starredMessageSchema);
