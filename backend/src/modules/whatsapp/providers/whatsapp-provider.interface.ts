import { type MessageType } from '../../../constants/message-types.js';
import { type ObjectIdLike } from '../../../types/common.js';
import { InvalidWhatsAppProviderError } from '../whatsapp.errors.js';

export const WHATSAPP_PROVIDER_NAMES = Object.freeze({
  BAILEYS: 'baileys',
} as const);

export type WhatsAppProviderName =
  (typeof WHATSAPP_PROVIDER_NAMES)[keyof typeof WHATSAPP_PROVIDER_NAMES];

export const WHATSAPP_PROVIDER_METHODS = Object.freeze([
  'createSession',
  'destroySession',
  'sendTextMessage',
  'normalizeEvent',
  'getConnectionStatus',
] as const);

export type WhatsAppProviderMethod = (typeof WHATSAPP_PROVIDER_METHODS)[number];

/**
 * Media metadata a provider can read off an inbound notification without downloading anything.
 * Null whenever the message carries no media (plain text) or a node with no file behind it
 * (a shared contact card, a location pin).
 */
export interface NormalizedInboundMedia {
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  /** True for a recorded voice note, as opposed to an ordinary audio file the lead attached. */
  isVoiceNote: boolean;
}

/** Normalized inbound message handed to session ingestion callbacks. */
export interface NormalizedInboundMessage {
  provider: WhatsAppProviderName;
  normalized: boolean;
  eventType: string;
  messageId: string | null;
  remoteJid: string;
  senderJid: string;
  pushName: string | null;
  text: string;
  /**
   * What kind of message this is, on the CRM's own MESSAGE_TYPES vocabulary. Optional so a
   * provider (or a fixture) that only ever produces text need not say so; consumers default it
   * to TEXT, which is what every inbound message was before media was recognised.
   */
  messageType?: MessageType;
  /** Cheaply-available media metadata; nothing is ever downloaded to produce it. */
  media?: NormalizedInboundMedia | null;
  timestamp: unknown;
  senderPhoneJid?: string | null;
  /** True when this message was sent by the linked WhatsApp account itself (Baileys `key.fromMe`). */
  fromMe?: boolean;
  /** True when `fromMe` and the chat is the linked account's own "message yourself" thread. */
  isSelfChat?: boolean;
  safe: {
    from: string;
    textPreview: string;
  };
}

export interface PairingCodeInfo {
  provider: WhatsAppProviderName;
  pairingCodeAvailable: boolean;
  pairingCode?: string;
  error?: {
    name?: string;
    message?: string;
    code?: unknown;
    statusCode?: unknown;
  };
}

export interface QrInfo {
  provider: WhatsAppProviderName;
  qrAvailable: boolean;
}

export interface CreateSessionOptions {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  qrOutput?: string;
  pairingPhoneNumber?: string;
  pairingCodeRequestDelayMs?: number;
  socketOptions?: Record<string, unknown>;
  onQr?: (info: QrInfo) => void | Promise<void>;
  onPairingCode?: (info: PairingCodeInfo) => void | Promise<void>;
  onPairingCodeError?: (info: PairingCodeInfo) => void | Promise<void>;
  onConnectionUpdate?: (connectionUpdate: unknown) => void | Promise<void>;
  onInboundMessage?: (inboundMessage: NormalizedInboundMessage) => void | Promise<void>;
}

export interface WhatsAppSessionHandle {
  provider: WhatsAppProviderName;
  /** Baileys WASocket (or equivalent); shape varies by provider version. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Baileys socket typing is incomplete across versions
  socket?: any;
  createdAt?: Date;
  close?: () => void | Promise<void>;
  [key: string]: unknown;
}

export interface DestroySessionResult {
  provider: WhatsAppProviderName;
  destroyed: boolean;
}

export interface SendTextMessageOptions {
  sessionHandle?: WhatsAppSessionHandle | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- alternate socket injection for tests/POC
  socket?: any;
  to?: string;
  recipientJid?: string;
  text?: string;
  message?: string;
}

export interface SendTextMessageResult {
  provider: WhatsAppProviderName;
  sent: boolean;
  recipientType: 'group' | 'direct';
  providerMessageId: string | null;
}

export interface NormalizeEventResult {
  provider: WhatsAppProviderName;
  normalized: boolean;
  eventType: string;
}

export interface ConnectionStatusResult {
  provider: WhatsAppProviderName;
  status: string;
}

export interface WhatsAppProvider {
  name: string;
  createSession: (sessionInput?: CreateSessionOptions) => Promise<WhatsAppSessionHandle>;
  destroySession: (sessionHandle?: WhatsAppSessionHandle | null) => Promise<DestroySessionResult>;
  sendTextMessage: (messageInput?: SendTextMessageOptions) => Promise<SendTextMessageResult>;
  normalizeEvent: (providerEvent?: { type?: string }) => NormalizeEventResult;
  getConnectionStatus: () => ConnectionStatusResult;
}

export const assertWhatsAppProvider = (provider: unknown): WhatsAppProvider => {
  if (!provider || typeof provider !== 'object') {
    throw new InvalidWhatsAppProviderError('Provider must be an object.');
  }

  const candidate = provider as Partial<WhatsAppProvider> & Record<string, unknown>;

  if (!candidate.name || typeof candidate.name !== 'string') {
    throw new InvalidWhatsAppProviderError('Provider must expose a name.');
  }

  const missingMethods = WHATSAPP_PROVIDER_METHODS.filter(
    (methodName) => typeof candidate[methodName] !== 'function',
  );

  if (missingMethods.length > 0) {
    throw new InvalidWhatsAppProviderError(
      `Provider is missing methods: ${missingMethods.join(', ')}`,
    );
  }

  return candidate as WhatsAppProvider;
};
