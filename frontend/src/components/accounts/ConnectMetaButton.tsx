import { useEffect, useRef, useState } from 'react';
import {
  getEmbeddedSignupConfig, startEmbeddedSignup, exchangeEmbeddedSignup, completeEmbeddedSignup,
  type EmbeddedSignupConfig,
} from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { loadFacebookSdk, parseSignupEvent, type FacebookSdk, type SignupAssets } from '../../lib/meta-embedded-signup';
import { errorMessage, type WhatsAppAccount } from '../types';

interface Props { accountId: string; onConnected: (account: WhatsAppAccount) => void }
type Ready = { config: EmbeddedSignupConfig; state: string; sdk: FacebookSdk };

const ConnectMetaButton = ({ accountId, onConnected }: Props) => {
  const { authedRequest } = useAuth();
  const [ready, setReady] = useState<Ready | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [generation, setGeneration] = useState(0);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const { data: config } = await authedRequest((token) => getEmbeddedSignupConfig({ token, accountId }));
        if (stopped) return;
        setAvailable(config.available);
        if (!config.available) return;
        if (!config.appId || !config.configId || !config.graphVersion) throw new Error('Meta setup is incomplete.');
        const sdk = await loadFacebookSdk();
        if (stopped) return;
        sdk.init({ appId: config.appId, version: config.graphVersion, autoLogAppEvents: false, xfbml: false });
        const { data } = await authedRequest((token) => startEmbeddedSignup({ token, accountId }));
        if (!stopped) setReady({ config, sdk, state: data.state });
      } catch (err) {
        if (!stopped) setError(errorMessage(err, 'Unable to prepare Meta login.'));
      }
    })();
    return () => { stopped = true; cleanup.current?.(); cleanup.current = null; };
  }, [accountId, authedRequest, generation]);

  const launch = () => {
    if (!ready || busy || !/^\d{6}$/.test(pin)) return;
    setBusy(true);
    setError(null);
    let stopped = false;
    let assets: SignupAssets | null = null;
    let exchanged = false;
    let exchanging = false;
    let finishing = false;
    const end = () => { stopped = true; window.removeEventListener('message', receive); clearTimeout(timeout); };
    const fail = (message: string) => {
      if (stopped) return;
      end(); setBusy(false); setReady(null); setError(message);
    };
    const complete = async () => {
      if (stopped || !exchanged || !assets || finishing) return;
      finishing = true;
      try {
        const selected = assets;
        const result = await authedRequest((token) => completeEmbeddedSignup({ token, accountId,
          state: ready.state, ...selected, pin }));
        if (!stopped) { end(); setBusy(false); setPin(''); onConnected(result.data); }
      } catch (err) { fail(errorMessage(err, 'Unable to connect WhatsApp. Start Connect with Meta again.')); }
    };
    const receive = (event: MessageEvent) => {
      if (stopped) return;
      const parsed = parseSignupEvent(event);
      if (!parsed) return;
      if (parsed.kind === 'finish') { assets = parsed.assets; void complete(); }
      else fail(parsed.kind === 'cancel' ? 'Meta login was cancelled. You can try again.' :
        parsed.kind === 'unsupported' ? 'Choose a Cloud API phone number in Meta. This connection does not support Business App coexistence or account-only signup.' :
          'Meta reported an onboarding error. Please try again.');
    };
    const timeout = window.setTimeout(() => fail('Meta login timed out. Start a new connection attempt.'), 5 * 60_000);
    cleanup.current = end;
    window.addEventListener('message', receive);
    try {
      // Launch synchronously inside the click handler. Awaiting preparation here blocks popups.
      ready.sdk.login((response) => {
        if (stopped || exchanging) return;
        const code = response.authResponse?.code;
        if (!code) { fail('Meta login did not complete. Please try again.'); return; }
        exchanging = true;
        // Do not wait for the independent FINISH event: Meta's code lives for just 30 seconds.
        void authedRequest((token) => exchangeEmbeddedSignup({ token, accountId, state: ready.state, code }))
          .then(() => { exchanged = true; void complete(); })
          .catch((err: unknown) => fail(errorMessage(err, 'Unable to authorize this connection.')));
      }, { config_id: ready.config.configId!, response_type: 'code', override_default_response_type: true, extras: { setup: {} } });
    } catch { fail('Meta login could not open. Allow popups and try again.'); }
  };

  return <section className="mb-4 space-y-3 rounded-xl border border-slate-200 p-3" aria-label="Connect with Meta">
    <p className="text-sm text-slate-600">Connect your business WhatsApp through Meta without copying API credentials.</p>
    {available === false ? <p className="text-sm text-amber-700">Connect with Meta is awaiting platform setup. Contact your platform administrator.</p> : <>
      <label className="block text-xs text-slate-600" htmlFor="meta-signup-pin">WhatsApp two-step verification PIN</label>
      <input id="meta-signup-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6}
        value={pin} disabled={busy} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
        className="w-full rounded-lg border border-slate-300 px-3 py-2" />
      <p className="text-xs text-slate-500">Choose six digits for your new number, or enter its existing PIN. Keep it safe; this is not the SMS code.</p>
      <button type="button" disabled={!ready || busy || !/^\d{6}$/.test(pin)} onClick={launch}
        className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {busy ? 'Connecting with Meta…' : ready ? 'Connect with Meta' : 'Preparing Meta login…'}
      </button>
    </>}
    {error ? <><p role="alert" className="text-xs text-red-600">{error}</p>
      <button type="button" onClick={() => { cleanup.current?.(); setReady(null); setError(null); setGeneration((value) => value + 1); }}
        className="text-sm text-blue-600">Prepare a new connection</button></> : null}
  </section>;
};
export default ConnectMetaButton;
