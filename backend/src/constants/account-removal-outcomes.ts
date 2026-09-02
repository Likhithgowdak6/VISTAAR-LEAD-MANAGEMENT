/**
 * What actually happened when an admin pressed Remove on a WhatsApp number.
 *
 * `deleted` - the account had no history worth keeping, so the document and its stored Baileys
 * credentials are gone for good. `hidden` - the account is still referenced by conversations,
 * messages or a lead source, so it was soft-removed (status `removed`) and dropped out of the
 * accounts list; nothing it owns is orphaned.
 */
export const ACCOUNT_REMOVAL_OUTCOMES = Object.freeze({
  DELETED: 'deleted',
  HIDDEN: 'hidden',
} as const);

export type AccountRemovalOutcome =
  (typeof ACCOUNT_REMOVAL_OUTCOMES)[keyof typeof ACCOUNT_REMOVAL_OUTCOMES];
