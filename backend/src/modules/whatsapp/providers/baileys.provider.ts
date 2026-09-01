import qrcodeTerminal from 'qrcode-terminal';

import { MESSAGE_TYPES, type MessageType } from '../../../constants/message-types.js';
import {
  createPipelineTrace,
  maskJid as maskTraceJid,
  PIPELINE_STAGE,
  preview as tracePreview,
  type PipelineTrace,
} from '../../../observability/pipeline-trace.js';
import { createEncryptedBaileysAuthState } from '../auth-state/baileys-auth-state.adapter.js';
import { WhatsAppProviderNotReadyError } from '../whatsapp.errors.js';
import {
  assertWhatsAppProvider,
  WHATSAPP_PROVIDER_NAMES,
  type CreateSessionOptions,
  type NormalizedInboundMessage,
  type SendTextMessageOptions,
  type WhatsAppSessionHandle,
} from './whatsapp-provider.interface.js';

export const BAILEYS_IMPORT_TARGET = '@whiskeysockets/baileys';

/** Minimal Baileys package surface used by this provider. Full package types are incomplete. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BaileysPackage = any;

/** Minimal WASocket surface used by this provider. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BaileysSocket = any;

/**
 * The handful of fields every Baileys media node carries that can be read straight off the
 * payload. Nothing here requires downloading the media itself - `fileLength` and `mimetype`
 * arrive with the notification, and `ptt` ("push to talk") is how WhatsApp marks a voice note
 * apart from an ordinary audio file.
 */
export interface BaileysMediaPayload {
  caption?: string;
  mimetype?: string;
  fileName?: string;
  /** Number, numeric string, or a protobuf Long depending on Baileys version - always coerced. */
  fileLength?: unknown;
  ptt?: boolean;
}

export interface BaileysInboundRawMessage {
  key?: {
    id?: string | null;
    remoteJid?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
  };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: BaileysMediaPayload;
    videoMessage?: BaileysMediaPayload;
    audioMessage?: BaileysMediaPayload;
    documentMessage?: BaileysMediaPayload;
    stickerMessage?: BaileysMediaPayload;
    contactMessage?: { displayName?: string };
    contactsArrayMessage?: { displayName?: string };
    locationMessage?: { degreesLatitude?: number; degreesLongitude?: number };
  } | null;
  pushName?: string | null;
  messageTimestamp?: unknown;
}

export interface BaileysMessageUpsert {
  messages?: BaileysInboundRawMessage[];
}

export interface BaileysConnectionUpdateEvent {
  qr?: string;
  connection?: string;
  lastDisconnect?: unknown;
}

export interface SafeCallOptions {
  // Callback arg types vary by event (QR / pairing / inbound); Baileys forces a wide type here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callback?: ((value: any) => unknown) | null;
  logger?: { error?: (...args: unknown[]) => void } | null;
  label: string;
  value?: unknown;
}

export interface RenderTerminalQrOptions {
  qr?: string;
  qrOutput?: string;
}

export interface ResolveLidPhoneJidOptions {
  socket?: BaileysSocket;
  jid?: string | null;
}

export interface RenderTerminalPairingCodeOptions {
  pairingCode?: string;
}

export interface CreateBaileysProviderOptions {
  loadPackage?: () => Promise<BaileysPackage>;
  createAuthState?: typeof createEncryptedBaileysAuthState;
  renderQr?: (options?: RenderTerminalQrOptions) => void;
  renderPairingCode?: (options?: RenderTerminalPairingCodeOptions) => void;
  logger?: { error?: (...args: unknown[]) => void };
}

export const loadBaileysPackage = (): Promise<BaileysPackage> => import(BAILEYS_IMPORT_TARGET);

const safeCall = async ({ callback, logger, label, value }: SafeCallOptions) => {
  if (typeof callback !== 'function') {
    return;
  }

  try {
    await callback(value);
  } catch (error: unknown) {
    const err = error as { code?: unknown; name?: unknown; message?: unknown };
    logger?.error?.(`${label} failed safely.`, {
      code: err?.code,
      name: err?.name,
      message: err?.message,
    });
  }
};

const resolveMakeWASocket = (baileysPackage: BaileysPackage) =>
  baileysPackage.makeWASocket ?? baileysPackage.default;

