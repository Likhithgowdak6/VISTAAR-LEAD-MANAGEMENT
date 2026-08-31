import { type Query, type QueryFilter, type UpdateQuery } from 'mongoose';

import { createUniqueLeadId } from '../../services/lead-id.service.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  decryptContactEmailFromStorage,
  decryptContactPhoneFromStorage,
  decryptContactProviderJidsFromStorage,
  encryptContactEmailForStorage,
  encryptContactPhoneForStorage,
  encryptContactProviderJidsForStorage,
} from '../privacy/protected-pii.service.js';
import { type EncryptedField } from '../security/encrypted-field.schema.js';
import { Contact, type ContactDocument } from './contact.model.js';

const withEncryptedFields = <TResult, TQueryHelpers>(
  query: Query<TResult, ContactDocument, TQueryHelpers>,
  includeEncrypted: boolean,
): Query<TResult, ContactDocument, TQueryHelpers> => {
  if (!includeEncrypted) {
    return query;
  }

  return query.select('+encryptedPhone +encryptedEmail +encryptedProviderJids');
};

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code: unknown }).code === 11000;

export const createContact = async (contactData: Partial<ContactDocument>) => {
  const leadId =
    contactData.leadId ??
    (await createUniqueLeadId({
      exists: async (candidateLeadId) =>
        Boolean(
          await Contact.exists({
            organizationId: contactData.organizationId,
            leadId: candidateLeadId,
          }),
        ),
    }));

  return Contact.create({
    ...contactData,
    leadId,
  });
};

export interface FindContactByIdParams {
  contactId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  includeEncrypted?: boolean;
}

export const findContactById = ({
  contactId,
  organizationId,
  includeEncrypted = false,
}: FindContactByIdParams = {}) => {
  const filter: QueryFilter<ContactDocument> = {
    _id: contactId,
  };

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  return withEncryptedFields(Contact.findOne(filter), includeEncrypted).exec();
};

export interface FindContactByLeadIdParams {
  organizationId?: ObjectIdLike;
  leadId?: string;
  includeEncrypted?: boolean;
}

export const findContactByLeadId = ({
  organizationId,
  leadId,
  includeEncrypted = false,
}: FindContactByLeadIdParams = {}) =>
  withEncryptedFields(
    Contact.findOne({
      organizationId,
      leadId,
    }),
    includeEncrypted,
  ).exec();

export interface FindOrCreateContactByLeadIdParams {
  organizationId?: ObjectIdLike;
  leadId?: string;
  contactData?: Partial<ContactDocument>;
}

export const findOrCreateContactByLeadId = async ({
  organizationId,
  leadId,
  contactData = {},
}: FindOrCreateContactByLeadIdParams = {}) => {
  const existingContact = await findContactByLeadId({
    organizationId,
    leadId,
  });

  if (existingContact) {
    return {
      contact: existingContact,
      created: false,
    };
  }

  try {
    const contact = await createContact({
      ...contactData,
      organizationId: organizationId as ContactDocument['organizationId'],
      leadId,
    });

    return {
      contact,
      created: true,
    };
  } catch (error: unknown) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const contact = await findContactByLeadId({
      organizationId,
      leadId,
    });

    return {
      contact,
      created: false,
    };
  }
};

export interface FindContactByProviderKeyParams {
  organizationId?: ObjectIdLike;
  providerContactKey?: string;
  includeEncrypted?: boolean;
}

export const findContactByProviderKey = ({
  organizationId,
  providerContactKey,
  includeEncrypted = false,
}: FindContactByProviderKeyParams = {}) =>
  withEncryptedFields(
    Contact.findOne({
      organizationId,
      providerContactKey,
    }),
    includeEncrypted,
  ).exec();

/**
 * Stores a phone on a contact that does not have one yet, and only then.
 *
 * Contacts first seen through an unresolved `@lid` sender are created without a phone. When the
 * LID mapping becomes available later, this fills the gap without a migration. The "is missing"
 * test is part of the query so a concurrent writer can never clobber a known number.
 */
export interface AttachContactPhoneIfMissingParams {
  contactId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  phone?: string | null;
}

