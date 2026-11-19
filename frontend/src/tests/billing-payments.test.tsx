/**
 * Recording and reversing money.
 *
 * These are the actions a user can take that change what a client is told they owe, so the
 * properties worth pinning are the ones that stop a mistake becoming a wrong figure in front of
 * a customer:
 *
 *   - reversing a payment asks first, and says what will happen rather than "are you sure";
 *   - `online` cannot be typed by hand, because provider money is recorded by the webhook with
 *     an id that deduplicates it - a hand-typed copy would be a second row for the same money;
 *   - a voided row stays visible, because a ledger that hides a reversal is less useful than
 *     one that shows it;
 *   - amounts are validated before a round trip, and the server's own refusal is shown as
 *     written when it comes back.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  listInvoicePayments: vi.fn(),
  recordInvoicePayment: vi.fn(),
  voidInvoicePayment: vi.fn(),
}));

vi.mock('../api/billing', () => ({
  listInvoicePayments: mocks.listInvoicePayments,
  recordInvoicePayment: mocks.recordInvoicePayment,
  voidInvoicePayment: mocks.voidInvoicePayment,
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../hooks/useMobileBackLayer', () => ({ useMobileBackLayer: () => undefined }));

const PaymentsPanel = (await import('../components/billing/PaymentsPanel')).default;

const invoice = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'inv1',
    status: 'issued',
    total: '1180.00',
    totalPaise: 118000,
    balance: '1180.00',
    balancePaise: 118000,
    amountPaidPaise: 0,
    ...overrides,
  }) as never;

const payment = (overrides: Record<string, unknown> = {}) => ({
  id: 'pay1',
  invoiceId: 'inv1',
  amountPaise: 50000,
  amount: '500.00',
  mode: 'cash',
  paidAt: '2026-11-18T00:00:00.000Z',
  reference: null,
  notes: null,
  isVoided: false,
  voidedAt: null,
  voidReason: null,
  isProviderPayment: false,
  recordedBy: null,
  createdAt: null,
  ...overrides,
});

const asUser = (permissions: string[]) =>
  mocks.useAuth.mockReturnValue({
    permissions,
    authedRequest: (make: (token: string) => unknown) => Promise.resolve(make('t')),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listInvoicePayments.mockResolvedValue({ data: [] });
  asUser(['invoices.read', 'payments.record']);
});

describe('recording a payment', () => {
  it('is offered only to somebody who may record payments', async () => {
    asUser(['invoices.read']);

    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);

    await waitFor(() => expect(mocks.listInvoicePayments).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
  });

  it('is not offered on a draft, which has no number and cannot be paid', async () => {
    render(<PaymentsPanel invoice={invoice({ status: 'draft' })} onChanged={vi.fn()} />);

    await waitFor(() => expect(mocks.listInvoicePayments).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
  });

  it('is not offered on a cancelled invoice', async () => {
    render(<PaymentsPanel invoice={invoice({ status: 'cancelled' })} onChanged={vi.fn()} />);

    await waitFor(() => expect(mocks.listInvoicePayments).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
  });

  it('does not offer online as a mode anyone can type', async () => {
    /**
     * Provider money arrives through the webhook carrying a payment id that deduplicates it.
     * A hand-typed `online` row would be a second record of the same money with nothing to
     * match it against.
     */
    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));

    const modes = [...screen.getByLabelText('How').querySelectorAll('option')].map(
      (option) => (option as HTMLOptionElement).value,
    );

    expect(modes).not.toContain('online');
    expect(modes).toContain('cash');
  });

  it('refuses a non-numeric amount without a round trip', async () => {
    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: 'five hundred' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Enter an amount/i);
    expect(mocks.recordInvoicePayment).not.toHaveBeenCalled();
  });

  it('sends the typed amount as a decimal string, not a number', async () => {
    // Paise are the server's business. The browser passes through what was typed.
    mocks.recordInvoicePayment.mockResolvedValue({
      data: { payment: payment(), invoice: invoice({ amountPaidPaise: 50000 }) },
    });

    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '500.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));

    await waitFor(() => expect(mocks.recordInvoicePayment).toHaveBeenCalled());

    const sent = mocks.recordInvoicePayment.mock.calls[0]![0];
    expect(sent.amount).toBe('500.50');
    expect(typeof sent.amount).toBe('string');
  });

  it("shows the server's own refusal rather than a generic failure", async () => {
    // The server refuses more than the outstanding balance, with a message written for the
    // person reading it.
    mocks.recordInvoicePayment.mockRejectedValue(
      new Error('That is more than the ₹1,180.00 still outstanding on this invoice.'),
    );

    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '99999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/still outstanding/i);
  });
});

