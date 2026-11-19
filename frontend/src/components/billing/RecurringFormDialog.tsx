import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';

import {
  createRecurringTemplate,
  updateRecurringTemplate,
  type InvoiceItemInput,
} from '../../api/billing';
import { listConversations } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { useMobileBackLayer } from '../../hooks/useMobileBackLayer';
import { useBillingModalFocus } from '../../hooks/useBillingModalFocus';
import { toAmountString } from '../../lib/money';
import { errorMessage } from '../types';
import { type RecurringTemplate } from '../../types';

interface Props {
  /** Absent when setting up a new schedule. */
  template?: RecurringTemplate | null;
  onClose: () => void;
  onSaved: (template: RecurringTemplate) => void;
}

/** This compact form edits the first line; all other line details are preserved. */
const firstItem = (template: RecurringTemplate | null | undefined) =>
  (template?.items?.[0] ?? null) as
    | InvoiceItemInput
    | null;

const INTERVALS = [
  { value: 1, label: 'Every month' },
  { value: 2, label: 'Every 2 months' },
  { value: 3, label: 'Every quarter' },
  { value: 6, label: 'Every 6 months' },
  { value: 12, label: 'Every year' },
];

/**
 * Setting up a repeating invoice.
 *
 * THE GENERATE-AS CHOICE IS THE WHOLE FORM, really, and it is presented as a decision rather
 * than a checkbox with a sensible default. `issued` means an invoice with a permanent number
 * appears every month with nobody present; `draft` means somebody checks it first. The backend
 * defaults to `draft` and this asks explicitly, because the person setting it up in March is
 * the only one who will think about it before September.
 *
 * One line of copy is repeated from the backend deliberately: a schedule never messages a
 * client. Somebody reading this form should not have to go and find that out.
 */
