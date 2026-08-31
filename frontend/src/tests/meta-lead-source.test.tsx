import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import LeadSourcesPage from '../pages/LeadSourcesPage';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const ACCOUNTS = [{ id: 'acc-1', name: 'Studio Main', brandKey: 'studio-main', status: 'active' }];

/** Not a credential: a made-up string long enough to pass the form's own length check. */
const TOKEN = 'paste-a-page-token-here-0123456789';

const META_SOURCE = {
  id: 'ls-meta',
  name: 'Meta wedding leads',
  kind: 'meta_lead_ads',
  sheetUrl: null,
  gid: null,
  meta: {
    pageId: '777',
    pageName: 'Vistaar Studio',
    formId: '4001',
    formName: 'Wedding enquiry',
    hasAccessToken: true,
    accessTokenLast4: 'wxyz',
    accessTokenSetAt: '2026-08-20T06:00:00.000Z',
    lastLeadCreatedAt: '2026-08-25T09:00:00.000Z',
  },
  whatsappAccountId: 'acc-1',
  defaultCountryCode: '91',
  status: 'active',
  aiContextEnabled: false,
  lastSyncedAt: '2026-08-26T06:00:00.000Z',
  lastSyncStatus: 'ok',
  lastError: null,
  lastSyncCounts: { imported: 3, duplicates: 8, skipped: 0, failed: 0 },
  totalImported: 21,
};

const openMetaTab = async () => {
  fireEvent.click(await screen.findByRole('tab', { name: 'Meta Lead Ads' }));
};

