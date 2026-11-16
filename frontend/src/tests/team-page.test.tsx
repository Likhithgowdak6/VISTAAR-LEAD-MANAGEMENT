import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import TeamPage from '../pages/TeamPage';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const USERS = [
  {
    id: 'u1',
    name: 'Asha Menon',
    email: 'asha@example.com',
    role: 'admin',
    status: 'active',
    mustChangePassword: false,
  },
  {
    id: 'u2',
    name: 'Vikram Rao',
    email: 'vikram@example.com',
    role: 'manager',
    status: 'active',
    mustChangePassword: false,
  },
  {
    id: 'u3',
    name: 'Priya Nair',
    email: 'priya@example.com',
    role: 'staff',
    status: 'disabled',
    mustChangePassword: true,
  },
];

beforeEach(() => {
  endpoints.listUsers.mockResolvedValue({ data: USERS });
  endpoints.updateUser.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const asAdmin = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({
      role: 'admin',
      permissions: [PERMISSIONS.USERS_READ, PERMISSIONS.USERS_MANAGE],
    }),
  );

describe('TeamPage', () => {
  it('lists team members with their roles and status', async () => {
    asAdmin();
    renderAuthed(<TeamPage />);

    expect(await screen.findByText('Asha Menon')).toBeInTheDocument();
    expect(screen.getByText('Vikram Rao')).toBeInTheDocument();
    expect(screen.getByText('priya@example.com')).toBeInTheDocument();

    // Role names also appear as <option>s in the add form, so assert within the list.
    const list = screen.getByRole('list');
    expect(within(list).getByText('Manager')).toBeInTheDocument();
    expect(within(list).getByText('Staff')).toBeInTheDocument();

    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText('Must change password')).toBeInTheDocument();
  });

  it('creates a new member with the chosen role and forces a password change', async () => {
    asAdmin();
    endpoints.createUser.mockResolvedValue({ data: { id: 'u4' } });
    renderAuthed(<TeamPage />);

    await screen.findByText('Asha Menon');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Manager' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Temporary password'), {
      target: { value: 'TemporaryPass123' },
    });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'manager' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() =>
      expect(endpoints.createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Manager',
          email: 'new@example.com',
          role: 'manager',
          mustChangePassword: true,
        }),
      ),
    );
  });

  it('disables another member', async () => {
    asAdmin();
    endpoints.disableUser.mockResolvedValue({ data: {} });
    renderAuthed(<TeamPage />);

    await screen.findByText('Vikram Rao');
    fireEvent.click(screen.getAllByRole('button', { name: 'Disable' })[0]);

    await waitFor(() =>
      expect(endpoints.disableUser).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u2' })),
    );
  });

  it('hides management controls without users.manage', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({ role: 'manager', permissions: [PERMISSIONS.USERS_READ] }),
    );

    renderAuthed(<TeamPage />);

    await screen.findByText('Asha Menon');
    expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset password' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('offers no self-management controls for the signed-in user', async () => {
    asAdmin();
    renderAuthed(<TeamPage />);

    await screen.findByText('Asha Menon');
    // The helper signs in as u1 (Asha), so only u2 and u3 expose actions.
    expect(screen.getAllByRole('button', { name: 'Reset password' })).toHaveLength(2);
    expect(screen.queryByRole('switch', { name: 'Can view phone numbers for Asha Menon' })).not.toBeInTheDocument();
  });

  it('grants phone access without replacing unrelated permission overrides', async () => {
    asAdmin();
    const phone = PERMISSIONS.CLIENT_PII_REVEAL;
    const overrides = { allow: [PERMISSIONS.CRM_TASKS_MANAGE], deny: [PERMISSIONS.CONVERSATIONS_DELETE, phone] };
    const users = USERS.map((user) => user.id === 'u2' ? { ...user, permissionOverrides: overrides } : user);
    endpoints.listUsers.mockResolvedValue({ data: users });
    endpoints.updateUser.mockImplementation(async ({ permissionOverrides }: { permissionOverrides: typeof overrides }) => {
      endpoints.listUsers.mockResolvedValue({ data: users.map((user) => user.id === 'u2' ? { ...user, permissionOverrides } : user) });
      return { data: {} };
    });
    renderAuthed(<TeamPage />);
    const toggle = await screen.findByRole('switch', { name: 'Can view phone numbers for Vikram Rao' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(endpoints.updateUser).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u2', permissionOverrides: {
        allow: [PERMISSIONS.CRM_TASKS_MANAGE, phone], deny: [PERMISSIONS.CONVERSATIONS_DELETE],
      },
    })));
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('revokes role-default admin phone access with an explicit deny', async () => {
    asAdmin();
    const users = USERS.map((user) => user.id === 'u2' ? { ...user, role: 'admin' } : user);
    endpoints.listUsers.mockResolvedValue({ data: users });
    endpoints.updateUser.mockImplementation(async ({ permissionOverrides }: { permissionOverrides: { allow: string[]; deny: string[] } }) => {
      endpoints.listUsers.mockResolvedValue({ data: users.map((user) => user.id === 'u2' ? { ...user, permissionOverrides } : user) });
      return { data: {} };
    });
    renderAuthed(<TeamPage />);
    const toggle = await screen.findByRole('switch', { name: 'Can view phone numbers for Vikram Rao' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(endpoints.updateUser).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u2', permissionOverrides: { allow: [], deny: [PERMISSIONS.CLIENT_PII_REVEAL] },
    })));
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it('keeps the current state and shows an error when saving fails', async () => {
    asAdmin();
    endpoints.updateUser.mockRejectedValue(new Error('Could not save phone access.'));
    renderAuthed(<TeamPage />);
    const toggle = await screen.findByRole('switch', { name: 'Can view phone numbers for Vikram Rao' });
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save phone access.');
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
  });

  it('honors explicit denials and never offers controls for a super admin', async () => {
    asAdmin();
    endpoints.listUsers.mockResolvedValue({ data: [
      ...USERS.map((user) => user.id === 'u2' ? {
        ...user, role: 'admin', permissionOverrides: {
          allow: [PERMISSIONS.CLIENT_PII_REVEAL], deny: [PERMISSIONS.CLIENT_PII_REVEAL],
        },
      } : user),
      { ...USERS[0], id: 'root', name: 'Workspace owner', role: 'super_admin' },
    ] });
    renderAuthed(<TeamPage />);
    expect(await screen.findByRole('switch', { name: 'Can view phone numbers for Vikram Rao' })).not.toBeChecked();
    expect(screen.queryByRole('switch', { name: 'Can view phone numbers for Workspace owner' })).not.toBeInTheDocument();
  });
});
