/**
 * The only file in the CRM that knows the shape of Meta's WhatsApp Cloud API.
 *
 * Same contract as lead-sources/meta-graph.client.ts next door, and for the same reasons: pure
 * functions, `fetch` injected so no test ever touches the network, every request on a timeout,
 * and every failure converted into one of the module's own typed errors before it leaves.
 *
 * It is a SEPARATE client from meta-graph.client.ts rather than an extension of it, because the
 * two have almost nothing in common at the wire level. The lead client is GET-only with the token
 * in the query string (forced on it by Meta's paging URLs); this one POSTs JSON and multipart with
 * a Bearer header, and WhatsApp's error codes are a different numbering scheme entirely - a 131047
 * means nothing to the lead importer and a 190 means something different here.
 */
import { Buffer } from 'node:buffer';

import {
  CLOUD_FAILURE_KINDS,
  CLOUD_WINDOW_CLOSED_CODE,
  WhatsAppCloudError,
  type CloudFailureKind,
} from './cloud.errors.js';

/**
 * The pinned Graph API version, matched to lead-sources/meta-graph.client.ts on purpose: both
 * speak to the same Meta app, and two versions drifting apart is a debugging tax nobody budgets
 * for. Meta supports a version for roughly two years and then starts rejecting calls to it, so
 * this is a constant to bump deliberately rather than a floating "latest".
 */
export const CLOUD_API_VERSION = 'v25.0';

export const CLOUD_API_BASE_URL = 'https://graph.facebook.com';

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Meta's hard ceiling for a text message body. Longer bodies are rejected outright rather than
 * truncated, so the provider checks before spending a round trip.
 */
export const CLOUD_MAX_TEXT_LENGTH = 4096;

interface CloudErrorEnvelope {
  error?: {
    code?: number;
    error_subcode?: number;
    type?: string;
    message?: string;
    error_data?: { details?: string };
  };
}

/**
 * Meta's WhatsApp error taxonomy, collapsed to the four reactions the CRM actually has.
 *
 * The codes are WhatsApp's own, NOT the Graph codes the lead importer classifies. The ones worth
 * naming individually:
 *
 *   131047  Re-engagement required. The 24-hour customer service window has closed and only an
 *           approved template may be sent. This is THE error this integration exists around, and
 *           it must never be retried: the window does not reopen because we asked twice.
 *   131026  Undeliverable. The number is not on WhatsApp, or cannot receive this message type.
 *   131021  Sender and recipient are the same number.
 *   131051  Unsupported message type.
 *   132xxx  Template problems: not found, not approved, wrong parameter count, wrong language.
 *           Permanent, because a template is not going to approve itself between attempts.
 *   133xxx  The number is not registered, or registration was deleted - a setup problem.
 *   130429  Throughput limit. 131048 is the spam-rate limit, 80007 the business-tier cap.
 *   190/102 The token is dead. No retry revives it; somebody must paste a new one.
 *   131031  The business account was restricted or disabled by Meta.
 */