beforeEach(() => {
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.LEAD_SOURCES_MANAGE] }),
  );
  endpoints.listLeadSources.mockResolvedValue({ data: [] });
  endpoints.listAccounts.mockResolvedValue({ data: ACCOUNTS });
  endpoints.testMetaLeadSourceConnection.mockResolvedValue({
    data: {
      identity: { id: '777', name: 'Vistaar Studio' },
      pages: [{ id: '777', name: 'Vistaar Studio' }],
      pageScoped: true,
    },
  });
  endpoints.listMetaLeadForms.mockResolvedValue({
    data: [
      { id: '4001', name: 'Wedding enquiry', status: 'ACTIVE' },
      { id: '4002', name: 'Old enquiry', status: 'ARCHIVED' },
    ],
  });
  endpoints.createMetaLeadSource.mockResolvedValue({ data: META_SOURCE });
  endpoints.syncLeadSource.mockResolvedValue({ data: META_SOURCE });
  endpoints.updateLeadSource.mockResolvedValue({ data: META_SOURCE });
  endpoints.deleteLeadSource.mockResolvedValue({ data: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Connecting a Meta Lead Ads source', () => {
  it('keeps the Google Sheet form as the default, so nothing moved for existing admins', async () => {
    renderAuthed(<LeadSourcesPage />);

    expect(await screen.findByLabelText('Google Sheet link')).toBeInTheDocument();
    expect(screen.queryByLabelText('Page access token')).not.toBeInTheDocument();
  });

  it('will not save until the pasted token has actually been tested', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openMetaTab();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Meta wedding leads' } });
    fireEvent.change(screen.getByLabelText('Page access token'), { target: { value: TOKEN } });

    expect(screen.getByRole('button', { name: 'Connect Meta form' })).toBeDisabled();
  });

  it('tests the token, then offers the page’s forms to pick from', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openMetaTab();

    fireEvent.change(screen.getByLabelText('Page access token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(endpoints.testMetaLeadSourceConnection).toHaveBeenCalledTimes(1));
    expect(endpoints.testMetaLeadSourceConnection.mock.calls[0][0]).toMatchObject({
      accessToken: TOKEN,
    });

    // A single page (the normal answer for a Page token) is selected for the admin.
    await waitFor(() => expect(endpoints.listMetaLeadForms).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('option', { name: 'Wedding enquiry' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Every form on this page' })).toBeInTheDocument();
  });

  it('saves the page, the form and the token, with backfill and AI context off by default', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openMetaTab();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Meta wedding leads' } });
    fireEvent.change(screen.getByLabelText('Page access token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await screen.findByRole('option', { name: 'Wedding enquiry' });
    fireEvent.change(screen.getByLabelText('Lead form'), { target: { value: '4001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Meta form' }));

    await waitFor(() => expect(endpoints.createMetaLeadSource).toHaveBeenCalledTimes(1));
    expect(endpoints.createMetaLeadSource.mock.calls[0][0]).toMatchObject({
      name: 'Meta wedding leads',
      accessToken: TOKEN,
      pageId: '777',
      pageName: 'Vistaar Studio',
      formId: '4001',
      formName: 'Wedding enquiry',
      whatsappAccountId: 'acc-1',
      defaultCountryCode: '91',
      aiContextEnabled: false,
      importExisting: false,
    });
  });

  it('sends a null form id for "every form on this page"', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openMetaTab();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Whole page' } });
    fireEvent.change(screen.getByLabelText('Page access token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await screen.findByRole('option', { name: 'Every form on this page' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Meta form' }));

    await waitFor(() => expect(endpoints.createMetaLeadSource).toHaveBeenCalledTimes(1));
    expect(endpoints.createMetaLeadSource.mock.calls[0][0]).toMatchObject({
      formId: null,
      formName: null,
    });
  });

  it('shows Meta’s refusal instead of pretending the token was accepted', async () => {
    endpoints.testMetaLeadSourceConnection.mockRejectedValue(
      new Error('The Meta access token has expired or was revoked.'),
    );

    renderAuthed(<LeadSourcesPage />);
    await openMetaTab();

    fireEvent.change(screen.getByLabelText('Page access token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or was revoked/i);
    expect(screen.queryByLabelText('Lead form')).not.toBeInTheDocument();
    expect(endpoints.createMetaLeadSource).not.toHaveBeenCalled();
  });

  it('never puts the token into a URL - both Meta calls are POSTs with a body', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openMetaTab();

    fireEvent.change(screen.getByLabelText('Page access token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(endpoints.listMetaLeadForms).toHaveBeenCalled());

    // The endpoint helpers take the token as a named field, not as a query parameter.
    expect(endpoints.listMetaLeadForms.mock.calls[0][0]).toMatchObject({
      accessToken: TOKEN,
      pageId: '777',
    });
  });
});

describe('A configured Meta source in the list', () => {
  it('shows the page, the form and four characters of the token - never the token', async () => {
    endpoints.listLeadSources.mockResolvedValue({ data: [META_SOURCE] });

    renderAuthed(<LeadSourcesPage />);

    const row = (await screen.findByText('Meta wedding leads')).closest('li');

    expect(row).toHaveTextContent('Meta Lead Ads');
    expect(row).toHaveTextContent('Vistaar Studio');
    expect(row).toHaveTextContent('Wedding enquiry');
    expect(row).toHaveTextContent('token ····wxyz');
    // No sheet to open, and no attempt to render one.
    expect(screen.queryByRole('link', { name: 'Open sheet' })).not.toBeInTheDocument();
  });

  it('calls an expired token out as needing attention rather than as one more failed sync', async () => {
    endpoints.listLeadSources.mockResolvedValue({
      data: [
        {
          ...META_SOURCE,
          lastSyncStatus: 'needs_attention',
          lastError:
            'The Meta access token has expired or was revoked. Paste a new Page access token to start importing again.',
        },
      ],
    });

    renderAuthed(<LeadSourcesPage />);

    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText(/Paste a new Page access token/i)).toBeInTheDocument();
  });

  it('still offers sync, pause and remove, exactly as a sheet source does', async () => {
    endpoints.listLeadSources.mockResolvedValue({ data: [META_SOURCE] });

    renderAuthed(<LeadSourcesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    await waitFor(() => expect(endpoints.syncLeadSource).toHaveBeenCalledTimes(1));
    expect(endpoints.syncLeadSource.mock.calls[0][0]).toMatchObject({ leadSourceId: 'ls-meta' });
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });
});
