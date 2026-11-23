export interface FacebookSdk {
  init(options: { appId: string; version: string; autoLogAppEvents: boolean; xfbml: boolean }): void;
  login(callback: (response: { authResponse?: { code?: string } }) => void, options: {
    config_id: string; response_type: 'code'; override_default_response_type: true; extras: { setup: Record<string, never> };
  }): void;
}
type MetaWindow = Window & { FB?: FacebookSdk };
let loading: Promise<FacebookSdk> | undefined;

export const loadFacebookSdk = (): Promise<FacebookSdk> => {
  const existing = (window as MetaWindow).FB;
  if (existing) return Promise.resolve(existing);
  if (loading) return loading;
  loading = new Promise<FacebookSdk>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    const fail = () => {
      clearTimeout(timeout);
      script.remove();
      loading = undefined;
      reject(new Error('Meta login could not load. Allow Facebook in your browser and try again.'));
    };
    const timeout = window.setTimeout(fail, 15_000);
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timeout);
      const sdk = (window as MetaWindow).FB;
      if (sdk) resolve(sdk); else fail();
    };
    document.head.appendChild(script);
  });
  return loading;
};

export interface SignupAssets { phoneNumberId: string; wabaId: string }
export const parseSignupEvent = (event: Pick<MessageEvent, 'origin' | 'data'>):
  { kind: 'finish'; assets: SignupAssets } | { kind: 'cancel' | 'error' | 'unsupported' } | null => {
  // Exact hosts, not endsWith('facebook.com'), which accepts attackerfacebook.com.
  if (!['https://www.facebook.com', 'https://web.facebook.com', 'https://business.facebook.com',
    'https://m.facebook.com', 'https://facebook.com'].includes(event.origin)) return null;
  try {
    const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (!payload || payload.type !== 'WA_EMBEDDED_SIGNUP') return null;
    if (payload.event === 'CANCEL') return { kind: 'cancel' };
    if (payload.event === 'ERROR') return { kind: 'error' };
    if (payload.event !== 'FINISH') {
      return typeof payload.event === 'string' && payload.event.startsWith('FINISH') ? { kind: 'unsupported' } : null;
    }
    const { phone_number_id: phoneNumberId, waba_id: wabaId } = payload.data ?? {};
    if (typeof phoneNumberId !== 'string' || !/^\d{5,32}$/.test(phoneNumberId) ||
        typeof wabaId !== 'string' || !/^\d{5,32}$/.test(wabaId)) return { kind: 'unsupported' };
    return { kind: 'finish', assets: { phoneNumberId, wabaId } };
  } catch { return null; }
};