export const renderTerminalQr = ({ qr, qrOutput = 'terminal' }: RenderTerminalQrOptions = {}) => {
  if (!qr || qrOutput !== 'terminal') {
    return;
  }

  console.log('Phase 5 WhatsApp QR is ready. Scan only with POC-WhatsApp-01.');
  console.log('Do not copy, screenshot, paste or store this QR.');
  qrcodeTerminal.generate(qr, {
    small: true,
  });
};

export const createSafeBaileysLogger = () => {
  const noop = () => {};
  const safeLogger: {
    trace: () => void;
    debug: () => void;
    info: () => void;
    warn: () => void;
    error: () => void;
    fatal: () => void;
    child: () => typeof safeLogger;
  } = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => safeLogger,
  };

  return safeLogger;
};

export const sanitizePairingPhoneNumber = (phoneNumber: unknown): string => {
  const normalizedPhoneNumber = String(phoneNumber ?? '')
    .trim()
    .replace(/^\+/, '')
    .replace(/[\s()-]/g, '');

  if (!/^\d{8,15}$/.test(normalizedPhoneNumber)) {
    throw new WhatsAppProviderNotReadyError(
      'Pairing phone number must include country code and digits only.',
    );
  }

  return normalizedPhoneNumber;
};

export const resolveDirectMessageJid = (to: unknown): string => {
  const recipient = String(to ?? '').trim();

  if (!recipient) {
    throw new WhatsAppProviderNotReadyError('Baileys message recipient is required.');
  }

  if (recipient.includes('@')) {
    return recipient;
  }

  return `${sanitizePairingPhoneNumber(recipient)}@s.whatsapp.net`;
};

export const maskBaileysJid = (jid = ''): string => {
  if (!jid || typeof jid !== 'string') {
    return 'unknown';
  }

  const [left, domain = 'unknown'] = jid.split('@');
  const visibleStart = left.slice(0, 3);
  const visibleEnd = left.slice(-3);

  return `${visibleStart}***${visibleEnd}@${domain}`;
};

export const extractBaileysText = (message: BaileysInboundRawMessage = {}): string =>
  message?.message?.conversation ||
  message?.message?.extendedTextMessage?.text ||
  message?.message?.imageMessage?.caption ||
  message?.message?.videoMessage?.caption ||
  message?.message?.documentMessage?.caption ||
  '';

/** Metadata about an inbound media message that is readable without downloading anything. */
export interface BaileysInboundMedia {
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  /** True only for an `audioMessage` WhatsApp marked as push-to-talk, i.e. a recorded voice note. */
  isVoiceNote: boolean;
}

/**
 * Which media node a raw Baileys payload carries, paired with the MESSAGE_TYPES value it maps
 * onto. Order matters only in that the first match wins; a real payload carries exactly one.
 */
const BAILEYS_MEDIA_KINDS = Object.freeze([
  ['imageMessage', MESSAGE_TYPES.IMAGE],
  ['videoMessage', MESSAGE_TYPES.VIDEO],
  ['audioMessage', MESSAGE_TYPES.AUDIO],
  ['documentMessage', MESSAGE_TYPES.DOCUMENT],
  ['stickerMessage', MESSAGE_TYPES.STICKER],
  ['contactMessage', MESSAGE_TYPES.CONTACT],
  ['contactsArrayMessage', MESSAGE_TYPES.CONTACT],
  ['locationMessage', MESSAGE_TYPES.LOCATION],
] as const);

/**
 * The MESSAGE_TYPES value for a raw inbound payload.
 *
 * Anything not recognised as one of the media kinds above falls back to TEXT, which is exactly
 * what this provider produced for every message before media existed. That is deliberate rather
 * than mapping the unknown remainder to UNSUPPORTED: WhatsApp delivers a steady trickle of
 * protocol/reaction/edit nodes with no text in them, and downstream (ai-brain.service.ts) a
 * non-TEXT message with no text is an owner escalation. Calling those UNSUPPORTED would page the
 * owner about invisible plumbing.
 */
export const resolveBaileysMessageType = (
  message: BaileysInboundRawMessage = {},
): MessageType => {
  const payload = message?.message;

  if (!payload) {
    return MESSAGE_TYPES.TEXT;
  }

  for (const [key, messageType] of BAILEYS_MEDIA_KINDS) {
    if (payload[key]) {
      return messageType;
    }
  }

  return MESSAGE_TYPES.TEXT;
};

