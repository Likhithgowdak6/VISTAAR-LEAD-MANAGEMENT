/**
 * The Conversions API settings panel.
 *
 * WHAT THIS SCREEN CAN GET WRONG IS EXPENSIVE AND QUIET. Switching delivery on starts changing
 * how an ad account spends money, and a panel that reads "sending" while nothing is sent — or
 * reads "test mode" while real conversions flow — is worse than one that refuses to load.
 *
 * So: storing a token must not start delivery, the test-event state must be visible, the token
 * must never come back, and Meta's own refusals must be shown as written rather than replaced
 * with "something went wrong".
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  getCapiConnection: vi.fn(),
  getCapiStatus: vi.fn(),
  connectCapi: vi.fn(),
  setCapiEnabled: vi.fn(),
  setCapiEvents: vi.fn(),
}));

vi.mock('../api/capi', () => ({
  getCapiConnection: mocks.getCapiConnection,
  getCapiStatus: mocks.getCapiStatus,
  connectCapi: mocks.connectCapi,
  setCapiEnabled: mocks.setCapiEnabled,
  setCapiEvents: mocks.setCapiEvents,
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));

const ConversionsApiPanel = (await import('../components/settings/ConversionsApiPanel')).default;

const AVAILABLE = [
  { key: 'lead_received', metaEventName: 'Lead' },
  { key: 'lead_qualified', metaEventName: 'QualifiedLead' },
  { key: 'lead_won', metaEventName: 'Won' },
  { key: 'purchase', metaEventName: 'Purchase' },
];

const connection = (over: Record<string, unknown> = {}) => ({
  connected: false,
  enabled: false,
  datasetId: null,
  accessTokenLast4: null,
  testEventCode: null,
  selectedEvents: [],
  connectedAt: null,
  lastDeliveredAt: null,
  lastError: null,
  lastErrorAt: null,
  availableEvents: AVAILABLE,
  ...over,
});

const status = (over: Record<string, unknown> = {}) => ({
  counts: { pending: 0, sent: 0, failed: 0, expired: 0, unmatchable: 0 },
  maxAttempts: 6,
  recentFailures: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({
    permissions: ['settings.manage'],
    authedRequest: (make: (token: string) => unknown) => Promise.resolve(make('t')),
  });
  mocks.getCapiConnection.mockResolvedValue({ data: connection() });
  mocks.getCapiStatus.mockResolvedValue({ data: status() });
});

describe('an unconnected workspace', () => {
  it('explains that this is the CRM integration, not a pixel', async () => {
    // An admin who thinks this is a pixel goes looking for a website to install it on.
    render(<ConversionsApiPanel />);

    expect(await screen.findByText(/no pixel and no script/i)).toBeInTheDocument();
  });

  it('cannot connect without both a dataset and a token', async () => {
    render(<ConversionsApiPanel />);

    const button = await screen.findByRole('button', { name: 'Connect dataset' });

    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Dataset ID'), { target: { value: '1234567890123' } });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'a-token-value' } });
    expect(button).toBeEnabled();
  });

  it('offers no delivery toggle at all', async () => {
    // There is nothing to switch on, and a toggle that cannot work is worse than no toggle.
    render(<ConversionsApiPanel />);

    await screen.findByRole('button', { name: 'Connect dataset' });

    expect(screen.queryByRole('button', { name: /Start sending/i })).not.toBeInTheDocument();
  });
});

describe('storing a credential does not start delivery', () => {
  it('says so when the dataset is connected', async () => {
    mocks.connectCapi.mockResolvedValue({ data: connection({ connected: true }) });

    render(<ConversionsApiPanel />);

    fireEvent.change(await screen.findByLabelText('Dataset ID'), {
      target: { value: '1234567890123' },
    });
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'a-token-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect dataset' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      /until you switch delivery on/i,
    );
  });

  it('clears the token out of the form once it is stored', async () => {
    mocks.connectCapi.mockResolvedValue({ data: connection({ connected: true }) });

    render(<ConversionsApiPanel />);

    fireEvent.change(await screen.findByLabelText('Dataset ID'), {
      target: { value: '1234567890123' },
    });
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'a-token-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect dataset' }));

    await waitFor(() =>
      expect((screen.getByLabelText('Access token') as HTMLInputElement).value).toBe(''),
    );
  });

  it('masks the token as it is typed', async () => {
    render(<ConversionsApiPanel />);

    expect(await screen.findByLabelText('Access token')).toHaveAttribute('type', 'password');
  });
});

describe('a connected workspace', () => {
  const connected = (over: Record<string, unknown> = {}) =>
    mocks.getCapiConnection.mockResolvedValue({
      data: connection({
        connected: true,
        datasetId: '1234567890123',
        accessTokenLast4: 'bcd1',
        selectedEvents: ['lead_qualified', 'purchase'],
        ...over,
      }),
    });

  it('never renders the access token, because none is returned', async () => {
    connected();

    render(<ConversionsApiPanel />);

    await screen.findByText(/Dataset 1234567890123/);

    // Four characters of a token hundreds of characters long identify nothing on their own.
    expect(screen.getByText(/····bcd1/)).toBeInTheDocument();
    expect((screen.getByLabelText('Access token') as HTMLInputElement).value).toBe('');
  });

  it('reads as paused until delivery is switched on', async () => {
    connected({ enabled: false });

    render(<ConversionsApiPanel />);

    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start sending' })).toBeInTheDocument();
  });

  it('reads as sending once it is on', async () => {
    connected({ enabled: true });

    render(<ConversionsApiPanel />);

    expect(await screen.findByText('Sending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause delivery' })).toBeInTheDocument();
  });

  it('marks test mode, so nobody thinks real reporting changed', async () => {
    connected({ enabled: true, testEventCode: 'TEST12345' });

    render(<ConversionsApiPanel />);

    expect(await screen.findByText('Test events only')).toBeInTheDocument();
  });

  it('warns that enabling starts changing how the ad account spends', async () => {
    connected({ enabled: false });

    render(<ConversionsApiPanel />);

    mocks.setCapiEnabled.mockResolvedValue({ data: connection({ connected: true, enabled: true }) });

    fireEvent.click(await screen.findByRole('button', { name: 'Start sending' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/will be reported to Meta/i);
  });

  it('shows the selected milestones as chosen', async () => {
    connected();

    render(<ConversionsApiPanel />);

    await screen.findByText('Lead qualified');

    const qualified = screen.getByRole('checkbox', { name: /Lead qualified/ });
    const received = screen.getByRole('checkbox', { name: /Lead received/ });

    expect(qualified).toBeChecked();
    expect(received).not.toBeChecked();
  });
});

describe('what the milestones mean', () => {
  it('says a purchase is money arriving, not an invoice being raised', async () => {
    // The single most important distinction on this screen: reporting invoices as sales would
    // optimise the ad account toward people who get billed rather than people who pay.
    render(<ConversionsApiPanel />);

    expect(await screen.findByText(/Never when an invoice is raised/i)).toBeInTheDocument();
  });

  it('explains why the raw lead event matters for coverage', async () => {
    render(<ConversionsApiPanel />);

    expect(await screen.findByText(/share of your leads it can see/i)).toBeInTheDocument();
  });

  it("states Meta's two-stage minimum", async () => {
    render(<ConversionsApiPanel />);

    expect(await screen.findByText(/at least two of these/i)).toBeInTheDocument();
  });
});

describe('errors are surfaced, not paraphrased', () => {
  it("shows the server's refusal when only one stage is selected", async () => {
    mocks.getCapiConnection.mockResolvedValue({
      data: connection({ connected: true, datasetId: '1234567890123', selectedEvents: ['purchase'] }),
    });
    mocks.setCapiEvents.mockRejectedValue(
      new Error(
        'Meta needs at least two funnel stages to model a conversion rate. Reporting only a purchase is refused - add a qualifying stage as well.',
      ),
    );

    render(<ConversionsApiPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Save what gets reported' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/only a purchase is refused/i);
  });

  it("shows Meta's own words when a token has been revoked", async () => {
    // Paraphrasing loses the error code somebody needs to search for.
    mocks.getCapiConnection.mockResolvedValue({
      data: connection({
        connected: true,
        datasetId: '1234567890123',
        enabled: true,
        lastError: 'The Meta access token has expired or was revoked.',
      }),
    });

    render(<ConversionsApiPanel />);

    expect(await screen.findByText(/expired or was revoked/i)).toBeInTheDocument();
    expect(screen.getByText(/Meta reported a problem/i)).toBeInTheDocument();
  });
});

describe('delivery status', () => {
  it('shows counts by state', async () => {
    mocks.getCapiStatus.mockResolvedValue({
      data: status({ counts: { pending: 3, sent: 42, failed: 1, expired: 0, unmatchable: 2 } }),
    });

    render(<ConversionsApiPanel />);

    await screen.findByText('Delivery');

    expect(screen.getByText('Delivered:')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('lists recent failures with their reason', async () => {
    // A conversion that never reached Meta is a number missing from somebody's reporting, and
    // this panel is the only place anyone would notice.
    mocks.getCapiStatus.mockResolvedValue({
      data: status({
        recentFailures: [
          {
            eventKey: 'purchase',
            state: 'failed',
            attempts: 6,
            lastError: 'Meta is temporarily unavailable.',
            lastErrorAt: '2026-11-24T00:00:00.000Z',
          },
        ],
      }),
    });

    render(<ConversionsApiPanel />);

    expect(await screen.findByText(/temporarily unavailable/i)).toBeInTheDocument();
  });

  it('says plainly when nothing has failed', async () => {
    render(<ConversionsApiPanel />);

    expect(await screen.findByText('Nothing has failed.')).toBeInTheDocument();
  });
});

describe('loading and failure', () => {
  it('shows a spinner first', () => {
    mocks.getCapiConnection.mockReturnValue(new Promise(() => {}));

    render(<ConversionsApiPanel />);

    expect(screen.getByText(/Loading Conversions API settings/i)).toBeInTheDocument();
  });

  it('reports a failed load rather than an empty panel', async () => {
    mocks.getCapiConnection.mockRejectedValue(new Error('Upstream unavailable.'));

    render(<ConversionsApiPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Upstream unavailable/i);
  });
});
