/**
 * Billing: invoices, payments, provider links and recurring templates.
 *
 * A SEPARATE MODULE FROM `endpoints.ts`, which is already past 1,800 lines. Everything here is
 * one feature and lands together; splitting it keeps both files readable without inventing a
 * second convention - the shapes, the `ApiSuccessResponse` envelope and `apiFetch` are the same.
 *
 * NOTHING IN THIS FILE RECOMPUTES MONEY. Totals, GST, balances and round-off all arrive already
 * calculated in integer paise with a formatted string beside each. Dividing paise by 100 in
 * JavaScript would reintroduce exactly the floating-point drift the backend's integer
 * arithmetic exists to remove.
 */

import { apiFetch, apiFetchBlob } from './client';
import {
  type ApiSuccessResponse,
  type BillingProfile,
  type Invoice,
  type InvoiceReconciliation,
  type InvoiceStatus,
  type Payment,
  type PaymentLink,
  type PaymentMode,
  type RazorpayConnection,
  type RecurringTemplate,
} from '../types';

interface TokenParams {
  token: string | null;
}

export interface InvoiceItemInput {
  description: string;
  quantity: string;
  rate: string;
  discountPercent?: string;
  taxRate?: string;
  hsnSacCode?: string | null;
  unit?: string | null;
}

export interface InvoiceContentsInput {
  items: InvoiceItemInput[];
  discount?: string;
  dueDate?: string | null;
  notes?: string | null;
  terms?: string | null;
  billToName?: string | null;
  billToState?: string | null;
  billToGstin?: string | null;
  billToAddress?: string | null;
}

// --- Invoices ---------------------------------------------------------------------------

export const listInvoices = ({
  token,
  contactId,
  status,
  recurringTemplateId,
  limit = 50,
  skip = 0,
}: TokenParams & {
  contactId?: string | null;
  status?: InvoiceStatus | null;
  /** The billing history of one recurring schedule. */
  recurringTemplateId?: string | null;
  limit?: number;
  skip?: number;
}): Promise<ApiSuccessResponse<Invoice[]>> => {
  const query = new URLSearchParams({ limit: String(limit), skip: String(skip) });

  if (contactId) query.set('contactId', contactId);
  if (status) query.set('status', status);
  if (recurringTemplateId) query.set('recurringTemplateId', recurringTemplateId);

  return apiFetch(`/invoices?${query.toString()}`, { token });
};

export const getInvoice = ({
  token,
  invoiceId,
}: TokenParams & { invoiceId: string }): Promise<ApiSuccessResponse<Invoice>> =>
  apiFetch(`/invoices/${invoiceId}`, { token });

export const createInvoice = ({
  token,
  ...body
}: TokenParams &
  InvoiceContentsInput & {
    contactId: string;
    conversationId?: string | null;
    /** Omitted or false keeps it a draft. Issuing allocates a permanent invoice number. */
    issue?: boolean;
  }): Promise<ApiSuccessResponse<Invoice>> => apiFetch('/invoices', { method: 'POST', token, body });

/** A whole-contents replace: the full item list is submitted, so removing a line is expressible. */
export const updateInvoice = ({
  token,
  invoiceId,
  ...body
}: TokenParams & { invoiceId: string } & InvoiceContentsInput): Promise<
  ApiSuccessResponse<Invoice>
> => apiFetch(`/invoices/${invoiceId}`, { method: 'PUT', token, body });

export const issueInvoice = ({
  token,
  invoiceId,
}: TokenParams & { invoiceId: string }): Promise<ApiSuccessResponse<Invoice>> =>
  apiFetch(`/invoices/${invoiceId}/issue`, { method: 'POST', token });

export const cancelInvoice = ({
  token,
  invoiceId,
}: TokenParams & { invoiceId: string }): Promise<ApiSuccessResponse<Invoice>> =>
  apiFetch(`/invoices/${invoiceId}/cancel`, { method: 'POST', token });

/** The rendered PDF, through a permission-checked route rather than the media route. */
export const downloadInvoicePdf = ({
  token,
  invoiceId,
}: TokenParams & { invoiceId: string }): Promise<Blob> =>
  apiFetchBlob(`/invoices/${invoiceId}/pdf`, { token });

// --- Payments ---------------------------------------------------------------------------

export const listInvoicePayments = ({
  token,
  invoiceId,
}: TokenParams & { invoiceId: string }): Promise<ApiSuccessResponse<Payment[]>> =>
  apiFetch(`/invoices/${invoiceId}/payments`, { token });

/**
 * Records money received by hand.
 *
 * `idempotencyKey` is minted once per ATTEMPT and resent when that attempt is retried. Hand
 * entered money carries no provider id, so without it a request that succeeded but whose
 * response was lost credits the client twice when the button is pressed again - and the
 * server's balance check only notices when the repeat would exceed what is outstanding.
 */
export const recordInvoicePayment = ({
  token,
  invoiceId,
  ...body
}: TokenParams & {
  invoiceId: string;
  amount: string;
  mode: PaymentMode;
  paidAt?: string | null;
  reference?: string | null;
  notes?: string | null;
  idempotencyKey: string;
}): Promise<ApiSuccessResponse<{ payment: Payment; invoice: Invoice }>> =>
  apiFetch(`/invoices/${invoiceId}/payments`, { method: 'POST', token, body });

export const voidInvoicePayment = ({
  token,
  invoiceId,
  paymentId,
  reason,
}: TokenParams & { invoiceId: string; paymentId: string; reason?: string | null }): Promise<
  ApiSuccessResponse<{ payment: Payment; invoice: Invoice }>
