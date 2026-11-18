/**
 * Connecting a number through Meta's official Cloud API.
 *
 * The QR modal next door polls and waits, because pairing is something the phone does. This one
 * is a form, because the Cloud API has no handshake: three values are pasted, the server spends
 * them on a real Graph call, and either the number is connected or it is not.
 *
 * The verified name coming back is the point of that round trip. The most likely mistake here is
 * not a bad token - that fails loudly - but the RIGHT token with the WRONG phone number id, which
 * otherwise connects cleanly and sends from somebody else's number. Showing the name Meta
 * returned is what lets an admin catch it in the two seconds before anybody notices.
 */
import { type FormEvent, useState } from 'react';

import { connectCloudAccount } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { useMobileBackLayer } from '../../hooks/useMobileBackLayer';
import { type AuthValue, errorMessage, type WhatsAppAccount } from '../types';

type Props = {
  account: WhatsAppAccount;
  onClose: () => void;
  onConnected?: () => void;
};

type CloudForm = {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
};

const EMPTY: CloudForm = { phoneNumberId: '', wabaId: '', accessToken: '' };

/** Meta shows these as digit strings; anything else is a paste that picked up extra characters. */
const isMetaId = (value: string): boolean => /^\d{5,32}$/.test(value.trim());

const ConnectCloudModal = ({ account, onClose, onConnected }: Props) => {
  useMobileBackLayer({ active: true, onBack: onClose });
  const { authedRequest } = useAuth() as AuthValue;

  const [form, setForm] = useState<CloudForm>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<WhatsAppAccount | null>(null);

  const update = (field: keyof CloudForm) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  const idsLookValid = isMetaId(form.phoneNumberId) && isMetaId(form.wabaId);
  const canSubmit = idsLookValid && form.accessToken.trim().length >= 20 && !saving;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await authedRequest((token) =>
        connectCloudAccount({
          token,
          accountId: account.id,
          phoneNumberId: form.phoneNumberId.trim(),
          wabaId: form.wabaId.trim(),
          accessToken: form.accessToken.trim(),
        }),
      );

      // Cleared the moment the request resolves. The token has done its job and there is no
      // reason for it to sit in component state while the success panel is on screen.
      setForm(EMPTY);
      setConnected(response.data);
      onConnected?.();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, 'Unable to connect this number.'));
    } finally {
      setSaving(false);
    }
  };

  const renderBody = () => {
    if (connected) {
      return (
        <div className="py-6 text-center">
          <p className="text-lg font-semibold text-green-600">Connected ✓</p>
          {/* The confirmation that matters: which number this actually is. */}
          {connected.cloud?.verifiedName ? (
            <p className="mt-2 text-sm font-medium text-slate-900">
              {connected.cloud.verifiedName}
            </p>
          ) : null}
          {connected.cloud?.displayPhoneNumber ? (
            <p className="font-mono text-sm text-slate-600">
              {connected.cloud.displayPhoneNumber}
            </p>
          ) : null}
          <p className="mt-3 text-xs text-slate-500">
            If that is not the right number, disconnect it and paste the correct phone number ID.
          </p>
        </div>
      );
    }

    return (
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label
            htmlFor="cloud-phone-number-id"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Phone number ID
          </label>
          <input
            id="cloud-phone-number-id"
            inputMode="numeric"
            autoComplete="off"
            placeholder="109876543210987"
            value={form.phoneNumberId}
            onChange={(event) => update('phoneNumberId')(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">
            Meta dashboard → WhatsApp → API Setup. It is the long number under your test or live
            number, not the phone number itself.
          </p>
        </div>

        <div>
          <label htmlFor="cloud-waba-id" className="mb-1 block text-xs font-medium text-slate-600">
            WhatsApp Business Account ID
          </label>
          <input
            id="cloud-waba-id"
            inputMode="numeric"
            autoComplete="off"
            placeholder="102233445566778"
            value={form.wabaId}
            onChange={(event) => update('wabaId')(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">
            On the same screen. This is what lets the app list your message templates.
          </p>
        </div>

        <div>
          <label htmlFor="cloud-token" className="mb-1 block text-xs font-medium text-slate-600">
            Access token
          </label>
          <textarea
            id="cloud-token"
            rows={3}
            autoComplete="off"
            spellCheck={false}
            value={form.accessToken}
            onChange={(event) => update('accessToken')(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">
            Use a <strong>permanent</strong> System User token. The temporary one on the API Setup
            screen expires in 24 hours and messages will stop without warning.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            It is encrypted before it is stored and is never shown again — only its last four
            characters.
          </p>
        </div>

        {form.phoneNumberId.trim() !== '' && !isMetaId(form.phoneNumberId) ? (
          <p className="text-xs text-amber-700">
            A phone number ID is digits only. Check for a stray space or line break in the paste.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
        >
          {saving ? 'Checking with Meta…' : 'Connect'}
        </button>
      </form>
    );
  };

  return (
    <div
      role="dialog"
      aria-label={`Connect ${account.name} to the WhatsApp Cloud API`}
      data-mobile-sheet-backdrop
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div data-mobile-sheet className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">Connect {account.name}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            ×
          </button>
        </div>

        {renderBody()}

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          {connected ? 'Done' : 'Cancel'}
        </button>
      </div>
    </div>
  );
};

export default ConnectCloudModal;
