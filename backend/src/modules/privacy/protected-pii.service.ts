import { BLIND_INDEX_PURPOSES, computeBlindIndex } from '../security/blind-index.service.js';
import {
  decryptJson,
  decryptString,
  encryptJson,
  encryptString,
} from '../security/encryption.service.js';
import { EncryptionOperationError } from '../security/encryption.errors.js';
import { type EncryptedField } from '../security/encrypted-field.schema.js';

const WHATSAPP_JID_DOMAIN = 's.whatsapp.net';

/**
 * Canonicalizes a WhatsApp JID so the same person always maps to one lookup key.
 * Strips the Baileys device suffix (`:NN`), lowercases the domain, and drops the
 * leading `+`. Returns null for empty input.
 */
export const normalizeProviderJid = (jid: unknown): string | null => {
  const normalizedJid = normalizeOptionalString(jid, 'providerJid');

  if (normalizedJid === null) {
    return null;
  }

  const [userPart, domainPart] = normalizedJid.split('@');
  const normalizedUser = userPart!.split(':')[0]!.replace(/^\+/, '');
  const normalizedDomain = (domainPart ?? WHATSAPP_JID_DOMAIN).toLowerCase();

  if (normalizedUser === '') {
    return null;
  }

  return `${normalizedUser}@${normalizedDomain}`;
};

/**
 * Deterministic, non-reversible lookup key for a WhatsApp JID. Stored in an
 * indexed contact field so returning senders resolve to one contact without
 * storing or querying plaintext PII.
 */
export const computeContactProviderKey = (jid: unknown): string | null =>
  computeBlindIndex(normalizeProviderJid(jid), BLIND_INDEX_PURPOSES.CONTACT_PROVIDER_JID);

/**
 * Extracts the bare phone digits from a personal WhatsApp JID. Returns null for
 * non-phone JIDs (for example `@lid` or `@g.us`).
 */
export const extractPhoneFromJid = (jid: unknown): string | null => {
  const normalizedJid = normalizeProviderJid(jid);

  if (normalizedJid === null) {
    return null;
  }

  const [userPart, domainPart] = normalizedJid.split('@');

  if (domainPart !== WHATSAPP_JID_DOMAIN || !/^\d{8,15}$/.test(userPart!)) {
    return null;
  }

  return userPart!;
};

export interface NormalizePhoneNumberOptions {
  /** Digits only, no `+` (for example `91`). Applied when the input carries no country code. */
  defaultCountryCode?: string | null;
}

/**
 * Canonicalizes a human-entered phone number to bare international digits.
 *
 * A number that already declares its country code (`+…` or `00…`) is taken as-is. Anything else
 * is ambiguous — `9229214043` could be a national number or a truncated international one — so
 * the default country code is prepended unless the value already starts with it and is long
 * enough to be a full international number. Returns null when the result could not be a real
 * number, which the caller is expected to treat as a skip rather than a guess.
 */
export const normalizePhoneNumber = (
  value: unknown,
  { defaultCountryCode = null }: NormalizePhoneNumberOptions = {},
): string | null => {
  const rawValue = normalizeOptionalString(value, 'phone');

  if (rawValue === null) {
    return null;
  }

  const hasPlusPrefix = rawValue.startsWith('+');
  const digits = rawValue.replace(/\D/g, '');

  if (digits === '') {
    return null;
  }

  const countryCode = (defaultCountryCode ?? '').replace(/\D/g, '');

  let internationalDigits: string;

  if (hasPlusPrefix) {
    internationalDigits = digits;
  } else if (digits.startsWith('00')) {
    internationalDigits = digits.slice(2);
  } else if (countryCode !== '' && digits.startsWith(countryCode) && digits.length > 10) {
    internationalDigits = digits;
  } else if (countryCode !== '') {
    internationalDigits = `${countryCode}${digits}`;
  } else {
    internationalDigits = digits;
  }

  return /^\d{8,15}$/.test(internationalDigits) ? internationalDigits : null;
};

/**
 * The same contact lookup key `computeContactProviderKey` derives from an inbound JID, but
 * starting from a phone number. Building the personal JID form first is what makes a lead
 * imported from a spreadsheet and the same person's later WhatsApp message resolve to one
 * contact — both sides hash an identical `<digits>@s.whatsapp.net`.
 */
