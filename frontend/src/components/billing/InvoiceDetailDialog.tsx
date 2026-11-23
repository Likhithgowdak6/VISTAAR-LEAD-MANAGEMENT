import { createPortal } from 'react-dom';
import { useCallback, useEffect, useState } from 'react';

import {
  cancelInvoice,
  downloadInvoicePdf,
  getInvoice,
  issueInvoice,
} from '../../api/billing';
import { useAuth } from '../../auth/AuthContext';
import { useMobileBackLayer } from '../../hooks/useMobileBackLayer';
import { useBillingModalFocus } from '../../hooks/useBillingModalFocus';
import { formatDate, formatRupees } from '../../lib/money';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import ConfirmDialog from '../ConfirmDialog';
import Spinner from '../Spinner';
import { errorMessage } from '../types';
import { type Invoice } from '../../types';
import InvoiceFormDialog from './InvoiceFormDialog';
import InvoiceStatusBadge from './InvoiceStatusBadge';
import PaymentLinksPanel from './PaymentLinksPanel';
import PaymentsPanel from './PaymentsPanel';

interface Props {
  invoiceId: string;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * One invoice, everything about it.
 *
 * NO SEND BUTTON ANYWHERE ON THIS SCREEN, and that is deliberate rather than unfinished.
 * Messaging a client about an invoice goes through the existing chase gate - the booking is won,
 * the event has finished, and the owner has confirmed the payment is pending - which lives in
 * the WhatsApp pipeline and has its own approval. A "send this invoice" button here would be a
 * second route to a customer's phone that bypasses quiet hours, opt-out and the owner's say-so.
 *
 * What this screen does instead is SHOW where the automated chase has got to, so somebody can
 * see that it is running without being able to push it.
 */
const InvoiceDetailDialog = ({ invoiceId, onClose, onChanged }: Props) => {
  useMobileBackLayer({ active: true, onBack: onClose });
  const { authedRequest, permissions } = useAuth();

  const canManage = hasPermission(permissions, PERMISSIONS.INVOICES_MANAGE);

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const modalRef = useBillingModalFocus(onClose, busy);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => getInvoice({ token, invoiceId }));
      setInvoice(payload.data);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load this invoice.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, invoiceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const run = async (action: () => Promise<Invoice>, success: string) => {
    setBusy(true);
    setError(null);

    try {
      setInvoice(await action());
      setNotice(success);
      onChanged();
    } catch (actionError: unknown) {
      setError(errorMessage(actionError, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  const handlePdf = async () => {
    setBusy(true);
    setError(null);

    try {
      const blob = await authedRequest((token) => downloadInvoicePdf({ token, invoiceId }));
      const url = URL.createObjectURL(blob);

      // Opened rather than force-downloaded: an owner checking what a client will see wants to
      // look at it, and the browser's own viewer offers the download.
      window.open(url, '_blank', 'noopener');

      // Revoked after the new tab has had a chance to take it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (pdfError: unknown) {
      setError(errorMessage(pdfError, 'Unable to produce the PDF.'));
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, value: string, emphasis = false) => (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
      {/* `whitespace-nowrap` for the same reason as the line totals: a rupee figure broken
          across two lines reads as two different numbers. */}
      <span
        className={
          emphasis
            ? 'whitespace-nowrap text-sm font-semibold text-slate-900 dark:text-slate-100'
            : 'whitespace-nowrap text-sm text-slate-700 dark:text-slate-300'
        }
      >
        {value}
      </span>
    </div>
  );

  return createPortal(
    <div
      role="dialog"
      ref={modalRef}
      aria-label="Invoice"
      data-mobile-sheet-backdrop
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-3 sm:p-6"
    >
      <div
        data-mobile-sheet
        className="w-full max-w-2xl rounded-2xl bg-white p-4 shadow-xl dark:bg-slate-900 sm:p-6"
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate font-mono text-base font-semibold text-slate-900 dark:text-slate-100">
              {invoice?.invoiceNumber ?? 'Draft invoice'}
            </h3>
            {invoice ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <InvoiceStatusBadge invoice={invoice} />
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>

        {loading ? (
          <div className="py-8">
            <Spinner label="Loading invoice…" />
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </p>
        ) : null}

        {notice ? (
          <p role="status" className="mb-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
            {notice}
          </p>
        ) : null}

        {invoice ? (
          <>
            <div className="mb-4 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {invoice.billTo?.name ?? 'No client name'}
              </p>
              {invoice.billTo?.gstin ? (
                <p className="font-mono text-xs text-slate-500 dark:text-slate-400">
                  {invoice.billTo.gstin}
                </p>
              ) : null}
              {invoice.billTo?.address ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {invoice.billTo.address}
                </p>
              ) : null}
            </div>

            {/*
              TWO LAYOUTS, BECAUSE FOUR MONEY COLUMNS DO NOT FIT A PHONE.

              The table was previously inside `overflow-hidden`, and at 375px the right-hand edge
              of the line total was simply cut off - a clipped figure on an invoice, which is the
              one thing this screen must never do. A horizontal scrollbar would technically
              expose it, but a scroll somebody has to discover is a poor way to show money, so
              below `sm` each line is stacked instead and every column is on screen at once.

              `whitespace-nowrap` on the amounts is what stops "₹1,77,000.00" being broken across
              two lines, which reads as two different numbers.
            */}
            <ul className="mb-4 rounded-xl border border-slate-200 dark:border-slate-800 sm:hidden">
              {invoice.items.map((item, index) => (
                <li
                  key={index}
                  className="border-b border-slate-100 p-3 last:border-b-0 dark:border-slate-800"
                >
                  <p className="break-words text-xs font-medium text-slate-900 dark:text-slate-100">
                    {item.description}
                    {item.hsnSacCode ? (
                      <span className="ml-1 font-normal text-slate-400">· {item.hsnSacCode}</span>
                    ) : null}
                  </p>

                  <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {item.quantity}
                      {item.unit ? ` ${item.unit}` : ''} × {formatRupees(item.rate)}
                    </span>
                    <span className="whitespace-nowrap text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {formatRupees(item.total)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>

            <div className="mb-4 hidden overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 sm:block">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2 font-medium">Description</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((item, index) => (
                    <tr key={index} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="break-words px-3 py-2 text-slate-700 dark:text-slate-300">
                        {item.description}
                        {item.hsnSacCode ? (
                          <span className="ml-1 text-slate-400">· {item.hsnSacCode}</span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-slate-600 dark:text-slate-400">
                        {item.quantity}
                        {item.unit ? ` ${item.unit}` : ''}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-slate-600 dark:text-slate-400">
                        {formatRupees(item.rate)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-slate-900 dark:text-slate-100">
                        {formatRupees(item.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mb-4 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
              {row('Taxable', formatRupees(invoice.taxable))}
              {invoice.discountPaise > 0 ? row('Discount', `− ${formatRupees(invoice.discount)}`) : null}
              {/* The GST split, shown the way it was charged rather than as one tax figure. */}
              {invoice.isInterstate
                ? row('IGST', formatRupees(invoice.igst))
                : (
                    <>
                      {row('CGST', formatRupees(invoice.cgst))}
                      {row('SGST', formatRupees(invoice.sgst))}
                    </>
                  )}
              {/* Shown so the figures visibly add up; the PDF prints the same line. */}
              {invoice.roundOffPaise !== 0 ? row('Round off', formatRupees(invoice.roundOff)) : null}
              {row('Total', formatRupees(invoice.total), true)}
              {invoice.amountPaidPaise > 0 ? row('Paid', `− ${formatRupees(invoice.amountPaid)}`) : null}
              {row('Balance', formatRupees(invoice.balance), true)}
            </div>

            <div className="mb-4 grid gap-1 rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-800">
              {row('Issued', formatDate(invoice.issuedAt))}
              {row('Due', formatDate(invoice.dueDate))}
              {invoice.paidAt ? row('Settled', formatDate(invoice.paidAt)) : null}
            </div>

            {/*
              REMINDER STATE IS READ-ONLY. It reports what the automated chase has done; there is
              no control here to start or advance it, because authorising a message to a customer
              belongs to the owner approval flow, not to this screen.
            */}
            {invoice.remindersSentCount > 0 ||
            invoice.promiseDate ||
            invoice.paymentFollowUp?.state ? (
              <div className="mb-4 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Payment chase
                </p>
                {row('Reminders sent', String(invoice.remindersSentCount))}
                {invoice.lastReminderAt ? row('Last reminder', formatDate(invoice.lastReminderAt)) : null}
                {invoice.promiseDate ? row('Client promised', formatDate(invoice.promiseDate)) : null}
                {invoice.paymentFollowUp?.state
                  ? row('State', String(invoice.paymentFollowUp.state))
                  : null}
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  Reminders are sent by the owner approval flow after a booking is won and its
                  event has finished. They cannot be started from here.
                </p>
              </div>
            ) : null}

            <PaymentsPanel
              invoice={invoice}
              onChanged={(updated) => {
                setInvoice(updated);
                onChanged();
              }}
            />

            <PaymentLinksPanel invoice={invoice} onChanged={load} />

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handlePdf}
                disabled={busy}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {busy ? 'Working…' : 'View PDF'}
              </button>

              {canManage && invoice.status === 'draft' ? (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    disabled={busy}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      run(
                        async () =>
                          (await authedRequest((token) => issueInvoice({ token, invoiceId }))).data,
                        'Invoice issued. The client has not been messaged.',
                      )
                    }
                    disabled={busy}
                    className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
                  >
                    Issue
                  </button>
                </>
              ) : null}

              {canManage && invoice.status !== 'cancelled' && invoice.status !== 'paid' ? (
                <button
                  type="button"
                  onClick={() => setConfirmCancel(true)}
                  disabled={busy}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-red-500/10"
                >
                  Cancel invoice
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          Close
        </button>
      </div>

      {editing && invoice ? (
        <InvoiceFormDialog
          invoice={invoice}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            setInvoice(updated);
            onChanged();
          }}
        />
      ) : null}

      {confirmCancel ? (
        <ConfirmDialog
          title="Cancel this invoice?"
          /* The number is kept on purpose, and saying so stops somebody expecting it back. */
          message="It keeps its number so the sequence has no gap anyone has to explain, and it stops being chased. This cannot be undone."
          confirmLabel="Cancel invoice"
          tone="danger"
          onCancel={() => setConfirmCancel(false)}
          onConfirm={() => {
            setConfirmCancel(false);
            void run(
              async () => (await authedRequest((token) => cancelInvoice({ token, invoiceId }))).data,
              'Invoice cancelled.',
            );
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
};

export default InvoiceDetailDialog;