/** Baileys hands `fileLength` back as a number, a numeric string or a protobuf Long. */
const toSizeBytes = (fileLength: unknown): number | null => {
  if (fileLength === null || fileLength === undefined) {
    return null;
  }

  const size = Number(
    typeof fileLength === 'object' ? (fileLength as { toString?: () => string }).toString?.() : fileLength,
  );

  return Number.isFinite(size) && size >= 0 ? size : null;
};

const nonEmptyString = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';

  return text === '' ? null : text;
};

/**
 * Mimetype / filename / size / voice-note flag for an inbound media message, or null when the
 * message carries no media node (plain text) or a node with nothing to read off it (a contact
 * card, a location pin). NOTHING is downloaded here - this provider stays pure and stateless,
 * and fetching the bytes is a separate piece of work.
 */
export const extractBaileysMedia = (
  message: BaileysInboundRawMessage = {},
): BaileysInboundMedia | null => {
  const payload = message?.message;

  if (!payload) {
    return null;
  }

  const mediaPayload =
    payload.imageMessage ??
    payload.videoMessage ??
    payload.audioMessage ??
    payload.documentMessage ??
    payload.stickerMessage;

  if (!mediaPayload) {
    return null;
  }

  return {
    mimeType: nonEmptyString(mediaPayload.mimetype),
    fileName: nonEmptyString(mediaPayload.fileName),
    sizeBytes: toSizeBytes(mediaPayload.fileLength),
    isVoiceNote: Boolean(payload.audioMessage) && mediaPayload.ptt === true,
  };
};

/**
 * True for any JID that is not a 1:1 human conversation. None of these can ever be a lead, and
 * all of them would otherwise land in the dashboard as noise:
 *
 *   @g.us        group chats
 *   @newsletter  WhatsApp Channels the connected number follows (job alerts, news feeds)
 *   @broadcast   status updates and broadcast-list traffic
 */
const NON_CONVERSATIONAL_JID_RULES = Object.freeze([
  ['@g.us', 'group chat (@g.us) - a group is never a lead'],
  ['@newsletter', 'WhatsApp Channel (@newsletter) - a channel is never a lead'],
  ['@broadcast', 'broadcast or status list (@broadcast) - never a lead'],
] as const);

/** Which of the rules above a JID trips, in words, or null for an ordinary 1:1 chat. */
export const describeNonConversationalJid = (jid: unknown): string | null => {
  const value = typeof jid === 'string' ? jid.trim().toLowerCase() : '';

  return NON_CONVERSATIONAL_JID_RULES.find(([suffix]) => value.endsWith(suffix))?.[1] ?? null;
};

export const isNonConversationalJid = (jid: unknown): boolean =>
  describeNonConversationalJid(jid) !== null;

/**
 * WHY the gateway filter would drop this message, in the owner's words, or null when it lets the
 * message through. `shouldIgnoreBaileysInboundMessage` is this function's boolean, so the reason
 * printed in a trace can never disagree with the decision actually taken.
 *
 * These four drops used to be entirely invisible: a message hitting one of them produced no log
 * line anywhere, which is indistinguishable from WhatsApp never delivering it.
 */
export const describeBaileysGatewayDrop = (
  message: BaileysInboundRawMessage = {},
): string | null => {
  const remoteJid = message?.key?.remoteJid;

  if (!message?.message) {
    return 'no message payload on the event (a receipt, reaction or protocol node, not a message)';
  }

  if (!remoteJid) {
    return 'no remoteJid on the event, so there is no chat to attach it to';
  }

  return describeNonConversationalJid(remoteJid);
};

export const shouldIgnoreBaileysInboundMessage = (
  message: BaileysInboundRawMessage = {},
): boolean =>
  // `fromMe` is intentionally NOT an ignore condition here: it must flow through so the
  // ingestion layer can tell an echo of our own send apart from the owner manually typing a
  // reply from their own phone (see automation/inbound-router.service.ts).
  describeBaileysGatewayDrop(message) !== null;

/** The payload node WhatsApp actually sent, for the "a raw message arrived" trace line. */
const rawPayloadKind = (message: BaileysInboundRawMessage = {}): string => {
  const payload = message?.message;

  if (!payload) {
    return '(none)';
  }

  return Object.keys(payload)[0] ?? '(empty)';
};

