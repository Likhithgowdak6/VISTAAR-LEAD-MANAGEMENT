import { useCallback, useEffect, useRef, useState } from 'react';

import {
  listInvoicePayments,
  recordInvoicePayment,
  voidInvoicePayment,
} from '../../api/billing';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { formatDate, formatRupees, toAmountString } from '../../lib/money';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import ConfirmDialog from '../ConfirmDialog';
import { errorMessage } from '../types';
import { type Invoice, type Payment, type PaymentMode } from '../../types';

interface Props {
  invoice: Invoice;
  onChanged: (invoice: Invoice) => void;
}

const MODES: { value: PaymentMode; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'upi', label: 'UPI' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' },
];

/**
 * The payment ledger for one invoice, and the form that adds to it.
 *
 * `online` IS DELIBERATELY ABSENT from the modes somebody can choose. Money captured by the
 * provider is recorded by the webhook with the provider's own payment id, which is what makes it
 * impossible to double-count. Letting a human type an `online` payment by hand would create a
 * second row for the same money with no id to deduplicate against.
 *
 * VOIDED ROWS STAY VISIBLE, struck through. A ledger that hides a reversal is less useful than
 * one that shows it: "we recorded this, then took it back" is usually the thing somebody is
 * trying to understand.
 */
const PaymentsPanel = ({ invoice, onChanged }: Props) => {
  const { authedRequest, permissions } = useAuth();

  const canRecord = hasPermission(permissions, PERMISSIONS.PAYMENTS_RECORD);

  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [voidTarget, setVoidTarget] = useState<Payment | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PaymentMode>('cash');
  const [reference, setReference] = useState('');

  /**
   * The attempt whose outcome we do not know.
   *
   * The ref is the source of truth - it must survive a render without causing one, and two
   * submits must never read a stale copy. `held` mirrors it purely so the escape hatch below
   * can be rendered, because a ref change does not re-render.
   */
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);
  const [held, setHeld] = useState(false);

  const holdAttempt = (value: { key: string; fingerprint: string } | null) => {
    attempt.current = value;
    setHeld(value !== null);
  };

  const newAttemptKey = () => crypto.randomUUID();

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) =>
        listInvoicePayments({ token, invoiceId: invoice.id }),
      );
      setPayments(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load payments.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, invoice.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const submit = async () => {
    const parsed = toAmountString(amount);

    if (parsed === null) {
      setError('Enter an amount, like 1500 or 1500.50.');
      return;
    }

    /**
     * ONE KEY PER ATTEMPT, HELD ACROSS A RETRY, and cleared only on success.
     *
     * Hand-recorded money has no provider id to deduplicate on. A request that succeeds but
     * whose response is lost - a proxy timeout, a sleeping phone - leaves the person looking at
     * an error over money that WAS recorded; pressing Record again used to credit the client
     * twice, and the server's balance check only catches that when the repeat would exceed the
     * outstanding amount. Resending the same key makes the second press a no-op.
     *
     * Minted here rather than per render, for the same reason as payment links: a key that
     * changes on every render defeats the guarantee entirely.
     */
    const fingerprint = JSON.stringify([invoice.id, parsed, mode, reference.trim() || null]);

    // A HELD KEY BELONGS TO THE DETAILS IT WAS MINTED FOR. Reusing it for a different amount
    // would ask the server to deduplicate two genuinely different payments against one key,
    // which it refuses - so the ambiguity is explained here instead, where the ledger is on
    // screen. Only an attempt whose outcome is UNKNOWN is ever held; see the catch below.
    if (attempt.current && attempt.current.fingerprint !== fingerprint) {
      setError(
        'The last attempt may already have been recorded - we never got an answer. Retry it ' +
          'exactly as it was, or use the button below to check the ledger and start again.',
      );
      return;
    }

    const key = attempt.current?.key ?? newAttemptKey();
    holdAttempt({ key, fingerprint });

    setBusy(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        recordInvoicePayment({
          token,
          invoiceId: invoice.id,
          amount: parsed,
          mode,
          reference: reference.trim() || null,
          idempotencyKey: key,
        }),
      );

      onChanged(payload.data.invoice);
      holdAttempt(null);
      setAmount('');
      setReference('');
      setAdding(false);
      await load();
    } catch (saveError: unknown) {
      /**
       * WHICH FAILURES PROVE NOTHING WAS RECORDED - and the two 4xx codes that do not.
       *
       * "More than the balance outstanding" is the application answering: the request arrived,
       * was rejected before any insert, and wrote nothing. Releasing the key there lets someone
       * correct their own typo instead of being locked out of it.
       *
       * But a 4xx is NOT automatically the application's answer. A 408 says the request timed
       * out, and a 429 may come from a proxy in front of the app - in both cases an EARLIER
       * attempt may still be in flight or already committed, so the key must be held. Treating
       * every 4xx as proof of no write is exactly the assumption that double-credits a client.
       *
       * Anything else - a dropped connection, a 502, no response at all - is unknown by
       * definition and holds the key.
       */
      const AMBIGUOUS_STATUSES = [408, 429];

      const definitivelyRefused =
        saveError instanceof ApiError &&
        saveError.status >= 400 &&
        saveError.status < 500 &&
        !AMBIGUOUS_STATUSES.includes(saveError.status);

      if (definitivelyRefused) {
        holdAttempt(null);
      }

      // A conflict means a payment for this attempt ALREADY EXISTS with different details.
      // Reload so the person can see it rather than being told about it in the abstract.
      //
      // AWAITED BEFORE THE MESSAGE IS SET, not fired off: `load` clears the error on success,
      // so letting it settle afterwards would wipe the explanation off the screen.
      if (saveError instanceof ApiError && saveError.code === 'PAYMENT_ATTEMPT_CONFLICT') {
        await load();
      }

      // The server's own message already explains the refusal - surfaced as written rather
      // than replaced with a generic failure.
      setError(errorMessage(saveError, 'Unable to record that payment.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmVoid = async () => {
    if (!voidTarget) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        voidInvoicePayment({
          token,
          invoiceId: invoice.id,
          paymentId: voidTarget.id,
          reason: voidReason.trim() || null,
        }),
      );

      onChanged(payload.data.invoice);
      setVoidTarget(null);
      setVoidReason('');
      await load();
    } catch (voidError: unknown) {
      setError(errorMessage(voidError, 'Unable to reverse that payment.'));
    } finally {
      setBusy(false);
    }
  };

  const field =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

  return (
    <div className="mb-4 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Payments
        </p>

        {canRecord && invoice.status !== 'draft' && invoice.status !== 'cancelled' ? (
          <button
            type="button"
            onClick={() => setAdding((open) => !open)}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {adding ? 'Close' : 'Record payment'}
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mb-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      {/*
        THE WAY OUT OF AN UNKNOWN OUTCOME, and the only one offered.

        Closing and reopening the form deliberately does NOT discard a held attempt - that would
        silently hand back a fresh key and let the same money be recorded twice. So the escape
        has to be explicit, and it has to show the evidence first: reloading the ledger answers
        whether the payment actually landed, and only then is the key released.
      */}
      {held ? (
        <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 p-2 dark:border-amber-500/40 dark:bg-amber-500/10">
          <button
            type="button"
            onClick={() => {
              holdAttempt(null);
              setError(null);
              void load();
            }}
            disabled={busy}
            className="rounded-lg border border-amber-400 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/50 dark:text-amber-200 dark:hover:bg-amber-500/20"
          >
            Reload ledger and start a new payment
          </button>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
            Reloading shows whether that payment landed. If it is listed below, it is already
            recorded — do not enter it again. Anything you record after this is a separate
            payment.
          </p>
        </div>
      ) : null}

      {adding ? (
        <div className="mb-3 grid gap-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-800 sm:grid-cols-4">
          <div className="sm:col-span-1">
            <label htmlFor="pay-amount" className="mb-1 block text-xs text-slate-600 dark:text-slate-400">
              Amount (₹)
            </label>
            <input
              id="pay-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={invoice.balance}
              className={field}
            />
          </div>

          <div className="sm:col-span-1">
            <label htmlFor="pay-mode" className="mb-1 block text-xs text-slate-600 dark:text-slate-400">
              How
            </label>
            <select
              id="pay-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as PaymentMode)}
              className={field}
            >
              {MODES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-1">
            <label htmlFor="pay-ref" className="mb-1 block text-xs text-slate-600 dark:text-slate-400">
              Reference
            </label>
            <input
              id="pay-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="UTR, cheque no."
              className={field}
            />
          </div>

          <div className="flex items-end sm:col-span-1">
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
            >
              {busy ? 'Saving…' : 'Record'}
            </button>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-4">
            {formatRupees(invoice.balance)} outstanding. Payments taken through a payment link
            are recorded automatically and do not need entering here.
          </p>
        </div>
      ) : null}

      {loading ? (
        <p className="py-2 text-xs text-slate-400">Loading…</p>
      ) : payments.length === 0 ? (
        <p className="py-2 text-xs text-slate-500 dark:text-slate-400">Nothing received yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {payments.map((payment) => (
            <li key={payment.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span
                  className={`block text-sm font-medium ${
                    payment.isVoided
                      ? 'text-slate-400 line-through'
                      : 'text-slate-900 dark:text-slate-100'
                  }`}
                >
                  {formatRupees(payment.amount)}
                </span>
                <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                  {formatDate(payment.paidAt)}
                  {payment.mode ? ` · ${payment.mode.replace('_', ' ')}` : ''}
                  {payment.isProviderPayment ? ' · online' : ''}
                  {payment.reference ? ` · ${payment.reference}` : ''}
                </span>
                {payment.isVoided ? (
                  <span className="block text-xs text-red-600 dark:text-red-400">
                    Reversed{payment.voidReason ? `: ${payment.voidReason}` : ''}
                  </span>
                ) : null}
              </span>

              {canRecord && !payment.isVoided ? (
                <button
                  type="button"
                  onClick={() => setVoidTarget(payment)}
                  className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-slate-700 dark:hover:bg-red-500/10"
                >
                  Reverse
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {voidTarget ? (
        <ConfirmDialog
          title={`Reverse ${formatRupees(voidTarget.amount)}?`}
          message="The row stays in the ledger marked as reversed, and the invoice balance goes back up. If this invoice was settled, it becomes owed again."
          confirmLabel="Reverse payment"
          tone="danger"
          busy={busy}
          onCancel={() => {
            setVoidTarget(null);
            setVoidReason('');
          }}
          onConfirm={confirmVoid}
        />
      ) : null}
    </div>
  );
};

export default PaymentsPanel;
