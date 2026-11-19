/**
 * The payment provider: connecting it, and the links it issues.
 *
 * THE RULE THAT MATTERS MOST: no secret ever comes back to the browser. There is no endpoint that
 * returns one, so the connection panel can only ever report *that* it is connected and which key
 * id - and the secret inputs must stay empty on a connected workspace, or somebody would
 * reasonably assume the value shown is the stored one.
 *
 * The rest is about not taking money twice. A link is created with an idempotency key held across
 * a retry; reconcile is the repair path for a webhook that never arrived, and is safe to press
 * repeatedly because recording goes through the same deduplicating ledger.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  getBillingProfile: vi.fn(),
  getRazorpayConnection: vi.fn(),
  updateBillingProfile: vi.fn(),
  connectRazorpay: vi.fn(),
  listPaymentLinks: vi.fn(),
  createPaymentLink: vi.fn(),
  reconcilePaymentLink: vi.fn(),
  cancelPaymentLink: vi.fn(),
}));

vi.mock('../api/billing', () => ({
  getBillingProfile: mocks.getBillingProfile,
  getRazorpayConnection: mocks.getRazorpayConnection,
  updateBillingProfile: mocks.updateBillingProfile,
  connectRazorpay: mocks.connectRazorpay,
  listPaymentLinks: mocks.listPaymentLinks,
  createPaymentLink: mocks.createPaymentLink,
  reconcilePaymentLink: mocks.reconcilePaymentLink,
  cancelPaymentLink: mocks.cancelPaymentLink,
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../hooks/useMobileBackLayer', () => ({ useMobileBackLayer: () => undefined }));

const BillingSettingsPanel = (await import('../components/billing/BillingSettingsPanel')).default;
const PaymentLinksPanel = (await import('../components/billing/PaymentLinksPanel')).default;

const asUser = (permissions: string[]) =>
  mocks.useAuth.mockReturnValue({
    permissions,
    authedRequest: (make: (token: string) => unknown) => Promise.resolve(make('t')),
  });

const invoice = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'inv1',
    status: 'issued',
    balancePaise: 118000,
    balance: '1180.00',
    ...overrides,
  }) as never;

const link = (overrides: Record<string, unknown> = {}) => ({
  id: 'lnk1',
  invoiceId: 'inv1',
  amountPaise: 118000,
  currency: 'INR',
  state: 'created',
  url: 'https://rzp.io/i/abc',
  providerLinkId: 'plink_123',
  isLive: false,
  lastError: null,
  createdAt: '2026-11-18T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBillingProfile.mockResolvedValue({ data: {} });
  mocks.getRazorpayConnection.mockResolvedValue({ data: { connected: false } });
  mocks.listPaymentLinks.mockResolvedValue({ data: [] });
  asUser(['invoices.read', 'invoices.manage', 'settings.manage']);
});

describe('connecting a provider', () => {
  it('leaves both secret fields empty on a connected workspace', async () => {
    mocks.getRazorpayConnection.mockResolvedValue({
      data: {
        connected: true,
        keyId: 'rzp_test_ABC',
        isLive: false,
        webhookUrl: null,
        webhookPath: null,
        connectedAt: '2026-10-01T00:00:00.000Z',
      },
    });

    render(<BillingSettingsPanel />);

    await screen.findByText(/rzp_test_ABC/);

    expect((screen.getByLabelText('Key secret') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Webhook secret') as HTMLInputElement).value).toBe('');
  });

  it('says the secrets are never shown again, so nobody waits for them to appear', async () => {
    render(<BillingSettingsPanel />);

    expect(await screen.findByText(/never shown again/i)).toBeInTheDocument();
  });

  it('masks both secrets as they are typed', async () => {
    render(<BillingSettingsPanel />);

    await screen.findByLabelText('Key secret');

    expect(screen.getByLabelText('Key secret')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Webhook secret')).toHaveAttribute('type', 'password');
  });

  it('refuses to submit until all three values are present', async () => {
    render(<BillingSettingsPanel />);

    const button = await screen.findByRole('button', { name: 'Connect' });

    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Key ID'), { target: { value: 'rzp_test_ABC' } });
    fireEvent.change(screen.getByLabelText('Key secret'), { target: { value: 's' } });

    // Without the webhook secret, payments would never be recorded automatically - so it is
    // required rather than optional.
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Webhook secret'), { target: { value: 'w' } });

    expect(button).toBeEnabled();
  });

  it('clears what was typed once the pair is accepted', async () => {
    mocks.connectRazorpay.mockResolvedValue({
      data: { connected: true, keyId: 'rzp_test_ABC', isLive: false, webhookUrl: null, webhookPath: null, connectedAt: null },
    });

    render(<BillingSettingsPanel />);

    await screen.findByLabelText('Key ID');

    fireEvent.change(screen.getByLabelText('Key ID'), { target: { value: 'rzp_test_ABC' } });
    fireEvent.change(screen.getByLabelText('Key secret'), { target: { value: 'secret-value' } });
    fireEvent.change(screen.getByLabelText('Webhook secret'), { target: { value: 'hook-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    // No reason for a key secret to sit in component state while a success panel is on screen.
    await waitFor(() =>
      expect((screen.getByLabelText('Key secret') as HTMLInputElement).value).toBe(''),
    );
  });

  it("shows the provider's own rejection rather than a generic failure", async () => {
    mocks.connectRazorpay.mockRejectedValue(
      new Error('Razorpay rejected those credentials. Check the key id and secret.'),
    );

    render(<BillingSettingsPanel />);

    await screen.findByLabelText('Key ID');

    fireEvent.change(screen.getByLabelText('Key ID'), { target: { value: 'rzp_test_ABC' } });
    fireEvent.change(screen.getByLabelText('Key secret'), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText('Webhook secret'), { target: { value: 'w' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected those credentials/i);
  });

  it('shows the webhook URL to paste, and warns what happens until it is set', async () => {
    mocks.getRazorpayConnection.mockResolvedValue({
      data: {
        connected: true,
        keyId: 'rzp_test_ABC',
        isLive: false,
        webhookUrl: 'https://crm.example/api/v1/payments/razorpay/webhook/tok',
        webhookPath: null,
        connectedAt: null,
      },
    });

    render(<BillingSettingsPanel />);

    expect(await screen.findByText(/webhook\/tok/)).toBeInTheDocument();
    expect(screen.getByText(/will not be recorded automatically/i)).toBeInTheDocument();
  });
});

describe('the billing profile', () => {
  it('explains that state decides the GST split, because it is not cosmetic', async () => {
    render(<BillingSettingsPanel />);

    expect(await screen.findByText(/CGST \+ SGST or IGST/)).toBeInTheDocument();
  });

  it('sends every field on save, so clearing one actually clears it', async () => {
    mocks.getBillingProfile.mockResolvedValue({
      data: { companyName: 'Vistaar', gstin: '29ABCDE1234F1Z5', state: 'Karnataka' },
    });
    mocks.updateBillingProfile.mockResolvedValue({ data: { companyName: 'Vistaar' } });

    render(<BillingSettingsPanel />);

    const gstin = await screen.findByLabelText('GSTIN');

    fireEvent.change(gstin, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save billing details' }));

    await waitFor(() => expect(mocks.updateBillingProfile).toHaveBeenCalled());

    // A partial save would make removing a GSTIN impossible to express, and the invoice would
    // keep printing one the admin believed they had deleted.
    expect(mocks.updateBillingProfile.mock.calls[0]![0]).toMatchObject({ gstin: null });
  });

  it("shows the server's validation message as written", async () => {
    mocks.updateBillingProfile.mockRejectedValue(
      new Error('That is not a valid GSTIN. It is 15 characters, like 29ABCDE1234F1Z5.'),
    );

    render(<BillingSettingsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Save billing details' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/15 characters/);
  });

  it('confirms a successful save', async () => {
    mocks.updateBillingProfile.mockResolvedValue({ data: { companyName: 'Vistaar' } });

    render(<BillingSettingsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Save billing details' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
  });
});

describe('payment links', () => {
  it('says creating one does not message the client', async () => {
    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);

    expect(await screen.findByText(/does not message them/i)).toBeInTheDocument();
  });

  it('sends an idempotency key, which is what stops a retry opening a second link', async () => {
    mocks.createPaymentLink.mockResolvedValue({ data: link() });

    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }));

    await waitFor(() => expect(mocks.createPaymentLink).toHaveBeenCalled());

    const sent = mocks.createPaymentLink.mock.calls[0]![0];
    expect(typeof sent.idempotencyKey).toBe('string');
    expect(sent.idempotencyKey.length).toBeGreaterThan(8);
  });

  it('reuses the same key when a failed attempt is retried', async () => {
    // A key regenerated per attempt would defeat the server-side guard entirely: the timeout
    // that made the user press again is exactly when a duplicate link gets created.
    mocks.createPaymentLink.mockRejectedValueOnce(new Error('Razorpay timed out.'));
    mocks.createPaymentLink.mockResolvedValueOnce({ data: link() });

    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => expect(mocks.createPaymentLink).toHaveBeenCalledTimes(2));

    expect(mocks.createPaymentLink.mock.calls[1]![0].idempotencyKey).toBe(
      mocks.createPaymentLink.mock.calls[0]![0].idempotencyKey,
    );
  });

  it('offers no second link while one is still open', async () => {
    mocks.listPaymentLinks.mockResolvedValue({ data: [link({ state: 'created' })] });

    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);

    await screen.findByText('created');
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
  });

  it('offers no link on a settled invoice', async () => {
    render(
      <PaymentLinksPanel
        invoice={invoice({ status: 'paid', balancePaise: 0, balance: '0.00' })}
        onChanged={vi.fn()}
      />,
    );

    await screen.findByText(/does not message them/i);
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
  });

  it('marks a test-mode link, so nobody chases a client with a link that takes no money', async () => {
    mocks.listPaymentLinks.mockResolvedValue({ data: [link({ isLive: false })] });

    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);

    expect(await screen.findByText('Test mode')).toBeInTheDocument();
  });

  it('checks status against the provider, which is the repair path for a lost webhook', async () => {
    mocks.listPaymentLinks.mockResolvedValue({ data: [link()] });
    mocks.reconcilePaymentLink.mockResolvedValue({ data: link({ state: 'paid' }) });

    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Check status' }));

    await waitFor(() =>
      expect(mocks.reconcilePaymentLink.mock.calls[0]![0]).toMatchObject({
        invoiceId: 'inv1',
        linkId: 'lnk1',
      }),
    );
  });

  it('asks before cancelling, and says a payment already made is still recorded', async () => {
    mocks.listPaymentLinks.mockResolvedValue({ data: [link()] });

    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel link' }));

    const dialog = await screen.findByRole('dialog', { name: /Cancel this payment link/ });

    expect(dialog).toHaveTextContent(/checked for any payment already made/i);
    expect(mocks.cancelPaymentLink).not.toHaveBeenCalled();
  });

  it('shows a link error on the row rather than hiding a broken link', async () => {
    mocks.listPaymentLinks.mockResolvedValue({
      data: [link({ state: 'failed', lastError: 'Razorpay rejected the amount.' })],
    });

    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);

    expect(await screen.findByText(/rejected the amount/i)).toBeInTheDocument();
  });

  it('gives a reader no create, check or cancel control', async () => {
    asUser(['invoices.read']);

    mocks.listPaymentLinks.mockResolvedValue({ data: [link()] });

    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);

    await screen.findByText('created');

    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel link' })).not.toBeInTheDocument();
  });

  it('shows empty history when the workspace has no links', async () => {
    // History reads local records and returns an empty list before provider setup.
    mocks.listPaymentLinks.mockResolvedValue({ data: [] });

    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);

    expect(await screen.findByText(/No payment links/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});


describe('provider state contract', () => {
  it.each(['creating', 'created', 'unknown'])('does not offer a competing link while state is %s', async (state) => {
    mocks.listPaymentLinks.mockResolvedValue({ data: [link({ state })] });
    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);
    await screen.findByText(state, { exact: true });
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel link' }) !== null).toBe(state === 'created');
  });

  it('reports failed history instead of pretending no links exist', async () => {
    mocks.listPaymentLinks.mockRejectedValue(new Error('Synthetic history unavailable'));
    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic history unavailable');
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
  });

  it('does not claim an uncertain provider response created a usable link', async () => {
    mocks.createPaymentLink.mockResolvedValue({ data: link({ state: 'unknown', url: null }) });
    render(<PaymentLinksPanel invoice={invoice()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }));
    expect(await screen.findByText(/has not confirmed a usable link/i)).toBeInTheDocument();
    expect(screen.queryByText('Payment link created. Nothing has been sent to the client.')).not.toBeInTheDocument();
  });
});
