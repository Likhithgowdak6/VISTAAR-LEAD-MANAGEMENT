import { useCallback, useEffect, useRef, useState } from 'react';

import {
  listInvoices,
  listRecurringTemplates,
  setRecurringTemplateActive,
} from '../../api/billing';
import { useAuth } from '../../auth/AuthContext';
import { formatDate, formatRupees } from '../../lib/money';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import ConfirmDialog from '../ConfirmDialog';
import EmptyState from '../EmptyState';
import Spinner from '../Spinner';
import { errorMessage } from '../types';
import { type Invoice, type RecurringTemplate } from '../../types';
import InvoiceDetailDialog from './InvoiceDetailDialog';
import InvoiceStatusBadge from './InvoiceStatusBadge';
import RecurringFormDialog from './RecurringFormDialog';

/**
 * Repeating invoices.
 *
 * THE SCREEN SAYS WHAT WILL HAPPEN UNATTENDED, prominently, because that is the whole risk of
 * this feature: a template set up in March still bills in September with nobody watching. Each
 * row states whether it produces a draft for somebody to check or issues an invoice outright,
 * and when the next one is due.
 *
 * There is no "generate now". Generation belongs to the daily job, which holds the lease and the
 * period key that make it safe to run twice; a button here would be a second path into the same
 * invariant for no reason beyond impatience.
 */