const classifyCloudError = ({
  metaCode,
  httpStatus,
}: {
  metaCode: number | null;
  httpStatus: number | null;
}): { failureKind: CloudFailureKind; code: string; message: string } => {
  if (metaCode === 131_047) {
    return {
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
      code: CLOUD_WINDOW_CLOSED_CODE,
      message:
        'This customer last messaged more than 24 hours ago, so WhatsApp will only accept an approved template. Pick a template to reopen the conversation.',
    };
  }

  if (metaCode === 190 || metaCode === 102 || metaCode === 463 || metaCode === 467) {
    return {
      failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
      code: 'WHATSAPP_CLOUD_TOKEN_EXPIRED',
      message:
        'The WhatsApp access token has expired or was revoked. Paste a new token on this number to start sending again.',
    };
  }

  if (metaCode === 131_026 || metaCode === 131_021 || metaCode === 131_051) {
    return {
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
      code: 'WHATSAPP_CLOUD_UNDELIVERABLE',
      message:
        'WhatsApp could not deliver this message. The number may not be on WhatsApp, or it cannot receive this kind of message.',
    };
  }

  if (metaCode !== null && metaCode >= 132_000 && metaCode <= 132_999) {
    return {
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
      code: 'WHATSAPP_CLOUD_TEMPLATE_REJECTED',
      message:
        'WhatsApp refused this template. It may not be approved yet, or the filled-in values do not match the template it was approved as.',
    };
  }

  if (metaCode !== null && metaCode >= 133_000 && metaCode <= 133_999) {
    return {
      failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
      code: 'WHATSAPP_CLOUD_NUMBER_NOT_REGISTERED',
      message:
        'This number is not registered for the WhatsApp Cloud API, or its registration was removed. Check it in the Meta dashboard.',
    };
  }

  if (metaCode === 131_031 || metaCode === 368) {
    return {
      failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
      code: 'WHATSAPP_CLOUD_ACCOUNT_RESTRICTED',
      message:
        'Meta has restricted this WhatsApp Business account, so it cannot send. Check the account status in the Meta dashboard.',
    };
  }

  if (
    metaCode === 130_429 ||
    metaCode === 131_048 ||
    metaCode === 80_007 ||
    metaCode === 4 ||
    metaCode === 613 ||
    httpStatus === 429
  ) {
    return {
      failureKind: CLOUD_FAILURE_KINDS.RATE_LIMITED,
      code: 'WHATSAPP_CLOUD_RATE_LIMITED',
      message: 'WhatsApp is rate limiting this number. The message will be retried shortly.',
    };
  }

  if (metaCode === 10 || (metaCode !== null && metaCode >= 200 && metaCode <= 299)) {
    return {
      failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
      code: 'WHATSAPP_CLOUD_PERMISSION_DENIED',
      message:
        'Meta refused the request for lack of permission. The token needs whatsapp_business_messaging and access to this number.',
    };
  }

  return {
    failureKind: CLOUD_FAILURE_KINDS.TRANSIENT,
    code: 'WHATSAPP_CLOUD_TRANSIENT_ERROR',
    message: `WhatsApp could not process the request${
      httpStatus === null ? '' : ` (HTTP ${httpStatus})`
    }. It will be retried.`,
  };
};

const toCloudError = ({
  body,
  httpStatus,
}: {
  body: unknown;
  httpStatus: number | null;
}): WhatsAppCloudError => {
  const envelope = (body ?? {}) as CloudErrorEnvelope;
  const metaCode = typeof envelope.error?.code === 'number' ? envelope.error.code : null;
  const metaSubcode =
    typeof envelope.error?.error_subcode === 'number' ? envelope.error.error_subcode : null;

  // A 5xx with no parsable envelope is Meta being briefly unwell, not a configuration problem.
  if (metaCode === null && httpStatus !== null && httpStatus >= 500) {
    return new WhatsAppCloudError('WhatsApp is temporarily unavailable. The send will be retried.', {
      code: 'WHATSAPP_CLOUD_TRANSIENT_ERROR',
      failureKind: CLOUD_FAILURE_KINDS.TRANSIENT,
      httpStatus,
    });
  }

  const { failureKind, code, message } = classifyCloudError({ metaCode, httpStatus });

  // Meta's own prose is never used as the message: it is written for a developer, it changes
  // without notice, and `error_data.details` in particular quotes back the recipient's number.
  return new WhatsAppCloudError(message, {
    code,
    failureKind,
    metaCode,
    metaSubcode,
    httpStatus,
  });
};