> =>
  apiFetch(`/invoices/${invoiceId}/payments/${paymentId}/void`, {
    method: 'POST',
    token,
    body: { reason: reason ?? null },
  });

/** Compares the invoice's cached balance against its own ledger. Asks the provider nothing. */
export const reconcileInvoiceLedger = ({
  token,
  invoiceId,
}: TokenParams & { invoiceId: string }): Promise<ApiSuccessResponse<InvoiceReconciliation>> =>
  apiFetch(`/invoices/${invoiceId}/reconcile`, { token });

// --- Provider payment links ---------------------------------------------------------------

export const listPaymentLinks = ({
  token,
  invoiceId,
}: TokenParams & { invoiceId: string }): Promise<ApiSuccessResponse<PaymentLink[]>> =>
  apiFetch(`/invoices/${invoiceId}/payment-links`, { token });

export const createPaymentLink = ({
  token,
  invoiceId,
  idempotencyKey,
  amount,
}: TokenParams & {
  invoiceId: string;
  /**
   * Required by the server. Replaying the same key with a DIFFERENT amount is refused, so a
   * retry after a timeout cannot quietly open a second link for one debt.
   */
  idempotencyKey: string;
  amount?: string | null;
}): Promise<ApiSuccessResponse<PaymentLink>> =>
  apiFetch(`/invoices/${invoiceId}/payment-links`, {
    method: 'POST',
    token,
    body: amount ? { idempotencyKey, amount } : { idempotencyKey },
  });

/** Asks the provider what actually happened to a link whose webhook may have been missed. */
export const reconcilePaymentLink = ({
  token,
  invoiceId,
  linkId,
}: TokenParams & { invoiceId: string; linkId: string }): Promise<ApiSuccessResponse<PaymentLink>> =>
  apiFetch(`/invoices/${invoiceId}/payment-links/${linkId}/reconcile`, { method: 'POST', token });

export const cancelPaymentLink = ({
  token,
  invoiceId,
  linkId,
}: TokenParams & { invoiceId: string; linkId: string }): Promise<ApiSuccessResponse<PaymentLink>> =>
  apiFetch(`/invoices/${invoiceId}/payment-links/${linkId}/cancel`, { method: 'POST', token });

// --- Settings -------------------------------------------------------------------------------

export const getBillingProfile = ({
  token,
}: TokenParams): Promise<ApiSuccessResponse<BillingProfile>> =>
  apiFetch('/settings/billing', { token });

/** A whole-profile replace: omitting a field clears it, so the form always submits everything. */
export const updateBillingProfile = ({
  token,
  ...body
}: TokenParams & Partial<BillingProfile>): Promise<ApiSuccessResponse<BillingProfile>> =>
  apiFetch('/settings/billing', { method: 'PUT', token, body });

export const getRazorpayConnection = ({
  token,
}: TokenParams): Promise<ApiSuccessResponse<RazorpayConnection>> =>
  apiFetch('/settings/razorpay', { token });

/**
 * Connects the provider.
 *
 * The secrets travel once, on this request. No read route returns them in any form - not even a
 * last four - so rotating a key means pasting a new pair.
 */
export const connectRazorpay = ({
  token,
  ...body
}: TokenParams & {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}): Promise<ApiSuccessResponse<RazorpayConnection>> =>
  apiFetch('/settings/razorpay', { method: 'PUT', token, body });

// --- Recurring templates --------------------------------------------------------------------

export const listRecurringTemplates = ({
  token,
  active,
}: TokenParams & { active?: boolean | null }): Promise<ApiSuccessResponse<RecurringTemplate[]>> =>
  apiFetch(
    `/recurring-invoices${active === undefined || active === null ? '' : `?active=${String(active)}`}`,
    { token },
  );

export const createRecurringTemplate = ({
  token,
  ...body
}: TokenParams &
  InvoiceContentsInput & {
    contactId: string;
    conversationId?: string | null;
    name?: string;
    intervalMonths?: number;
    dayOfMonth?: number;
    dueInDays?: number;
    /** `draft` means a human issues each generated invoice. `issued` is unattended. */
    generateAs?: 'draft' | 'issued';
    startFrom?: string | null;
  }): Promise<ApiSuccessResponse<RecurringTemplate>> =>
  apiFetch('/recurring-invoices', { method: 'POST', token, body });

/**
 * Edits a schedule.
 *
 * NO `contactId`. A template owns a billing history - every invoice it generated carries its id
 * - so repointing it would attribute one client's invoices to another. The server does not
 * accept one either; billing somebody else means a new schedule.
 */
export const updateRecurringTemplate = ({
  token,
  templateId,
  ...body
}: TokenParams &
  InvoiceContentsInput & {
    templateId: string;
    name?: string;
    intervalMonths?: number;
    dayOfMonth?: number;
    dueInDays?: number;
    generateAs?: 'draft' | 'issued';
  }): Promise<ApiSuccessResponse<RecurringTemplate>> =>
  apiFetch(`/recurring-invoices/${templateId}`, { method: 'PUT', token, body });

export const setRecurringTemplateActive = ({
  token,
  templateId,
  active,
}: TokenParams & { templateId: string; active: boolean }): Promise<
  ApiSuccessResponse<RecurringTemplate>
> =>
  apiFetch(`/recurring-invoices/${templateId}/active`, {
    method: 'POST',
    token,
    body: { active },
  });
