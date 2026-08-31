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
