import { type Invoice } from '../../types';

/**
 * An invoice's state, as one badge.
 *
 * OVERDUE IS NOT A STATUS and is shown as its own badge beside the real one. The backend derives
 * it from the due date and the balance rather than storing it, precisely so the two can never
 * disagree - collapsing them here into a single "overdue" chip would hide whether the invoice
 * was issued or merely sent, which is what decides what to do about it.
 */
const TONE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  issued: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300',
  sent: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300',
  paid: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  cancelled: 'bg-slate-100 text-slate-500 line-through dark:bg-slate-800 dark:text-slate-500',
};

const LABEL: Record<string, string> = {
  draft: 'Draft',
  issued: 'Issued',
  sent: 'Sent',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

const InvoiceStatusBadge = ({ invoice }: { invoice: Invoice }) => {
  const status = invoice.status;

  return (
    <>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          TONE[status] ?? TONE.draft
        }`}
      >
        {LABEL[status] ?? status}
      </span>

      {invoice.isOverdue ? (
        <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:bg-red-500/10 dark:text-red-300">
          Overdue
        </span>
      ) : null}

      {/* Partly paid is derived from the figures too, for the same reason. */}
      {invoice.amountPaidPaise > 0 && invoice.balancePaise > 0 ? (
        <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          Part paid
        </span>
      ) : null}
    </>
  );
};

export default InvoiceStatusBadge;