export const computeContactProviderKeyFromPhone = (
  phone: unknown,
  options: NormalizePhoneNumberOptions = {},
): string | null => {
  const normalizedPhone = normalizePhoneNumber(phone, options);

  if (normalizedPhone === null) {
    return null;
  }

  return computeContactProviderKey(`${normalizedPhone}@${WHATSAPP_JID_DOMAIN}`);
};

export const PII_ENCRYPTION_PURPOSES = Object.freeze({
  CONTACT_PHONE: 'wam-crm-ai:v1:contact.encryptedPhone',
  CONTACT_EMAIL: 'wam-crm-ai:v1:contact.encryptedEmail',
  CONTACT_PROVIDER_JIDS: 'wam-crm-ai:v1:contact.encryptedProviderJids',
  WHATSAPP_ACCOUNT_PHONE: 'wam-crm-ai:v1:whatsappAccount.encryptedPhone',
  WHATSAPP_ACCOUNT_JID: 'wam-crm-ai:v1:whatsappAccount.encryptedJid',
  LEAD_SUBMISSION_PAYLOAD: 'wam-crm-ai:v1:leadSubmission.encryptedPayload',
});

function normalizeOptionalString(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new EncryptionOperationError(`${fieldName} must be a string.`);
  }

  const normalized = value.trim();

  return normalized === '' ? null : normalized;
}

function normalizeProviderJids(values: unknown): string[] | null {
  if (values === null || values === undefined) {
    return null;
  }

  if (!Array.isArray(values)) {
    throw new EncryptionOperationError('providerJids must be an array.');
  }

  return values
    .map((value) => normalizeOptionalString(value, 'providerJid'))
    .filter((value): value is string => value !== null);
}

export const encryptContactPhoneForStorage = (value: unknown): EncryptedField | null =>
  encryptString(normalizeOptionalString(value, 'phone'), PII_ENCRYPTION_PURPOSES.CONTACT_PHONE);

export const decryptContactPhoneFromStorage = (encryptedField: unknown): string | null =>
  decryptString(encryptedField, PII_ENCRYPTION_PURPOSES.CONTACT_PHONE);

export const encryptContactEmailForStorage = (value: unknown): EncryptedField | null =>
  encryptString(normalizeOptionalString(value, 'email'), PII_ENCRYPTION_PURPOSES.CONTACT_EMAIL);

export const decryptContactEmailFromStorage = (encryptedField: unknown): string | null =>
  decryptString(encryptedField, PII_ENCRYPTION_PURPOSES.CONTACT_EMAIL);

export const encryptContactProviderJidsForStorage = (values: unknown): EncryptedField | null =>
  encryptJson(normalizeProviderJids(values), PII_ENCRYPTION_PURPOSES.CONTACT_PROVIDER_JIDS);

export const decryptContactProviderJidsFromStorage = (encryptedField: unknown): unknown =>
  decryptJson(encryptedField, PII_ENCRYPTION_PURPOSES.CONTACT_PROVIDER_JIDS);

export const encryptAccountPhoneForStorage = (value: unknown): EncryptedField | null =>
  encryptString(
    normalizeOptionalString(value, 'phone'),
    PII_ENCRYPTION_PURPOSES.WHATSAPP_ACCOUNT_PHONE,
  );

export const decryptAccountPhoneFromStorage = (encryptedField: unknown): string | null =>
  decryptString(encryptedField, PII_ENCRYPTION_PURPOSES.WHATSAPP_ACCOUNT_PHONE);

export const encryptAccountJidForStorage = (value: unknown): EncryptedField | null =>
  encryptString(
    normalizeOptionalString(value, 'jid'),
    PII_ENCRYPTION_PURPOSES.WHATSAPP_ACCOUNT_JID,
  );

export const decryptAccountJidFromStorage = (encryptedField: unknown): string | null =>
  decryptString(encryptedField, PII_ENCRYPTION_PURPOSES.WHATSAPP_ACCOUNT_JID);

/**
 * A whole lead-form submission, encrypted as one blob. The row is treated as PII in full rather
 * than field by field: the standard columns carry name, email and phone, and a free-text answer
 * can contain anything the lead chose to type.
 */
export const encryptLeadSubmissionPayloadForStorage = (value: unknown): EncryptedField | null =>
  encryptJson(value, PII_ENCRYPTION_PURPOSES.LEAD_SUBMISSION_PAYLOAD);

export const decryptLeadSubmissionPayloadFromStorage = (encryptedField: unknown): unknown =>
  decryptJson(encryptedField, PII_ENCRYPTION_PURPOSES.LEAD_SUBMISSION_PAYLOAD);
