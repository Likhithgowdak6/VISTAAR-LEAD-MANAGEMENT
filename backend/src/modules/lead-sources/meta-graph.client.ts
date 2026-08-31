/**
 * The only file in the CRM that knows the shape of Meta's Graph API.
 *
 * Same contract as google-sheet.client.ts next door: pure functions, `fetch` injected so no test
 * ever touches the network, every request on a timeout, and every failure converted into one of
 * the module's own typed errors before it leaves.
 */
import {
  META_GRAPH_FAILURE_KINDS,
  MetaGraphError,
  type MetaGraphFailureKind,
} from './lead-source.errors.js';

/**
 * The pinned Graph API version. Meta supports a version for roughly two years from release and
 * then starts rejecting calls to it, so this is a single constant to bump deliberately rather
 * than a floating "latest" that breaks in production on a date nobody wrote down. Check it
 * against Meta's Graph API changelog before each release; the README says the same.
 *
 * v25.0 was introduced in February 2026, which puts its sunset around early 2028.
 */
export const META_GRAPH_API_VERSION = 'v25.0';

export const META_GRAPH_BASE_URL = 'https://graph.facebook.com';

/** Leads per cursor page. Meta caps this well below its own limit for the leads edge. */
export const META_GRAPH_PAGE_SIZE = 100;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PAGES = 10;

/**
 * Everything the mapper knows how to read off a lead. `form_name` is deliberately absent: the
 * leads edge does not return it, so the importer supplies the name it already has on the source.
 */
const LEAD_FIELDS = [
  'id',
  'created_time',
  'ad_id',
  'ad_name',
  'adset_id',
  'adset_name',
  'campaign_id',
  'campaign_name',
  'form_id',
  'is_organic',
  'platform',
  'field_data',
] as const;

export interface MetaGraphFieldDatum {
  name: string;
  values: string[];
}

export interface MetaGraphLead {
  id: string;
  created_time: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  is_organic?: boolean;
  platform?: string;
  field_data?: MetaGraphFieldDatum[];
}

export interface MetaPageSummary {
  id: string;
  name: string | null;
}

export interface MetaLeadFormSummary {
  id: string;
  name: string | null;
  status: string | null;
}

interface MetaErrorEnvelope {
  error?: {
    code?: number;
    error_subcode?: number;
    type?: string;
    message?: string;
    error_user_msg?: string;
  };
}

interface MetaGraphPage<T> {
  data?: T[];
  paging?: { next?: string; cursors?: { after?: string } };
}

/**
 * Meta's error taxonomy, collapsed to the four reactions the importer actually has.
 *
 * 190 is the OAuth catch-all (expired, revoked, password changed, user removed the app) and 102
 * is the session equivalent; both mean "this token is dead" and no retry will revive it. The
 * 200-299 block plus 10 are permission refusals — the app was never granted `leads_retrieval`,
 * or the page is not linked to it — which is equally a human problem. 4/17/32/613 and the
 * 80000-block are throttles: correct configuration, just too many calls. Everything else,
 * including Meta's own 1/2 "temporary problem", is treated as transient and simply retried on the
 * next tick.
 */
const classifyMetaError = ({
  metaCode,
  metaSubcode,
  httpStatus,
}: {
  metaCode: number | null;
  metaSubcode: number | null;
  httpStatus: number | null;
}): { failureKind: MetaGraphFailureKind; code: string; message: string } => {
  if (metaCode === 190 || metaCode === 102 || metaCode === 463 || metaCode === 467) {
    return {
      failureKind: META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
      code: 'META_TOKEN_EXPIRED',
      message:
        'The Meta access token has expired or was revoked. Paste a new Page access token to start importing again.',
    };
  }

  if (metaCode === 10 || (metaCode !== null && metaCode >= 200 && metaCode <= 299)) {
    return {
      failureKind: META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
      code: 'META_PERMISSION_DENIED',
      message:
        'Meta refused the request for lack of permission. The token needs leads_retrieval and the page must be connected to the app.',
    };
  }

  if (
    metaCode === 4 ||
    metaCode === 17 ||
    metaCode === 32 ||
    metaCode === 341 ||
    metaCode === 613 ||
    (metaCode !== null && metaCode >= 80_000 && metaCode <= 80_009) ||
    httpStatus === 429
  ) {
    return {
      failureKind: META_GRAPH_FAILURE_KINDS.RATE_LIMITED,
      code: 'META_RATE_LIMITED',
      message: 'Meta is rate limiting this app. The next scheduled poll will try again.',
    };
  }

  if (metaSubcode === 1_357_045) {
    // "Please reduce the amount of data you are asking for" — a transient shape problem.
    return {
      failureKind: META_GRAPH_FAILURE_KINDS.TRANSIENT,
      code: 'META_TRANSIENT_ERROR',
      message: 'Meta could not serve the request right now. The next scheduled poll will retry.',
    };
  }

  return {
    failureKind: META_GRAPH_FAILURE_KINDS.TRANSIENT,
    code: 'META_TRANSIENT_ERROR',
    message: `Meta returned an unexpected error${
      httpStatus === null ? '' : ` (HTTP ${httpStatus})`
    }. The next scheduled poll will retry.`,
  };
};

