import { env } from '../../../config/env.js';
import { createHttpError } from '../../../utils/http-error.js';

export const SIGNUP_GRAPH_VERSION = 'v27.0';

export const signupConfiguration = () => {
  const appId = env.WHATSAPP_EMBEDDED_SIGNUP_APP_ID || env.META_APP_ID;
  const configId = env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID;
  const appSecret = env.WHATSAPP_CLOUD_APP_SECRET || env.META_APP_SECRET;
  return {
    available: Boolean(env.WHATSAPP_CLOUD_ENABLED && /^\d+$/.test(appId) &&
      /^\d+$/.test(configId) && appSecret && env.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN),
    appId, configId, appSecret,
  };
};

// Never propagate fetch errors, Graph bodies or URLs: the exchange URL contains secrets.
export const signupGraphRequest = async (
  path: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>> => {
  try {
    const response = await fetchFn(`https://graph.facebook.com/${SIGNUP_GRAPH_VERSION}/${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json();
    if (!response.ok || !body || typeof body !== 'object' || 'error' in body) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw createHttpError({ statusCode: 502, code: 'META_SIGNUP_REQUEST_FAILED',
      message: 'Meta could not finish the connection. Check your Meta setup and try Connect with Meta again.' });
  }
};

export const exchangeSignupCode = async (code: string, fetchFn: typeof fetch = fetch) => {
  const { appId, appSecret } = signupConfiguration();
  const query = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
  const body = await signupGraphRequest(`oauth/access_token?${query}`, {}, fetchFn);
  if (typeof body.access_token !== 'string' || body.access_token.length < 20) {
    throw createHttpError({ statusCode: 502, code: 'META_SIGNUP_TOKEN_MISSING',
      message: 'Meta did not return a business token. Start Connect with Meta again.' });
  }
  return body.access_token;
};

export const registerSignupPhone = async (
  phoneNumberId: string, accessToken: string, pin: string, fetchFn: typeof fetch = fetch,
) => {
  if (!/^\d{5,32}$/.test(phoneNumberId) || !/^\d{6}$/.test(pin)) {
    throw createHttpError({ statusCode: 400, code: 'META_SIGNUP_INVALID_REGISTRATION',
      message: 'A valid phone number and six-digit verification PIN are required.' });
  }
  const result = await signupGraphRequest(`${phoneNumberId}/register`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  }, fetchFn);
  if (result.success !== true) {
    throw createHttpError({ statusCode: 502, code: 'META_SIGNUP_REGISTRATION_FAILED',
      message: 'Meta did not confirm number registration. The account has not been connected.' });
  }
};
