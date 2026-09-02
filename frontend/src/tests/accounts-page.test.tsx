import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AccountsPage from '../pages/AccountsPage';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const ACCOUNTS = [
  { id: 'a1', name: 'Sales Line', brandKey: 'sales-line', status: 'disconnected', runtime: {} },
  { id: 'a2', name: 'Support', brandKey: 'support', status: 'active', runtime: {} },
];

beforeEach(() => {
  endpoints.listAccounts.mockResolvedValue({ data: ACCOUNTS });
});

afterEach(() => {
  vi.clearAllMocks();
});

const asManager = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({
      role: 'admin',
      permissions: [PERMISSIONS.ACCOUNTS_READ, PERMISSIONS.ACCOUNTS_MANAGE],
    }),
  );

describe('AccountsPage', () => {
  it('lists accounts with their status', async () => {
    asManager();
    renderAuthed(<AccountsPage />);

    expect(await screen.findByText('Sales Line')).toBeInTheDocument();
    expect(screen.getByText('Support')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('creates a new account', async () => {
    asManager();
    endpoints.createAccount.mockResolvedValue({ data: { id: 'a3' } });
    renderAuthed(<AccountsPage />);

    await screen.findByText('Sales Line');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Line' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add number' }));

    await waitFor(() =>
      expect(endpoints.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New Line', brandKey: 'new-line' }),
      ),
    );
  });

  it('starts a connect and shows the QR modal', async () => {
    asManager();
    endpoints.connectAccount.mockResolvedValue({ data: { status: 'connecting' } });
    endpoints.getAccount.mockResolvedValue({ data: { status: 'connecting' } });
    endpoints.getAccountQr.mockResolvedValue({ data: { qrDataUrl: 'data:image/png;base64,QQ==' } });

    renderAuthed(<AccountsPage />);

    await screen.findByText('Sales Line');
    // "Sales Line" is disconnected → has a Connect button.
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0]);

    await waitFor(() =>
      expect(endpoints.connectAccount).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'a1' }),
      ),
    );
    expect(await screen.findByAltText('WhatsApp QR code')).toBeInTheDocument();
  });

  it('leaves a soft-removed number out of the list entirely', async () => {
    asManager();
    endpoints.listAccounts.mockResolvedValue({
      data: [
        ...ACCOUNTS,
        { id: 'a3', name: 'Likhith Gowda k', brandKey: 'likhith', status: 'removed', runtime: {} },
      ],
    });

    renderAuthed(<AccountsPage />);

    await screen.findByText('Sales Line');
    expect(screen.queryByText('Likhith Gowda k')).not.toBeInTheDocument();
  });

  it('asks before removing, and does not call the API until it is confirmed', async () => {
    asManager();
    renderAuthed(<AccountsPage />);

    await screen.findByText('Sales Line');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);

    expect(await screen.findByRole('dialog', { name: 'Remove Sales Line' })).toBeInTheDocument();
    expect(endpoints.removeAccount).not.toHaveBeenCalled();
  });

  it('cancelling the confirmation removes nothing', async () => {
    asManager();
    renderAuthed(<AccountsPage />);

    await screen.findByText('Sales Line');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Remove Sales Line' })).not.toBeInTheDocument(),
    );
    expect(endpoints.removeAccount).not.toHaveBeenCalled();
  });

  it('says so when a number with no history was deleted permanently', async () => {
    asManager();
    endpoints.removeAccount.mockResolvedValue({
      data: {
        outcome: 'deleted',
        account: { id: 'a1', name: 'Sales Line' },
        references: { conversations: 0, messages: 0, leadSources: 0, total: 0 },
      },
    });

    renderAuthed(<AccountsPage />);

    await screen.findByText('Sales Line');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove number' }));

    await waitFor(() =>
      expect(endpoints.removeAccount).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'a1' }),
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Sales Line was deleted permanently.',
    );
  });

  it('says why a number with history was only hidden', async () => {
    asManager();
    endpoints.removeAccount.mockResolvedValue({
      data: {
        outcome: 'hidden',
        account: { id: 'a2', name: 'Support' },
        references: { conversations: 47, messages: 912, leadSources: 0, total: 959 },
      },
    });

    renderAuthed(<AccountsPage />);

    await screen.findByText('Support');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove number' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Support was disconnected and hidden from this list');
    expect(notice).toHaveTextContent('47 conversations and 912 messages');
  });

  it('hides management controls without accounts.manage', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({ role: 'manager', permissions: [PERMISSIONS.ACCOUNTS_READ] }),
    );

    renderAuthed(<AccountsPage />);

    await screen.findByText('Sales Line');
    expect(screen.queryByRole('button', { name: 'Add number' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });
});
