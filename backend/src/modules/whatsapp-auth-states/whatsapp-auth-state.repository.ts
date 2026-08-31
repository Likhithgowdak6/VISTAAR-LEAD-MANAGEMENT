import { type ObjectIdLike } from '../../types/common.js';
import { type EncryptedField } from '../security/encrypted-field.schema.js';
import { decryptJson, encryptJson } from '../security/encryption.service.js';
import {
  WhatsAppAuthState,
  WHATSAPP_AUTH_STATE_STATUSES,
  type WhatsAppAuthStateDocument,
  type WhatsAppAuthStateNamespace,
  type WhatsAppAuthStateStatus,
} from './whatsapp-auth-state.model.js';

export interface AuthStatePayloadPurposeOptions {
  namespace?: WhatsAppAuthStateNamespace;
  keyId?: string;
}

export interface EncryptAuthStatePayloadOptions {
  namespace?: WhatsAppAuthStateNamespace;
  keyId?: string;
  payload?: unknown;
}

export interface DecryptAuthStatePayloadOptions {
  namespace?: WhatsAppAuthStateNamespace;
  keyId?: string;
  encryptedPayload?: EncryptedField | null;
}

export interface UpsertEncryptedAuthStateOptions {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  namespace?: WhatsAppAuthStateNamespace;
  keyId?: string;
  payload?: unknown;
  status?: WhatsAppAuthStateStatus;
  now?: Date;
}

export interface FindEncryptedAuthStateOptions {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  namespace?: WhatsAppAuthStateNamespace;
  keyId?: string;
}

export interface ListAuthStateKeysOptions {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
}

export interface MarkAuthStateCorruptOptions {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  namespace?: WhatsAppAuthStateNamespace;
  keyId?: string;
  now?: Date;
}

export interface DeleteAuthStateForAccountOptions {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
}

export interface DeleteAuthStateKeyOptions {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  namespace?: WhatsAppAuthStateNamespace;
  keyId?: string;
}

export interface DecryptedAuthStateRecord {
  id: WhatsAppAuthStateDocument['_id'];
  organizationId: WhatsAppAuthStateDocument['organizationId'];
  whatsappAccountId: WhatsAppAuthStateDocument['whatsappAccountId'];
  namespace: WhatsAppAuthStateDocument['namespace'];
  keyId: WhatsAppAuthStateDocument['keyId'];
  status: WhatsAppAuthStateDocument['status'];
  lastWrittenAt: WhatsAppAuthStateDocument['lastWrittenAt'];
  payload: unknown;
}

export const getAuthStatePayloadPurpose = ({
  namespace,
  keyId,
}: AuthStatePayloadPurposeOptions = {}): string =>
  `wam-crm-ai:v1:whatsappAuthState.encryptedPayload:${namespace}:${keyId}`;

export const encryptAuthStatePayloadForStorage = ({
  namespace,
  keyId,
  payload,
}: EncryptAuthStatePayloadOptions = {}): EncryptedField | null =>
  // encryptJson is still untyped in encryption.service; cast keeps this repo strict.
  encryptJson(payload, getAuthStatePayloadPurpose({ namespace, keyId })) as EncryptedField | null;

export const decryptAuthStatePayloadFromStorage = ({
  namespace,
  keyId,
  encryptedPayload,
}: DecryptAuthStatePayloadOptions = {}): unknown =>
  decryptJson(encryptedPayload, getAuthStatePayloadPurpose({ namespace, keyId }));

export const upsertEncryptedAuthState = ({
  organizationId,
  whatsappAccountId,
  namespace,
  keyId,
  payload,
  status = WHATSAPP_AUTH_STATE_STATUSES.ACTIVE,
  now = new Date(),
}: UpsertEncryptedAuthStateOptions = {}) => {
  const encryptedPayload = encryptAuthStatePayloadForStorage({
    namespace,
    keyId,
    payload,
  }) as EncryptedField;

  return WhatsAppAuthState.findOneAndUpdate(
    {
      organizationId,
      whatsappAccountId,
      namespace,
      keyId,
    },
    {
      organizationId,
      whatsappAccountId,
      namespace,
      keyId,
      encryptedPayload,
      status,
      lastWrittenAt: now,
    },
    {
      upsert: true,
      returnDocument: 'after',
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  )
    .select('+encryptedPayload')
    .exec();
};

export const findEncryptedAuthStateForInternalUse = async ({
  organizationId,
  whatsappAccountId,
  namespace,
  keyId,
}: FindEncryptedAuthStateOptions = {}): Promise<DecryptedAuthStateRecord | null> => {
  const authState = await WhatsAppAuthState.findOne({
    organizationId,
    whatsappAccountId,
    namespace,
    keyId,
  })
    .select('+encryptedPayload')
    .exec();

  if (!authState) {
    return null;
  }

  return {
    id: authState._id,
    organizationId: authState.organizationId,
    whatsappAccountId: authState.whatsappAccountId,
    namespace: authState.namespace,
    keyId: authState.keyId,
    status: authState.status,
    lastWrittenAt: authState.lastWrittenAt,
    payload: decryptAuthStatePayloadFromStorage({
      namespace: authState.namespace,
      keyId: authState.keyId,
      encryptedPayload: authState.encryptedPayload,
    }),
  };
};

export const listAuthStateKeysForAccount = ({
  organizationId,
  whatsappAccountId,
}: ListAuthStateKeysOptions = {}) =>
  WhatsAppAuthState.find({
    organizationId,
    whatsappAccountId,
  })
    .select('namespace keyId status lastWrittenAt createdAt updatedAt')
    .sort({
      namespace: 1,
      keyId: 1,
    })
    .exec();

export const markAuthStateCorrupt = ({
  organizationId,
  whatsappAccountId,
  namespace,
  keyId,
  now = new Date(),
}: MarkAuthStateCorruptOptions = {}) =>
  WhatsAppAuthState.findOneAndUpdate(
    {
      organizationId,
      whatsappAccountId,
      namespace,
      keyId,
    },
    {
      status: WHATSAPP_AUTH_STATE_STATUSES.CORRUPT,
      lastWrittenAt: now,
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();

export const deleteAuthStateForAccount = ({
  organizationId,
  whatsappAccountId,
}: DeleteAuthStateForAccountOptions = {}) =>
  WhatsAppAuthState.deleteMany({
    organizationId,
    whatsappAccountId,
  }).exec();

export const deleteAuthStateKey = ({
  organizationId,
  whatsappAccountId,
  namespace,
  keyId,
}: DeleteAuthStateKeyOptions = {}) =>
  WhatsAppAuthState.deleteOne({
    organizationId,
    whatsappAccountId,
    namespace,
    keyId,
  }).exec();