export const attachContactPhoneIfMissing = ({
  contactId,
  organizationId,
  phone,
}: AttachContactPhoneIfMissingParams = {}) => {
  if (!phone) {
    return Promise.resolve(null);
  }

  return Contact.findOneAndUpdate(
    {
      _id: contactId,
      organizationId,
      $or: [{ encryptedPhone: null }, { encryptedPhone: { $exists: false } }],
    },
    {
      $set: {
        encryptedPhone: encryptContactPhoneForStorage(phone) as EncryptedField | null,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
};

/**
 * The email counterpart of `attachContactPhoneIfMissing`, for a contact first seen over
 * WhatsApp — which never carries an email — and later matched to a lead form that does.
 */
export interface AttachContactEmailIfMissingParams {
  contactId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  email?: string | null;
}

export const attachContactEmailIfMissing = ({
  contactId,
  organizationId,
  email,
}: AttachContactEmailIfMissingParams = {}) => {
  if (!email) {
    return Promise.resolve(null);
  }

  return Contact.findOneAndUpdate(
    {
      _id: contactId,
      organizationId,
      $or: [{ encryptedEmail: null }, { encryptedEmail: { $exists: false } }],
    },
    {
      $set: {
        encryptedEmail: encryptContactEmailForStorage(email) as EncryptedField | null,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
};

export interface FindOrCreateContactByProviderKeyParams {
  organizationId?: ObjectIdLike;
  providerContactKey?: string;
  displayName?: string;
  profileName?: string | null;
  phone?: string | null;
  providerJids?: string[] | null;
  source?: string;
}

export const findOrCreateContactByProviderKey = async ({
  organizationId,
  providerContactKey,
  displayName,
  profileName,
  phone,
  providerJids,
  source = 'whatsapp',
}: FindOrCreateContactByProviderKeyParams = {}) => {
  if (!providerContactKey) {
    throw new Error('CONTACT_PROVIDER_KEY_REQUIRED');
  }

  const existingContact = await findContactByProviderKey({
    organizationId,
    providerContactKey,
  });

  if (existingContact) {
    return {
      contact: existingContact,
      created: false,
    };
  }

  const contactData: Partial<ContactDocument> = {
    organizationId: organizationId as ContactDocument['organizationId'],
    providerContactKey,
    displayName,
    profileName,
    source,
  };

  if (phone !== undefined) {
    contactData.encryptedPhone = encryptContactPhoneForStorage(phone) as EncryptedField | null;
  }

  if (providerJids !== undefined) {
    contactData.encryptedProviderJids = encryptContactProviderJidsForStorage(
      providerJids,
    ) as EncryptedField | null;
  }

  try {
    const contact = await createContact(contactData);

    return {
      contact,
      created: true,
    };
  } catch (error: unknown) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const contact = await findContactByProviderKey({
      organizationId,
      providerContactKey,
    });

    return {
      contact,
      created: false,
    };
  }
};

export interface SetContactEncryptedPiiParams {
  contactId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  phone?: string | null;
  email?: string | null;
  providerJids?: string[] | null;
}

export const setContactEncryptedPii = ({
  contactId,
  organizationId,
  phone,
  email,
  providerJids,
}: SetContactEncryptedPiiParams = {}) => {
  const update: UpdateQuery<ContactDocument> = {};

  if (phone !== undefined) {
    update.encryptedPhone = encryptContactPhoneForStorage(phone) as EncryptedField | null;
  }

  if (email !== undefined) {
    update.encryptedEmail = encryptContactEmailForStorage(email) as EncryptedField | null;
  }

  if (providerJids !== undefined) {
    update.encryptedProviderJids = encryptContactProviderJidsForStorage(
      providerJids,
    ) as EncryptedField | null;
  }

  return Contact.findOneAndUpdate(
    {
      _id: contactId,
      organizationId,
    },
    update,
    {
      returnDocument: 'after',
      runValidators: true,
    },
  )
    .select('+encryptedPhone +encryptedEmail +encryptedProviderJids')
    .exec();
};

export interface FindContactPrivatePiiForInternalUseParams {
  contactId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const findContactPrivatePiiForInternalUse = async ({
  contactId,
  organizationId,
}: FindContactPrivatePiiForInternalUseParams = {}) => {
  const contact = await findContactById({
    contactId,
    organizationId,
    includeEncrypted: true,
  });

  if (!contact) {
    return null;
  }

  return {
    contactId: contact._id,
    organizationId: contact.organizationId,
    phone: decryptContactPhoneFromStorage(contact.encryptedPhone),
    email: decryptContactEmailFromStorage(contact.encryptedEmail),
    providerJids: decryptContactProviderJidsFromStorage(contact.encryptedProviderJids),
  };
};
