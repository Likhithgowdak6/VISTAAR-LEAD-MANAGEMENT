/**
 * The list, and the journey from it into one invoice.
 *
 * The list is where somebody answers "who still owes us money", so the properties worth pinning
 * are the ones that would make them answer wrongly: the outstanding figure summed from integers
 * rather than from formatted strings, an overpayment shown as an overpayment rather than clamped
 * to settled, and a status filter that actually reaches the server instead of quietly hiding rows
 * that were never loaded.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  listInvoices: vi.fn(),
  getInvoice: vi.fn(),
  listInvoicePayments: vi.fn(),
  listPaymentLinks: vi.fn(),
  downloadInvoicePdf: vi.fn(),
}));

vi.mock('../api/billing', () => ({
  listInvoices: mocks.listInvoices,
  getInvoice: mocks.getInvoice,
  listInvoicePayments: mocks.listInvoicePayments,
  listPaymentLinks: mocks.listPaymentLinks,
  downloadInvoicePdf: mocks.downloadInvoicePdf,
  issueInvoice: vi.fn(),
  cancelInvoice: vi.fn(),
  recordInvoicePayment: vi.fn(),
  voidInvoicePayment: vi.fn(),
  createPaymentLink: vi.fn(),
  reconcilePaymentLink: vi.fn(),
  cancelPaymentLink: vi.fn(),
  createInvoice: vi.fn(),
  updateInvoice: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({ listConversations: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../hooks/useMobileBackLayer', () => ({ useMobileBackLayer: () => undefined }));

const InvoicesPanel = (await import('../components/billing/InvoicesPanel')).default;

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv1',
  invoiceNumber: 'VIS-2026-0001',
  status: 'issued',
  isOverdue: false,
  billTo: { name: 'Riya Sharma', state: null, gstin: null, address: null },
  items: [],
  total: '1180.00',
  totalPaise: 118000,
  balance: '1180.00',
  balancePaise: 118000,
  amountPaidPaise: 0,
  dueDate: null,
  promiseDate: null,
  remindersSentCount: 0,
  paymentFollowUp: { state: null, remindersSent: 0, nextAt: null },
  ...overrides,
});

const detail = (overrides: Record<string, unknown> = {}) => ({
  ...row(),
  organizationId: 'org1',
  contactId: 'c1',
  conversationId: null,
  subtotal: '1000.00',
  subtotalPaise: 100000,
  discount: '0.00',
  discountPaise: 0,
  taxable: '1000.00',
  taxablePaise: 100000,
  tax: '180.00',
  taxPaise: 18000,
  cgst: '90.00',
  cgstPaise: 9000,
  sgst: '90.00',
  sgstPaise: 9000,
  igst: '0.00',
  igstPaise: 0,
  roundOff: '0.00',
  roundOffPaise: 0,
  amountPaid: '0.00',
  isInterstate: false,
  issuedAt: '2026-11-18T00:00:00.000Z',
  paidAt: null,
  notes: null,
  terms: null,
  lastReminderAt: null,
  razorpayLinkUrl: null,
  hasPdf: true,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

/** The "N shown · ₹X outstanding" line, whose two halves are separate text nodes. */
const summary = () => screen.findByText(/shown ·/);

const asUser = (permissions: string[]) =>
  mocks.useAuth.mockReturnValue({
    permissions,
    authedRequest: (make: (token: string) => unknown) => Promise.resolve(make('t')),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listInvoices.mockResolvedValue({ data: [] });
  mocks.listInvoicePayments.mockResolvedValue({ data: [] });
  mocks.listPaymentLinks.mockResolvedValue({ data: [] });
  asUser(['invoices.read', 'invoices.manage']);
});

describe('what is owed', () => {
  it('sums the outstanding balance from the integers, not from the formatted strings', async () => {
    mocks.listInvoices.mockResolvedValue({
      data: [
        row({ id: 'a', balancePaise: 33333, balance: '333.33' }),
        row({ id: 'b', balancePaise: 33333, balance: '333.33' }),
        row({ id: 'c', balancePaise: 33333, balance: '333.33' }),
      ],
    });

    render(<InvoicesPanel />);

    // 99,999 paise, formatted once at the end. Accumulating rupees instead - dividing each row
    // by 100 and adding the floats - is how a header total drifts from the rows beneath it.
    expect(await summary()).toHaveTextContent('₹999.99 outstanding');
  });

  it('leaves drafts and cancelled invoices out of the outstanding figure', async () => {
    mocks.listInvoices.mockResolvedValue({
      data: [
        row({ id: 'a', status: 'issued', balancePaise: 100000, balance: '1000.00' }),
        row({ id: 'b', status: 'draft', invoiceNumber: null, balancePaise: 500000, balance: '5000.00' }),
        row({ id: 'c', status: 'cancelled', balancePaise: 900000, balance: '9000.00' }),
      ],
    });

    render(<InvoicesPanel />);

    // Nobody owes money on a draft that was never issued, or on an invoice that was withdrawn.
    expect(await summary()).toHaveTextContent('₹1,000.00 outstanding');
  });

  it('shows an overpayment rather than clamping it to settled', async () => {
    mocks.listInvoices.mockResolvedValue({
      data: [row({ balancePaise: -25000, balance: '-250.00', status: 'paid' })],
    });

    render(<InvoicesPanel />);

    // Somebody paid too much; that needs a human, so it must not look like a clean settlement.
    expect(await screen.findByText(/₹250.00 overpaid/)).toBeInTheDocument();
  });

  it('marks a fully paid invoice as settled', async () => {
    mocks.listInvoices.mockResolvedValue({
      data: [row({ balancePaise: 0, balance: '0.00', status: 'paid', amountPaidPaise: 118000 })],
    });

    render(<InvoicesPanel />);

    expect(await screen.findByText('Settled')).toBeInTheDocument();
  });
});

