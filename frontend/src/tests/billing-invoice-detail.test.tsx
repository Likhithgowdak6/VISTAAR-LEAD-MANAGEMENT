/**
 * The invoice screen: what it shows, what it lets you do, and what it refuses to.
 *
 * TWO THINGS ARE BEING PROTECTED HERE.
 *
 * **The figures add up on screen.** An invoice that prints a round-off line in its PDF and
 * doesn't show one here would look like it cannot add, and the first person to notice would be
 * a client's accounts clerk. The GST split is shown as it was CHARGED - CGST+SGST or IGST,
 * never both - because that is what the tax return was filed on.
 *
 * **Nothing here messages a customer.** Reminder state is reported so somebody can see the chase
 * is running; there is no control to start or advance it, because authorising a message belongs
 * to the owner approval flow with its own gate.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  getInvoice: vi.fn(),
  issueInvoice: vi.fn(),
  cancelInvoice: vi.fn(),
  listInvoicePayments: vi.fn(),
  listPaymentLinks: vi.fn(),
}));

vi.mock('../api/billing', () => ({
  getInvoice: mocks.getInvoice,
  issueInvoice: mocks.issueInvoice,
  cancelInvoice: mocks.cancelInvoice,
  listInvoicePayments: mocks.listInvoicePayments,
  listPaymentLinks: mocks.listPaymentLinks,
  downloadInvoicePdf: vi.fn(),
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

const InvoiceDetailDialog = (await import('../components/billing/InvoiceDetailDialog')).default;

const invoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv1',
  organizationId: 'org1',
  contactId: 'c1',
  conversationId: null,
  invoiceNumber: 'VIS-2026-0007',
  status: 'issued',
  isOverdue: false,
  billTo: { name: 'Riya Sharma', state: 'Karnataka', gstin: '29ABCDE1234F1Z5', address: 'Bengaluru' },
  items: [
    {
      description: 'Wedding shoot',
      hsnSacCode: '998383',
      quantity: '1',
      unit: 'day',
      ratePaise: 15000000,
      rate: '150000.00',
      discountPercent: '0',
      taxRate: '18',
      subtotalPaise: 15000000,
      subtotal: '150000.00',
      taxPaise: 2700000,
      tax: '27000.00',
      totalPaise: 17700000,
      total: '177000.00',
    },
  ],
  subtotalPaise: 15000000,
  subtotal: '150000.00',
  discountPaise: 0,
  discount: '0.00',
  taxablePaise: 15000000,
  taxable: '150000.00',
  taxPaise: 2700000,
  tax: '27000.00',
  cgstPaise: 1350000,
  cgst: '13500.00',
  sgstPaise: 1350000,
  sgst: '13500.00',
  igstPaise: 0,
  igst: '0.00',
  roundOffPaise: 0,
  roundOff: '0.00',
  totalPaise: 17700000,
  total: '177000.00',
  amountPaidPaise: 0,
  amountPaid: '0.00',
  balancePaise: 17700000,
  balance: '177000.00',
  isInterstate: false,
  dueDate: '2026-12-02T00:00:00.000Z',
  promiseDate: null,
  paymentFollowUp: { state: null, remindersSent: 0, nextAt: null },
  issuedAt: '2026-11-18T00:00:00.000Z',
  paidAt: null,
  notes: null,
  terms: null,
  remindersSentCount: 0,
  lastReminderAt: null,
  razorpayLinkUrl: null,
  hasPdf: true,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

const asUser = (permissions: string[]) =>
  mocks.useAuth.mockReturnValue({
    permissions,
    authedRequest: (make: (token: string) => unknown) => Promise.resolve(make('t')),
  });

const open = (data: Record<string, unknown> = {}) => {
  mocks.getInvoice.mockResolvedValue({ data: invoice(data) });

  return render(
    <InvoiceDetailDialog invoiceId="inv1" onClose={vi.fn()} onChanged={vi.fn()} />,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listInvoicePayments.mockResolvedValue({ data: [] });
  mocks.listPaymentLinks.mockResolvedValue({ data: [] });
  asUser(['invoices.read', 'invoices.manage', 'payments.record']);
});

describe('the figures', () => {
  it('shows the total the server calculated', async () => {
    open();

    // Scoped to the summary row rather than matched anywhere on screen - the line item and the
    // balance carry the same figure on a single-item unpaid invoice, so a loose match would pass
    // even if the Total row went missing.
    const label = await screen.findByText('Total', { selector: 'span' });

    expect(label.parentElement).toHaveTextContent('₹1,77,000.00');
  });

  it('shows CGST and SGST on an intra-state invoice, and no IGST', async () => {
    open();

    await screen.findByText('VIS-2026-0007');

    expect(screen.getByText('CGST')).toBeInTheDocument();
    expect(screen.getByText('SGST')).toBeInTheDocument();
    expect(screen.queryByText('IGST')).not.toBeInTheDocument();
  });

  it('shows IGST alone on an inter-state invoice', async () => {
    open({
      isInterstate: true,
      cgstPaise: 0,
      cgst: '0.00',
      sgstPaise: 0,
      sgst: '0.00',
      igstPaise: 2700000,
      igst: '27000.00',
    });

    await screen.findByText('VIS-2026-0007');

    expect(screen.getByText('IGST')).toBeInTheDocument();
    expect(screen.queryByText('CGST')).not.toBeInTheDocument();
  });

  it('shows a round-off line when there is one, so the total visibly adds up', async () => {
    open({ roundOffPaise: 41, roundOff: '0.41' });

    expect(await screen.findByText('Round off')).toBeInTheDocument();
  });

  it('hides the round-off line when it is zero', async () => {
    open();

    await screen.findByText('VIS-2026-0007');
    expect(screen.queryByText('Round off')).not.toBeInTheDocument();
  });
});

describe('issuing', () => {
  it('is offered on a draft', async () => {
    open({ status: 'draft', invoiceNumber: null });

    expect(await screen.findByRole('button', { name: 'Issue' })).toBeInTheDocument();
  });

  it('is not offered once issued, because a number is already spent', async () => {
    open();

    await screen.findByText('VIS-2026-0007');
    expect(screen.queryByRole('button', { name: 'Issue' })).not.toBeInTheDocument();
  });

  it('says plainly that issuing does not message the client', async () => {
    mocks.issueInvoice.mockResolvedValue({ data: invoice() });

    open({ status: 'draft', invoiceNumber: null });

    fireEvent.click(await screen.findByRole('button', { name: 'Issue' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/has not been messaged/i);
  });

  it('is not offered to a reader', async () => {
    asUser(['invoices.read']);

    open({ status: 'draft', invoiceNumber: null });

    await screen.findByText(/Draft invoice/);
    expect(screen.queryByRole('button', { name: 'Issue' })).not.toBeInTheDocument();
  });
});

describe('editing', () => {
  it('is offered on a draft only', async () => {
    open({ status: 'draft', invoiceNumber: null });

    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('is withdrawn once issued, because the client has been told a figure', async () => {
    open();

    await screen.findByText('VIS-2026-0007');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

describe('cancelling', () => {
  it('asks first and says the number is kept', async () => {
    open();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel invoice' }));

    const dialog = await screen.findByRole('dialog', { name: /Cancel this invoice/ });

    expect(dialog).toHaveTextContent(/keeps its number/i);
    expect(dialog).toHaveTextContent(/cannot be undone/i);
    expect(mocks.cancelInvoice).not.toHaveBeenCalled();
  });

  it('is not offered on a paid invoice', async () => {
    open({ status: 'paid', balancePaise: 0, balance: '0.00', amountPaidPaise: 17700000 });

    await screen.findByText('VIS-2026-0007');
    expect(screen.queryByRole('button', { name: 'Cancel invoice' })).not.toBeInTheDocument();
  });
});

describe('reminder state is reported, never controlled', () => {
  it('shows how many reminders went out and any promised date', async () => {
    open({
      remindersSentCount: 2,
      lastReminderAt: '2026-11-15T00:00:00.000Z',
      promiseDate: '2026-11-25T00:00:00.000Z',
      paymentFollowUp: { state: 'awaiting_payment', remindersSent: 2, nextAt: null },
    });

    await screen.findByText('Payment chase');

    expect(screen.getByText('Reminders sent')).toBeInTheDocument();
    expect(screen.getByText('Client promised')).toBeInTheDocument();
  });

  it('explains that reminders cannot be started from here', async () => {
    open({ remindersSentCount: 1 });

    expect(await screen.findByText(/cannot be started from here/i)).toBeInTheDocument();
  });

  it('offers no control that would message the client', async () => {
    open({ remindersSentCount: 1, promiseDate: '2026-11-25T00:00:00.000Z' });

    await screen.findByText('Payment chase');

    for (const label of [/send/i, /remind/i, /chase/i, /whatsapp/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });
});

describe('loading and failure', () => {
  it('shows a spinner while loading', () => {
    mocks.getInvoice.mockReturnValue(new Promise(() => {}));

    render(<InvoiceDetailDialog invoiceId="inv1" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(screen.getByText(/Loading invoice/i)).toBeInTheDocument();
  });

  it('reports a failure rather than rendering an empty invoice', async () => {
    mocks.getInvoice.mockRejectedValue(new Error('Invoice not found.'));

    render(<InvoiceDetailDialog invoiceId="inv1" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not found/i);
  });
});
