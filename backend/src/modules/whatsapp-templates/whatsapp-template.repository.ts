import { type ObjectIdLike } from '../../types/common.js';
import {
  WhatsAppTemplate,
  WHATSAPP_TEMPLATE_STATUSES,
  type WhatsAppTemplateDocument,
  type WhatsAppTemplateStatus,
} from './whatsapp-template.model.js';

export interface UpsertTemplateOptions {
  organizationId: ObjectIdLike;
  whatsappAccountId: ObjectIdLike;
  name: string;
  language: string;
  status: WhatsAppTemplateStatus;
  category: string | null;
  bodyText: string | null;
  headerText: string | null;
  footerText: string | null;
  bodyVariableCount: number;
  headerVariableCount: number;
  components: unknown[];
  syncedAt?: Date;
}

/**
 * Writes one template, creating it if this is the first sync.
 *
 * Keyed on (account, name, language) to match the unique index, so a template whose wording or
 * status changed on Meta's side is updated rather than duplicated.
 */
export const upsertWhatsAppTemplate = ({
  organizationId,
  whatsappAccountId,
  name,
  language,
  syncedAt = new Date(),
  ...rest
}: UpsertTemplateOptions) =>
  WhatsAppTemplate.findOneAndUpdate(
    {
      whatsappAccountId,
      name,
      language,
    },
    {
      $set: {
        organizationId,
        whatsappAccountId,
        name,
        language,
        syncedAt,
        ...rest,
      },
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  ).exec();

/**
 * Removes templates this account had before the sync and Meta no longer reports.
 *
 * Scoped by `syncedAt` rather than by comparing name lists: anything the sync just touched has
 * the run's timestamp, so one query removes exactly what Meta dropped. Using a timestamp older
 * than the run would delete templates another process had just written.
 *
 * Deleting rather than marking removed is right here - the record is a cache, and a template
 * Meta has forgotten cannot be sent by anybody.
 */
export const deleteStaleWhatsAppTemplates = ({
  whatsappAccountId,
  syncedBefore,
}: {
  whatsappAccountId: ObjectIdLike;
  syncedBefore: Date;
}) =>
  WhatsAppTemplate.deleteMany({
    whatsappAccountId,
    syncedAt: { $lt: syncedBefore },
  }).exec();

export interface ListTemplatesOptions {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  /** When true, only templates WhatsApp will actually accept right now. */
  approvedOnly?: boolean;
  limit?: number;
}

export const findWhatsAppTemplates = ({
  organizationId,
  whatsappAccountId,
  approvedOnly = false,
  limit = 200,
}: ListTemplatesOptions = {}) => {
  const filter: Record<string, unknown> = {};

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  if (whatsappAccountId) {
    filter.whatsappAccountId = whatsappAccountId;
  }

  if (approvedOnly) {
    filter.status = WHATSAPP_TEMPLATE_STATUSES.APPROVED;
  }

  return WhatsAppTemplate.find(filter)
    .sort({
      // Approved first so the useful ones are at the top of a picker, then alphabetical.
      status: 1,
      name: 1,
    })
    .limit(limit)
    .exec();
};

/**
 * One template by name and language.
 *
 * The send path's lookup. Organisation-scoped on purpose even though the account id is already
 * narrow enough: a template name arrives from a request body, and scoping every read by
 * organisation is the habit that makes a missed check somewhere else survivable.
 */
export const findWhatsAppTemplateByName = ({
  organizationId,
  whatsappAccountId,
  name,
  language,
}: {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  name?: string;
  language?: string;
}): Promise<WhatsAppTemplateDocument | null> =>
  WhatsAppTemplate.findOne({
    organizationId,
    whatsappAccountId,
    name,
    language,
  }).exec();

/** Drops every template for an account. Called when a number is removed or disconnected. */
export const deleteWhatsAppTemplatesForAccount = ({
  whatsappAccountId,
  organizationId,
}: {
  whatsappAccountId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}) =>
  WhatsAppTemplate.deleteMany({
    ...(organizationId ? { organizationId } : {}),
    whatsappAccountId,
  }).exec();
