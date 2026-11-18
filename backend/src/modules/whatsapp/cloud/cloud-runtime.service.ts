/**
 * What stands in for a session on a Cloud API account.
 *
 * A Baileys account has a socket: it is opened, it lives in the session manager's map, it can drop
 * and reconnect, and sending means writing to it. A Cloud account has none of that. It has a phone
 * number id and a token, and every send is an independent HTTPS call. There is nothing to keep
 * alive, nothing to restore after a restart, and nothing that can be "not running" except an
 * account somebody disconnected.
 *
 * So Cloud accounts are kept OUT of the session manager entirely rather than bent to fit it. The
 * manager stays exactly as Baileys-shaped as it was - QR strings, reconnect timers, logout
 * handling - and this module supplies the one thing the rest of the CRM actually wanted from it:
 * something with `sendTextMessage` and `sendMediaMessage` on it.
 *
 * NO CREDENTIAL CACHE, deliberately. Every send re-reads and re-decrypts. At the outbound rate
 * this CRM runs (single-digit messages per minute, per account) the round trip is free, and the
 * alternative is a cache that has to be invalidated when a token is rotated or an account is
 * disconnected. A cache miss costs a few milliseconds; a stale cache entry keeps sending from a
 * number the owner believes they switched off.
 */
import { ACCOUNT_STATUSES } from '../../../constants/account-statuses.js';
import { WHATSAPP_PROVIDER_KINDS } from '../../../constants/whatsapp-providers.js';
import { type ObjectIdLike } from '../../../types/common.js';
import {
  findAccountById as defaultFindAccountById,
  findCloudAccountsByStatus as defaultFindCloudAccountsByStatus,
} from '../../whatsapp-accounts/whatsapp-account.repository.js';
import { type WhatsAppAccountDocument } from '../../whatsapp-accounts/whatsapp-account.model.js';
import {
  type OutboundMediaKind,
  type SendMediaMessageOptions,
  type SendTextMessageResult,
} from '../providers/whatsapp-provider.interface.js';
import { decryptCloudAccessTokenFromStorage } from './cloud-credentials.service.js';
import { CLOUD_FAILURE_KINDS, WhatsAppCloudError } from './cloud.errors.js';
import {
  sendCloudMedia as defaultSendCloudMedia,
  sendCloudTemplate as defaultSendCloudTemplate,
  sendCloudText as defaultSendCloudText,
  uploadCloudMedia as defaultUploadCloudMedia,
  type CloudTemplateComponent,
} from './whatsapp-cloud.client.js';

/** Everything a send needs, resolved from one account document. */
export interface ResolvedCloudCredentials {
  accountId: string;
  organizationId: string;
  phoneNumberId: string;
  wabaId: string | null;
  accessToken: string;
}

export interface CloudRuntimeDeps {
  findAccount?: typeof defaultFindAccountById;
  findCloudAccounts?: typeof defaultFindCloudAccountsByStatus;
  sendText?: typeof defaultSendCloudText;
  sendTemplate?: typeof defaultSendCloudTemplate;
  sendMedia?: typeof defaultSendCloudMedia;
  uploadMedia?: typeof defaultUploadCloudMedia;
  decryptToken?: typeof decryptCloudAccessTokenFromStorage;
}

const asResult = (
  providerMessageId: string | null,
  recipientType: 'group' | 'direct' = 'direct',
): SendTextMessageResult => ({
  provider: WHATSAPP_PROVIDER_KINDS.CLOUD,
  sent: true,
  recipientType,
  providerMessageId,
});

