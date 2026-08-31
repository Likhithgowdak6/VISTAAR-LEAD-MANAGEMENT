import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { connectAccount, getAccount, getAccountQr, resetAccount } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import Spinner from '../Spinner';
import { type AuthValue, errorMessage, type WhatsAppAccount } from '../types';

const POLL_MS = 2000;
const SLOW_HINT_MS = 15000;

type ConnectMode = 'qr' | 'phone';

type Props = {
  account: WhatsAppAccount;
  onClose: () => void;
  onConnected?: () => void;
};

const ConnectQrModal = ({ account, onClose, onConnected }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [mode, setMode] = useState<ConnectMode>('qr');
  const [phone, setPhone] = useState('');
  const [phoneSubmitted, setPhoneSubmitted] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(account.status);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const startedAt = useRef(0);

  const initiate = useCallback(
    async (pairingPhoneNumber?: string) => {
      setError(null);
      try {
        await authedRequest((token) =>
          connectAccount({ token, accountId: account.id, pairingPhoneNumber }),
        );
      } catch (connectError: unknown) {
        setError(errorMessage(connectError, 'Unable to start the connection.'));
      }
    },
    [authedRequest, account.id],
  );

  // Start in QR mode when the modal opens.
  useEffect(() => {
    startedAt.current = Date.now();
    // Kick off the connection; state updates happen after the awaited request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    initiate(undefined);
  }, [initiate]);

  const poll = useCallback(async () => {
    try {
      const [accountPayload, connPayload] = await Promise.all([
        authedRequest((token) => getAccount({ token, accountId: account.id })),
        authedRequest((token) => getAccountQr({ token, accountId: account.id })),
      ]);
      setStatus((accountPayload?.data?.status as string | undefined) ?? null);
      setQrDataUrl((connPayload?.data?.qrDataUrl as string | undefined) ?? null);
      setPairingCode((connPayload?.data?.pairingCode as string | undefined) ?? null);
      if (Date.now() - startedAt.current > SLOW_HINT_MS) {
        setSlow(true);
      }
    } catch (pollError: unknown) {
      setError(errorMessage(pollError, 'Unable to load the connection.'));
    }
  }, [authedRequest, account.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  useEffect(() => {
    if (status === 'active') {
      onConnected?.();
    }
  }, [status, onConnected]);

  const switchToPhone = async () => {
    setError(null);
    setQrDataUrl(null);
    setPairingCode(null);
    setPhoneSubmitted(false);
    // Drop the QR session so the phone-pairing attempt starts fresh.
    await authedRequest((token) => resetAccount({ token, accountId: account.id })).catch(() => {});
    setMode('phone');
  };

  const switchToQr = async () => {
    setError(null);
    setQrDataUrl(null);
    setPairingCode(null);
    await authedRequest((token) => resetAccount({ token, accountId: account.id })).catch(() => {});
    setMode('qr');
    startedAt.current = Date.now();
    initiate(undefined);
  };

  const submitPhone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (phone.trim() === '') {
      return;
    }
    setPhoneSubmitted(true);
    startedAt.current = Date.now();
    await initiate(phone.trim());
  };

  const renderBody = () => {
    if (status === 'active') {
      return (
        <div className="py-8 text-center">
          <p className="text-lg font-semibold text-green-600">Connected ✓</p>
          <p className="mt-1 text-sm text-slate-500">This number is now live.</p>
        </div>
      );
    }

    if (mode === 'phone') {
      if (!phoneSubmitted) {
        return (
          <form onSubmit={submitPhone} className="space-y-2 py-2">
            <label htmlFor="pair-phone" className="block text-sm font-medium text-slate-700">
              WhatsApp number
            </label>
            <input
              id="pair-phone"
              type="tel"
              placeholder="919876543210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />
            <p className="text-xs text-slate-500">
              Full international format: country code + number, digits only, no leading zero (e.g.
              India <span className="font-mono">91</span> + your 10-digit number). It must be the
              exact WhatsApp number on the phone you're linking.
            </p>
            <button
              type="submit"
              disabled={phone.trim() === ''}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
            >
              Get code
            </button>
          </form>
        );
      }

      if (pairingCode) {
        return (
          <div className="py-2 text-center">
            <p className="text-sm text-slate-600">
              Code for <span className="font-mono font-semibold">{phone}</span>
            </p>
            <p className="my-3 select-all font-mono text-2xl font-bold tracking-widest text-slate-900">
              {pairingCode}
            </p>
            <p className="text-xs text-slate-500">
              On <strong>that exact</strong> WhatsApp number: Settings → Linked devices → Link a
              device → <em>Link with phone number instead</em> → enter the code above. If it says
              &ldquo;check the phone number&rdquo;, the number above doesn&rsquo;t match this
              phone&rsquo;s WhatsApp — go back and fix it.
            </p>
            <p className="mt-2 text-xs text-slate-400">status: {status}</p>
          </div>
        );
      }

      return (
        <div className="flex flex-col items-center gap-2 py-8">
          <Spinner label="Requesting code…" />
          <p className="text-xs text-slate-400">status: {status ?? 'starting'}</p>
        </div>
      );
    }

    if (qrDataUrl) {
      return (
        <div className="text-center">
          <img src={qrDataUrl} alt="WhatsApp QR code" className="mx-auto h-64 w-64" />
          <p className="mt-3 text-sm text-slate-600">
            Scan with the <strong>disposable</strong> WhatsApp number — never a personal or client
            number.
          </p>
          <p className="mt-1 text-xs text-slate-400">Waiting for the scan… status: {status}</p>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center gap-2 py-8">
        <Spinner label="Generating QR…" />
        <p className="text-xs text-slate-400">status: {status ?? 'starting'}</p>
        {slow ? (
          <p className="mt-2 max-w-xs text-center text-xs text-amber-600">
            Still waiting for a QR. Check the backend terminal for a WhatsApp/Baileys error, and
            confirm the backend was restarted with WHATSAPP_ENABLED=true.
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-label={`Connect ${account.name}`}
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">Connect {account.name}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            ×
          </button>
        </div>

        {renderBody()}

        {status !== 'active' ? (
          <div className="mt-3 text-center">
            {mode === 'qr' ? (
              <button
                type="button"
                onClick={switchToPhone}
                className="text-xs font-medium text-blue-600 hover:text-blue-700"
              >
                Link with phone number instead
              </button>
            ) : (
              <button
                type="button"
                onClick={switchToQr}
                className="text-xs font-medium text-blue-600 hover:text-blue-700"
              >
                Use QR code instead
              </button>
            )}
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="mt-2 text-center text-xs text-red-600">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Close
        </button>
      </div>
    </div>
  );
};

export default ConnectQrModal;
