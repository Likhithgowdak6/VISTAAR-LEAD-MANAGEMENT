/**
 * What each role can see and press in billing.
 *
 * THE SERVER IS THE SECURITY BOUNDARY, not this. Every route behind these buttons checks its own
 * permission, so hiding a control is a UX decision rather than a defence. It still matters: a
 * manager shown "Record payment" who gets a 403 learns nothing useful, and a button that only
 * sometimes works is worse than one that is absent.
 *
 * The three permissions are genuinely different acts and are tested as such - reading what a
 * client was billed, changing what they owe, and declaring that money arrived.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  listInvoices: vi.fn(),
  listInvoicePayments: vi.fn(),
  listPaymentLinks: vi.fn(),
  listRecurringTemplates: vi.fn(),
  getBillingProfile: vi.fn(),
  getRazorpayConnection: vi.fn(),
  getInvoice: vi.fn(),
}));

vi.mock('../api/billing', () => ({
  listInvoices: mocks.listInvoices,
  listInvoicePayments: mocks.listInvoicePayments,
  listPaymentLinks: mocks.listPaymentLinks,
  listRecurringTemplates: mocks.listRecurringTemplates,
  getBillingProfile: mocks.getBillingProfile,
  getRazorpayConnection: mocks.getRazorpayConnection,
  getInvoice: mocks.getInvoice,
  recordInvoicePayment: vi.fn(),
  voidInvoicePayment: vi.fn(),
  createPaymentLink: vi.fn(),
  reconcilePaymentLink: vi.fn(),
  cancelPaymentLink: vi.fn(),
  issueInvoice: vi.fn(),
  cancelInvoice: vi.fn(),
  downloadInvoicePdf: vi.fn(),
  updateBillingProfile: vi.fn(),
  connectRazorpay: vi.fn(),
  setRecurringTemplateActive: vi.fn(),
  createRecurringTemplate: vi.fn(),
  createInvoice: vi.fn(),
  updateInvoice: vi.fn(),
  reconcileInvoiceLedger: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({ listConversations: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../hooks/useMobileBackLayer', () => ({ useMobileBackLayer: () => undefined }));

const BillingPage = (await import('../pages/BillingPage')).default;

const asUser = (permissions: string[]) => {
  mocks.useAuth.mockReturnValue({
    permissions,
    authedRequest: (make: (token: string) => unknown) => Promise.resolve(make('t')),
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listInvoices.mockResolvedValue({ data: [] });
  mocks.listRecurringTemplates.mockResolvedValue({ data: [] });
  mocks.getBillingProfile.mockResolvedValue({ data: {} });
  mocks.getRazorpayConnection.mockResolvedValue({ data: { connected: false } });
});

describe('who sees billing at all', () => {
  it('tells somebody with no billing permission that they have no access', async () => {
    asUser(['messages.send']);

    render(<BillingPage />);

    expect(await screen.findByText(/do not have access to billing/i)).toBeInTheDocument();
  });

  it('shows the invoice list to a reader', async () => {
    asUser(['invoices.read']);

    render(<BillingPage />);

    expect(await screen.findByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
  });
});

describe('the tab strip', () => {
  it('is absent when only one section is available', async () => {
    // A single tab is not a choice, and rendering one implies there is somewhere else to go.
    asUser(['invoices.read']);

    render(<BillingPage />);

    await screen.findByRole('heading', { name: 'Invoices' });
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('hides Recurring from a reader who cannot raise invoices', async () => {
    asUser(['invoices.read']);

    render(<BillingPage />);

    await screen.findByRole('heading', { name: 'Invoices' });
    expect(screen.queryByRole('tab', { name: 'Recurring' })).not.toBeInTheDocument();
  });

  it('hides Settings from somebody who cannot manage workspace settings', async () => {
    asUser(['invoices.read', 'invoices.manage']);

    render(<BillingPage />);

    await screen.findByRole('tab', { name: 'Recurring' });
    expect(screen.queryByRole('tab', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('shows all three to an admin', async () => {
    asUser(['invoices.read', 'invoices.manage', 'settings.manage']);

    render(<BillingPage />);

    expect(await screen.findByRole('tab', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Recurring' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
  });

  it('falls back to a tab the caller can open rather than a blank panel', async () => {
    // A deep link to settings from somebody without `settings.manage`.
    asUser(['invoices.read']);

    render(<BillingPage defaultTab="settings" />);

    expect(await screen.findByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
  });
});

describe('raising invoices', () => {
  it('offers New invoice to somebody who may manage them', async () => {
    asUser(['invoices.read', 'invoices.manage']);

    render(<BillingPage />);

    expect(await screen.findByRole('button', { name: 'New invoice' })).toBeInTheDocument();
  });

  it('does not offer it to a reader', async () => {
    asUser(['invoices.read']);

    render(<BillingPage />);

    await screen.findByRole('heading', { name: 'Invoices' });
    expect(screen.queryByRole('button', { name: 'New invoice' })).not.toBeInTheDocument();
  });
});

describe('the empty state explains itself differently by role', () => {
  it('invites somebody who can raise one', async () => {
    asUser(['invoices.read', 'invoices.manage']);

    render(<BillingPage />);

    expect(await screen.findByText(/Raise one for a client/i)).toBeInTheDocument();
  });

  it('just explains to a reader', async () => {
    asUser(['invoices.read']);

    render(<BillingPage />);

    expect(await screen.findByText(/will appear here/i)).toBeInTheDocument();
  });
});

describe('secrets never reach the browser', () => {
  it('renders no secret for a connected provider, because none is returned', async () => {
    asUser(['invoices.read', 'invoices.manage', 'settings.manage']);

    mocks.getRazorpayConnection.mockResolvedValue({
      data: {
        connected: true,
        keyId: 'rzp_test_ABCDEFGH',
        isLive: false,
        webhookUrl: 'https://example.test/api/v1/payments/razorpay/webhook/tok',
        webhookPath: null,
        connectedAt: null,
      },
    });

    render(<BillingPage defaultTab="settings" />);

    await screen.findByText('rzp_test_ABCDEFGH');

    // The key id identifies an account and is safe. A secret would be a credential that can
    // move money, and there is no endpoint that returns one - so nothing here can render it.
    const secretInputs = screen
      .getAllByLabelText(/secret/i)
      .map((input) => (input as HTMLInputElement).value);

    expect(secretInputs.every((value) => value === '')).toBe(true);
  });

  it('marks a test-mode connection so nobody thinks real money moved', async () => {
    asUser(['invoices.read', 'invoices.manage', 'settings.manage']);

    mocks.getRazorpayConnection.mockResolvedValue({
      data: { connected: true, keyId: 'rzp_test_X', isLive: false, webhookUrl: null, webhookPath: null, connectedAt: null },
    });

    render(<BillingPage defaultTab="settings" />);

    expect(await screen.findByText('Test mode')).toBeInTheDocument();
  });
});

describe('nothing on this screen messages a client', () => {
  it('offers no send action anywhere in the invoice list', async () => {
    asUser(['invoices.read', 'invoices.manage', 'payments.record', 'settings.manage']);

    mocks.listInvoices.mockResolvedValue({
      data: [
        {
          id: 'inv1',
          invoiceNumber: 'VIS-2026-0001',
          status: 'issued',
          isOverdue: false,
          billTo: { name: 'Riya', state: null, gstin: null, address: null },
          items: [],
          total: '1180.00',
          totalPaise: 118000,
          balance: '1180.00',
          balancePaise: 118000,
          amountPaidPaise: 0,
          dueDate: null,
          remindersSentCount: 0,
          paymentFollowUp: { state: null, remindersSent: 0, nextAt: null },
        },
      ],
    });

    render(<BillingPage />);

    await screen.findByText('VIS-2026-0001');

    // Messaging a customer belongs to the owner approval flow, which has its own gate. A send
    // button here would be a second route to a client's phone.
    for (const label of [/send/i, /remind/i, /whatsapp/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });
});
