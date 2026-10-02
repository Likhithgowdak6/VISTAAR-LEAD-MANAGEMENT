import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import AddLeadSourceForm from '../components/lead-sources/AddLeadSourceForm';
import { type WhatsAppAccount } from '../components/types';
import { PERMISSIONS } from '../lib/permissions';
import LeadSourcesPage from '../pages/LeadSourcesPage';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const ACCOUNTS = [
  { id: 'acc-1', name: 'Studio Main', brandKey: 'studio-main', status: 'active' },
  { id: 'acc-2', name: 'Old Number', brandKey: 'old-number', status: 'removed' },
];

const LEAD_SOURCE = {
  id: 'ls-1',
  name: 'Meta wedding leads',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=0',
  gid: '0',
  whatsappAccountId: 'acc-1',
  defaultCountryCode: '91',
  status: 'active',
  aiContextEnabled: false,
  lastSyncedAt: '2026-08-19T06:00:00.000Z',
  lastSyncStatus: 'ok',
  lastError: null,
  lastSyncCounts: { imported: 4, duplicates: 20, skipped: 1, failed: 0 },
  totalImported: 12,
};

beforeEach(() => {
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.LEAD_SOURCES_MANAGE] }),
  );
  endpoints.listLeadSources.mockResolvedValue({ data: [LEAD_SOURCE] });
  endpoints.listAccounts.mockResolvedValue({ data: ACCOUNTS });
  endpoints.createLeadSource.mockResolvedValue({ data: LEAD_SOURCE });
  endpoints.syncLeadSource.mockResolvedValue({ data: LEAD_SOURCE });
  endpoints.updateLeadSource.mockResolvedValue({ data: LEAD_SOURCE });
  endpoints.deleteLeadSource.mockResolvedValue({ data: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('LeadSourcesPage', () => {
  it('lists a connected sheet with its destination number and import counts', async () => {
    renderAuthed(<LeadSourcesPage />);

    expect(await screen.findByText('Meta wedding leads')).toBeInTheDocument();
    expect(screen.getByText(/New leads open on/)).toHaveTextContent('Studio Main');
    expect(screen.getByText(/12 leads imported/)).toHaveTextContent('1 skipped');
  });

  it('no longer offers to create a Google Sheet source', async () => {
    renderAuthed(<LeadSourcesPage />);

    await screen.findByRole('button', { name: 'Connect Facebook' });

    expect(screen.queryByLabelText('Google Sheet link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect sheet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Google Sheet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Meta Lead Ads' })).not.toBeInTheDocument();
  });

  it('keeps an already-configured sheet source fully usable', async () => {
    // Withdrawing the creation form must not strand the sources it created: they still render,
    // still link out to the spreadsheet, and still sync.
    renderAuthed(<LeadSourcesPage />);

    expect(await screen.findByText('Meta wedding leads')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open sheet' })).toHaveAttribute(
      'href',
      LEAD_SOURCE.sheetUrl,
    );
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Pause importing from/ })).toBeInTheDocument();
  });

  it('makes Facebook the one prominent way in, with the token form tucked away', async () => {
    renderAuthed(<LeadSourcesPage />);

    const fallback = await screen.findByRole('button', {
      name: 'Use a Page access token instead',
    });

    // Collapsed by default: open, it would read as a peer option rather than a fallback.
    expect(fallback).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Page access token')).not.toBeInTheDocument();

    fireEvent.click(fallback);

    expect(screen.getByLabelText('Page access token')).toBeInTheDocument();
  });

  it('surfaces the sheet error so an admin can fix the sharing setting', async () => {
    endpoints.listLeadSources.mockResolvedValue({
      data: [
        {
          ...LEAD_SOURCE,
          lastSyncStatus: 'failed',
          lastError: 'The sheet is not link-shared. Set it to "anyone with the link can view".',
        },
      ],
    });

    renderAuthed(<LeadSourcesPage />);

    expect(await screen.findByText(/not link-shared/i)).toBeInTheDocument();
    expect(screen.getByText('Sync failed')).toBeInTheDocument();
  });

  it('does not offer a removed number as a destination', async () => {
    renderAuthed(<LeadSourcesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Use a Page access token instead' }));
    await screen.findByLabelText('WhatsApp number for new leads');

    expect(screen.getByRole('option', { name: 'Studio Main' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Old Number' })).not.toBeInTheDocument();
  });

  it('runs an immediate sync on request', async () => {
    renderAuthed(<LeadSourcesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    await waitFor(() => expect(endpoints.syncLeadSource).toHaveBeenCalledTimes(1));
    expect(endpoints.syncLeadSource.mock.calls[0][0]).toMatchObject({ leadSourceId: 'ls-1' });
  });

  it('pauses a source without deleting the leads it produced', async () => {
    renderAuthed(<LeadSourcesPage />);

    fireEvent.click(
      await screen.findByRole('switch', { name: /Pause importing from/ }),
    );

    await waitFor(() => expect(endpoints.updateLeadSource).toHaveBeenCalledTimes(1));
    expect(endpoints.updateLeadSource.mock.calls[0][0]).toMatchObject({
      leadSourceId: 'ls-1',
      status: 'paused',
    });
    expect(endpoints.deleteLeadSource).not.toHaveBeenCalled();
  });

  it('turns the AI-messages-first switch on for one form only', async () => {
    renderAuthed(<LeadSourcesPage />);

    // Per form, because a lead only ever carries the form it came from. This is the switch that
    // makes the studio message a stranger, so it is off until someone turns it on.
    const greet = await screen.findByRole('switch', { name: /message new leads.*first/i });
    expect(greet).not.toBeChecked();

    fireEvent.click(greet);

    await waitFor(() =>
      expect(endpoints.updateLeadSource).toHaveBeenCalledWith(
        expect.objectContaining({ leadSourceId: 'ls-1', autoGreetEnabled: true }),
      ),
    );
  });

  it('tells the admin to add a number first when none exists', async () => {
    endpoints.listAccounts.mockResolvedValue({ data: [] });
    endpoints.listLeadSources.mockResolvedValue({ data: [] });

    renderAuthed(<LeadSourcesPage />);

    expect(await screen.findByText(/Add a WhatsApp number on the Accounts page first/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Facebook' })).not.toBeInTheDocument();
  });
});

/*
 * The sheet IMPORTER is still supported; the sheet CREATION form is simply no longer offered on
 * the page. So it is exercised directly here rather than through LeadSourcesPage - deleting the
 * coverage along with the mount point would leave a live API path with nothing testing it.
 */
describe('AddLeadSourceForm (kept, no longer mounted on the page)', () => {
  it('still connects a sheet, with backfill and AI context off by default', async () => {
    // The fixture is a partial DTO; the form reads only id, name and status. Rendering the
    // component directly type-checks its props, which going through a mocked endpoint did not.
    const accounts = ACCOUNTS.filter(
      (account) => account.status !== 'removed',
    ) as unknown as WhatsAppAccount[];

    renderAuthed(<AddLeadSourceForm accounts={accounts} />);

    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Birthday leads' },
    });
    fireEvent.change(screen.getByLabelText('Google Sheet link'), {
      target: { value: 'https://docs.google.com/spreadsheets/d/xyz/edit#gid=3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect sheet' }));

    await waitFor(() => expect(endpoints.createLeadSource).toHaveBeenCalledTimes(1));
    expect(endpoints.createLeadSource.mock.calls[0][0]).toMatchObject({
      name: 'Birthday leads',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/xyz/edit#gid=3',
      whatsappAccountId: 'acc-1',
      defaultCountryCode: '91',
      aiContextEnabled: false,
      importExisting: false,
    });
  });
});