const RecurringPanel = () => {
  const { authedRequest, permissions } = useAuth();

  const canManage = hasPermission(permissions, PERMISSIONS.INVOICES_MANAGE);

  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RecurringTemplate | null>(null);
  const [pauseTarget, setPauseTarget] = useState<RecurringTemplate | null>(null);

  /** Which schedule's billing history is expanded, and what it has raised. */
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<Invoice[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  const historyRequest = useRef(0);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listRecurringTemplates({ token }));
      setTemplates(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load recurring invoices.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  /**
   * What a schedule has actually billed.
   *
   * Loaded on demand rather than with the list: most people open this screen to check a next
   * run date, and fetching a history for every row would be a request per template for
   * something nobody looked at.
   */
  const showHistory = async (template: RecurringTemplate) => {
    const request = ++historyRequest.current;
    if (historyFor === template.id) {
      setHistoryFor(null);
      return;
    }

    setHistoryFor(template.id);
    setHistory([]);
    setHistoryLoading(true);

    try {
      const payload = await authedRequest((token) =>
        listInvoices({ token, recurringTemplateId: template.id, limit: 50 }),
      );
      if (request !== historyRequest.current) return;
      setHistory(payload.data ?? []);
    } catch (historyError: unknown) {
      if (request !== historyRequest.current) return;
      setError(errorMessage(historyError, 'Unable to load what this schedule has billed.'));
    } finally {
      if (request === historyRequest.current) setHistoryLoading(false);
    }
  };

  const toggle = async (template: RecurringTemplate, active: boolean) => {
    setBusy(true);
    setError(null);

    try {
      await authedRequest((token) =>
        setRecurringTemplateActive({ token, templateId: template.id, active }),
      );
      await load();
    } catch (toggleError: unknown) {
      setError(errorMessage(toggleError, 'Unable to change that schedule.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Recurring invoices
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Generated automatically. Clients are never messaged by a schedule.
          </p>
        </div>

        {canManage ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            New schedule
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {loading ? (
          <div className="p-4">
            <Spinner label="Loading schedules…" />
          </div>
        ) : templates.length === 0 ? (
          <EmptyState
            title="No recurring invoices"
            description={
              canManage
                ? 'Set one up for a retainer or an annual charge.'
                : 'Recurring schedules in this workspace will appear here.'
            }
          />
        ) : (
          <ul>
            {/*
              `sm:flex-wrap` on each row IS WHAT KEEPS THE HISTORY OFF THE ROW'S OWN LINE.

              Without it the expanded history was a third item on a `flex-row` line, competing
              for width with the schedule's own text and squashing "Monthly on day 5 · Riya
              Sharma" into a column two words wide on a full desktop screen. With wrapping, the
              `w-full` history cannot fit beside its siblings and takes a line of its own.
            */}
            {templates.map((template) => (
              <li
                key={template.id}
                className="flex flex-col gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {template.name ?? 'Recurring invoice'}
                    </span>

                    {!template.active ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        Paused
                      </span>
                    ) : null}

                    {/*
                      THE FIELD THAT MATTERS MOST ON THIS ROW. `issued` means an invoice with a
                      real number appears without anybody present; `draft` means somebody checks
                      it first. Shown as a badge rather than buried in a detail view.
                    */}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        template.generateAs === 'issued'
                          ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
                          : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                      }`}
                    >
                      {template.generateAs === 'issued' ? 'Issues automatically' : 'Creates drafts'}
                    </span>
                  </div>

                  <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                    {template.intervalLabel} on day {template.dayOfMonth} ·{' '}
                    {template.billTo?.name ?? 'No client name'}
                  </p>

                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {template.active ? (
                      <>
                        Next: {formatDate(template.nextRunAt)}
                        {template.nextPeriod ? ` · ${template.nextPeriod}` : ''}
                      </>
                    ) : (
                      <>Paused · resumes from {formatDate(template.nextRunAt)}</>
                    )}
                    {template.generatedCount > 0
                      ? ` · ${template.generatedCount} generated`
                      : ''}
                  </p>

                  {/*
                    A template that has quietly stopped working is the failure nobody notices
                    until a client asks why they have not been invoiced. Surfaced on the row.
                  */}
                  {template.lastError ? (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                      Last run failed: {template.lastError}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                  {template.generatedCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => showHistory(template)}
                      aria-expanded={historyFor === template.id}
                      className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      {historyFor === template.id ? 'Hide invoices' : 'Invoices'}
                    </button>
                  ) : null}

                  {canManage ? (
                    <button
                      type="button"
                      onClick={() => setEditing(template)}
                      disabled={busy}
                      className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      Edit
                    </button>
                  ) : null}

                  {canManage ? (
                    template.active ? (
                      <button
                        type="button"
                        onClick={() => setPauseTarget(template)}
                        disabled={busy}
                        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        Pause
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggle(template, true)}
                        disabled={busy}
                        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        Resume
                      </button>
                    )
                  ) : null}
                </div>

                {historyFor === template.id ? (
                  <div className="w-full rounded-lg border border-slate-200 p-2 dark:border-slate-800">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      Invoices from this schedule
                    </p>

                    {historyLoading ? (
                      <p className="py-1 text-xs text-slate-400">Loading…</p>
                    ) : history.length === 0 ? (
                      <p className="py-1 text-xs text-slate-500 dark:text-slate-400">
                        Nothing yet.
                      </p>
                    ) : (
                      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                        {history.map((invoice) => (
                          <li key={invoice.id}>
                            <button
                              type="button"
                              onClick={() => setOpenInvoiceId(invoice.id)}
                              className="flex w-full items-center justify-between gap-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
                            >
                              <span className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                                  {invoice.invoiceNumber ?? 'Draft'}
                                </span>
                                <InvoiceStatusBadge invoice={invoice} />
                              </span>
                              <span className="shrink-0 text-xs text-slate-600 dark:text-slate-400">
                                {formatRupees(invoice.total)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && canManage ? (
        <RecurringFormDialog
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      {openInvoiceId ? (
        <InvoiceDetailDialog
          invoiceId={openInvoiceId}
          onClose={() => setOpenInvoiceId(null)}
          onChanged={() => undefined}
        />
      ) : null}

      {creating && canManage ? (
        <RecurringFormDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      ) : null}

      {pauseTarget ? (
        <ConfirmDialog
          title="Pause this schedule?"
          /*
            Said explicitly because it surprises people: pausing does not move the next run date,
            so resuming after the billing day bills the period that was missed.
          */
          message="No invoices are generated while it is paused. The next run date does not move, so resuming after the billing day has passed will bill that period."
          confirmLabel="Pause"
          busy={busy}
          onCancel={() => setPauseTarget(null)}
          onConfirm={() => {
            const target = pauseTarget;
            setPauseTarget(null);
            void toggle(target, false);
          }}
        />
      ) : null}
    </div>
  );
};

export default RecurringPanel;
