/**
 * Sending an Instagram DM through the Messenger Platform.
 *
 * `POST /{version}/{PAGE_ID}/messages` with a Page access token - the Facebook Login path, not
 * `graph.instagram.com`. That choice follows from reusing the existing `MetaConnection`: this
 * installation already holds a long-lived Facebook user token and mints Page tokens from it, so
 * Instagram needs no second authorisation and no second app.
 *
 * THE 1,000-CHARACTER LIMIT IS META'S, and it is enforced here rather than at the form. A reply
 * assembled from a template or a keyword rule can exceed it without anybody typing it, and
 * Instagram's refusal does not say which of several messages was too long.
 *
 * THE TOKEN GOES IN A HEADER, NOT THE QUERY STRING. Meta's own examples put it in the URL; a URL
 * is recorded by proxies, load balancers and error trackers.
 */
import { META_GRAPH_BASE_URL } from '../lead-sources/meta-graph.client.js';

/**
 * Pinned separately from the Lead Ads importer, which is on v25.0 and works.
 *
 * Bumping the shared constant to ship Instagram would change how every existing lead is fetched
 * as a side effect. Meta keeps a version usable for two years after its successor ships, so
 * v25.0 is in no danger - but a new integration should not start life on an old schema either.
 */
export const INSTAGRAM_GRAPH_API_VERSION = 'v27.0';

/** Meta refuses a text message longer than this. UTF-8 bytes, per the Send API reference. */
export const INSTAGRAM_TEXT_MAX_BYTES = 1000;

export interface InstagramSendResult {
  recipientId: string | null;
  messageId: string | null;
}

export class InstagramSendError extends Error {
  readonly code: string;
  readonly metaCode: number | null;
  readonly httpStatus: number | null;
  /** `transient` retries; `needs_attention` stops and tells somebody. */
  readonly failureKind: 'transient' | 'needs_attention';

  constructor({
    message,
    code,
    metaCode = null,
    httpStatus = null,
    failureKind,
  }: {
    message: string;
    code: string;
    metaCode?: number | null;
    httpStatus?: number | null;
    failureKind: 'transient' | 'needs_attention';
  }) {
    super(message);
    this.name = 'InstagramSendError';
    this.code = code;
    this.metaCode = metaCode;
    this.httpStatus = httpStatus;
    this.failureKind = failureKind;
  }
}

/**
 * Meta's error codes, translated into whether retrying can possibly help.
 *
 * The distinction is the whole point: a revoked token fails identically every minute forever, and
 * retrying it burns a send budget while the owner is never told to re-authorise.
 */
const classify = (
  metaCode: number | null,
  httpStatus: number | null,
): { code: string; failureKind: 'transient' | 'needs_attention'; message: string } => {
  if (metaCode !== null && [190, 102, 463, 467].includes(metaCode)) {
    return {
      code: 'INSTAGRAM_TOKEN_EXPIRED',
      failureKind: 'needs_attention',
      message:
        'Instagram access has expired or was revoked. Reconnect the account in Settings to start replying again.',
    };
  }

  if (metaCode === 10 || (metaCode !== null && metaCode >= 200 && metaCode <= 299)) {
    return {
      code: 'INSTAGRAM_PERMISSION_DENIED',
      failureKind: 'needs_attention',
      message:
        'Instagram refused the send for lack of permission. The Page token needs instagram_manage_messages, and "Allow Access to Messages" must be on in the Instagram app settings.',
    };
  }

  // 551 is Meta's "this person is not available" - typically the 24-hour window has closed or the
  // user blocked the account. Retrying cannot reopen it.
  if (metaCode === 551 || metaCode === 100) {
    return {
      code: 'INSTAGRAM_RECIPIENT_UNAVAILABLE',
      failureKind: 'needs_attention',
      message:
        'Instagram would not deliver to this person. The 24-hour reply window may have closed, or they may have blocked or deleted the account.',
    };
  }

  if (metaCode === 4 || metaCode === 613 || httpStatus === 429) {
    return {
      code: 'INSTAGRAM_RATE_LIMITED',
      failureKind: 'transient',
      message: 'Instagram is rate limiting this account. The send will be retried.',
    };
  }

  return {
    code: 'INSTAGRAM_SEND_FAILED',
    failureKind: httpStatus !== null && httpStatus >= 500 ? 'transient' : 'needs_attention',
    message: 'Instagram refused the message.',
  };
};

export const instagramTextTooLong = (text: string): boolean =>
  Buffer.byteLength(text, 'utf8') > INSTAGRAM_TEXT_MAX_BYTES;

/**
 * Sends one text DM.
 *
 * `recipientId` is the Instagram-scoped id (IGSID) from the inbound webhook - NOT the @handle and
 * not a numeric user id from anywhere else. It is scoped to this app and this account, which is
 * why it can only ever come from a delivery we received.
 */