describe('finding an invoice', () => {
  it('filters by status at the server, so the count is not of a partial page', async () => {
    render(<InvoicesPanel />);

    await waitFor(() => expect(mocks.listInvoices).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'paid' } });

    await waitFor(() =>
      expect(mocks.listInvoices.mock.calls.at(-1)![0]).toMatchObject({ status: 'paid' }),
    );
  });

  it('sends no status when showing everything', async () => {
    render(<InvoicesPanel />);

    await waitFor(() => expect(mocks.listInvoices).toHaveBeenCalled());

    expect(mocks.listInvoices.mock.calls[0]![0]).toMatchObject({ status: null });
  });

  it('searches the loaded page by number, client or amount', async () => {
    mocks.listInvoices.mockResolvedValue({
      data: [
        row({ id: 'a', invoiceNumber: 'VIS-2026-0001', billTo: { name: 'Riya Sharma', state: null, gstin: null, address: null } }),
        row({ id: 'b', invoiceNumber: 'VIS-2026-0002', billTo: { name: 'Arjun Mehta', state: null, gstin: null, address: null } }),
      ],
    });

    render(<InvoicesPanel />);

    await screen.findByText('VIS-2026-0001');

    fireEvent.change(screen.getByLabelText('Search invoices'), { target: { value: 'arjun' } });

    expect(screen.queryByText('VIS-2026-0001')).not.toBeInTheDocument();
    expect(screen.getByText('VIS-2026-0002')).toBeInTheDocument();
  });

  it('says nothing matched rather than looking like an empty workspace', async () => {
    mocks.listInvoices.mockResolvedValue({ data: [row()] });

    render(<InvoicesPanel />);

    await screen.findByText('VIS-2026-0001');

    fireEvent.change(screen.getByLabelText('Search invoices'), { target: { value: 'zzz' } });

    expect(screen.getByText('Nothing matched')).toBeInTheDocument();
  });
});

describe('from the list into one invoice', () => {
  it('opens the detail, shows the figures, and offers the PDF', async () => {
    mocks.listInvoices.mockResolvedValue({ data: [row()] });
    mocks.getInvoice.mockResolvedValue({ data: detail() });
    mocks.downloadInvoicePdf.mockResolvedValue({ data: new Blob(['%PDF']) });

    render(<InvoicesPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /VIS-2026-0001/ }));

    await waitFor(() => expect(mocks.getInvoice.mock.calls[0]![0]).toMatchObject({ invoiceId: 'inv1' }));

    const label = await screen.findByText('Total', { selector: 'span' });
    expect(label.parentElement).toHaveTextContent('₹1,180.00');

    fireEvent.click(screen.getByRole('button', { name: 'View PDF' }));

    await waitFor(() =>
      expect(mocks.downloadInvoicePdf.mock.calls[0]![0]).toMatchObject({ invoiceId: 'inv1' }),
    );
  });

  it('previews a draft as a PDF without issuing it a number', async () => {
    /**
     * The backend renders a draft too - it files the document as `draft.pdf` - because an owner
     * checking what a client will see should not have to burn an invoice number to look. So the
     * button is offered; what must not happen is the preview quietly issuing the invoice.
     */
    mocks.listInvoices.mockResolvedValue({ data: [row({ status: 'draft', invoiceNumber: null })] });
    mocks.getInvoice.mockResolvedValue({ data: detail({ status: 'draft', invoiceNumber: null }) });
    mocks.downloadInvoicePdf.mockResolvedValue({ data: new Blob(['%PDF']) });

    render(<InvoicesPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /Draft/ }));

    await screen.findByText(/Draft invoice/);
    fireEvent.click(screen.getByRole('button', { name: 'View PDF' }));

    await waitFor(() => expect(mocks.downloadInvoicePdf).toHaveBeenCalledTimes(1));

    // Still a draft on screen afterwards: nothing was issued by looking at it.
    expect(screen.getByRole('button', { name: 'Issue' })).toBeInTheDocument();
  });
});

describe('loading and failure', () => {
  it('shows a spinner first', () => {
    mocks.listInvoices.mockReturnValue(new Promise(() => {}));

    render(<InvoicesPanel />);

    expect(screen.getByText(/Loading invoices/i)).toBeInTheDocument();
  });

  it('reports a failed load instead of an empty list', async () => {
    mocks.listInvoices.mockRejectedValue(new Error('Upstream unavailable.'));

    render(<InvoicesPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Upstream unavailable/i);
    expect(screen.queryByText('No invoices yet')).not.toBeInTheDocument();
  });
});