describe('the ledger', () => {
  it('shows a voided payment rather than hiding it', async () => {
    mocks.listInvoicePayments.mockResolvedValue({
      data: [payment({ isVoided: true, voidReason: 'Entered against the wrong invoice' })],
    });

    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);

    expect(await screen.findByText(/Entered against the wrong invoice/)).toBeInTheDocument();
  });

  it('marks provider payments differently from hand-entered ones', async () => {
    mocks.listInvoicePayments.mockResolvedValue({
      data: [payment({ isProviderPayment: true, mode: 'online' })],
    });

    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);

    expect(await screen.findByText(/online/)).toBeInTheDocument();
  });

  it('offers no reverse button on an already-voided row', async () => {
    mocks.listInvoicePayments.mockResolvedValue({ data: [payment({ isVoided: true })] });

    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);

    await screen.findByText('₹500.00');
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument();
  });
});

describe('reversing a payment', () => {
  beforeEach(() => {
    mocks.listInvoicePayments.mockResolvedValue({ data: [payment()] });
  });

  it('asks first, and says what will happen', async () => {
    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reverse' }));

    const dialog = await screen.findByRole('dialog', { name: /Reverse ₹500.00/ });

    // Not "are you sure" - what actually happens, including that a settled invoice reopens.
    expect(dialog).toHaveTextContent(/stays in the ledger/i);
    expect(dialog).toHaveTextContent(/becomes owed again/i);
    expect(mocks.voidInvoicePayment).not.toHaveBeenCalled();
  });

  it('does nothing when the confirmation is declined', async () => {
    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reverse' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Go back' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Reverse/ })).not.toBeInTheDocument(),
    );
    expect(mocks.voidInvoicePayment).not.toHaveBeenCalled();
  });

  it('reverses once confirmed and hands back the updated invoice', async () => {
    const onChanged = vi.fn();

    mocks.voidInvoicePayment.mockResolvedValue({
      data: {
        payment: payment({ isVoided: true }),
        invoice: invoice({ amountPaidPaise: 0, balancePaise: 118000 }),
      },
    });

    render(<PaymentsPanel invoice={invoice()} onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reverse' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reverse payment' }));

    await waitFor(() => expect(mocks.voidInvoicePayment).toHaveBeenCalledTimes(1));

    // The parent is given the invoice the server returned, so the balance on screen cannot
    // drift from what was actually stored.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('surfaces a failed reversal instead of pretending it worked', async () => {
    mocks.voidInvoicePayment.mockRejectedValue(new Error('That payment has already been reversed.'));

    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reverse' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reverse payment' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already been reversed/i);
  });
});


describe('payment attempt recovery', () => {
  it('reuses the attempt key after an uncertain response and clears it on success', async () => {
    mocks.recordInvoicePayment.mockRejectedValueOnce(new Error('Response lost'))
      .mockResolvedValue({ data: { payment: payment(), invoice: invoice() } });
    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Response lost');
    const firstKey = mocks.recordInvoicePayment.mock.calls[0]![0].idempotencyKey;
    expect(firstKey.length).toBeGreaterThan(8);
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(mocks.recordInvoicePayment).toHaveBeenCalledTimes(2));
    expect(mocks.recordInvoicePayment.mock.calls[1]![0].idempotencyKey).toBe(firstKey);
    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(mocks.recordInvoicePayment).toHaveBeenCalledTimes(3));
    expect(mocks.recordInvoicePayment.mock.calls[2]![0].idempotencyKey).not.toBe(firstKey);
  });

  it('does not silently replace an uncertain payment with changed details', async () => {
    mocks.recordInvoicePayment.mockRejectedValue(new Error('Response lost'));
    render(<PaymentsPanel invoice={invoice()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '700' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/previous payment may have been recorded/i);
    expect(mocks.recordInvoicePayment).toHaveBeenCalledTimes(1);
  });
});
