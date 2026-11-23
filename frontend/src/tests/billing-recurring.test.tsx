/**
 * Schedules that bill people while nobody is watching.
 *
 * The risk here is not a wrong click, it is the absence of one: a template set up in March still
 * bills in September with no human in the loop. So the row has to state, without being opened,
 * whether it produces a draft for somebody to check or issues a numbered invoice outright, when
 * the next one falls due, and whether the last run failed.
 *
 * And there is deliberately no "generate now": generation belongs to the daily runner, which
 * holds the lease and the period key that make running twice safe.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  listRecurringTemplates: vi.fn(),
  setRecurringTemplateActive: vi.fn(),
  updateRecurringTemplate: vi.fn(),
  listInvoices: vi.fn(),
  getInvoice: vi.fn(),
}));

vi.mock('../api/billing', () => ({
  listRecurringTemplates: mocks.listRecurringTemplates,
  setRecurringTemplateActive: mocks.setRecurringTemplateActive,
  updateRecurringTemplate: mocks.updateRecurringTemplate,
  listInvoices: mocks.listInvoices,
  getInvoice: mocks.getInvoice,
  createRecurringTemplate: vi.fn(),
  listInvoicePayments: vi.fn(),
  listPaymentLinks: vi.fn(),
  downloadInvoicePdf: vi.fn(),
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

const RecurringPanel = (await import('../components/billing/RecurringPanel')).default;

const template = (overrides: Record<string, unknown> = {}) => ({
  id: 'tpl1',
  name: 'Studio retainer',
  active: true,
  intervalMonths: 1,
  intervalLabel: 'Monthly',
  dayOfMonth: 5,
  generateAs: 'draft',
  billTo: { name: 'Riya Sharma', state: 'Karnataka', gstin: null, address: null },
  items: [],
  nextRunAt: '2026-12-05T00:00:00.000Z',
  nextPeriod: '2026-12',
  generatedCount: 0,
  lastError: null,
  lastRunAt: null,
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
  mocks.listRecurringTemplates.mockResolvedValue({ data: [] });
  mocks.listInvoices.mockResolvedValue({ data: [] });
  asUser(['invoices.read', 'invoices.manage']);
});

const generatedInvoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv1',
  invoiceNumber: 'VIS-2026-0004',
  status: 'issued',
  isOverdue: false,
  billTo: { name: 'Riya Sharma', state: null, gstin: null, address: null },
  items: [],
  total: '11800.00',
  totalPaise: 1180000,
  balance: '11800.00',
  balancePaise: 1180000,
  amountPaidPaise: 0,
  dueDate: null,
  remindersSentCount: 0,
  paymentFollowUp: { state: null, remindersSent: 0, nextAt: null },
  ...overrides,
});

describe('what a row tells you without being opened', () => {
  it('distinguishes a schedule that issues invoices from one that drafts them', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({
      data: [template({ generateAs: 'issued' })],
    });

    render(<RecurringPanel />);

    // "Creates drafts" would be a very different promise to the person reading this row.
    expect(await screen.findByText('Issues automatically')).toBeInTheDocument();
  });

  it('shows the next occurrence and the period it will bill', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template()] });

    render(<RecurringPanel />);

    expect(await screen.findByText(/Next: .*Dec 2026/)).toBeInTheDocument();
    expect(screen.getByText(/2026-12/)).toBeInTheDocument();
  });

  it('shows how many invoices a schedule has already produced', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template({ generatedCount: 7 })] });

    render(<RecurringPanel />);

    expect(await screen.findByText(/7 generated/)).toBeInTheDocument();
  });

  it('surfaces a failed run rather than leaving it silent', async () => {
    // The failure nobody notices until a client asks why they were not invoiced.
    mocks.listRecurringTemplates.mockResolvedValue({
      data: [template({ lastError: 'Billing profile has no GSTIN.' })],
    });

    render(<RecurringPanel />);

    expect(await screen.findByText(/Billing profile has no GSTIN/)).toBeInTheDocument();
  });

  it('marks a paused schedule and says when it would resume', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template({ active: false })] });

    render(<RecurringPanel />);

    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(screen.getByText(/resumes from/)).toBeInTheDocument();
  });
});

describe('pausing and resuming', () => {
  it('warns that the next run date does not move, because that surprises people', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template()] });

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));

    const dialog = await screen.findByRole('dialog', { name: /Pause this schedule/ });

    expect(dialog).toHaveTextContent(/next run date does not move/i);
    expect(mocks.setRecurringTemplateActive).not.toHaveBeenCalled();
  });

  it('pauses once confirmed', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template()] });
    mocks.setRecurringTemplateActive.mockResolvedValue({ data: template({ active: false }) });

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));

    // The row button and the dialog's confirm share a label, so the confirm is taken from
    // inside the dialog rather than by name alone.
    const dialog = await screen.findByRole('dialog', { name: /Pause this schedule/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause' }));

    await waitFor(() => expect(mocks.setRecurringTemplateActive).toHaveBeenCalled());

    expect(mocks.setRecurringTemplateActive.mock.calls[0]![0]).toMatchObject({
      templateId: 'tpl1',
      active: false,
    });
  });

  it('resumes without a confirmation, because resuming harms nothing immediately', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template({ active: false })] });
    mocks.setRecurringTemplateActive.mockResolvedValue({ data: template() });

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));

    await waitFor(() =>
      expect(mocks.setRecurringTemplateActive.mock.calls[0]![0]).toMatchObject({ active: true }),
    );
  });

  it('reports a failed toggle instead of showing the wrong state', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template({ active: false })] });
    mocks.setRecurringTemplateActive.mockRejectedValue(new Error('That schedule was deleted.'));

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/was deleted/i);
  });
});

describe('permissions', () => {
  it('gives a reader no way to pause, resume or create', async () => {
    asUser(['invoices.read']);

    mocks.listRecurringTemplates.mockResolvedValue({ data: [template()] });

    render(<RecurringPanel />);

    await screen.findByText('Studio retainer');

    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New schedule' })).not.toBeInTheDocument();
  });
});

describe('a schedule never messages anyone', () => {
  it('says so on the panel', async () => {
    render(<RecurringPanel />);

    expect(
      await screen.findByText(/Clients are never messaged by a schedule/i),
    ).toBeInTheDocument();
  });

  it('offers no generate-now, which would be a second path into the runner invariant', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template()] });

    render(<RecurringPanel />);

    await screen.findByText('Studio retainer');

    for (const label of [/generate/i, /run now/i, /send/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });
});

describe('what a schedule has actually billed', () => {
  it('is not offered on a schedule that has produced nothing', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template({ generatedCount: 0 })] });

    render(<RecurringPanel />);

    await screen.findByText('Studio retainer');
    expect(screen.queryByRole('button', { name: 'Invoices' })).not.toBeInTheDocument();
  });

  it('is loaded only when asked for, not once per row up front', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template({ generatedCount: 3 })] });

    render(<RecurringPanel />);

    await screen.findByRole('button', { name: 'Invoices' });

    // Most visits to this screen are to check a next-run date. A history per row would be a
    // request each for something nobody opened.
    expect(mocks.listInvoices).not.toHaveBeenCalled();
  });

  it('asks the server for that template only', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template({ generatedCount: 3 })] });
    mocks.listInvoices.mockResolvedValue({ data: [generatedInvoice()] });

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Invoices' }));

    await waitFor(() =>
      expect(mocks.listInvoices.mock.calls[0]![0]).toMatchObject({ recurringTemplateId: 'tpl1' }),
    );

    expect(await screen.findByText('VIS-2026-0004')).toBeInTheDocument();
  });

  it('says plainly when a schedule has billed nothing yet', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template({ generatedCount: 2 })] });
    mocks.listInvoices.mockResolvedValue({ data: [] });

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Invoices' }));

    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument();
  });

  it('collapses again rather than reloading on every press', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template({ generatedCount: 3 })] });
    mocks.listInvoices.mockResolvedValue({ data: [generatedInvoice()] });

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Invoices' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Hide invoices' }));

    await waitFor(() => expect(screen.queryByText('VIS-2026-0004')).not.toBeInTheDocument());
    expect(mocks.listInvoices).toHaveBeenCalledTimes(1);
  });
});

describe('the expanded history does not crush the row it belongs to', () => {
  /**
   * The original bug: the history panel was a third child of the row's `sm:flex-row` line, so
   * it competed for width with the schedule's own text and squashed "Monthly on day 5 · Sharma
   * Weddings" into a column two words wide on a 1440px screen.
   *
   * jsdom measures nothing, so these pin the structural cause instead — a full-width child on a
   * wrapping row, which can only land on a line of its own. The visual result was confirmed in
   * a real browser.
   */
  /** Expands the history and returns the SCHEDULE's row, not the invoice's own list item. */
  const expandHistory = async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template({ generatedCount: 2 })] });
    mocks.listInvoices.mockResolvedValue({ data: [generatedInvoice()] });

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Invoices' }));
    await screen.findByText('VIS-2026-0004');

    return screen.getByText('Studio retainer').closest('li')!;
  };

  it('keeps the history inside the row it describes', async () => {
    const row = await expandHistory();

    expect(within(row).getByText('VIS-2026-0004')).toBeInTheDocument();
  });

  it('gives the history a line of its own instead of a share of the row', async () => {
    const row = await expandHistory();

    const history = within(row).getByText('VIS-2026-0004').closest('div.w-full');

    // Full width on a wrapping row: it cannot sit beside the schedule text.
    expect(history).not.toBeNull();
    expect(row.className).toContain('sm:flex-wrap');
  });

  it('leaves the schedule text readable while the history is open', async () => {
    const row = await expandHistory();

    // The details that were being squashed are still rendered in full.
    expect(row.textContent).toContain('Monthly on day 5');
    expect(row.textContent).toContain('Riya Sharma');
    expect(row.textContent).toContain('2 generated');
  });
});

