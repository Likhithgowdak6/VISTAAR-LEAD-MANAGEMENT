import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';

import { createInvoice, updateInvoice, type InvoiceItemInput } from '../../api/billing';
import { listConversations } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { useMobileBackLayer } from '../../hooks/useMobileBackLayer';
import { useBillingModalFocus } from '../../hooks/useBillingModalFocus';
import { formatRupees, toAmountString } from '../../lib/money';
import { errorMessage } from '../types';
import { type Invoice } from '../../types';

interface Props {
  /** Absent when raising a new invoice. */
  invoice?: Invoice | null;
  /** Pre-selects a client, e.g. when raising from a lead. */
  contactId?: string | null;
  onClose: () => void;
  onSaved: (invoice: Invoice) => void;
}

interface ItemRow {
  description: string;
  quantity: string;
  rate: string;
  discountPercent: string;
  taxRate: string;
  hsnSacCode: string;
  unit: string;
}

const emptyRow = (): ItemRow => ({
  description: '',
  quantity: '1',
  rate: '',
  discountPercent: '0',
  taxRate: '18',
  hsnSacCode: '',
  unit: '',
});

/**
 * Raising or editing an invoice.
 *
 * NO TOTALS ARE CALCULATED HERE. The running figure below the lines is a PREVIEW, computed from
 * the typed numbers purely so somebody is not typing blind - and it is labelled as one. What the
 * invoice actually says comes back from the server, which does the GST split, the discount and
 * the rounding in integer paise. Two implementations of tax arithmetic is one too many, and the
 * browser's would be the wrong one.
 *
 * EDITING IS A WHOLE-CONTENTS REPLACE, matching the API: the full line list is submitted, so
 * deleting a row is expressible. The server refuses edits once a reminder has gone out.
 */