export const createCloudRuntime = ({
  findAccount = defaultFindAccountById,
  findCloudAccounts = defaultFindCloudAccountsByStatus,
  sendText = defaultSendCloudText,
  sendTemplate = defaultSendCloudTemplate,
  sendMedia = defaultSendCloudMedia,
  uploadMedia = defaultUploadCloudMedia,
  decryptToken = decryptCloudAccessTokenFromStorage,
}: CloudRuntimeDeps = {}) => {
  /**
   * Turns an account id into credentials, or explains why it cannot.
   *
   * Every refusal here is NEEDS_ATTENTION rather than transient: none of them resolve by waiting,
   * and all of them are fixed by a human opening the account and finishing the connection. That
   * classification is what stops the delivery queue walking a backoff ladder to the same answer.
   */
  const resolveCredentials = async ({
    accountId,
    organizationId,
  }: {
    accountId?: ObjectIdLike;
    organizationId?: ObjectIdLike;
  }): Promise<ResolvedCloudCredentials> => {
    const account = (await findAccount({
      accountId,
      organizationId,
      includeEncrypted: true,
    })) as WhatsAppAccountDocument | null;

    if (!account) {
      throw new WhatsAppCloudError('That WhatsApp number no longer exists.', {
        code: 'WHATSAPP_CLOUD_ACCOUNT_NOT_FOUND',
        failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
      });
    }

    if (account.provider !== WHATSAPP_PROVIDER_KINDS.CLOUD) {
      throw new WhatsAppCloudError('That number is not connected through the WhatsApp Cloud API.', {
        code: 'WHATSAPP_CLOUD_WRONG_PROVIDER',
        failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
      });
    }

    // Checked before the credentials rather than after: a paused number has working credentials,
    // and "paused" is an instruction, not a fault.
    if (account.status !== ACCOUNT_STATUSES.ACTIVE) {
      throw new WhatsAppCloudError(
        `This number is ${String(account.status)}, so it cannot send right now.`,
        {
          code: 'WHATSAPP_CLOUD_ACCOUNT_NOT_ACTIVE',
          failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
        },
      );
    }

    const phoneNumberId = account.cloud?.phoneNumberId ?? null;

    if (!phoneNumberId) {
      throw new WhatsAppCloudError('This number has no WhatsApp Cloud API phone number id yet.', {
        code: 'WHATSAPP_CLOUD_NOT_CONFIGURED',
        failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
      });
    }

    const accessToken = decryptToken(account.encryptedCloudToken);

    if (!accessToken) {
      throw new WhatsAppCloudError('This number has no stored WhatsApp access token.', {
        code: 'WHATSAPP_CLOUD_TOKEN_MISSING',
        failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
      });
    }

    return {
      accountId: account._id.toString(),
      organizationId: account.organizationId.toString(),
      phoneNumberId,
      wabaId: account.cloud?.wabaId ?? null,
      accessToken,
    };
  };

  const sendTextMessage = async ({
    accountId,
    organizationId,
    to,
    text,
  }: {
    accountId?: ObjectIdLike;
    organizationId?: ObjectIdLike;
    to?: string;
    text?: string | null;
  }): Promise<SendTextMessageResult> => {
    const credentials = await resolveCredentials({ accountId, organizationId });

    const { providerMessageId } = await sendText({
      phoneNumberId: credentials.phoneNumberId,
      accessToken: credentials.accessToken,
      to: to ?? '',
      text: text ?? '',
    });

    return asResult(providerMessageId);
  };

  /**
   * Sends an approved template.
   *
   * The ONLY way to reach a customer outside the 24-hour window, and the only send in the system
   * whose wording the agent did not write - Meta holds the approved text and we supply the
   * placeholder values. That is also why nothing in this codebase ever silently converts a
   * free-form message into a template: the customer would receive words nobody chose.
   */
  const sendTemplateMessage = async ({
    accountId,
    organizationId,
    to,
    templateName,
    languageCode,
    components = [],
  }: {
    accountId?: ObjectIdLike;
    organizationId?: ObjectIdLike;
    to?: string;
    templateName: string;
    languageCode: string;
    components?: CloudTemplateComponent[];
  }): Promise<SendTextMessageResult> => {
    const credentials = await resolveCredentials({ accountId, organizationId });

    const { providerMessageId } = await sendTemplate({
      phoneNumberId: credentials.phoneNumberId,
      accessToken: credentials.accessToken,
      to: to ?? '',
      templateName,
      languageCode,
      components,
    });

    return asResult(providerMessageId);
  };

  /**
   * Two calls, not one: Cloud API will not take raw bytes on a message, so the file is uploaded
   * for a media id and the id is then sent. A failure between the two leaves an orphaned upload on
   * Meta's side, which expires by itself in 30 days and is not worth cleaning up.
   */
  const sendMediaMessage = async ({
    accountId,
    organizationId,
    to,
    kind,
    data,
    mimeType,
    fileName = null,
    caption = null,
  }: {
    accountId?: ObjectIdLike;
    organizationId?: ObjectIdLike;
    to?: string;
    kind: OutboundMediaKind;
    data: Buffer;
    mimeType: string;
    fileName?: string | null;
    caption?: string | null;
  }): Promise<SendTextMessageResult> => {
    const credentials = await resolveCredentials({ accountId, organizationId });

    const mediaId = await uploadMedia({
      phoneNumberId: credentials.phoneNumberId,
      accessToken: credentials.accessToken,
      data,
      mimeType,
      fileName,
    });

    const { providerMessageId } = await sendMedia({
      phoneNumberId: credentials.phoneNumberId,
      accessToken: credentials.accessToken,
      to: to ?? '',
      kind,
      mediaId,
      caption,
      fileName,
    });

    return asResult(providerMessageId);
  };

  /**
   * The accounts the delivery runner should drain, in the shape it already uses for Baileys.
   *
   * Returns ids rather than documents so the runner cannot accidentally reach for a credential it
   * has no business holding.
   */
  const listSendableAccounts = async (): Promise<
    Array<{ accountId: string; organizationId: string }>
  > => {
    const accounts = await findCloudAccounts({ status: ACCOUNT_STATUSES.ACTIVE });

    return accounts.map((account) => ({
      accountId: account._id.toString(),
      organizationId: account.organizationId.toString(),
    }));
  };

  return {
    resolveCredentials,
    sendTextMessage,
    sendTemplateMessage,
    sendMediaMessage,
    listSendableAccounts,
  };
};

