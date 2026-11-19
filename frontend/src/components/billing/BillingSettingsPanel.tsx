import { useCallback, useEffect, useState } from 'react';

import {
  connectRazorpay,
  getBillingProfile,
  getRazorpayConnection,
  updateBillingProfile,
} from '../../api/billing';
import { useAuth } from '../../auth/AuthContext';
import { formatDate } from '../../lib/money';
import Spinner from '../Spinner';
import { errorMessage } from '../types';
import { type BillingProfile, type RazorpayConnection } from '../../types';

const EMPTY: BillingProfile = {
  companyName: null,
  gstin: null,
  state: null,
  address: null,
  bankName: null,
  bankAccountName: null,
  bankAccountNumber: null,
  bankIfsc: null,
  upiId: null,
  invoicePrefix: null,
};

/**
 * The business's own billing identity, and the payment provider connection.
 *
 * THE PROFILE SAVE IS A WHOLE-PROFILE REPLACE, matching the API: clearing a field means sending
 * it empty, so the form always submits every field. A partial save would make removing a GSTIN
 * impossible to express, and an invoice would keep printing one the admin believed they had
 * deleted.
 *
 * NEITHER RAZORPAY SECRET IS EVER READ BACK. The connection panel can say whether it is
 * connected and which key id, and nothing else - rotating means pasting a new pair. There is no
 * endpoint that returns a secret, so there is nothing here to accidentally render.
 */