export const sendInstagramText = async ({
  pageId,
  pageAccessToken,
  recipientId,
  text,
  humanAgent = false,
  fetchImpl = fetch,
}: {
  pageId: string;
  pageAccessToken: string;
  recipientId: string;
  text: string;
  /**
   * Tags the send as a human answering a customer, which Meta allows up to seven days after the
   * customer's last message instead of twenty-four hours.
   *
   * ONLY TRUE WHEN A PERSON IS ACTUALLY REPLYING. Using it for an automatic reply would be a
   * false declaration to Meta about who is on the other end, and the penalty is the account's
   * messaging access.
   */
  humanAgent?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<InstagramSendResult> => {
  if (instagramTextTooLong(text)) {
    throw new InstagramSendError({
      message: `Instagram refuses a message over ${INSTAGRAM_TEXT_MAX_BYTES} characters. This one is ${Buffer.byteLength(text, 'utf8')}.`,
      code: 'INSTAGRAM_TEXT_TOO_LONG',
      failureKind: 'needs_attention',
    });
  }

  const url = `${META_GRAPH_BASE_URL}/${INSTAGRAM_GRAPH_API_VERSION}/${pageId}/messages`;

  const body: Record<string, unknown> = {
    recipient: { id: recipientId },
    message: { text },
  };

  if (humanAgent) {
    body.messaging_type = 'MESSAGE_TAG';
    body.tag = 'HUMAN_AGENT';
  }

  let response: Response;

  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${pageAccessToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // A timeout and a dropped connection are indistinguishable here, and either may have been
    // delivered. Transient is the only honest classification.
    throw new InstagramSendError({
      message: 'Instagram could not be reached.',
      code: 'INSTAGRAM_TRANSIENT_ERROR',
      failureKind: 'transient',
    });
  }

  const payload = (await response.json().catch(() => null)) as
    | { recipient_id?: string; message_id?: string; error?: { code?: number; message?: string } }
    | null;

  if (!response.ok) {
    const metaCode = typeof payload?.error?.code === 'number' ? payload.error.code : null;
    const { code, failureKind, message } = classify(metaCode, response.status);

    throw new InstagramSendError({
      // Meta's own words where it gave any, because the code is what somebody searches for.
      message: payload?.error?.message ? `${message} (${payload.error.message})` : message,
      code,
      metaCode,
      httpStatus: response.status,
      failureKind,
    });
  }

  return {
    recipientId: payload?.recipient_id ?? null,
    messageId: payload?.message_id ?? null,
  };
};

export interface InstagramCapablePage {
  pageId: string;
  pageName: string | null;
  /** The Page's own access token, which is what Instagram sends with. */
  pageAccessToken: string;
  /** Null when the Page has no Instagram professional account attached. */
  instagram: { id: string; username: string | null } | null;
}

/**
 * Every Page the authorising user manages, with its Instagram account where there is one.
 *
 * ITS OWN CALL RATHER THAN EXTENDING THE LEAD ADS LISTER, because that function is on the Lead
 * Ads version pin and asking it for `instagram_business_account` would change what every lead
 * import requests. This asks for exactly what connecting Instagram needs and nothing else.
 *
 * A PAGE WITHOUT AN INSTAGRAM ACCOUNT IS RETURNED, NOT FILTERED OUT. "My Page is not in the list"
 * is a much harder question to answer than "this Page has no Instagram account attached" - so the
 * UI gets to say the second rather than leaving somebody to work out the first.
 */
export const listInstagramCapablePages = async ({
  userAccessToken,
  fetchImpl = fetch,
}: {
  userAccessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<InstagramCapablePage[]> => {
  const url = new URL(`${META_GRAPH_BASE_URL}/${INSTAGRAM_GRAPH_API_VERSION}/me/accounts`);

  url.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username}');
  url.searchParams.set('limit', '100');

  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${userAccessToken}` },
  });

  const payload = (await response.json().catch(() => null)) as {
    data?: {
      id?: string;
      name?: string;
      access_token?: string;
      instagram_business_account?: { id?: string; username?: string };
    }[];
    error?: { code?: number; message?: string };
  } | null;

  if (!response.ok) {
    const metaCode = typeof payload?.error?.code === 'number' ? payload.error.code : null;
    const { code, failureKind, message } = classify(metaCode, response.status);

    throw new InstagramSendError({
      message: payload?.error?.message ? `${message} (${payload.error.message})` : message,
      code,
      metaCode,
      httpStatus: response.status,
      failureKind,
    });
  }

  return (payload?.data ?? [])
    .filter((page) => typeof page.id === 'string' && typeof page.access_token === 'string')
    .map((page) => ({
      pageId: String(page.id),
      pageName: page.name ?? null,
      pageAccessToken: String(page.access_token),
      instagram: page.instagram_business_account?.id
        ? {
            id: String(page.instagram_business_account.id),
            username: page.instagram_business_account.username ?? null,
          }
        : null,
    }));
};
