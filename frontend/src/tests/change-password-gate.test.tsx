import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import AppShell from '../pages/AppShell';
import { renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const authPayload = (mustChangePassword: boolean) => ({
  data: {
    accessToken: 'access-token-1',
    user: { id: 'u1', name: 'Asha Menon', role: 'staff', mustChangePassword },
    organization: { id: 'o1', name: 'Acme' },
    permissions: [],
  },
});

beforeEach(() => {
  endpoints.listConversations.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ChangePasswordGate', () => {
  it('blocks the app and asks for a new password when one is owed', async () => {
    endpoints.refresh.mockResolvedValue(authPayload(true));

    renderAuthed(<AppShell />);

    expect(await screen.findByText('Choose a new password')).toBeInTheDocument();
    // The inbox is not reachable behind the gate.
    expect(screen.queryByRole('button', { name: 'Inbox' })).not.toBeInTheDocument();
  });

  it('does not appear once the password has been changed', async () => {
    endpoints.refresh.mockResolvedValue(authPayload(false));

    renderAuthed(<AppShell />);

    expect(await screen.findByRole('button', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.queryByText('Choose a new password')).not.toBeInTheDocument();
  });

  it('submits the change and drops into the app on success', async () => {
    endpoints.refresh.mockResolvedValue(authPayload(true));
    endpoints.changePassword.mockResolvedValue({
      data: {
        passwordChanged: true,
        user: { id: 'u1', name: 'Asha Menon', mustChangePassword: false },
      },
    });

    renderAuthed(<AppShell />);

    await screen.findByText('Choose a new password');

    fireEvent.change(screen.getByLabelText('Current (temporary) password'), {
      target: { value: 'TemporaryPass123' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'BrandNewPassword456' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'BrandNewPassword456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set password and continue' }));

    await waitFor(() =>
      expect(endpoints.changePassword).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPassword: 'TemporaryPass123',
          newPassword: 'BrandNewPassword456',
        }),
      ),
    );

    // The gate clears because the refreshed profile no longer owes a change.
    expect(await screen.findByRole('button', { name: 'Inbox' })).toBeInTheDocument();
  });

  it('refuses to submit when the confirmation does not match', async () => {
    endpoints.refresh.mockResolvedValue(authPayload(true));

    renderAuthed(<AppShell />);

    await screen.findByText('Choose a new password');

    fireEvent.change(screen.getByLabelText('Current (temporary) password'), {
      target: { value: 'TemporaryPass123' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'BrandNewPassword456' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'DifferentPassword789' },
    });

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set password and continue' })).toBeDisabled();
    expect(endpoints.changePassword).not.toHaveBeenCalled();
  });
});
