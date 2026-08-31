import { WHATSAPP_AUTH_STATE_NAMESPACES } from '../../whatsapp-auth-states/whatsapp-auth-state.model.js';
import { WhatsAppProviderError } from '../whatsapp.errors.js';

export const BAILEYS_CREDS_KEY_ID = 'default';

export const BAILEYS_AUTH_PAYLOAD_TYPES = Object.freeze({
  BUFFER: 'wam-crm-ai:buffer:v1',
  DATE: 'wam-crm-ai:date:v1',
} as const);

const APP_STATE_SYNC_KEY_TYPE = 'app-state-sync-key';

export type SerializedBaileysBuffer = {
  __type: typeof BAILEYS_AUTH_PAYLOAD_TYPES.BUFFER;
  base64: string;
};

export type SerializedBaileysDate = {
  __type: typeof BAILEYS_AUTH_PAYLOAD_TYPES.DATE;
  iso: string;
};

/** JSON-safe tree produced by serializeBaileysAuthPayload. */
export type SerializedBaileysAuthPayload =
  | null
  | undefined
  | string
  | number
  | boolean
  | SerializedBaileysBuffer
  | SerializedBaileysDate
  | SerializedBaileysAuthPayload[]
  | { [key: string]: SerializedBaileysAuthPayload };

export interface BaileysKeyStorageKeyOptions {
  type?: unknown;
  id?: unknown;
}

export interface HydrateBaileysKeyValueOptions {
  type?: unknown;
  value?: unknown;
  /** Baileys `proto` namespace; only AppStateSyncKeyData.fromObject is used. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Baileys proto typings are incomplete
  proto?: any;
}

export const toBaileysCredsStorageKey = () => ({
  namespace: WHATSAPP_AUTH_STATE_NAMESPACES.CREDS,
  keyId: BAILEYS_CREDS_KEY_ID,
});

export const toBaileysKeyStorageKey = ({ type, id }: BaileysKeyStorageKeyOptions = {}) => {
  const normalizedType = String(type ?? '').trim();
  const normalizedId = String(id ?? '').trim();

  if (!normalizedType) {
    throw new WhatsAppProviderError('Baileys auth-state key type is required.', {
      code: 'BAILEYS_AUTH_STATE_KEY_TYPE_REQUIRED',
    });
  }

  if (!normalizedId) {
    throw new WhatsAppProviderError('Baileys auth-state key id is required.', {
      code: 'BAILEYS_AUTH_STATE_KEY_ID_REQUIRED',
    });
  }

  return {
    namespace: WHATSAPP_AUTH_STATE_NAMESPACES.KEYS,
    keyId: `${normalizedType}:${normalizedId}`,
  };
};

const isSerializedBuffer = (value: unknown): value is SerializedBaileysBuffer =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as SerializedBaileysBuffer).__type === BAILEYS_AUTH_PAYLOAD_TYPES.BUFFER &&
    typeof (value as SerializedBaileysBuffer).base64 === 'string',
  );

const isSerializedDate = (value: unknown): value is SerializedBaileysDate =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as SerializedBaileysDate).__type === BAILEYS_AUTH_PAYLOAD_TYPES.DATE &&
    typeof (value as SerializedBaileysDate).iso === 'string',
  );

export const serializeBaileysAuthPayload = (value: unknown): SerializedBaileysAuthPayload => {
  if (value === null || value === undefined) {
    return value;
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return {
      __type: BAILEYS_AUTH_PAYLOAD_TYPES.BUFFER,
      base64: Buffer.from(value).toString('base64'),
    };
  }

  if (value instanceof Date) {
    return {
      __type: BAILEYS_AUTH_PAYLOAD_TYPES.DATE,
      iso: value.toISOString(),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeBaileysAuthPayload(item));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .map(([key, nestedValue]) => [key, serializeBaileysAuthPayload(nestedValue)]),
    );
  }

  return value as string | number | boolean;
};

export const deserializeBaileysAuthPayload = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (isSerializedBuffer(value)) {
    return Buffer.from(value.base64, 'base64');
  }

  if (isSerializedDate(value)) {
    return new Date(value.iso);
  }

  if (Array.isArray(value)) {
    return value.map((item) => deserializeBaileysAuthPayload(item));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        deserializeBaileysAuthPayload(nestedValue),
      ]),
    );
  }

  return value;
};

export const hydrateBaileysKeyValue = ({
  type,
  value,
  proto,
}: HydrateBaileysKeyValueOptions = {}): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (type === APP_STATE_SYNC_KEY_TYPE && proto?.Message?.AppStateSyncKeyData?.fromObject) {
    return proto.Message.AppStateSyncKeyData.fromObject(value);
  }

  return value;
};
