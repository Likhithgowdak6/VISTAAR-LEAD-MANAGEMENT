import { useCallback, useEffect, useMemo, useState } from 'react';

import { listInvoices } from '../../api/billing';
import { useAuth } from '../../auth/AuthContext';
import { formatDate, formatRupees } from '../../lib/money';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import EmptyState from '../EmptyState';
import Spinner from '../Spinner';
import { errorMessage } from '../types';
import { type Invoice, type InvoiceStatus } from '../../types';
import InvoiceDetailDialog from './InvoiceDetailDialog';
import InvoiceFormDialog from './InvoiceFormDialog';
import InvoiceStatusBadge from './InvoiceStatusBadge';

const STATUS_FILTERS: { value: InvoiceStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'issued', label: 'Issued' },
  { value: 'sent', label: 'Sent' },
  { value: 'paid', label: 'Paid' },
  { value: 'cancelled', label: 'Cancelled' },
];

const PAGE_SIZE = 50;

/**
 * The invoice list.
 *
 * SEARCH IS CLIENT-SIDE OVER THE LOADED PAGE, deliberately. The API filters by status and
 * contact but has no text search, and adding one to match a number or a client name would mean
 * a new endpoint and an index for a list that is fifty rows. Filtering what is on screen is
 * honest about its scope - the count says how many of the loaded invoices matched - and avoids
 * inventing a server feature the backend does not have.
 */
const InvoicesPanel = () => {
  const { authedRequest, permissions } = useAuth();

  const canManage = hasPermission(permissions, PERMISSIONS.INVOICES_MANAGE);

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<InvoiceStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const payload = await authedRequest((token) =>
        listInvoices({
          token,
          status: status === 'all' ? null : status,
          limit: PAGE_SIZE,
        }),
      );

      setInvoices(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load invoices.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, status]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();

    if (needle === '') {
      return invoices;
    }

    return invoices.filter((invoice) =>
      [invoice.invoiceNumber, invoice.billTo?.name, invoice.total]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle)),
    );
  }, [invoices, search]);

  /**
   * What is still owed across everything on screen.
   *
   * Summed from `balancePaise` - the integers - and formatted once at the end. Adding the
   * formatted strings, or dividing each by 100 first, is how a total drifts from its own rows.
   */
  const outstandingPaise = useMemo(
    () =>
      visible
        .filter((invoice) => invoice.status !== 'cancelled' && invoice.status !== 'draft')
        .reduce((sum, invoice) => sum + Math.max(0, invoice.balancePaise), 0),
    [visible],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Invoices</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {visible.length} shown · {formatRupees(String(outstandingPaise / 100))} outstanding
          </p>
        </div>

        {canManage ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            New invoice
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search number, client or amount"
          aria-label="Search invoices"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 sm:max-w-xs"
        />

        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as InvoiceStatus | 'all')}
          aria-label="Filter by status"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {loading ? (
          <div className="p-4">
            <Spinner label="Loading invoices…" />
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="p-4 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        {!loading && !error && visible.length === 0 ? (
          <EmptyState
            title={search.trim() !== '' ? 'Nothing matched' : 'No invoices yet'}
            description={
              search.trim() !== ''
                ? 'Try a different number, client or amount.'
                : canManage
                  ? 'Raise one for a client to get started.'
                  : 'Invoices raised in this workspace will appear here.'
            }
          />
        ) : null}

        {!loading && visible.length > 0 ? (
          <ul>
            {visible.map((invoice) => (
              <li key={invoice.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(invoice.id)}
                  className="flex w-full flex-col gap-2 border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {invoice.invoiceNumber ?? 'Draft'}
                      </span>
                      <InvoiceStatusBadge invoice={invoice} />
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">
                      {invoice.billTo?.name ?? 'No client name'}
                      {invoice.dueDate ? ` · due ${formatDate(invoice.dueDate)}` : ''}
                    </span>
                  </span>

                  <span className="shrink-0 text-left sm:text-right">
                    <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {formatRupees(invoice.total)}
                    </span>
                    {invoice.balancePaise > 0 && invoice.status !== 'cancelled' ? (
                      <span className="block text-xs text-amber-700 dark:text-amber-400">
                        {formatRupees(invoice.balance)} due
                      </span>
                    ) : invoice.balancePaise < 0 ? (
                      // Surfaced rather than clamped: somebody paid too much and it needs a human.
                      <span className="block text-xs text-purple-700 dark:text-purple-400">
                        {formatRupees(String(Math.abs(invoice.balancePaise) / 100))} overpaid
                      </span>
                    ) : (
                      <span className="block text-xs text-slate-400">Settled</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {openId ? (
        <InvoiceDetailDialog
          invoiceId={openId}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      ) : null}

      {creating && canManage ? (
        <InvoiceFormDialog
          onClose={() => setCreating(false)}
          onSaved={(invoice) => {
            setCreating(false);
            void load();
            setOpenId(invoice.id);
          }}
        />
      ) : null}
    </div>
  );
};

export default InvoicesPanel;