export interface CloudRequestOptions {
  accessToken: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const assertToken = (accessToken: unknown): string => {
  const token = typeof accessToken === 'string' ? accessToken.trim() : '';

  if (token === '') {
    throw new WhatsAppCloudError('No WhatsApp access token is configured for this number.', {
      code: 'WHATSAPP_CLOUD_TOKEN_MISSING',
      failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
    });
  }

  return token;
};

/**
 * Meta ids reach this file from the database, which got them from an admin's paste. Checked here
 * anyway, because they are interpolated into a URL path: a value containing `../` or a query
 * separator would otherwise address an endpoint nobody intended.
 */
const assertMetaId = (value: unknown, label: string): string => {
  const id = typeof value === 'string' ? value.trim() : '';

  if (!/^\d{5,32}$/.test(id)) {
    throw new WhatsAppCloudError(`This number's ${label} is missing or malformed.`, {
      code: 'WHATSAPP_CLOUD_CONFIG_INVALID',
      failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
    });
  }

  return id;
};

export const buildCloudUrl = ({
  path,
  params = {},
}: {
  path: string;
  params?: Record<string, string | number | undefined>;
}): string => {
  const url = new URL(`${CLOUD_API_BASE_URL}/${CLOUD_API_VERSION}/${path.replace(/^\/+/, '')}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
};

/**
 * One Cloud API call.
 *
 * The token travels in the Authorization header, never the query string - unlike the lead client,
 * nothing here follows a Meta-built `paging.next` URL, so there is no reason to put a credential
 * somewhere a proxy or an error page might echo it. Nothing logs the URL or the body either way.
 */
const requestCloud = async <T>({
  url,
  accessToken,
  method = 'GET',
  body,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  url: string;
  accessToken: string;
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  let response: Response;
  let text: string;

  try {
    response = await fetchFn(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // FormData must set its own Content-Type: it carries the multipart boundary, and
        // overriding it produces a body Meta cannot parse and an error that blames the file.
        ...(body === undefined || isFormData ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : isFormData ? (body as FormData) : JSON.stringify(body),
    });
    text = await response.text();
  } catch (error: unknown) {
    // Abort included: a request that ran out of time is indistinguishable from a network drop as
    // far as the queue is concerned, and both are worth retrying.
    throw new WhatsAppCloudError('Could not reach WhatsApp. The send will be retried.', {
      code: 'WHATSAPP_CLOUD_NETWORK_ERROR',
      failureKind: CLOUD_FAILURE_KINDS.TRANSIENT,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  const parsed: unknown = (() => {
    try {
      return text === '' ? null : JSON.parse(text);
    } catch {
      return null;
    }
  })();

  if (!response.ok) {
    throw toCloudError({ body: parsed, httpStatus: response.status });
  }

  // A 200 carrying an error envelope is rare here but costs nothing to handle.
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    throw toCloudError({ body: parsed, httpStatus: response.status });
  }

  if (parsed === null) {
    throw new WhatsAppCloudError('WhatsApp returned an empty response.', {
      code: 'WHATSAPP_CLOUD_TRANSIENT_ERROR',
      failureKind: CLOUD_FAILURE_KINDS.TRANSIENT,
      httpStatus: response.status,
    });
  }

  return parsed as T;
};

interface CloudSendResponse {
  messages?: Array<{ id?: unknown }>;
  contacts?: Array<{ wa_id?: unknown }>;
}

const readSentMessageId = (body: CloudSendResponse): string | null => {
  const id = body.messages?.[0]?.id;

  return typeof id === 'string' && id !== '' ? id : null;
};

/**
 * Meta wants a plain international number with no `+`, no spaces and no `@s.whatsapp.net`.
 *
 * The CRM stores recipients in several shapes depending on where they came from - a Baileys JID, a
 * pasted lead phone, a normalised contact field - so every one of them is reduced here rather than
 * trusting the caller. A JID's `:device` suffix and `@domain` are dropped; everything that is not
 * a digit goes.
 */
export const toCloudRecipient = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  const withoutDomain = raw.split('@')[0] ?? '';
  const withoutDevice = withoutDomain.split(':')[0] ?? '';
  const digits = withoutDevice.replace(/\D/g, '');

  if (digits.length < 8 || digits.length > 20) {
    throw new WhatsAppCloudError('That recipient is not a usable WhatsApp number.', {
      code: 'WHATSAPP_CLOUD_RECIPIENT_INVALID',
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
    });
  }

  return digits;
};

export interface SendCloudTextOptions extends CloudRequestOptions {
  phoneNumberId: string;
  to: string;
  text: string;
  /** WhatsApp renders a link preview when true. Off by default: previews surprise agents. */
  previewUrl?: boolean;
}

export const sendCloudText = async ({
  phoneNumberId,
  accessToken,
  to,
  text,
  previewUrl = false,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: SendCloudTextOptions): Promise<{ providerMessageId: string | null }> => {
  const token = assertToken(accessToken);
  const numberId = assertMetaId(phoneNumberId, 'phone number id');
  const recipient = toCloudRecipient(to);
  const body = typeof text === 'string' ? text : '';

  if (body.trim() === '') {
    throw new WhatsAppCloudError('There is no text to send.', {
      code: 'WHATSAPP_CLOUD_EMPTY_BODY',
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
    });
  }

  if (body.length > CLOUD_MAX_TEXT_LENGTH) {
    throw new WhatsAppCloudError(
      `WhatsApp messages cannot exceed ${CLOUD_MAX_TEXT_LENGTH} characters.`,
      {
        code: 'WHATSAPP_CLOUD_BODY_TOO_LONG',
        failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
      },
    );
  }

  const response = await requestCloud<CloudSendResponse>({
    url: buildCloudUrl({ path: `${numberId}/messages` }),
    accessToken: token,
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: { preview_url: previewUrl, body },
    },
    fetchFn,
    timeoutMs,
  });

  return { providerMessageId: readSentMessageId(response) };
};

/** One filled-in placeholder, in the order the template declares them. */
export interface CloudTemplateParameter {
  type: 'text';
  text: string;
}

export interface CloudTemplateComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: string;
  index?: string;
  parameters: CloudTemplateParameter[];
}

export interface SendCloudTemplateOptions extends CloudRequestOptions {
  phoneNumberId: string;
  to: string;
  templateName: string;
  languageCode: string;
  components?: CloudTemplateComponent[];
}

/**
 * Sends an approved template - the only thing WhatsApp accepts outside the 24-hour window.
 *
 * The template's TEXT is not sent: only its name, its language and the values for its
 * placeholders. Meta holds the approved wording. That is why a template cannot be edited at send
 * time, and why the composer must show the agent the approved body rather than letting them type.
 */
export const sendCloudTemplate = async ({
  phoneNumberId,
  accessToken,
  to,
  templateName,
  languageCode,
  components = [],
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: SendCloudTemplateOptions): Promise<{ providerMessageId: string | null }> => {
  const token = assertToken(accessToken);
  const numberId = assertMetaId(phoneNumberId, 'phone number id');
  const recipient = toCloudRecipient(to);
  const name = typeof templateName === 'string' ? templateName.trim() : '';
  const language = typeof languageCode === 'string' ? languageCode.trim() : '';

  if (name === '' || language === '') {
    throw new WhatsAppCloudError('A template needs both a name and a language.', {
      code: 'WHATSAPP_CLOUD_TEMPLATE_INCOMPLETE',
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
    });
  }

  const response = await requestCloud<CloudSendResponse>({
    url: buildCloudUrl({ path: `${numberId}/messages` }),
    accessToken: token,
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'template',
      template: {
        name,
        language: { code: language },
        // Meta rejects an empty `components` array on some template shapes, so it is omitted
        // entirely rather than sent empty when the template takes no parameters.
        ...(components.length > 0 ? { components } : {}),
      },
    },
    fetchFn,
    timeoutMs,
  });

  return { providerMessageId: readSentMessageId(response) };
};

export type CloudMediaKind = 'image' | 'video' | 'audio' | 'document';

export interface UploadCloudMediaOptions extends CloudRequestOptions {
  phoneNumberId: string;
  data: Buffer;
  mimeType: string;
  fileName?: string | null;
}

/**
 * Uploads a file and returns Meta's media id.
 *
 * Cloud API will not accept raw bytes on a message: media is uploaded first and then referenced by
 * id. The id is good for 30 days, but nothing here caches it - a resend is rare and a stale id
 * fails in a way that looks like a corrupt file.
 */
export const uploadCloudMedia = async ({
  phoneNumberId,
  accessToken,
  data,
  mimeType,
  fileName = null,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: UploadCloudMediaOptions): Promise<string> => {
  const token = assertToken(accessToken);
  const numberId = assertMetaId(phoneNumberId, 'phone number id');

  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new WhatsAppCloudError('There is no file to upload.', {
      code: 'WHATSAPP_CLOUD_MEDIA_EMPTY',
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
    });
  }

  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', mimeType);
  form.set(
    'file',
    new Blob([new Uint8Array(data)], { type: mimeType }),
    fileName ?? 'attachment',
  );

  const response = await requestCloud<{ id?: unknown }>({
    url: buildCloudUrl({ path: `${numberId}/media` }),
    accessToken: token,
    method: 'POST',
    body: form,
    fetchFn,
    timeoutMs,
  });

  if (typeof response.id !== 'string' || response.id === '') {
    throw new WhatsAppCloudError('WhatsApp accepted the upload but returned no media id.', {
      code: 'WHATSAPP_CLOUD_MEDIA_NO_ID',
      failureKind: CLOUD_FAILURE_KINDS.TRANSIENT,
    });
  }

  return response.id;
};

export interface SendCloudMediaOptions extends CloudRequestOptions {
  phoneNumberId: string;
  to: string;
  kind: CloudMediaKind;
  mediaId: string;
  caption?: string | null;
  fileName?: string | null;
}

/**
 * Sends an already-uploaded file.
 *
 * WhatsApp ignores a caption on audio, and a filename on anything but a document, so neither is
 * sent where it would be dropped - Meta is stricter about unexpected keys than it looks.
 *
 * There is no voice-note flag, unlike Baileys: Cloud API decides from the bytes, rendering
 * Ogg/Opus audio as a recorded voice note and anything else as an attached track.
 */
export const sendCloudMedia = async ({
  phoneNumberId,
  accessToken,
  to,
  kind,
  mediaId,
  caption = null,
  fileName = null,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: SendCloudMediaOptions): Promise<{ providerMessageId: string | null }> => {
  const token = assertToken(accessToken);
  const numberId = assertMetaId(phoneNumberId, 'phone number id');
  const recipient = toCloudRecipient(to);

  const trimmedCaption = typeof caption === 'string' && caption.trim() !== '' ? caption : null;

  const payload: Record<string, unknown> = { id: mediaId };

  if (trimmedCaption !== null && kind !== 'audio') {
    payload.caption = trimmedCaption;
  }

  if (kind === 'document' && typeof fileName === 'string' && fileName !== '') {
    payload.filename = fileName;
  }

  const response = await requestCloud<CloudSendResponse>({
    url: buildCloudUrl({ path: `${numberId}/messages` }),
    accessToken: token,
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: kind,
      [kind]: payload,
    },
    fetchFn,
    timeoutMs,
  });

  return { providerMessageId: readSentMessageId(response) };
};

export interface CloudMediaDescriptor {
  url: string;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
}

/** Step one of an inbound media download: the id becomes a short-lived, token-gated URL. */
export const describeCloudMedia = async ({
  mediaId,
  accessToken,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: CloudRequestOptions & { mediaId: string }): Promise<CloudMediaDescriptor> => {
  const token = assertToken(accessToken);
  const id = assertMetaId(mediaId, 'media id');

  const body = await requestCloud<{
    url?: unknown;
    mime_type?: unknown;
    file_size?: unknown;
    sha256?: unknown;
  }>({
    url: buildCloudUrl({ path: id }),
    accessToken: token,
    fetchFn,
    timeoutMs,
  });

  if (typeof body.url !== 'string' || body.url === '') {
    throw new WhatsAppCloudError('WhatsApp did not return a download URL for that media.', {
      code: 'WHATSAPP_CLOUD_MEDIA_NO_URL',
      failureKind: CLOUD_FAILURE_KINDS.TRANSIENT,
    });
  }

  return {
    url: body.url,
    mimeType: typeof body.mime_type === 'string' ? body.mime_type : null,
    sizeBytes: typeof body.file_size === 'number' ? body.file_size : null,
    sha256: typeof body.sha256 === 'string' ? body.sha256 : null,
  };
};

/**
 * Step two: the bytes themselves.
 *
 * The URL is on a Meta CDN host rather than graph.facebook.com and STILL needs the Bearer token -
 * fetching it without one returns a 401 whose body is HTML, which is why this does not go through
 * requestCloud's JSON parsing.
 *
 * `maxBytes` is enforced against the Content-Length before the body is read, so an oversized file
 * costs a header round trip rather than the download.
 */
export const downloadCloudMedia = async ({
  url,
  accessToken,
  maxBytes,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: CloudRequestOptions & { url: string; maxBytes?: number }): Promise<Buffer> => {
  const token = assertToken(accessToken);

  // Only Meta's own CDN. Without this the media id - which arrives in a webhook body - could
  // steer an authenticated, token-bearing request at any host that answered the describe call.
  let host: string;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
      throw new Error('HTTPS_REQUIRED');
    }
    host = parsed.hostname;
  } catch {
    throw new WhatsAppCloudError('WhatsApp returned an unusable media URL.', {
      code: 'WHATSAPP_CLOUD_MEDIA_URL_INVALID',
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
    });
  }

  if (!/(^|\.)(fbcdn\.net|fbsbx\.com|facebook\.com|whatsapp\.net)$/i.test(host)) {
    throw new WhatsAppCloudError('That media URL is not on a Meta host.', {
      code: 'WHATSAPP_CLOUD_MEDIA_URL_UNTRUSTED',
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;

  try {
    response = await fetchFn(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });

  if (!response.ok) {
    throw new WhatsAppCloudError('WhatsApp refused the attachment download.', {
      code: 'WHATSAPP_CLOUD_MEDIA_DOWNLOAD_FAILED',
      failureKind: CLOUD_FAILURE_KINDS.TRANSIENT,
      httpStatus: response.status,
    });
  }

  const declared = Number(response.headers.get('content-length') ?? '');

  if (
    typeof maxBytes === 'number' &&
    Number.isFinite(declared) &&
    declared > 0 &&
    declared > maxBytes
  ) {
    throw new WhatsAppCloudError('That attachment is larger than the configured limit.', {
      code: 'WHATSAPP_CLOUD_MEDIA_TOO_LARGE',
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
    });
  }

  let bytes: Buffer;
  if (response.body && typeof maxBytes === 'number') {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > maxBytes) {
          controller.abort();
          throw new WhatsAppCloudError('That attachment is larger than the configured limit.', {
            code: 'WHATSAPP_CLOUD_MEDIA_TOO_LARGE', failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
          });
        }
        chunks.push(Buffer.from(chunk.value));
      }
      bytes = Buffer.concat(chunks, received);
    } finally { reader.releaseLock(); }
  } else {
    bytes = Buffer.from(await response.arrayBuffer());
  }

  // A missing or lying Content-Length is not a reason to accept an unbounded file.
  if (typeof maxBytes === 'number' && bytes.length > maxBytes) {
    throw new WhatsAppCloudError('That attachment is larger than the configured limit.', {
      code: 'WHATSAPP_CLOUD_MEDIA_TOO_LARGE',
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
    });
  }

  return bytes;
  } catch (error: unknown) {
    if (error instanceof WhatsAppCloudError) throw error;
    throw new WhatsAppCloudError('Could not download the attachment from WhatsApp.', {
      code: 'WHATSAPP_CLOUD_MEDIA_NETWORK_ERROR',
      failureKind: CLOUD_FAILURE_KINDS.TRANSIENT,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
};

export interface CloudPhoneNumberSummary {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
}

/**
 * Verifies credentials the moment an admin pastes them, and reports what they point at.
 *
 * This is the whole of the "Test connection" button: if this call succeeds, the token can read the
 * number, which is the same permission it needs to send from it. Showing the verified name back is
 * what lets an admin notice they pasted the wrong number id before any customer does.
 */
export const fetchCloudPhoneNumber = async ({
  phoneNumberId,
  accessToken,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: CloudRequestOptions & { phoneNumberId: string }): Promise<CloudPhoneNumberSummary> => {
  const token = assertToken(accessToken);
  const numberId = assertMetaId(phoneNumberId, 'phone number id');

  const body = await requestCloud<{
    id?: unknown;
    display_phone_number?: unknown;
    verified_name?: unknown;
    quality_rating?: unknown;
  }>({
    url: buildCloudUrl({
      path: numberId,
      params: { fields: 'id,display_phone_number,verified_name,quality_rating' },
    }),
    accessToken: token,
    fetchFn,
    timeoutMs,
  });

  return {
    id: typeof body.id === 'string' ? body.id : numberId,
    displayPhoneNumber:
      typeof body.display_phone_number === 'string' ? body.display_phone_number : null,
    verifiedName: typeof body.verified_name === 'string' ? body.verified_name : null,
    qualityRating: typeof body.quality_rating === 'string' ? body.quality_rating : null,
  };
};

/** A message template exactly as Meta describes it. Shapes vary; unknown keys are ignored. */
export interface CloudTemplateSummary {
  name: string;
  language: string;
  status: string;
  category: string | null;
  components: unknown[];
}

/** Verify account ownership and enable webhook delivery before marking a number connected. */
export const connectCloudWebhookSubscription = async ({
  wabaId, phoneNumberId, accessToken, fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
}: CloudRequestOptions & { wabaId: string; phoneNumberId: string }): Promise<void> => {
  const businessId = assertMetaId(wabaId, 'WhatsApp Business Account id');
  const numberId = assertMetaId(phoneNumberId, 'phone number id');
  const token = assertToken(accessToken);
  let after: string | undefined;
  let found = false;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await requestCloud<{
      data?: Array<{ id?: string }>;
      paging?: { next?: string; cursors?: { after?: string } };
    }>({
      url: buildCloudUrl({ path: `${businessId}/phone_numbers`, params: { fields: 'id', limit: 100, after } }),
      accessToken: token, fetchFn, timeoutMs,
    });
    found = page.data?.some((number) => number.id === numberId) ?? false;
    if (found || !page.paging?.next || !page.paging.cursors?.after) break;
    after = page.paging.cursors.after;
  }
  if (!found) {
    throw new WhatsAppCloudError('This phone number does not belong to the supplied WhatsApp Business Account. Check both IDs.', {
      code: 'WHATSAPP_CLOUD_ACCOUNT_MISMATCH', failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
    });
  }
  const subscription = await requestCloud<{ success?: boolean }>({
    url: buildCloudUrl({ path: `${businessId}/subscribed_apps` }),
    method: 'POST', body: {}, accessToken: token, fetchFn, timeoutMs,
  });
  if (subscription.success !== true) {
    throw new WhatsAppCloudError('Meta did not confirm the webhook subscription. Check the app and token permissions, then connect again.', {
      code: 'WHATSAPP_CLOUD_SUBSCRIPTION_FAILED', failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
    });
  }
};

export interface FetchCloudTemplatesOptions extends CloudRequestOptions {
  wabaId: string;
  limit?: number;
  maxPages?: number;
}

/**
 * Every message template on the business account, approved or not.
 *
 * Rejected and pending ones are deliberately included: an agent who cannot see that their template
 * was rejected has no way to understand why their messages stopped going out, and "it is not in
 * the list" is the least actionable error in this entire integration.
 */
export const fetchCloudTemplates = async ({
  wabaId,
  accessToken,
  limit = 100,
  maxPages = 10,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: FetchCloudTemplatesOptions): Promise<CloudTemplateSummary[]> => {
  const token = assertToken(accessToken);
  const businessId = assertMetaId(wabaId, 'WhatsApp Business Account id');

  const templates: CloudTemplateSummary[] = [];

  let url: string | null = buildCloudUrl({
    path: `${businessId}/message_templates`,
    params: { fields: 'name,status,category,language,components', limit },
  });

  let pagesWalked = 0;

  while (url !== null && pagesWalked < maxPages) {
    const page: { data?: unknown[]; paging?: { next?: unknown } } = await requestCloud<{
      data?: unknown[];
      paging?: { next?: unknown };
    }>({ url, accessToken: token, fetchFn, timeoutMs });

    pagesWalked += 1;

    for (const entry of page.data ?? []) {
      const record = (entry ?? {}) as {
        name?: unknown;
        language?: unknown;
        status?: unknown;
        category?: unknown;
        components?: unknown;
      };

      // Name and language together are what identify a template on a send. One without the other
      // cannot be sent, so it is not worth storing.
      if (typeof record.name !== 'string' || record.name === '') {
        continue;
      }

      if (typeof record.language !== 'string' || record.language === '') {
        continue;
      }

      templates.push({
        name: record.name,
        language: record.language,
        status: typeof record.status === 'string' ? record.status.toUpperCase() : 'UNKNOWN',
        category: typeof record.category === 'string' ? record.category.toUpperCase() : null,
        components: Array.isArray(record.components) ? record.components : [],
      });
    }

    // Unlike the lead client this DOES follow `paging.next`, which is safe here: the token is in
    // a header, so Meta's next URL carries no credential to leak.
    url = typeof page.paging?.next === 'string' ? page.paging.next : null;
  }

  return templates;
};