export const isLidJid = (jid: unknown): jid is string =>
  typeof jid === 'string' && jid.trim().endsWith('@lid');

/**
 * True when `remoteJid` is the linked account's own "message yourself" chat - Baileys
 * represents that as an inbound/outbound message whose remoteJid bare-number matches the
 * socket's own JID. Both sides are normalized by dropping the `:<device>` suffix Baileys
 * appends to some JIDs before comparing the phone-number portion.
 */
export const isSelfChatJid = (remoteJid: unknown, ownJid: unknown): boolean => {
  if (typeof remoteJid !== 'string' || typeof ownJid !== 'string') {
    return false;
  }

  const bareNumber = (jid: string): string => jid.split('@')[0]?.split(':')[0]?.toLowerCase() ?? '';

  const remoteNumber = bareNumber(remoteJid);
  const ownNumber = bareNumber(ownJid);

  return remoteNumber !== '' && remoteNumber === ownNumber;
};

/**
 * Resolves a `@lid` sender to its phone-number JID using the session's LID mapping store.
 *
 * WhatsApp increasingly delivers direct messages from an opaque LinkedID (`<id>@lid`) rather
 * than `<phone>@s.whatsapp.net`, so the phone cannot be parsed out of the JID. Baileys keeps a
 * reverse mapping in the `lid-mapping` keystore (Mongo-backed here through the auth-state
 * adapter). Returns null for non-LID input or when the mapping is not known yet — callers must
 * treat a missing phone as normal, not an error.
 */
export const resolveLidPhoneJid = async ({ socket, jid }: ResolveLidPhoneJidOptions = {}): Promise<
  string | null
> => {
  if (!isLidJid(jid)) {
    return null;
  }

  const lidMapping = socket?.signalRepository?.lidMapping;

  if (typeof lidMapping?.getPNForLID !== 'function') {
    return null;
  }

  try {
    return (await lidMapping.getPNForLID(jid)) ?? null;
  } catch {
    // A missing or unreadable mapping must never drop the inbound message.
    return null;
  }
};

export const normalizeBaileysInboundMessage = (
  message: BaileysInboundRawMessage = {},
  {
    ownJid,
    // Stages 1-3 of the pipeline trace. Created here rather than passed in from the socket
    // handler because this is the only place that sees a message the gateway filter is about to
    // drop - beyond this function that message no longer exists. Seeded with the WhatsApp
    // message id so every later stage, in every other file, derives the same correlation id.
    trace = createPipelineTrace({ seed: message?.key?.id }),
  }: { ownJid?: string | null; trace?: PipelineTrace } = {},
): NormalizedInboundMessage | null => {
  trace.pass(PIPELINE_STAGE.PROVIDER_RECEIVED, () => ({
    from: maskTraceJid(message?.key?.participant || message?.key?.remoteJid),
    chat: maskTraceJid(message?.key?.remoteJid),
    node: rawPayloadKind(message),
  }));

  const gatewayDropReason = describeBaileysGatewayDrop(message);

  if (gatewayDropReason !== null) {
    trace.stop(PIPELINE_STAGE.PROVIDER_GATEWAY, gatewayDropReason, () => ({
      chat: maskTraceJid(message?.key?.remoteJid),
    }));

    return null;
  }

  const remoteJid = message.key?.remoteJid;

  if (!remoteJid) {
    // Unreachable while describeBaileysGatewayDrop covers a missing remoteJid; kept as a type
    // narrowing guard, and traced anyway so it can never become a silent drop.
    trace.stop(PIPELINE_STAGE.PROVIDER_GATEWAY, 'no remoteJid on the event');

    return null;
  }

  trace.pass(PIPELINE_STAGE.PROVIDER_GATEWAY, () => ({ verdict: 'not a group, channel or broadcast' }));

  const text = extractBaileysText(message);
  const media = extractBaileysMedia(message);
  const messageType = resolveBaileysMessageType(message);

  trace.pass(PIPELINE_STAGE.PROVIDER_NORMALIZED, () => ({
    fromMe: Boolean(message.key?.fromMe),
    isSelfChat: isSelfChatJid(remoteJid, ownJid),
    type: messageType,
    media: media ? (media.isVoiceNote ? 'voice-note' : (media.mimeType ?? 'yes')) : 'none',
    body: tracePreview(text),
  }));

  return {
    provider: WHATSAPP_PROVIDER_NAMES.BAILEYS,
    normalized: true,
    eventType: 'message.received',
    messageId: message.key?.id ?? null,
    remoteJid,
    // Use participant only when it is a non-empty value; newer WhatsApp/LID direct
    // messages set `participant` to '' which must fall back to remoteJid (|| not ??).
    senderJid: message.key?.participant || remoteJid,
    pushName: message.pushName ?? null,
    text,
    messageType,
    media,
    timestamp: message.messageTimestamp ?? null,
    fromMe: Boolean(message.key?.fromMe),
    isSelfChat: isSelfChatJid(remoteJid, ownJid),
    safe: {
      from: maskBaileysJid(remoteJid),
      textPreview: text.slice(0, 80),
    },
  };
};