const RecurringFormDialog = ({ template, onClose, onSaved }: Props) => {
  useMobileBackLayer({ active: true, onBack: onClose });
  const { authedRequest } = useAuth();

  const editing = Boolean(template);
  const line = firstItem(template);

  const [clients, setClients] = useState<{ contactId: string; name: string }[]>([]);
  const [clientSearch, setClientSearch] = useState('');
  const [contactId, setContactId] = useState('');

  const [name, setName] = useState(template?.name ?? 'Monthly retainer');
  const [description, setDescription] = useState(line?.description ?? '');
  const [rate, setRate] = useState(line?.rate ?? '');
  const [taxRate, setTaxRate] = useState(line?.taxRate ?? '18');
  const [intervalMonths, setIntervalMonths] = useState(template?.intervalMonths ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(template?.dayOfMonth ?? 1);
  const [dueInDays, setDueInDays] = useState(template?.dueInDays ?? 15);
  const [generateAs, setGenerateAs] = useState<'draft' | 'issued'>(
    template?.generateAs ?? 'draft',
  );
  const [billToState, setBillToState] = useState(template?.billTo?.state ?? '');

  const [saving, setSaving] = useState(false);
  const modalRef = useBillingModalFocus(onClose, saving);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The client picker is for choosing one, and an edit cannot change it - so an edit does not
    // load leads at all.
    if (editing) {
      return;
    }

    let cancelled = false;

    const timer = setTimeout(() => {
      authedRequest((token) =>
        listConversations({ token, search: clientSearch.trim() || undefined, limit: 50 }),
      )
        .then((payload) => {
          if (cancelled) {
            return;
          }

          const seen = new Map<string, string>();

          for (const conversation of payload.data ?? []) {
            if (conversation.contactId && !seen.has(conversation.contactId)) {
              seen.set(conversation.contactId, conversation.displayName ?? 'Unnamed lead');
            }
          }

          setClients([...seen].map(([id, label]) => ({ contactId: id, name: label })));
        })
        .catch(() => {
          // Surfaced on submit instead, where it can say what to do.
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authedRequest, clientSearch, editing]);

  const submit = async () => {
    if (!editing && !contactId) {
      setError('Choose a client for this schedule.');
      return;
    }

    if (description.trim() === '') {
      setError('Describe what is being billed each time.');
      return;
    }

    const parsedRate = toAmountString(rate);

    if (parsedRate === null) {
      setError('Enter an amount, like 10000 or 10000.50.');
      return;
    }

    setSaving(true);
    setError(null);

    const items: InvoiceItemInput[] = [
      {
        description: description.trim(),
        quantity: line?.quantity ?? '1',
        rate: parsedRate,
        discountPercent: line?.discountPercent ?? '0',
        taxRate: taxRate.trim() || '0',
        hsnSacCode: line?.hsnSacCode,
        unit: line?.unit,
      },
      ...((template?.items?.slice(1) ?? []) as InvoiceItemInput[]),
    ];

    const contents = {
      name: name.trim() || 'Recurring invoice',
      items,
      discount: template?.discount ?? '0',
      intervalMonths,
      dayOfMonth,
      dueInDays,
      generateAs,
      billToState: billToState.trim() || null,
      billToName: template?.billTo?.name,
      billToGstin: template?.billTo?.gstin,
      billToAddress: template?.billTo?.address,
      notes: template?.notes,
      terms: template?.terms,
    };

    try {
      const payload = editing
        ? await authedRequest((token) =>
            updateRecurringTemplate({ token, templateId: template!.id, ...contents }),
          )
        : await authedRequest((token) =>
            createRecurringTemplate({ token, contactId, ...contents }),
          );

      onSaved(payload.data);
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, 'Unable to save this schedule.'));
      setSaving(false);
    }
  };

  const field =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';
  const label = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400';

  return createPortal(
    <div
      role="dialog"
      ref={modalRef}
      aria-label={editing ? 'Edit recurring invoice' : 'New recurring invoice'}
      data-mobile-sheet-backdrop
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-3 sm:p-6"
    >
      <div
        data-mobile-sheet
        className="w-full max-w-xl rounded-2xl bg-white p-4 shadow-xl dark:bg-slate-900 sm:p-6"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {editing ? `Edit ${template?.name ?? 'schedule'}` : 'New recurring invoice'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {editing ? (
            <p className="sm:col-span-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-400">
              Billing {template?.billTo?.name ?? 'this client'}. A schedule cannot be moved to
              another client, because the invoices it has already raised belong to this one — set
              up a new schedule instead. Changes apply from the next invoice; ones already
              generated keep the amounts they were billed at.
            </p>
          ) : (
            <>
              <div>
                <label htmlFor="rec-search" className={label}>
                  Find a client
                </label>
                <input
                  id="rec-search"
                  type="search"
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  placeholder="Search leads by name"
                  className={field}
                />
              </div>

              <div>
                <label htmlFor="rec-client" className={label}>
                  Client
                </label>
                <select
                  id="rec-client"
                  value={contactId}
                  onChange={(e) => setContactId(e.target.value)}
                  className={field}
                >
                  <option value="">Choose a client…</option>
                  {clients.map((client) => (
                    <option key={client.contactId} value={client.contactId}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div className="sm:col-span-2">
            <label htmlFor="rec-name" className={label}>
              Schedule name
            </label>
            <input
              id="rec-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={field}
            />
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="rec-desc" className={label}>
              What is billed
            </label>
            {editing && template && template.items.length > 1 ? (
              <p className="mb-2 text-xs text-slate-500">Editing the first line. The other {template.items.length - 1} lines and existing discounts are preserved.</p>
            ) : null}
            <input
              id="rec-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Monthly social media retainer"
              className={field}
            />
          </div>

          <div>
            <label htmlFor="rec-rate" className={label}>
              Amount (₹)
            </label>
            <input
              id="rec-rate"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="rec-tax" className={label}>
              GST %
            </label>
            <input
              id="rec-tax"
              inputMode="decimal"
              value={taxRate}
              onChange={(e) => setTaxRate(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="rec-interval" className={label}>
              How often
            </label>
            <select
              id="rec-interval"
              value={intervalMonths}
              onChange={(e) => setIntervalMonths(Number(e.target.value))}
              className={field}
            >
              {INTERVALS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="rec-day" className={label}>
              On day
            </label>
            <input
              id="rec-day"
              type="number"
              min={1}
              max={31}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(Number(e.target.value))}
              className={field}
            />
            {dayOfMonth > 28 ? (
              // The clamping rule, said where somebody is choosing a day it applies to.
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Shorter months bill on their last day, then it returns to the {dayOfMonth}th.
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="rec-due" className={label}>
              Payable within (days)
            </label>
            <input
              id="rec-due"
              type="number"
              min={0}
              max={365}
              value={dueInDays}
              onChange={(e) => setDueInDays(Number(e.target.value))}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="rec-state" className={label}>
              Client state
            </label>
            <input
              id="rec-state"
              value={billToState}
              onChange={(e) => setBillToState(e.target.value)}
              placeholder="Karnataka"
              className={field}
            />
          </div>
        </div>

        <fieldset className="mt-4">
          <legend className={label}>What each run produces</legend>

          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                {
                  value: 'draft' as const,
                  title: 'A draft to check',
                  detail:
                    'An invoice appears with no number. Somebody reviews and issues it. Safer when amounts or details change.',
                },
                {
                  value: 'issued' as const,
                  title: 'An issued invoice',
                  detail:
                    'A numbered invoice is created automatically, with nobody present. Right for a fixed retainer.',
                },
              ]
            ).map((option) => (
              <label
                key={option.value}
                className={`cursor-pointer rounded-lg border p-3 transition ${
                  generateAs === option.value
                    ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500 dark:bg-blue-500/10'
                    : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'
                }`}
              >
                <span className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="rec-generate-as"
                    value={option.value}
                    checked={generateAs === option.value}
                    onChange={() => setGenerateAs(option.value)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {option.title}
                    </span>
                    <span className="mt-1 block text-xs text-slate-600 dark:text-slate-400">
                      {option.detail}
                    </span>
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-400">
          A schedule never messages the client. Payment reminders are sent separately, after a
          booking is won and its event has finished, and only once the owner confirms the payment
          is still outstanding.
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create schedule'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default RecurringFormDialog;