describe('editing a schedule', () => {
  it('is offered to somebody who may manage billing', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template()] });

    render(<RecurringPanel />);

    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('is not offered to a reader', async () => {
    asUser(['invoices.read']);
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template()] });

    render(<RecurringPanel />);

    await screen.findByText('Studio retainer');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('opens with the schedule as it stands rather than blank', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({
      data: [template({ dayOfMonth: 12, dueInDays: 30, generateAs: 'issued' })],
    });

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: /Edit recurring invoice/ });

    expect((within(dialog).getByLabelText('On day') as HTMLInputElement).value).toBe('12');
    expect((within(dialog).getByLabelText('Payable within (days)') as HTMLInputElement).value).toBe('30');
  });

  it('does not offer to move the schedule to another client', async () => {
    // The invoices it has already raised belong to this one; repointing would reattribute them.
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template()] });

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: /Edit recurring invoice/ });

    expect(within(dialog).queryByLabelText('Client')).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent(/cannot be moved to another client/i);
  });

  it('says that edits apply from the next invoice', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({ data: [template()] });

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(await screen.findByText(/apply from the next invoice/i)).toBeInTheDocument();
  });

  it('sends the edit without a contact id', async () => {
    mocks.listRecurringTemplates.mockResolvedValue({
      data: [template({ items: [{ description: 'Retainer', rate: '10000', taxRate: '18' }] })],
    });
    mocks.updateRecurringTemplate.mockResolvedValue({ data: template() });

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: /Edit recurring invoice/ });

    fireEvent.change(within(dialog).getByLabelText('Amount (₹)'), { target: { value: '12000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mocks.updateRecurringTemplate).toHaveBeenCalled());

    const sent = mocks.updateRecurringTemplate.mock.calls[0]![0];
    expect(sent).toMatchObject({ templateId: 'tpl1' });
    expect(sent.items[0].rate).toBe('12000');
    expect(sent).not.toHaveProperty('contactId');
  });

  it("surfaces the server's refusal", async () => {
    mocks.listRecurringTemplates.mockResolvedValue({
      data: [template({ items: [{ description: 'Retainer', rate: '10000', taxRate: '18' }] })],
    });
    mocks.updateRecurringTemplate.mockRejectedValue(
      new Error('A schedule repeats every 1, 2, 3, 6 or 12 months.'),
    );

    render(<RecurringPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: /Edit recurring invoice/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/1, 2, 3, 6 or 12 months/);
  });
});

