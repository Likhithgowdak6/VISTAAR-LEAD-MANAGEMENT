/**
 * Raising and editing an invoice.
 *
 * THE FORM DOES NOT CALCULATE THE INVOICE. The figure under the lines is a preview so nobody
 * types blind, and it is labelled as one; the GST split, the discount and the rounding are the
 * server's, in integer paise. These tests pin that boundary - what is SENT is the typed strings,
 * and nothing the browser computed.
 *
 * They also pin the two things a person can get wrong here and not find out until a client reads
 * the invoice: saving a draft by accident when they meant to issue it, and the bill-to state,
 * which silently decides CGST+SGST versus IGST.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  createInvoice: vi.fn(),
  updateInvoice: vi.fn(),
  listConversations: vi.fn(),
}));

vi.mock('../api/billing', () => ({
  createInvoice: mocks.createInvoice,
  updateInvoice: mocks.updateInvoice,
}));

vi.mock('../api/endpoints', () => ({ listConversations: mocks.listConversations }));
vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../hooks/useMobileBackLayer', () => ({ useMobileBackLayer: () => undefined }));

const InvoiceFormDialog = (await import('../components/billing/InvoiceFormDialog')).default;

const asUser = () =>
  mocks.useAuth.mockReturnValue({
    permissions: ['invoices.read', 'invoices.manage'],
    authedRequest: (make: (token: string) => unknown) => Promise.resolve(make('t')),
  });

/** Fills one complete line so a submission reaches validation's far side. */
const fillLine = (description = 'Wedding shoot', rate = '150000') => {
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: description } });
  fireEvent.change(screen.getByLabelText('Rate (₹)'), { target: { value: rate } });
};

const pickClient = async () => {
  // The picker is debounced; the option appears once the conversation list resolves.
  await waitFor(() => expect(screen.getByRole('option', { name: 'Riya Sharma' })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'c1' } });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });

  mocks.listConversations.mockResolvedValue({
    data: [
      { id: 'conv1', contactId: 'c1', displayName: 'Riya Sharma' },
      { id: 'conv2', contactId: 'c1', displayName: 'Riya Sharma' },
      { id: 'conv3', contactId: 'c2', displayName: 'Arjun Mehta' },
    ],
  });

  asUser();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('choosing a client', () => {
  it('offers the leads already in the CRM, one entry per person', async () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    vi.advanceTimersByTime(300);

    // Riya has two threads and is still one person to bill.
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: 'Riya Sharma' })).toHaveLength(1),
    );
    expect(screen.getByRole('option', { name: 'Arjun Mehta' })).toBeInTheDocument();
  });

  it('searches leads rather than loading every conversation', async () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Find a client'), { target: { value: 'arjun' } });

    vi.advanceTimersByTime(300);

    await waitFor(() =>
      expect(mocks.listConversations.mock.calls.at(-1)![0]).toMatchObject({ search: 'arjun' }),
    );
  });

  it('prefills who is billed, while leaving it editable', async () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    vi.advanceTimersByTime(300);
    await pickClient();

    // The person who enquired is often not the entity being invoiced, so this is a default.
    expect((screen.getByLabelText('Billed to') as HTMLInputElement).value).toBe('Riya Sharma');
  });

  it('refuses to save without one', async () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    fillLine();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Choose a client/i);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });
});

describe('lines', () => {
  it('starts with one and can add more', async () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getAllByLabelText('Description')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));

    expect(screen.getAllByLabelText('Description')).toHaveLength(2);
  });

  it('offers no remove on the only line, because an invoice needs one', () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Remove line' })).not.toBeInTheDocument();
  });

  it('names the line that is wrong rather than saying the form is invalid', async () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));

    const descriptions = screen.getAllByLabelText('Description');
    const rates = screen.getAllByLabelText('Rate (₹)');

    fireEvent.change(descriptions[0]!, { target: { value: 'Shoot' } });
    fireEvent.change(rates[0]!, { target: { value: '1000' } });
    fireEvent.change(descriptions[1]!, { target: { value: 'Album' } });
    // Line 2 has no rate.

    vi.advanceTimersByTime(300);
    await pickClient();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Line 2 needs a rate/i);
  });

  it('refuses a quantity of zero, which would be a free line nobody meant', async () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    fillLine();
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '0' } });

    vi.advanceTimersByTime(300);
    await pickClient();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/quantity above zero/i);
  });

  it('refuses a discount that is not a number', async () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    fillLine();
    fireEvent.change(screen.getByLabelText('Invoice discount (₹)'), { target: { value: '10%' } });

    vi.advanceTimersByTime(300);
    await pickClient();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/discount must be a number/i);
  });
});

