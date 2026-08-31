/**
 * Which system a lead source pulls from.
 *
 * `google_sheet` is the original importer: Meta writes leads into a link-shared spreadsheet and
 * the CRM polls its CSV export. `meta_lead_ads` skips the sheet and asks the Graph API for the
 * form's leads directly.
 *
 * `google_sheet` is the default on purpose — every source that existed before this field was
 * added is a sheet, and a document written without a `kind` must keep behaving exactly as it did.
 */
export const LEAD_SOURCE_KINDS = Object.freeze({
  GOOGLE_SHEET: 'google_sheet',
  META_LEAD_ADS: 'meta_lead_ads',
} as const);

export type LeadSourceKind = (typeof LEAD_SOURCE_KINDS)[keyof typeof LEAD_SOURCE_KINDS];

export const LEAD_SOURCE_KIND_VALUES = Object.freeze(
  Object.values(LEAD_SOURCE_KINDS),
) as readonly [LeadSourceKind, ...LeadSourceKind[]];

/** "Every form on this page", stored as an absent form id rather than a magic string. */
export const META_ALL_FORMS = null;
