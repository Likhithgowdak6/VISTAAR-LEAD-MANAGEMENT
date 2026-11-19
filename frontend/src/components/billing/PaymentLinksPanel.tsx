import { useCallback, useEffect, useState } from 'react';

import {
  cancelPaymentLink,
  createPaymentLink,
  listPaymentLinks,
  reconcilePaymentLink,
} from '../../api/billing';
import { useAuth } from '../../auth/AuthContext';
import { formatDate, formatRupees } from '../../lib/money';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import ConfirmDialog from '../ConfirmDialog';
import { errorMessage } from '../types';
import { type Invoice, type PaymentLink } from '../../types';

interface Props {
  invoice: Invoice;
  onChanged: () => void;
}

const STATE_TONE: Record<string, string> = {
  created: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300',
  creating: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  unknown: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  paid: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  cancelled: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  expired: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  failed: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
};

/**
 * Razorpay payment links for one invoice.
 *
 * THE IDEMPOTENCY KEY IS MINTED ONCE PER ATTEMPT, not per render. The server refuses the same
 * key with a different amount, which is what stops a retry after a timeout quietly opening a
 * second link for one debt - but only if the client sends the same key when retrying the same
 * request. A key regenerated on each render would defeat that entirely.
 *
 * RECONCILE EXISTS BECAUSE WEBHOOKS GET LOST. It asks Razorpay what actually happened to a link,
 * and records any payment the webhook never delivered. Safe to press repeatedly: recording goes
 * through the same deduplicating ledger as the webhook.
 */
const PaymentLinksPanel = ({ invoice, onChanged }: Props) => {
  const { authedRequest, permissions } = useAuth();

  const canManage = hasPermission(permissions, PERMISSIONS.INVOICES_MANAGE);

  const [links, setLinks] = useState<PaymentLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyAvailable, setHistoryAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<PaymentLink | null>(null);

  /** Held in state so a retry of the SAME attempt reuses it. Cleared only on success. */
  const [attemptKey, setAttemptKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) =>
        listPaymentLinks({ token, invoiceId: invoice.id }),
      );
      setLinks(payload.data ?? []);
      setHistoryAvailable(true);
      setError(null);
    } catch (loadError: unknown) {
      setHistoryAvailable(false);
      setError(errorMessage(loadError, 'Unable to load payment links. Check the history before creating another link.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, invoice.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const newKey = () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `lnk-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const handleCreate = async () => {
    const key = attemptKey ?? newKey();
    setAttemptKey(key);

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const payload = await authedRequest((token) =>
        createPaymentLink({ token, invoiceId: invoice.id, idempotencyKey: key }),
      );

      if (payload.data.state === 'created') {
        setAttemptKey(null);
        setNotice('Payment link created. Nothing has been sent to the client.');
      } else {
        setNotice('Razorpay has not confirmed a usable link. Check with Razorpay before creating another link.');
      }
      await load();
      onChanged();
    } catch (createError: unknown) {
      setError(errorMessage(createError, 'Unable to create a payment link.'));
    } finally {
      setBusy(false);
    }
  };

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await action();
      setNotice(success);
      await load();
      onChanged();
    } catch (actionError: unknown) {
      setError(errorMessage(actionError, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  const hasOpenLink = links.some((link) => ['creating', 'created', 'unknown'].includes(link.state));

  return (
    <div className="mb-4 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Payment links
        </p>

        {canManage &&
        invoice.status !== 'draft' &&
        invoice.status !== 'cancelled' &&
        invoice.balancePaise > 0 &&
        !hasOpenLink && historyAvailable ? (
          <button
            type="button"
            onClick={handleCreate}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {busy ? 'Working…' : 'Create link'}
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mb-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p role="status" className="mb-2 text-xs text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      ) : null}

      {loading ? (
        <p className="py-2 text-xs text-slate-400">Loading…</p>
      ) : links.length === 0 ? (
        <p className="py-2 text-xs text-slate-500 dark:text-slate-400">
          No payment links. Creating one gives the client a way to pay; it does not message them.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {links.map((link) => (
            <li key={link.id} className="py-2">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {formatRupees(String(link.amountPaise / 100))}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        STATE_TONE[link.state] ?? STATE_TONE.cancelled
                      }`}
                    >
                      {link.state}
                    </span>
                    {/* Test keys and live keys look identical in a URL; saying which avoids
                        somebody chasing a client with a link that cannot take real money. */}
                    {!link.isLive ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                        Test mode
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                    {formatDate(link.createdAt)}
                  </span>
                  {link.lastError ? (
                    <span className="mt-0.5 block text-xs text-red-600 dark:text-red-400">
                      {link.lastError}
                    </span>
                  ) : null}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                {link.url ? (
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:border-slate-700 dark:hover:bg-blue-500/10"
                  >
                    Open link
                  </a>
                ) : null}

                {canManage ? (
                  <button
                    type="button"
                    onClick={() =>
                      run(
                        () =>
                          authedRequest((token) =>
                            reconcilePaymentLink({
                              token,
                              invoiceId: invoice.id,
                              linkId: link.id,
                            }),
                          ),
                        'Checked with Razorpay.',
                      )
                    }
                    disabled={busy}
                    className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    Check status
                  </button>
                ) : null}

                {canManage && link.state === 'created' ? (
                  <button
                    type="button"
                    onClick={() => setCancelTarget(link)}
                    disabled={busy}
                    className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-red-500/10"
                  >
                    Cancel link
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {cancelTarget ? (
        <ConfirmDialog
          title="Cancel this payment link?"
          /* It reconciles first, so a payment already made is recorded rather than lost. */
          message="Razorpay is checked for any payment already made before the link is closed. Anyone holding the link will no longer be able to pay through it."
          confirmLabel="Cancel link"
          tone="danger"
          busy={busy}
          onCancel={() => setCancelTarget(null)}
          onConfirm={() => {
            const target = cancelTarget;
            setCancelTarget(null);
            void run(
              () =>
                authedRequest((token) =>
                  cancelPaymentLink({ token, invoiceId: invoice.id, linkId: target.id }),
                ),
              'Payment link cancelled.',
            );
          }}
        />
      ) : null}
    </div>
  );
};

export default PaymentLinksPanel;