describe('the preview is only a preview', () => {
  it('says so, because it can differ from the saved invoice by a paisa', () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByText(/calculated when you save/i)).toBeInTheDocument();
  });

  it('sends the typed strings and no computed total', async () => {
    mocks.createInvoice.mockResolvedValue({ data: { id: 'inv1' } });

    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    fillLine('Wedding shoot', '150000');
    fireEvent.change(screen.getByLabelText('GST %'), { target: { value: '18' } });

    vi.advanceTimersByTime(300);
    await pickClient();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(mocks.createInvoice).toHaveBeenCalled());

    const sent = mocks.createInvoice.mock.calls[0]![0];

    expect(sent.items[0]).toMatchObject({ description: 'Wedding shoot', rate: '150000', taxRate: '18' });
    // Two implementations of tax arithmetic is one too many, and the browser's would be wrong.
    expect(sent).not.toHaveProperty('total');
    expect(sent).not.toHaveProperty('tax');
    expect(sent).not.toHaveProperty('totalPaise');
  });
});

describe('draft versus issued', () => {
  it('saves a draft by default, which allocates no number', async () => {
    mocks.createInvoice.mockResolvedValue({ data: { id: 'inv1' } });

    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    fillLine();
    vi.advanceTimersByTime(300);
    await pickClient();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(mocks.createInvoice.mock.calls[0]![0]).toMatchObject({ issue: false }));
  });

  it('changes the button label once issuing is chosen, so the act is not a surprise', async () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('checkbox'));

    expect(await screen.findByRole('button', { name: 'Create and issue' })).toBeInTheDocument();
  });

  it('states that issuing does not message the client', () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByText(/does not message the client/i)).toBeInTheDocument();
  });
});

describe('the bill-to state', () => {
  it('is explained as deciding the GST split rather than left looking cosmetic', () => {
    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByText(/Decides CGST \+ SGST or IGST/)).toBeInTheDocument();
  });

  it('is submitted as typed', async () => {
    mocks.createInvoice.mockResolvedValue({ data: { id: 'inv1' } });

    render(<InvoiceFormDialog onClose={vi.fn()} onSaved={vi.fn()} />);

    fillLine();
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Maharashtra' } });

    vi.advanceTimersByTime(300);
    await pickClient();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() =>
      expect(mocks.createInvoice.mock.calls[0]![0]).toMatchObject({ billToState: 'Maharashtra' }),
    );
  });
});

describe('editing an existing draft', () => {
  const draft = {
    id: 'inv1',
    invoiceNumber: null,
    status: 'draft',
    contactId: 'c1',
    billTo: { name: 'Riya Sharma', state: 'Karnataka', gstin: null, address: null },
    items: [
      {
        description: 'Shoot',
        quantity: '1',
        rate: '1000.00',
        discountPercent: '0',
        taxRate: '18',
        hsnSacCode: null,
        unit: null,
      },
      {
        description: 'Album',
        quantity: '1',
        rate: '500.00',
        discountPercent: '0',
        taxRate: '18',
        hsnSacCode: null,
        unit: null,
      },
    ],
    discount: '0.00',
    dueDate: null,
    notes: null,
    terms: null,
  } as never;

  it('loads the existing lines rather than starting blank', () => {
    render(<InvoiceFormDialog invoice={draft} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getAllByLabelText('Description')).toHaveLength(2);
    expect((screen.getAllByLabelText('Description')[1] as HTMLInputElement).value).toBe('Album');
  });

  it('does not ask for a client again, and does not re-offer issuing', () => {
    render(<InvoiceFormDialog invoice={draft} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.queryByLabelText('Client')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('submits the whole line list, so deleting a row is expressible', async () => {
    mocks.updateInvoice.mockResolvedValue({ data: { id: 'inv1' } });

    render(<InvoiceFormDialog invoice={draft} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove line' })[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mocks.updateInvoice).toHaveBeenCalled());

    // A patch of only the changed row could never express "this line is gone".
    expect(mocks.updateInvoice.mock.calls[0]![0].items).toHaveLength(1);
  });

  it("shows the server's refusal when an invoice may no longer be edited", async () => {
    mocks.updateInvoice.mockRejectedValue(
      new Error('This invoice has already been sent to the client and cannot be edited.'),
    );

    render(<InvoiceFormDialog invoice={draft} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be edited/i);
  });
});
