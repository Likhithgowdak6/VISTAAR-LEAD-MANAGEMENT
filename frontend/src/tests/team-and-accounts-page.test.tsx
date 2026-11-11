/**
 * Team and Accounts on one screen.
 *
 * THE TAB STRIP IS PERMISSION-FILTERED, which is the whole reason this file exists. The two
 * halves are gated by genuinely separate permissions — `users.read` and `accounts.read` — and
 * plenty of people hold one without the other. Rendering both tabs whenever somebody holds
 * EITHER (which is what StagesAndTagsPage does) would show a WhatsApp numbers tab to someone
 * who cannot read WhatsApp numbers, and hand them a failing panel when they pressed it.
 *
 * The child pages are mocked to markers. What is under test is which tab is shown and which is
 * reachable — not whether TeamPage can list users, which its own test already covers.
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import TeamAndAccountsPage from '../pages/TeamAndAccountsPage';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

vi.mock('../pages/TeamPage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="team-page">team page embedded={String(embedded)}</div>
  ),
}));

vi.mock('../pages/AccountsPage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="accounts-page">accounts page embedded={String(embedded)}</div>
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const signedInWith = (permissions: string[]) =>
  endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'admin', permissions }));

const BOTH = [PERMISSIONS.USERS_READ, PERMISSIONS.ACCOUNTS_READ];

describe('with both permissions', () => {
  it('shows the team tab first', async () => {
    signedInWith(BOTH);
    renderAuthed(<TeamAndAccountsPage />);

    expect(await screen.findByTestId('team-page')).toBeInTheDocument();
    expect(screen.queryByTestId('accounts-page')).not.toBeInTheDocument();
  });

  it('switches to the accounts tab when pressed', async () => {
    signedInWith(BOTH);
    renderAuthed(<TeamAndAccountsPage />);

    fireEvent.click(await screen.findByText('WhatsApp Numbers'));

    expect(screen.getByTestId('accounts-page')).toBeInTheDocument();
    expect(screen.queryByTestId('team-page')).not.toBeInTheDocument();
  });

  it('honours a defaultTab of accounts', async () => {
    // This is how the shell routes a stale `accounts` view onto the merged page.
    signedInWith(BOTH);
    renderAuthed(<TeamAndAccountsPage defaultTab="accounts" />);

    expect(await screen.findByTestId('accounts-page')).toBeInTheDocument();
  });

  it('RENDERS BOTH CHILDREN EMBEDDED, so neither draws its own heading', async () => {
    // Without this the page shows "Team & Accounts" and then "Team" directly underneath.
    signedInWith(BOTH);
    renderAuthed(<TeamAndAccountsPage />);

    expect(await screen.findByTestId('team-page')).toHaveTextContent('embedded=true');
  });
});

describe('with only one permission', () => {
  it('SHOWS NO TAB STRIP when the caller can only read users', async () => {
    // A single tab is not a choice, and rendering one implies there is somewhere else to go.
    signedInWith([PERMISSIONS.USERS_READ]);
    renderAuthed(<TeamAndAccountsPage />);

    expect(await screen.findByTestId('team-page')).toBeInTheDocument();
    expect(screen.queryByText('WhatsApp Numbers')).not.toBeInTheDocument();
    expect(screen.queryByText('Team Members')).not.toBeInTheDocument();
  });

  it('NEVER OFFERS THE ACCOUNTS TAB WITHOUT accounts.read', async () => {
    // The failure this prevents: a tab that 403s when pressed.
    signedInWith([PERMISSIONS.USERS_READ]);
    renderAuthed(<TeamAndAccountsPage />);

    await screen.findByTestId('team-page');

    expect(screen.queryByTestId('accounts-page')).not.toBeInTheDocument();
  });

  it('shows accounts alone when the caller can only read accounts', async () => {
    signedInWith([PERMISSIONS.ACCOUNTS_READ]);
    renderAuthed(<TeamAndAccountsPage />);

    expect(await screen.findByTestId('accounts-page')).toBeInTheDocument();
    expect(screen.queryByTestId('team-page')).not.toBeInTheDocument();
  });

  it('FALLS BACK TO A TAB THE CALLER CAN OPEN', async () => {
    // A link to the accounts tab, followed by somebody without `accounts.read`. Honouring
    // defaultTab blindly would land them on a panel they are not allowed to see.
    signedInWith([PERMISSIONS.USERS_READ]);
    renderAuthed(<TeamAndAccountsPage defaultTab="accounts" />);

    expect(await screen.findByTestId('team-page')).toBeInTheDocument();
  });
});

describe('the heading', () => {
  it('names both halves', async () => {
    signedInWith(BOTH);
    renderAuthed(<TeamAndAccountsPage />);

    expect(await screen.findByRole('heading', { name: /Team & Accounts/i })).toBeInTheDocument();
  });
});
