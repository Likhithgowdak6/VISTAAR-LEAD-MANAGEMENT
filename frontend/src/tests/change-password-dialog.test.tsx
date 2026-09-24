import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import AppShell from '../pages/AppShell';
import { renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const authPayload = (role = 'super_admin') => ({
  data: {
    accessToken: 'access-token-1',
    user: { id: 'u1', name: 'Himanshu', role, mustChangePassword: false },
    organization: { id: 'o1', name: 'Vistaar Verse' },
    permissions: [],
  },
});

const openDialog = async () => {
  endpoints.refresh.mockResolvedValue(authPayload());
  renderAuthed(<AppShell />);

  fireEvent.click(await screen.findByRole('button', { name: 'Password' }));

  return screen.findByRole('dialog', { name: 'Change your password' });
};

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  endpoints.listConversations.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ChangePasswordDialog', () => {
  it('is reachable from the header without any permission', async () => {
    // The whole point of this dialog: the Team page hides every action on your own row and on a
    // super-admin row, so before this existed the owner could only change his password in mongosh.
    expect(await openDialog()).toBeInTheDocument();
  });

  it('submits the current and new password', async () => {
    endpoints.changePassword.mockResolvedValue({
      data: { user: { id: 'u1', name: 'Himanshu', role: 'super_admin', mustChangePassword: false } },
    });

    await openDialog();

    fill('Current password', 'oldpassword1');
    fill('New password', 'newpassword1');
    fill('Confirm new password', 'newpassword1');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() =>
      expect(endpoints.changePassword).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPassword: 'oldpassword1',
          newPassword: 'newpassword1',
        }),
      ),
    );

    expect(await screen.findByText('Password changed')).toBeInTheDocument();
  });

  it('refuses a new password that does not match the confirmation', async () => {
    await openDialog();

    fill('Current password', 'oldpassword1');
    fill('New password', 'newpassword1');
    fill('Confirm new password', 'newpassword2');

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled();
  });

  it('refuses a password shorter than the policy minimum', async () => {
    await openDialog();

    fill('Current password', 'oldpassword1');
    fill('New password', 'short12');
    fill('Confirm new password', 'short12');

    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled();
    expect(endpoints.changePassword).not.toHaveBeenCalled();
  });

  it('refuses reusing the current password, rather than letting the server reject it', async () => {
    await openDialog();

    fill('Current password', 'samepassword1');
    fill('New password', 'samepassword1');
    fill('Confirm new password', 'samepassword1');

    expect(screen.getByText('That is your current password. Choose a different one.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled();
  });

  it('shows the server error and stays open so the attempt can be corrected', async () => {
    endpoints.changePassword.mockRejectedValue(new Error('Current password is incorrect.'));

    await openDialog();

    fill('Current password', 'wrongpassword1');
    fill('New password', 'newpassword1');
    fill('Confirm new password', 'newpassword1');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect.');
    // Still open: closing here would lose everything typed and hide the reason it failed.
    expect(screen.getByRole('dialog', { name: 'Change your password' })).toBeInTheDocument();
  });

  it('closes on cancel without calling the API', async () => {
    await openDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Change your password' })).not.toBeInTheDocument(),
    );
    expect(endpoints.changePassword).not.toHaveBeenCalled();
  });
});
