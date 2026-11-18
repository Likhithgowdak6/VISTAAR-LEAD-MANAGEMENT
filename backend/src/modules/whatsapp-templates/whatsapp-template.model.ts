import mongoose, { type Model, type Types } from 'mongoose';

/**
 * A WhatsApp message template, as Meta approved it.
 *
 * THIS IS A CACHE, not a source of truth. Meta owns these: it holds the approved wording, it
 * decides the status, and it can reject or disable one without telling us. Everything here is a
 * copy taken at `syncedAt` so the composer can show an agent what they are about to send without
 * a Graph round trip per keystroke.
 *
 * Deliberately NOT the same collection as message-templates/, despite the similar name. That one
 * is the owner's own saved replies - free text, no placeholders, sendable at any time. These are
 * Meta's, they carry `{{1}}` placeholders, they must be approved before use, and outside the
 * 24-hour service window they are the only thing WhatsApp will deliver at all. Merging the two
 * would mean one list where half the entries can be edited and half cannot.
 */
export const WHATSAPP_TEMPLATE_STATUSES = Object.freeze({
  APPROVED: 'APPROVED',
  PENDING: 'PENDING',
  REJECTED: 'REJECTED',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
  UNKNOWN: 'UNKNOWN',
} as const);

export type WhatsAppTemplateStatus =
  (typeof WHATSAPP_TEMPLATE_STATUSES)[keyof typeof WHATSAPP_TEMPLATE_STATUSES];

export const WHATSAPP_TEMPLATE_STATUS_VALUES = Object.freeze(
  Object.values(WHATSAPP_TEMPLATE_STATUSES),
) as readonly [WhatsAppTemplateStatus, ...WhatsAppTemplateStatus[]];

export interface WhatsAppTemplateDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId;
  /** Meta's template name. Unique per (account, language), and what a send actually names. */
  name: string;
  /** Meta's language code, e.g. `en_US`. A name without one cannot be sent. */
  language: string;
  status: WhatsAppTemplateStatus;
  /** MARKETING, UTILITY or AUTHENTICATION. Decides what Meta charges and how it is policed. */
  category: string | null;
  /** The approved body text, placeholders and all, for showing the agent what they will send. */
  bodyText: string | null;
  /** The header's text, when the header is a text header rather than an image or document. */
  headerText: string | null;
  footerText: string | null;
  /**
   * How many `{{n}}` placeholders the BODY declares.
   *
   * The composer requires exactly this many values before it will let a send through. Meta
   * rejects a mismatch with a 132-series error, and the agent sees a bounced message rather than
   * a form validation message - so counting here is worth doing properly.
   */
  bodyVariableCount: number;
  /** Placeholders in the header, counted separately because they are a separate component. */
  headerVariableCount: number;
  /** Meta's raw components array, kept verbatim so a new component type needs no migration. */
  components: unknown[];
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const whatsappTemplateSchema = new mongoose.Schema<WhatsAppTemplateDocument>(
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

    status: {
      type: String,
      required: true,
      enum: WHATSAPP_TEMPLATE_STATUS_VALUES,
      default: WHATSAPP_TEMPLATE_STATUSES.UNKNOWN,
    },

    category: {
      type: String,
      trim: true,
      maxlength: 64,
      default: null,
    },

    bodyText: {
      type: String,
      // Meta's own ceiling is 1024 for a template body; the extra room absorbs a future change
      // without a sync failing on validation.
      maxlength: 2000,
      default: null,
    },

    headerText: {
      type: String,
      maxlength: 1000,
      default: null,
    },

    footerText: {
      type: String,
      maxlength: 1000,
      default: null,
    },

    bodyVariableCount: {
      type: Number,
      required: true,
      min: 0,
      max: 50,
      default: 0,
    },

    headerVariableCount: {
      type: Number,
      required: true,
      min: 0,
      max: 50,
      default: 0,
    },

    components: {
      type: [mongoose.Schema.Types.Mixed],
      default: () => [],
    },

    syncedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
  },
  {
    timestamps: true,
  },
);

/**
 * What identifies a template on a send: the account it lives on, its name and its language.
 *
 * Unique, so a re-sync updates in place rather than accumulating a duplicate on every run. The
 * same name genuinely exists in several languages on one account, which is why `language` is part
 * of the key rather than a detail hanging off the name.
 */
whatsappTemplateSchema.index(
  {
    whatsappAccountId: 1,
    name: 1,
    language: 1,
  },
  {
    unique: true,
  },
);

whatsappTemplateSchema.index({
  organizationId: 1,
  whatsappAccountId: 1,
  status: 1,
});

export const WhatsAppTemplate: Model<WhatsAppTemplateDocument> =
  (mongoose.models.WhatsAppTemplate as Model<WhatsAppTemplateDocument> | undefined) ??
  mongoose.model<WhatsAppTemplateDocument>('WhatsAppTemplate', whatsappTemplateSchema);