const toMetaGraphError = ({
  body,
  httpStatus,
}: {
  body: unknown;
  httpStatus: number | null;
}): MetaGraphError => {
  const envelope = (body ?? {}) as MetaErrorEnvelope;
  const metaCode = typeof envelope.error?.code === 'number' ? envelope.error.code : null;
  const metaSubcode =
    typeof envelope.error?.error_subcode === 'number' ? envelope.error.error_subcode : null;

  // A 5xx with no parsable envelope is Meta being briefly unwell, not a configuration problem.
  if (metaCode === null && httpStatus !== null && httpStatus >= 500) {
    return new MetaGraphError(
      'Meta is temporarily unavailable. The next scheduled poll will retry.',
      {
        code: 'META_TRANSIENT_ERROR',
        failureKind: META_GRAPH_FAILURE_KINDS.TRANSIENT,
        httpStatus,
      },
    );
  }

  const { failureKind, code, message } = classifyMetaError({ metaCode, metaSubcode, httpStatus });

  // Meta's own prose is never used as the message: it is written for a developer, it changes
  // without notice, and it is the one string in the response most likely to quote back the URL
  // that carries the access token.
  return new MetaGraphError(message, { code, failureKind, metaCode, metaSubcode, httpStatus });
};

export interface MetaGraphRequestOptions {
  accessToken: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const assertToken = (accessToken: unknown): string => {
  const token = typeof accessToken === 'string' ? accessToken.trim() : '';

  if (token === '') {
    throw new MetaGraphError('No Meta access token is configured for this source.', {
      code: 'META_TOKEN_MISSING',
      failureKind: META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
    });
  }

  return token;
};

export const buildMetaGraphUrl = ({
  path,
  params = {},
}: {
  path: string;
  params?: Record<string, string | number | undefined>;
}): string => {
  const url = new URL(`${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${path.replace(/^\/+/, '')}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
};

/**
 * One Graph call. The token travels as a query parameter because that is the only form the
 * paging `next` URLs come back in, and keeping both paths identical is worth more than the
 * marginal difference between a header and a parameter over TLS. Nothing logs the URL.
 */
const requestGraph = async <T>({
  url,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  url: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;

  try {
    response = await fetchFn(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (error: unknown) {
    // Abort included: a request that ran out of time is indistinguishable from a network drop
    // as far as the importer is concerned, and both are worth retrying next tick.
    throw new MetaGraphError('Could not reach Meta. The next scheduled poll will retry.', {
      code: 'META_NETWORK_ERROR',
      failureKind: META_GRAPH_FAILURE_KINDS.TRANSIENT,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();

  // Meta answers JSON for everything it means to say; a body that will not parse is a proxy or
  // an outage page, and is treated as no body at all.
  const parsed: unknown = (() => {
    try {
      return text === '' ? null : JSON.parse(text);
    } catch {
      return null;
    }
  })();

  if (!response.ok) {
    throw toMetaGraphError({ body: parsed, httpStatus: response.status });
  }

  // A 200 carrying an error envelope happens on batched/edge reads; treat it as the failure it is.
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    throw toMetaGraphError({ body: parsed, httpStatus: response.status });
  }

  if (parsed === null) {
    throw new MetaGraphError('Meta returned an empty response.', {
      code: 'META_TRANSIENT_ERROR',
      failureKind: META_GRAPH_FAILURE_KINDS.TRANSIENT,
      httpStatus: response.status,
    });
  }

  return parsed as T;
};

export interface FetchMetaFormLeadsOptions extends MetaGraphRequestOptions {
  formId: string;
  /** Only leads created strictly after this instant. Omitted for a first, unbounded sync. */
  since?: Date | null;
  /** Stop once this many leads have been collected, even mid-page. */
  maxLeads?: number;
  /** Cursor pages to walk at most, so one source cannot monopolise a tick. */
  maxPages?: number;
}

export interface FetchMetaFormLeadsResult {
  leads: MetaGraphLead[];
  /** True when the cap stopped the walk before Meta ran out of pages. */
  truncated: boolean;
}

/**
 * Reads a lead form's leads, newest-first as Meta returns them, following `paging.next` until the
 * caps are hit.
 *
 * The `time_created` filter is what keeps a steady-state poll cheap: the importer passes the
 * watermark it recorded last tick and Meta only sends what has arrived since. It is a
 * `GREATER_THAN` on whole seconds, so the watermark is nudged up by a second by the caller to
 * avoid asking for the same boundary lead forever.
 */
export const fetchMetaFormLeads = async ({
  accessToken,
  formId,
  since = null,
  maxLeads = 200,
  maxPages = DEFAULT_MAX_PAGES,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: FetchMetaFormLeadsOptions): Promise<FetchMetaFormLeadsResult> => {
  const token = assertToken(accessToken);

  const filtering =
    since === null
      ? undefined
      : JSON.stringify([
          {
            field: 'time_created',
            operator: 'GREATER_THAN',
            value: Math.floor(since.getTime() / 1000),
          },
        ]);

  let url: string | null = buildMetaGraphUrl({
    path: `${formId}/leads`,
    params: {
      access_token: token,
      fields: LEAD_FIELDS.join(','),
      limit: Math.min(META_GRAPH_PAGE_SIZE, Math.max(1, maxLeads)),
      filtering,
    },
  });

  const leads: MetaGraphLead[] = [];
  let pagesWalked = 0;

  while (url !== null && pagesWalked < maxPages && leads.length < maxLeads) {
    const page: MetaGraphPage<MetaGraphLead> = await requestGraph<MetaGraphPage<MetaGraphLead>>({
      url,
      fetchFn,
      timeoutMs,
    });

    pagesWalked += 1;

    for (const lead of page.data ?? []) {
      if (leads.length >= maxLeads) {
        break;
      }

      if (lead && typeof lead.id === 'string') {
        leads.push(lead);
      }
    }

    url = typeof page.paging?.next === 'string' ? page.paging.next : null;
  }

  // A cursor still in hand means Meta had more to give and a cap stopped the walk. The next tick
  // picks up from the advanced watermark rather than re-walking these pages.
  return { leads, truncated: url !== null };
};

export interface MetaConnectionTest {
  /** What `/me` resolved to: the page itself for a Page token, the person for a User token. */
  identity: MetaPageSummary;
  /**
   * Pages this token can act for. `/me/accounts` answers that for a *User* token; a Page token
   * cannot list accounts, so in that case the single page is whatever `/me` returned.
   */
  pages: MetaPageSummary[];
  /** True when the page list came from `/me` rather than `/me/accounts`. */
  pageScoped: boolean;
}

const toPageSummary = (value: unknown): MetaPageSummary | null => {
  const record = (value ?? {}) as { id?: unknown; name?: unknown };

  if (typeof record.id !== 'string' || record.id === '') {
    return null;
  }

  return { id: record.id, name: typeof record.name === 'string' ? record.name : null };
};

/**
 * Verifies a token the moment an admin pastes it, and reports the pages it can reach so the
 * dashboard can offer a list instead of asking for an id.
 *
 * `/me` failing is a real failure — that token is not usable at all. `/me/accounts` failing is
 * not: it is the expected answer for a Page access token, which is the kind of token this
 * integration actually wants.
 */
export const testMetaConnection = async ({
  accessToken,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: MetaGraphRequestOptions): Promise<MetaConnectionTest> => {
  const token = assertToken(accessToken);

  const identityBody = await requestGraph<unknown>({
    url: buildMetaGraphUrl({ path: 'me', params: { access_token: token, fields: 'id,name' } }),
    fetchFn,
    timeoutMs,
  });

  const identity = toPageSummary(identityBody);

  if (!identity) {
    throw new MetaGraphError('Meta did not identify this token with a page or a user.', {
      code: 'META_TOKEN_UNRECOGNIZED',
      failureKind: META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
    });
  }

  try {
    const accounts = await requestGraph<MetaGraphPage<unknown>>({
      url: buildMetaGraphUrl({
        path: 'me/accounts',
        params: { access_token: token, fields: 'id,name', limit: META_GRAPH_PAGE_SIZE },
      }),
      fetchFn,
      timeoutMs,
    });

    const pages = (accounts.data ?? [])
      .map((entry) => toPageSummary(entry))
      .filter((page): page is MetaPageSummary => page !== null);

    if (pages.length > 0) {
      return { identity, pages, pageScoped: false };
    }
  } catch {
    // Expected for a Page access token. Fall through to the single-page answer below.
  }

  return { identity, pages: [identity], pageScoped: true };
};

export interface ListMetaLeadFormsOptions extends MetaGraphRequestOptions {
  pageId: string;
  maxForms?: number;
}

/** The page's lead forms, so an admin picks one from a list instead of typing an id. */
export const listMetaLeadForms = async ({
  accessToken,
  pageId,
  maxForms = META_GRAPH_PAGE_SIZE,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ListMetaLeadFormsOptions): Promise<MetaLeadFormSummary[]> => {
  const token = assertToken(accessToken);

  const body = await requestGraph<MetaGraphPage<unknown>>({
    url: buildMetaGraphUrl({
      path: `${pageId}/leadgen_forms`,
      params: {
        access_token: token,
        fields: 'id,name,status',
        limit: Math.min(META_GRAPH_PAGE_SIZE, Math.max(1, maxForms)),
      },
    }),
    fetchFn,
    timeoutMs,
  });

  return (body.data ?? [])
    .map((entry) => {
      const record = (entry ?? {}) as { id?: unknown; name?: unknown; status?: unknown };

      if (typeof record.id !== 'string' || record.id === '') {
        return null;
      }

      return {
        id: record.id,
        name: typeof record.name === 'string' ? record.name : null,
        status: typeof record.status === 'string' ? record.status : null,
      };
    })
    .filter((form): form is MetaLeadFormSummary => form !== null)
    .slice(0, maxForms);
};