const InvoiceFormDialog = ({ invoice, contactId, onClose, onSaved }: Props) => {
  useMobileBackLayer({ active: true, onBack: onClose });
  const { authedRequest } = useAuth();

  const editing = Boolean(invoice);

  /**
   * CLIENTS COME FROM CONVERSATIONS, not from a contacts endpoint - because there isn't one.
   *
   * The CRM has no "list all contacts" route: a contact is reached through the lead thread it
   * belongs to, and `listConversations` already carries `contactId` and `displayName` and
   * supports the same search the inbox uses. Reusing it is the point of merging billing into
   * this CRM rather than beside it - the client being invoiced is the lead already in here.
   */
  const [clients, setClients] = useState<{ contactId: string; name: string }[]>([]);
  const [clientSearch, setClientSearch] = useState('');
  const [selectedContact, setSelectedContact] = useState<string>(
    invoice?.contactId ?? contactId ?? '',
  );
  const [rows, setRows] = useState<ItemRow[]>(() =>
    invoice?.items?.length
      ? invoice.items.map((item) => ({
          description: item.description ?? '',
          quantity: item.quantity ?? '1',
          rate: item.rate ?? '',
          discountPercent: item.discountPercent ?? '0',
          taxRate: item.taxRate ?? '18',
          hsnSacCode: item.hsnSacCode ?? '',
          unit: item.unit ?? '',
        }))
      : [emptyRow()],
  );
  const [discount, setDiscount] = useState(invoice?.discount ?? '0');
  const [dueDate, setDueDate] = useState(invoice?.dueDate ? invoice.dueDate.slice(0, 10) : '');
  const [billToName, setBillToName] = useState(invoice?.billTo?.name ?? '');
  const [billToState, setBillToState] = useState(invoice?.billTo?.state ?? '');
  const [billToGstin, setBillToGstin] = useState(invoice?.billTo?.gstin ?? '');
  const [billToAddress, setBillToAddress] = useState(invoice?.billTo?.address ?? '');
  const [notes, setNotes] = useState(invoice?.notes ?? '');
  const [terms, setTerms] = useState(invoice?.terms ?? '');
  const [issueNow, setIssueNow] = useState(false);

  const [saving, setSaving] = useState(false);
  const modalRef = useBillingModalFocus(onClose, saving);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) {
      return;
    }

    let cancelled = false;

    // Debounced, because this fires on every keystroke in the client search.
    const timer = setTimeout(() => {
      authedRequest((token) =>
        listConversations({ token, search: clientSearch.trim() || undefined, limit: 50 }),
      )
        .then((payload) => {
          if (cancelled) {
            return;
          }

          // One entry per contact: a client with two threads is still one person to bill.
          const seen = new Map<string, string>();

          for (const conversation of payload.data ?? []) {
            if (conversation.contactId && !seen.has(conversation.contactId)) {
              seen.set(conversation.contactId, conversation.displayName ?? 'Unnamed lead');
            }
          }

          setClients([...seen].map(([id, name]) => ({ contactId: id, name })));
        })
        .catch(() => {
          // The picker simply shows nothing selectable. The error surfaces on submit, where it
          // can say what to do about it.
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authedRequest, editing, clientSearch]);

  const updateRow = (index: number, patch: Partial<ItemRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  /**
   * An indicative total, for the person typing.
   *
   * Float arithmetic on purpose and ONLY here: it is a preview, never submitted, and never
   * compared against anything the server returned. Everything that matters is recomputed
   * server-side in paise.
   */
  const preview = useMemo(() => {
    let subtotal = 0;
    let tax = 0;

    for (const row of rows) {
      const quantity = Number(row.quantity || '0');
      const rate = Number(row.rate || '0');
      const lineDiscount = Number(row.discountPercent || '0');
      const taxRate = Number(row.taxRate || '0');

      if (!Number.isFinite(quantity) || !Number.isFinite(rate)) {
        continue;
      }

      const gross = quantity * rate;
      const net = gross - (gross * lineDiscount) / 100;

      subtotal += net;
      tax += (net * taxRate) / 100;
    }

    const invoiceDiscount = Number(discount || '0');
    const taxable = Math.max(0, subtotal - (Number.isFinite(invoiceDiscount) ? invoiceDiscount : 0));

    return { subtotal, tax, total: taxable + tax };
  }, [rows, discount]);

  const validate = (): string | null => {
    if (!editing && !selectedContact) {
      return 'Choose a client for this invoice.';
    }

    if (rows.length === 0) {
      return 'An invoice needs at least one line.';
    }

    for (const [index, row] of rows.entries()) {
      if (row.description.trim() === '') {
        return `Line ${index + 1} needs a description.`;
      }

      if (toAmountString(row.rate) === null) {
        return `Line ${index + 1} needs a rate, like 1500 or 1500.50.`;
      }

      if (toAmountString(row.quantity) === null || Number(row.quantity) <= 0) {
        return `Line ${index + 1} needs a quantity above zero.`;
      }
    }

    if (discount.trim() !== '' && toAmountString(discount) === null) {
      return 'The discount must be a number, like 250 or 250.50.';
    }

    return null;
  };

  const handleSubmit = async () => {
    const problem = validate();

    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);
    setError(null);

    const items: InvoiceItemInput[] = rows.map((row) => ({
      description: row.description.trim(),
      quantity: row.quantity.trim() || '1',
      rate: row.rate.trim(),
      discountPercent: row.discountPercent.trim() || '0',
      taxRate: row.taxRate.trim() || '0',
      hsnSacCode: row.hsnSacCode.trim() || null,
      unit: row.unit.trim() || null,
    }));

    const contents = {
      items,
      discount: discount.trim() || '0',
      dueDate: dueDate ? new Date(dueDate).toISOString() : null,
      notes: notes.trim() || null,
      terms: terms.trim() || null,
      billToName: billToName.trim() || null,
      billToState: billToState.trim() || null,
      billToGstin: billToGstin.trim() || null,
      billToAddress: billToAddress.trim() || null,
    };

    try {
      const payload = editing
        ? await authedRequest((token) =>
            updateInvoice({ token, invoiceId: invoice!.id, ...contents }),
          )
        : await authedRequest((token) =>
            createInvoice({ token, contactId: selectedContact, issue: issueNow, ...contents }),
          );

      onSaved(payload.data);
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, 'Unable to save this invoice.'));
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
      aria-label={editing ? 'Edit invoice' : 'New invoice'}
      data-mobile-sheet-backdrop
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-3 sm:p-6"
    >
      <div
        data-mobile-sheet
        className="w-full max-w-3xl rounded-2xl bg-white p-4 shadow-xl dark:bg-slate-900 sm:p-6"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {editing ? `Edit ${invoice?.invoiceNumber ?? 'draft'}` : 'New invoice'}
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

        {!editing ? (
          <div className="mb-4 grid gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor="inv-client-search" className={label}>
                Find a client
              </label>
              <input
                id="inv-client-search"
                type="search"
                value={clientSearch}
                onChange={(event) => setClientSearch(event.target.value)}
                placeholder="Search leads by name"
                className={field}
              />
            </div>

            <div>
              <label htmlFor="inv-contact" className={label}>
                Client
              </label>
              <select
                id="inv-contact"
                value={selectedContact}
                onChange={(event) => {
                  setSelectedContact(event.target.value);

                  // Prefills the bill-to name, while leaving it editable: the person who
                  // enquired is often not the entity being billed.
                  const match = clients.find((c) => c.contactId === event.target.value);

                  if (match && billToName.trim() === '') {
                    setBillToName(match.name);
                  }
                }}
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
          </div>
        ) : null}

        <fieldset className="mb-4">
          <legend className={label}>Lines</legend>

          <div className="space-y-2">
            {rows.map((row, index) => (
              <div
                key={index}
                className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
              >
                <div className="grid gap-2 sm:grid-cols-12">
                  <div className="sm:col-span-5">
                    <label className={label} htmlFor={`row-desc-${index}`}>
                      Description
                    </label>
                    <input
                      id={`row-desc-${index}`}
                      value={row.description}
                      onChange={(e) => updateRow(index, { description: e.target.value })}
                      className={field}
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className={label} htmlFor={`row-qty-${index}`}>
                      Qty
                    </label>
                    <input
                      id={`row-qty-${index}`}
                      inputMode="decimal"
                      value={row.quantity}
                      onChange={(e) => updateRow(index, { quantity: e.target.value })}
                      className={field}
                    />
                  </div>

                  <div className="sm:col-span-3">
                    <label className={label} htmlFor={`row-rate-${index}`}>
                      Rate (₹)
                    </label>
                    <input
                      id={`row-rate-${index}`}
                      inputMode="decimal"
                      value={row.rate}
                      onChange={(e) => updateRow(index, { rate: e.target.value })}
                      className={field}
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className={label} htmlFor={`row-tax-${index}`}>
                      GST %
                    </label>
                    <input
                      id={`row-tax-${index}`}
                      inputMode="decimal"
                      value={row.taxRate}
                      onChange={(e) => updateRow(index, { taxRate: e.target.value })}
                      className={field}
                    />
                  </div>
                </div>

                <div className="mt-2 grid gap-2 sm:grid-cols-12">
                  <div className="sm:col-span-3">
                    <label className={label} htmlFor={`row-disc-${index}`}>
                      Discount %
                    </label>
                    <input
                      id={`row-disc-${index}`}
                      inputMode="decimal"
                      value={row.discountPercent}
                      onChange={(e) => updateRow(index, { discountPercent: e.target.value })}
                      className={field}
                    />
                  </div>

                  <div className="sm:col-span-3">
                    <label className={label} htmlFor={`row-hsn-${index}`}>
                      HSN/SAC
                    </label>
                    <input
                      id={`row-hsn-${index}`}
                      value={row.hsnSacCode}
                      onChange={(e) => updateRow(index, { hsnSacCode: e.target.value })}
                      className={field}
                    />
                  </div>

                  <div className="sm:col-span-3">
                    <label className={label} htmlFor={`row-unit-${index}`}>
                      Unit
                    </label>
                    <input
                      id={`row-unit-${index}`}
                      value={row.unit}
                      onChange={(e) => updateRow(index, { unit: e.target.value })}
                      className={field}
                    />
                  </div>

                  <div className="flex items-end sm:col-span-3">
                    {rows.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => setRows((c) => c.filter((_, i) => i !== index))}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-slate-700 dark:hover:bg-red-500/10"
                      >
                        Remove line
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setRows((c) => [...c, emptyRow()])}
            className="mt-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Add line
          </button>
        </fieldset>

        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="inv-discount" className={label}>
              Invoice discount (₹)
            </label>
            <input
              id="inv-discount"
              inputMode="decimal"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label htmlFor="inv-due" className={label}>
              Due date
            </label>
            <input
              id="inv-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={field}
            />
          </div>
        </div>

        <details className="mb-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <summary className="cursor-pointer text-xs font-semibold text-slate-700 dark:text-slate-300">
            Bill to, notes and terms
          </summary>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="bill-name" className={label}>
                Billed to
              </label>
              <input
                id="bill-name"
                value={billToName}
                onChange={(e) => setBillToName(e.target.value)}
                className={field}
              />
            </div>

            <div>
              <label htmlFor="bill-state" className={label}>
                State
              </label>
              <input
                id="bill-state"
                value={billToState}
                onChange={(e) => setBillToState(e.target.value)}
                placeholder="Karnataka"
                className={field}
              />
              {/* Not cosmetic: it decides CGST+SGST versus IGST on this invoice. */}
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Decides CGST + SGST or IGST. Leave blank to treat it as the same state as yours.
              </p>
            </div>

            <div>
              <label htmlFor="bill-gstin" className={label}>
                Client GSTIN
              </label>
              <input
                id="bill-gstin"
                value={billToGstin}
                onChange={(e) => setBillToGstin(e.target.value)}
                className={`${field} font-mono`}
              />
            </div>

            <div>
              <label htmlFor="bill-address" className={label}>
                Address
              </label>
              <input
                id="bill-address"
                value={billToAddress}
                onChange={(e) => setBillToAddress(e.target.value)}
                className={field}
              />
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="inv-notes" className={label}>
                Notes
              </label>
              <input
                id="inv-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className={field}
              />
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="inv-terms" className={label}>
                Terms
              </label>
              <input
                id="inv-terms"
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                className={field}
              />
            </div>
          </div>
        </details>

        <div className="mb-4 rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Estimated total
          </p>
          <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {formatRupees(preview.total.toFixed(2))}
          </p>
          {/* Said plainly, because the two can differ by a rounding paisa and somebody will notice. */}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            An estimate. The exact GST split and rounding are calculated when you save.
          </p>
        </div>

        {!editing ? (
          <label className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
            <input
              type="checkbox"
              checked={issueNow}
              onChange={(e) => setIssueNow(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                Issue immediately
              </span>
              <span className="mt-0.5 block">
                Allocates an invoice number now. Leave this off to keep it a draft you can still
                edit. Issuing does not message the client.
              </span>
            </span>
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="mb-3 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : issueNow ? 'Create and issue' : 'Save draft'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default InvoiceFormDialog;