const BillingSettingsPanel = () => {
  const { authedRequest } = useAuth();

  const [profile, setProfile] = useState<BillingProfile>(EMPTY);
  const [connection, setConnection] = useState<RazorpayConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [profilePayload, connectionPayload] = await Promise.all([
        authedRequest((token) => getBillingProfile({ token })),
        authedRequest((token) => getRazorpayConnection({ token })).catch(() => null),
      ]);

      setProfile({ ...EMPTY, ...(profilePayload.data ?? {}) });
      setConnection(connectionPayload?.data ?? null);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load billing settings.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const update = (key: keyof BillingProfile) => (value: string) =>
    setProfile((current) => ({ ...current, [key]: value === '' ? null : value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const payload = await authedRequest((token) => updateBillingProfile({ token, ...profile }));

      setProfile({ ...EMPTY, ...(payload.data ?? {}) });
      setSaved(true);
    } catch (saveError: unknown) {
      // The server's validation messages are written for whoever is reading the screen - "That
      // is not a valid GSTIN. It is 15 characters, like 29ABCDE1234F1Z5." - so they are shown
      // as written rather than replaced.
      setError(errorMessage(saveError, 'Unable to save.'));
    } finally {
      setSaving(false);
    }
  };

  const connect = async () => {
    setConnecting(true);
    setConnectError(null);

    try {
      const payload = await authedRequest((token) =>
        connectRazorpay({
          token,
          keyId: keyId.trim(),
          keySecret: keySecret.trim(),
          webhookSecret: webhookSecret.trim(),
        }),
      );

      setConnection(payload.data);
      // Cleared the moment the request resolves - there is no reason for a key secret to sit in
      // component state while a success panel is on screen.
      setKeyId('');
      setKeySecret('');
      setWebhookSecret('');
    } catch (connectFailure: unknown) {
      setConnectError(errorMessage(connectFailure, 'Unable to connect Razorpay.'));
    } finally {
      setConnecting(false);
    }
  };

  const field =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';
  const label = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400';

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <Spinner label="Loading billing settings…" />
      </div>
    );
  }

  const webhookUrl = connection?.webhookUrl ?? null;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Your billing details
        </h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Printed on every invoice you issue.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="bp-company" className={label}>
              Business name
            </label>
            <input
              id="bp-company"
              value={profile.companyName ?? ''}
              onChange={(e) => update('companyName')(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="bp-gstin" className={label}>
              GSTIN
            </label>
            <input
              id="bp-gstin"
              value={profile.gstin ?? ''}
              onChange={(e) => update('gstin')(e.target.value)}
              placeholder="29ABCDE1234F1Z5"
              className={`${field} font-mono`}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Without one, invoices are headed &ldquo;Invoice&rdquo; rather than &ldquo;Tax
              Invoice&rdquo;.
            </p>
          </div>

          <div>
            <label htmlFor="bp-state" className={label}>
              State
            </label>
            <input
              id="bp-state"
              value={profile.state ?? ''}
              onChange={(e) => update('state')(e.target.value)}
              placeholder="Karnataka"
              className={field}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Decides CGST + SGST or IGST on every invoice. Not cosmetic.
            </p>
          </div>

          <div>
            <label htmlFor="bp-prefix" className={label}>
              Invoice prefix
            </label>
            <input
              id="bp-prefix"
              value={profile.invoicePrefix ?? ''}
              onChange={(e) => update('invoicePrefix')(e.target.value.toUpperCase())}
              placeholder="INV"
              className={`${field} font-mono`}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Numbers look like PREFIX-2026-0001.
            </p>
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="bp-address" className={label}>
              Address
            </label>
            <input
              id="bp-address"
              value={profile.address ?? ''}
              onChange={(e) => update('address')(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="bp-bank" className={label}>
              Bank name
            </label>
            <input
              id="bp-bank"
              value={profile.bankName ?? ''}
              onChange={(e) => update('bankName')(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="bp-acct-name" className={label}>
              Account name
            </label>
            <input
              id="bp-acct-name"
              value={profile.bankAccountName ?? ''}
              onChange={(e) => update('bankAccountName')(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="bp-acct" className={label}>
              Account number
            </label>
            <input
              id="bp-acct"
              inputMode="numeric"
              value={profile.bankAccountNumber ?? ''}
              onChange={(e) => update('bankAccountNumber')(e.target.value)}
              className={`${field} font-mono`}
            />
          </div>

          <div>
            <label htmlFor="bp-ifsc" className={label}>
              IFSC
            </label>
            <input
              id="bp-ifsc"
              value={profile.bankIfsc ?? ''}
              onChange={(e) => update('bankIfsc')(e.target.value.toUpperCase())}
              placeholder="HDFC0001234"
              className={`${field} font-mono`}
            />
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="bp-upi" className={label}>
              UPI id
            </label>
            <input
              id="bp-upi"
              value={profile.upiId ?? ''}
              onChange={(e) => update('upiId')(e.target.value)}
              placeholder="business@okbank"
              className={field}
            />
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        {saved ? (
          <p role="status" className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">
            Saved.
          </p>
        ) : null}

        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
        >
          {saving ? 'Saving…' : 'Save billing details'}
        </button>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Razorpay
          </h3>

          {connection?.connected ? (
            <span className="flex items-center gap-2">
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                Connected
              </span>
              {/* Live and test keys look identical; saying which avoids somebody believing
                  they have taken real money when they have not, or the reverse. */}
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  connection.isLive
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
                    : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
                }`}
              >
                {connection.isLive ? 'Live' : 'Test mode'}
              </span>
            </span>
          ) : null}
        </div>

        {connection?.connected ? (
          <p className="mt-1 font-mono text-xs text-slate-500 dark:text-slate-400">
            {connection.keyId}
            {connection.connectedAt ? ` · since ${formatDate(connection.connectedAt)}` : ''}
          </p>
        ) : (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Connect Razorpay to give clients a link they can pay through. Without it, invoices
            and payments still work; you record what arrives by hand.
          </p>
        )}

        {webhookUrl ? (
          <div className="mt-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
            <p className={label}>Webhook URL</p>
            <p className="break-all font-mono text-xs text-slate-700 dark:text-slate-300">
              {webhookUrl}
            </p>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(webhookUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="mt-2 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-white dark:border-slate-700 dark:text-slate-300"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Paste this into Razorpay&rsquo;s webhook settings and subscribe to payment events.
              Until you do, payments will not be recorded automatically.
            </p>
          </div>
        ) : null}

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="rz-key" className={label}>
              Key ID
            </label>
            <input
              id="rz-key"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              placeholder="rzp_live_XXXXXXXX"
              autoComplete="off"
              className={`${field} font-mono`}
            />
          </div>

          <div>
            <label htmlFor="rz-secret" className={label}>
              Key secret
            </label>
            <input
              id="rz-secret"
              type="password"
              value={keySecret}
              onChange={(e) => setKeySecret(e.target.value)}
              autoComplete="off"
              className={`${field} font-mono`}
            />
          </div>

          <div>
            <label htmlFor="rz-webhook" className={label}>
              Webhook secret
            </label>
            <input
              id="rz-webhook"
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              autoComplete="off"
              className={`${field} font-mono`}
            />
          </div>
        </div>

        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Both secrets are encrypted before they are stored and are never shown again. To change
          them, paste a new pair.
        </p>

        {connectError ? (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {connectError}
          </p>
        ) : null}

        <button
          type="button"
          onClick={connect}
          disabled={
            connecting ||
            keyId.trim() === '' ||
            keySecret.trim() === '' ||
            webhookSecret.trim() === ''
          }
          className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
        >
          {connecting ? 'Checking…' : connection?.connected ? 'Replace credentials' : 'Connect'}
        </button>
      </section>
    </div>
  );
};

export default BillingSettingsPanel;