export type CloudRuntime = ReturnType<typeof createCloudRuntime>;

let sharedRuntime: CloudRuntime | null = null;

/** One runtime per process. Stateless, so sharing it costs nothing and saves wiring. */
export const getCloudRuntime = (): CloudRuntime => {
  sharedRuntime ??= createCloudRuntime();

  return sharedRuntime;
};

/** Tests only: drops the shared instance so injected doubles are not leaked between cases. */
export const resetCloudRuntime = (): void => {
  sharedRuntime = null;
};

/**
 * A `SendMediaMessageOptions`-compatible façade bound to one account, which is exactly the shape
 * `createOutboundDeliveryService` expects for its `sessionService`. Having it here means the
 * delivery runner treats a Cloud account and a Baileys account identically.
 */
export const createCloudDeliverySession = ({
  accountId,
  organizationId,
  runtime = getCloudRuntime(),
}: {
  accountId: ObjectIdLike;
  organizationId: ObjectIdLike;
  runtime?: CloudRuntime;
}) => ({
  providerKind: 'cloud' as const,
  sendTextMessage: ({ to, text }: { to: string; text?: string | null }) =>
    runtime.sendTextMessage({ accountId, organizationId, to, text }),
  sendMediaMessage: (options: Omit<SendMediaMessageOptions, 'sessionHandle' | 'socket'>) =>
    runtime.sendMediaMessage({
      accountId,
      organizationId,
      to: options.to ?? options.recipientJid ?? '',
      kind: options.kind,
      data: options.data,
      mimeType: options.mimeType,
      fileName: options.fileName ?? null,
      caption: options.caption ?? null,
    }),
  sendTemplateMessage: ({
    to,
    name,
    language,
    bodyParameters,
    headerParameters,
  }: {
    to: string;
    name: string;
    language: string;
    bodyParameters: string[];
    headerParameters: string[];
  }) =>
    runtime.sendTemplateMessage({
      accountId,
      organizationId,
      to,
      templateName: name,
      languageCode: language,
      components: buildTemplateComponents({ bodyParameters, headerParameters }),
    }),
});

/**
 * Turns stored placeholder values into Meta's component wire shape.
 *
 * A component with no parameters is OMITTED rather than sent empty: Meta rejects an empty
 * `parameters` array on a component that declares none, with a 132-series error that names the
 * template rather than the empty array, and that is a bad hour to spend.
 */
export const buildTemplateComponents = ({
  bodyParameters = [],
  headerParameters = [],
}: {
  bodyParameters?: string[];
  headerParameters?: string[];
}): CloudTemplateComponent[] => {
  const components: CloudTemplateComponent[] = [];

  if (headerParameters.length > 0) {
    components.push({
      type: 'header',
      parameters: headerParameters.map((text) => ({ type: 'text', text })),
    });
  }

  if (bodyParameters.length > 0) {
    components.push({
      type: 'body',
      parameters: bodyParameters.map((text) => ({ type: 'text', text })),
    });
  }

  return components;
};