export const renderTerminalPairingCode = ({
  pairingCode,
}: RenderTerminalPairingCodeOptions = {}) => {
  if (!pairingCode) {
    return;
  }

  console.log('Phase 5 WhatsApp pairing code is ready.');
  console.log('Enter this code only on POC-WhatsApp-01.');
  console.log('Do not copy, screenshot, paste or store this pairing code.');
  console.log(`Pairing code: ${pairingCode}`);
};

const summarizePairingCodeError = (error: unknown) => {
  const err = error as {
    name?: string;
    message?: string;
    code?: unknown;
    output?: { statusCode?: unknown };
  };

  return {
    name: err?.name,
    message: err?.message,
    code: err?.code,
    statusCode: err?.output?.statusCode,
  };
};

export const createBaileysProvider = ({
  loadPackage = loadBaileysPackage,
  createAuthState = createEncryptedBaileysAuthState,
  renderQr = renderTerminalQr,
  renderPairingCode = renderTerminalPairingCode,
  logger = console,
}: CreateBaileysProviderOptions = {}) =>
  assertWhatsAppProvider({
    name: WHATSAPP_PROVIDER_NAMES.BAILEYS,

    async createSession(sessionInput: CreateSessionOptions = {}) {
      const baileysPackage = await loadPackage();
      const makeWASocket = resolveMakeWASocket(baileysPackage);

      if (typeof makeWASocket !== 'function') {
        throw new WhatsAppProviderNotReadyError('Baileys makeWASocket export is unavailable.');
      }

      const authState = await createAuthState({
        organizationId: sessionInput.organizationId,
        whatsappAccountId: sessionInput.whatsappAccountId,
        initAuthCreds: baileysPackage.initAuthCreds,
        proto: baileysPackage.proto,
      });

      const socket: BaileysSocket = makeWASocket({
        auth: authState.state,
        browser: ['WAM CRM AI', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false,
        logger: createSafeBaileysLogger(),
        syncFullHistory: false,
        ...(sessionInput.socketOptions ?? {}),
      });

      socket.ev.on('creds.update', authState.saveCreds);

      let pairingCodeRequested = false;

      const requestPairingCodeSafely = async () => {
        if (!sessionInput.pairingPhoneNumber || pairingCodeRequested) {
          return;
        }

        pairingCodeRequested = true;

        if (typeof socket.requestPairingCode !== 'function') {
          const errorSummary = {
            name: 'WhatsAppProviderNotReadyError',
            message: 'Baileys requestPairingCode export is unavailable.',
            code: 'PAIRING_CODE_UNAVAILABLE',
            statusCode: undefined,
          };

          await safeCall({
            callback: sessionInput.onPairingCodeError,
            logger,
            label: 'Baileys pairing-code unavailable callback',
            value: {
              provider: WHATSAPP_PROVIDER_NAMES.BAILEYS,
              pairingCodeAvailable: false,
              error: errorSummary,
            },
          });

          return;
        }

        // WhatsApp rejects a pairing-code request (HTTP 428, "Connection Closed") if it is
        // issued before the socket has actually established its link. Wait a moment first.
        const delayMs = Number(sessionInput.pairingCodeRequestDelayMs ?? 0);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        try {
          const pairingCode = await socket.requestPairingCode(
            sanitizePairingPhoneNumber(sessionInput.pairingPhoneNumber),
          );

          renderPairingCode({
            pairingCode,
          });

          await safeCall({
            callback: sessionInput.onPairingCode,
            logger,
            label: 'Baileys pairing-code callback',
            value: {
              provider: WHATSAPP_PROVIDER_NAMES.BAILEYS,
              pairingCodeAvailable: true,
              pairingCode,
            },
          });
        } catch (error: unknown) {
          const errorSummary = summarizePairingCodeError(error);

          logger?.error?.('Baileys pairing-code request failed safely.', errorSummary);

          await safeCall({
            callback: sessionInput.onPairingCodeError,
            logger,
            label: 'Baileys pairing-code error callback',
            value: {
              provider: WHATSAPP_PROVIDER_NAMES.BAILEYS,
              pairingCodeAvailable: false,
              error: errorSummary,
            },
          });
        }
      };

      socket.ev.on('connection.update', (connectionUpdate: BaileysConnectionUpdateEvent) => {
        if (connectionUpdate.qr && !sessionInput.pairingPhoneNumber) {
          renderQr({
            qr: connectionUpdate.qr,
            qrOutput: sessionInput.qrOutput,
          });

          void safeCall({
            callback: sessionInput.onQr,
            logger,
            label: 'Baileys QR callback',
            value: {
              provider: WHATSAPP_PROVIDER_NAMES.BAILEYS,
              qrAvailable: true,
            },
          });
        }

        void safeCall({
          callback: sessionInput.onConnectionUpdate,
          logger,
          label: 'Baileys connection update callback',
          value: connectionUpdate,
        });

        // A QR event means WhatsApp is ready to link — the right moment to request a pairing
        // code (adapts to the connection speed, unlike firing on the early "connecting" event).
        if (connectionUpdate.qr) {
          void requestPairingCodeSafely();
        }
      });

      socket.ev.on('messages.upsert', async (messageUpdate: BaileysMessageUpsert = {}) => {
        const ownJid: string | null = socket.user?.id ?? null;
        const inboundMessages = (messageUpdate.messages ?? [])
          .map((message) => normalizeBaileysInboundMessage(message, { ownJid }))
          .filter((message): message is NormalizedInboundMessage => Boolean(message));

        for (const inboundMessage of inboundMessages) {
          // `@lid` senders carry no phone in the JID. Resolve it here, where the socket (and so
          // the LID mapping store) is in scope, and hand it to ingestion as a separate field.
          const senderPhoneJid = await resolveLidPhoneJid({
            socket,
            jid: inboundMessage.senderJid,
          });

          await safeCall({
            callback: sessionInput.onInboundMessage,
            logger,
            label: 'Baileys inbound message callback',
            value: senderPhoneJid ? { ...inboundMessage, senderPhoneJid } : inboundMessage,
          });
        }
      });

      return {
        provider: WHATSAPP_PROVIDER_NAMES.BAILEYS,
        socket,
        createdAt: new Date(),
        async close() {
          socket.end?.();
          socket.ws?.close?.();
        },
      };
    },

    async destroySession(sessionHandle?: WhatsAppSessionHandle | null) {
      await sessionHandle?.close?.();

      return {
        provider: WHATSAPP_PROVIDER_NAMES.BAILEYS,
        destroyed: true,
      };
    },

    async sendTextMessage(messageInput: SendTextMessageOptions = {}) {
      const socket = messageInput.sessionHandle?.socket ?? messageInput.socket;

      if (!socket || typeof socket.sendMessage !== 'function') {
        throw new WhatsAppProviderNotReadyError('Baileys socket is not ready for sending.');
      }

      const text = String(messageInput.text ?? messageInput.message ?? '').trim();

      if (!text) {
        throw new WhatsAppProviderNotReadyError('Baileys text message is required.');
      }

      const recipientJid = resolveDirectMessageJid(messageInput.to ?? messageInput.recipientJid);
      const sendResult = await socket.sendMessage(recipientJid, {
        text,
      });

      return {
        provider: WHATSAPP_PROVIDER_NAMES.BAILEYS,
        sent: true,
        recipientType: recipientJid.endsWith('@g.us') ? 'group' : 'direct',
        providerMessageId: sendResult?.key?.id ?? null,
      };
    },

    normalizeEvent(providerEvent: { type?: string } = {}) {
      return {
        provider: WHATSAPP_PROVIDER_NAMES.BAILEYS,
        normalized: false,
        eventType: providerEvent.type ?? 'unknown',
      };
    },

    getConnectionStatus() {
      return {
        provider: WHATSAPP_PROVIDER_NAMES.BAILEYS,
        status: 'not_started',
      };
    },
  });