describe('loading and failure', () => {
  it('shows a spinner first', () => {
    mocks.listRecurringTemplates.mockReturnValue(new Promise(() => {}));

    render(<RecurringPanel />);

    expect(screen.getByText(/Loading schedules/i)).toBeInTheDocument();
  });

  it('explains an empty list differently to somebody who could fill it', async () => {
    render(<RecurringPanel />);

    expect(await screen.findByText(/Set one up for a retainer/i)).toBeInTheDocument();
  });

  it('reports a failed load', async () => {
    mocks.listRecurringTemplates.mockRejectedValue(new Error('Upstream unavailable.'));

    render(<RecurringPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Upstream unavailable/i);
  });
});


it('preserves extra lines, quantities, discounts and billing identity while editing a schedule', async () => {
  const extra = { description: 'Hosting', quantity: '3', rate: '200', taxRate: '18', discountPercent: '5' };
  mocks.listRecurringTemplates.mockResolvedValue({ data: [template({
    items: [{ description: 'Retainer', quantity: '2', rate: '10000', taxRate: '18',
      discountPercent: '10', hsnSacCode: '9983', unit: 'month' }, extra],
    discount: '150.00', billTo: { name: 'Synthetic customer', state: 'Karnataka',
      gstin: '29ABCDE1234F1Z5', address: 'Synthetic test address' }, notes: 'Keep notes', terms: 'Keep terms',
  })] });
  mocks.updateRecurringTemplate.mockResolvedValue({ data: template() });
  render(<RecurringPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog', { name: /Edit recurring invoice/ });
  fireEvent.change(within(dialog).getByLabelText(/Amount/), { target: { value: '12000' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(mocks.updateRecurringTemplate).toHaveBeenCalled());
  expect(mocks.updateRecurringTemplate.mock.calls[0]![0]).toMatchObject({
    discount: '150.00', billToName: 'Synthetic customer', billToGstin: '29ABCDE1234F1Z5',
    billToAddress: 'Synthetic test address', notes: 'Keep notes', terms: 'Keep terms',
    items: [{ description: 'Retainer', quantity: '2', rate: '12000', taxRate: '18',
      discountPercent: '10', hsnSacCode: '9983', unit: 'month' }, extra],
  });
});
