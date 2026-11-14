import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/client';
import { useAuth } from '../auth/AuthContext';

type GoogleApi = { accounts: { id: {
  initialize: (options: { client_id: string; nonce: string; callback: (result: { credential: string }) => void }) => void;
  renderButton: (element: HTMLElement, options: Record<string, unknown>) => void;
} } };

type LoginResult = { data: { selectionRequired?: boolean; workspaces?: { id: string; name: string }[] } };

export default function GoogleSignIn({ clientId, inviteCode }: { clientId: string; inviteCode: string }) {
  const { acceptSession } = useAuth();
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [credential, setCredential] = useState('');
  const [choices, setChoices] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const submit = async (token: string, organizationId?: string) => {
      setBusy(true); setError('');
      try {
        const result = await apiFetch<LoginResult>('/auth/google', { method: 'POST',
          body: { credential: token, organizationId, inviteCode } });
        if (!active) return;
        if (result.data.selectionRequired) { setCredential(token); setChoices(result.data.workspaces ?? []); }
        else acceptSession(result);
      } catch (err) { if (active) setError(err instanceof Error ? err.message : 'Google sign-in failed.'); }
      finally { if (active) setBusy(false); }
    };
    void (async () => {
      try {
        const { data } = await apiFetch<{ data: { nonce: string } }>('/auth/google/nonce', { signal: controller.signal });
        if (!active) return;
        const initialize = () => {
          const google = (window as Window & { google?: GoogleApi }).google;
          if (!active || !google || !container.current) return;
          google.accounts.id.initialize({ client_id: clientId, nonce: data.nonce,
            callback: (result) => { void submit(result.credential); } });
          google.accounts.id.renderButton(container.current, { theme: 'outline', size: 'large',
            text: 'continue_with', shape: 'pill', width: Math.min(340, container.current.clientWidth || 280) });
        };
        if ((window as Window & { google?: GoogleApi }).google) initialize();
        else {
          const script = document.createElement('script');
          script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
          script.onload = initialize;
          script.onerror = () => { if (active) setError('Unable to load Google sign-in.'); };
          document.head.appendChild(script);
        }
      } catch (err) { if (active) setError(err instanceof Error ? err.message : 'Google sign-in unavailable.'); }
    })();
    return () => { active = false; controller.abort(); };
  }, [clientId, inviteCode, acceptSession, attempt]);
  const choose = async (id: string) => {
    setBusy(true); setError('');
    try { acceptSession(await apiFetch('/auth/google', { method: 'POST', body: { credential, organizationId: id, inviteCode } })); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to open workspace.'); }
    finally { setBusy(false); }
  };
  return <div className="mb-5 space-y-3">
    <div ref={container} className="flex justify-center" aria-label="Continue with Google" />
    {busy ? <p role="status" className="text-center text-xs text-slate-500">Signing in...</p> : null}
    {choices.length ? <div className="space-y-2"><p className="text-sm text-slate-500">Choose your workspace</p>
      {choices.map((choice) => <button key={choice.id} type="button" disabled={busy} onClick={() => void choose(choice.id)}
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900">{choice.name}</button>)}
    </div> : null}
    {error ? <><p role="alert" className="text-xs text-red-600">{error}</p><button type="button"
      onClick={() => { setError(''); setChoices([]); setAttempt((value) => value + 1); }} className="text-xs text-blue-600">Try Google again</button></> : null}
  </div>;
}
