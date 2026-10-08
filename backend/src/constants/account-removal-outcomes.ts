/**
 * What actually happened when an admin pressed Remove on a WhatsApp number.
 *
 * `deleted` - the account had no history worth keeping, so the document and its stored Baileys
 * credentials are gone for good. `hidden` - the account is still referenced by conversations,
 * messages or a lead source, so it was soft-removed (status `removed`) and dropped out of the
 * accounts list; nothing it owns is orphaned. `purged` - the account HAD history and an admin
 * explicitly asked for it to go anyway, so the threads were deleted first and the account
 * followed; same end state as `deleted`, but it is reported separately because something
 * irreplaceable was destroyed and the counts belong in the audit trail.
 */
export const ACCOUNT_REMOVAL_OUTCOMES = Object.freeze({
  DELETED: 'deleted',
  HIDDEN: 'hidden',
  PURGED: 'purged',
} as const);

export type AccountRemovalOutcome =
  (typeof ACCOUNT_REMOVAL_OUTCOMES)[keyof typeof ACCOUNT_REMOVAL_OUTCOMES];
